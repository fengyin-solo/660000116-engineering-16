#!/usr/bin/env node
/**
 * 协作白板 - 本地开发统一启动/检查脚本（零额外依赖，仅使用 Node 内置模块）
 *
 * 用法:
 *   node scripts/dev-launcher.js up [--install] [--force] [--detach]
 *   node scripts/dev-launcher.js stop
 *   node scripts/dev-launcher.js status
 *   node scripts/dev-launcher.js restart [--install] [--force] [--detach]
 *   node scripts/dev-launcher.js logs [server|client]
 *
 * 也可以通过根目录 npm scripts 调用:
 *   npm run dev / dev:stop / dev:status / dev:restart / dev:logs
 *
 * 说明:
 * - up 会依次执行: 环境检查 -> 端口/旧进程检查 -> 依赖准备(缺则安装) ->
 *   启动后端(3001) -> 启动前端(5173) -> 前后端连通与模板数据检查 -> 输出访问入口
 * - 任一阶段失败: 打印失败环节与原因、相关日志末尾, 并回收本次已启动的进程后退出(非 0)
 * - 重跑安全: 由本脚本启动的残留进程会被识别并清理; 已在运行且健康时直接复用
 * - 不会删除 server/data 下的任何数据; 手工 `cd server && npm run dev` 的方式不受影响
 */

'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, '.dev');
const SERVER_DIR = path.join(ROOT, 'server');
const CLIENT_DIR = path.join(ROOT, 'client');

const SERVER_PORT = 3001;
const CLIENT_PORT = 5173;

const SERVICES = {
  server: {
    name: '会议纪要与业务流程服务',
    dir: SERVER_DIR,
    port: SERVER_PORT,
    pidFile: path.join(RUNTIME_DIR, 'server.pid.json'),
    logFile: path.join(RUNTIME_DIR, 'server.log'),
    installLog: path.join(RUNTIME_DIR, 'install-server.log'),
    healthPath: '/api/health',
    keyPackage: 'express',
  },
  client: {
    name: '画板前端',
    dir: CLIENT_DIR,
    port: CLIENT_PORT,
    pidFile: path.join(RUNTIME_DIR, 'client.pid.json'),
    logFile: path.join(RUNTIME_DIR, 'client.log'),
    installLog: path.join(RUNTIME_DIR, 'install-client.log'),
    healthPath: '/',
    keyPackage: 'vite',
  },
};

const READY_TIMEOUT_MS = 45000;
const POLL_INTERVAL_MS = 400;
const isWin = process.platform === 'win32';
const NPM = isWin ? 'npm.cmd' : 'npm';

// ---------------------------------------------------------------------------
// 输出工具
// ---------------------------------------------------------------------------
const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const step = (n, title) => console.log(`\n${c.cyan(`[${n}] ${title}`)}`);
const ok = (msg) => console.log(`  ${c.green('✓')} ${msg}`);
const info = (msg) => console.log(`  ${c.gray('•')} ${msg}`);
const warn = (msg) => console.log(`  ${c.yellow('!')} ${msg}`);

class StageError extends Error {
  constructor(stage, reason, logFile) {
    super(reason);
    this.stage = stage;
    this.logFile = logFile;
  }
}

function tailLines(file, n = 20) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    return content.trimEnd().split('\n').slice(-n).join('\n');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 进程 / 端口工具
// ---------------------------------------------------------------------------
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 进程存在但无权限也视为存活
  }
}

function killTree(pid) {
  if (!pid || !isAlive(pid)) return;
  if (isWin) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  // detached 启动的进程自身就是新进程组组长, 负 pid 可整组结束(nodemon/vite 子进程一并回收)
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* noop */
    }
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* noop */
    }
  }
}

function readPidMeta(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writePidMeta(file, meta) {
  fs.writeFileSync(file, JSON.stringify(meta, null, 2));
}

/**
 * 判断 TCP 端口是否可绑定(返回 true 表示空闲)。
 * Vite 默认可能只监听 IPv6(::1), 因此 v4/vv6 两个回环地址都要探测。
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    let pending = 2;
    let anyBusy = false;
    for (const host of ['127.0.0.1', '::1']) {
      const srv = net.createServer();
      srv.once('error', () => {
        anyBusy = true;
        if (--pending === 0) resolve(!anyBusy);
      });
      srv.once('listening', () => srv.close(() => {
        if (--pending === 0) resolve(!anyBusy);
      }));
      try {
        srv.listen(port, host);
      } catch {
        anyBusy = true;
        if (--pending === 0) resolve(!anyBusy);
      }
    }
  });
}

/**
 * 查找占用某端口的进程 PID 列表。
 * Linux:
 *   - 解析 tcp/tcp6 的 LISTEN inode（优先读各进程自己的 /proc/<pid>/net，
 *     以兼容容器/沙箱里多网络命名空间的情况），再通过 /proc/<pid>/fd 反查 inode;
 * 其他平台: 尝试 lsof / fuser。
 */
function findPortPids(port) {
  const hexPort = port.toString(16).padStart(4, '0');

  if (process.platform === 'linux') {
    const parseTable = (tablePath) => {
      const inodes = new Set();
      let text;
      try {
        text = fs.readFileSync(tablePath, 'utf8');
      } catch {
        return inodes;
      }
      for (const line of text.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 11) continue;
        const localPort = (cols[1].split(':')[1] || '').toLowerCase();
        const state = cols[3];
        if (localPort === hexPort && state === '0A') {
          inodes.add(cols[9]); // 0A = LISTEN
        }
      }
      return inodes;
    };

    const pids = new Set();
    let entries;
    try {
      entries = fs.readdirSync('/proc');
    } catch {
      return [];
    }

    // 每个进程: 其 fd 中的监听 socket 若在该进程网络命名空间内监听了目标端口, 即为占用者。
    // 读 /proc/<pid>/net 而不是只看自身 /proc/net, 可兼容容器/沙箱的多网络命名空间。
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);

      const inodes = new Set([
        ...parseTable(`/proc/${pid}/net/tcp`),
        ...parseTable(`/proc/${pid}/net/tcp6`),
      ]);
      if (inodes.size === 0) continue;

      let fds;
      try {
        fds = fs.readdirSync(`/proc/${pid}/fd`);
      } catch {
        continue; // 无权限(其他用户进程)时跳过
      }
      for (const fd of fds) {
        let link;
        try {
          link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {
          continue;
        }
        const m = link.match(/^socket:\[(\d+)\]$/);
        if (m && inodes.has(m[1])) {
          pids.add(pid);
          break;
        }
      }
    }
    return [...pids];
  }

  // macOS / 其他 Unix
  const lsof = spawnSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' });
  if (lsof.status === 0) {
    return lsof.stdout.trim().split('\n').filter(Boolean).map(Number);
  }
  const fuser = spawnSync('fuser', [String(port) + '/tcp'], { encoding: 'utf8' });
  if (fuser.status === 0) {
    return fuser.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  }
  return [];
}

function describePid(pid) {
  try {
    if (process.platform === 'linux') {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+/g, ' ').trim();
      return raw || fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    }
  } catch {
    /* fallthrough */
  }
  return `PID ${pid}`;
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------
async function httpGet(url) {
  const res = await fetch(url);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, text, json };
}

/**
 * 就绪探测: 依次尝试多个 URL(用于同时覆盖 127.0.0.1 与 [::1],
 * 适配 Vite 仅绑定 IPv6 回环的默认行为)。
 */
async function httpGetAny(urls) {
  let lastErr;
  for (const url of urls) {
    try {
      return await httpGet(url);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function loopbackUrls(pathname, port) {
  return [`http://127.0.0.1:${port}${pathname}`, `http://[::1]:${port}${pathname}`];
}

async function waitFor(urls, { isReady, isProcessAlive, timeoutMs, logFile, stage, serviceName }) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    if (isProcessAlive && !isProcessAlive()) {
      throw new StageError(
        stage,
        `${serviceName}进程提前退出, 通常是代码报错或运行时异常。`,
        logFile
      );
    }
    try {
      const res = await httpGetAny(urls);
      if (isReady(res)) return res;
      lastErr = `HTTP ${res.status} ${res.text.slice(0, 200)}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new StageError(
    stage,
    `${serviceName}在 ${Math.round(timeoutMs / 1000)}s 内未就绪(${urls.join(' 或 ')})。最后一次探测结果: ${lastErr}`,
    logFile
  );
}

// ---------------------------------------------------------------------------
// 各阶段
// ---------------------------------------------------------------------------
function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function stageEnvironment() {
  step(1, '环境检查');
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 18) {
    throw new StageError(
      '环境检查',
      `需要 Node.js >= 18(依赖内置 fetch), 当前为 ${process.versions.node}。请升级 Node 后重试。`
    );
  }
  ok(`Node.js ${process.versions.node}`);

  const npmVer = spawnSync(NPM, ['-v'], { encoding: 'utf8' });
  if (npmVer.status !== 0) {
    throw new StageError('环境检查', '未找到 npm, 请确认 Node.js 安装完整且 npm 在 PATH 中。');
  }
  ok(`npm ${npmVer.stdout.trim()}`);

  for (const key of ['server', 'client']) {
    const svc = SERVICES[key];
    if (!fs.existsSync(path.join(svc.dir, 'package.json'))) {
      throw new StageError('环境检查', `缺少 ${path.relative(ROOT, svc.dir)}/package.json, 请确认仓库完整。`);
    }
  }
  ok('server / client 目录结构完整');
}

/** 读取并清理本脚本记录的进程; 返回当前存活的服务列表 */
function collectManagedLive() {
  const live = {};
  for (const [key, svc] of Object.entries(SERVICES)) {
    const meta = readPidMeta(svc.pidFile);
    if (meta && isAlive(meta.pid)) {
      live[key] = meta;
    } else if (meta) {
      fs.rmSync(svc.pidFile, { force: true });
    }
  }
  return live;
}

/**
 * 端口与旧进程检查。
 * - 本脚本残留的托管进程: 直接清理
 * - 其他进程占用且未加 --force: 失败并给出占用者信息
 * - --force: 强制结束端口占用者
 */
async function stagePorts(live, force) {
  step(2, '端口与旧进程检查');
  for (const key of Object.keys(live)) {
    const meta = live[key];
    warn(`发现上次由本脚本启动的 ${SERVICES[key].name}(PID ${meta.pid}), 先清理旧进程`);
    killTree(meta.pid);
    fs.rmSync(SERVICES[key].pidFile, { force: true });
  }

  for (const [key, svc] of Object.entries(SERVICES)) {
    const free = await isPortFree(svc.port);
    if (free) {
      ok(`端口 ${svc.port} (${svc.name}) 空闲`);
      continue;
    }

    const occupantPids = findPortPids(svc.port);
    const desc = occupantPids.map((p) => `PID ${p}: ${describePid(p)}`).join('\n      ');

    if (!force) {
      throw new StageError(
        '端口与旧进程检查',
        [
          `端口 ${svc.port} 已被其他进程占用, ${svc.name}无法启动。`,
          desc ? `占用进程:\n      ${desc}` : '未能解析占用进程(可能属于其他用户), 可用 lsof -i :' + svc.port + ' 查看。',
          `处理方式: 结束该进程后重跑; 或使用 --force 由脚本强制结束:\n      node scripts/dev-launcher.js up --force`,
        ].join('\n      ')
      );
    }

    warn(`--force: 强制结束端口 ${svc.port} 的占用进程`);
    for (const pid of occupantPids) killTree(pid);
    let freed = false;
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      if (await isPortFree(svc.port)) {
        freed = true;
        break;
      }
    }
    if (!freed) {
      throw new StageError('端口与旧进程检查', `强制结束后端口 ${svc.port} 仍被占用, 请手动检查。`);
    }
    ok(`端口 ${svc.port} 已释放`);
  }
}

function depsInstalled(svc) {
  if (!fs.existsSync(path.join(svc.dir, 'node_modules'))) return false;
  // 关键依赖无法解析说明 node_modules 残缺, 需要重新安装
  try {
    require.resolve(svc.keyPackage, { paths: [svc.dir] });
    return true;
  } catch {
    return false;
  }
}

function runInstall(svc) {
  fs.writeFileSync(svc.installLog, '');
  const out = fs.openSync(svc.installLog, 'a');
  const child = spawnSync(NPM, ['install'], { cwd: svc.dir, stdio: ['ignore', out, out], encoding: 'utf8' });
  fs.closeSync(out);
  return child.status === 0;
}

function stageDeps(forceInstall) {
  step(3, '依赖准备');
  for (const [key, svc] of Object.entries(SERVICES)) {
    const label = `${svc.name} (${path.relative(ROOT, svc.dir)})`;
    if (!forceInstall && depsInstalled(svc)) {
      ok(`${label} 依赖已就绪, 跳过安装(不会重复安装)`);
      continue;
    }
    info(`${label} 执行 npm install ...`);
    if (!runInstall(svc)) {
      throw new StageError(
        '依赖准备',
        `${label} npm install 失败, 常见原因: 网络不可达、registry 异常或磁盘权限问题。安装日志末尾:`,
        svc.installLog
      );
    }
    if (!depsInstalled(svc)) {
      throw new StageError(
        '依赖准备',
        `${label} 安装命令返回成功但关键依赖 ${svc.keyPackage} 仍无法解析, node_modules 可能不完整。`,
        svc.installLog
      );
    }
    ok(`${label} 依赖安装完成`);
  }
}

function startService(key, extraEnv = {}) {
  const svc = SERVICES[key];
  fs.writeFileSync(svc.logFile, '');
  const out = fs.openSync(svc.logFile, 'a');
  let outClosed = false;
  const closeOut = () => {
    if (!outClosed) {
      outClosed = true;
      try {
        fs.closeSync(out);
      } catch {
        /* 已关闭则忽略 */
      }
    }
  };
  const child = spawn(NPM, ['run', 'dev'], {
    cwd: svc.dir,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', out, out],
    detached: true, // 独立进程组, 便于连同 nodemon/vite 子进程一起回收
  });
  child.once('exit', closeOut);
  child.unref();
  const meta = { pid: child.pid, port: svc.port, startedAt: new Date().toISOString(), cmd: 'npm run dev' };
  writePidMeta(svc.pidFile, meta);
  return meta;
}

async function stageServer() {
  step(4, `启动后端: ${SERVICES.server.name} (端口 ${SERVER_PORT})`);
  const meta = startService('server');
  info('进程已拉起, 等待 /api/health 就绪 ...');
  await waitFor(loopbackUrls(SERVICES.server.healthPath, SERVER_PORT), {
    isReady: (res) => res.status === 200 && res.json && res.json.status === 'ok',
    isProcessAlive: () => isAlive(meta.pid),
    timeoutMs: READY_TIMEOUT_MS,
    logFile: SERVICES.server.logFile,
    stage: '后端启动',
    serviceName: SERVICES.server.name,
  });
  ok(`后端健康检查通过 /api/health`);
  return meta;
}

async function stageClient() {
  step(5, `启动前端: ${SERVICES.client.name} (端口 ${CLIENT_PORT})`);
  const meta = startService('client');
  info('进程已拉起, 等待 Vite 页面可访问 ...');
  await waitFor(loopbackUrls(SERVICES.client.healthPath, CLIENT_PORT), {
    isReady: (res) => res.status === 200 || res.status === 304,
    isProcessAlive: () => isAlive(meta.pid),
    timeoutMs: READY_TIMEOUT_MS,
    logFile: SERVICES.client.logFile,
    stage: '前端启动',
    serviceName: SERVICES.client.name,
  });
  ok(`前端页面可访问 http://localhost:${CLIENT_PORT}/`);
  return meta;
}

async function stageConnectivity() {
  step(6, '前后端连通与模板数据检查');

  // 1) 后端直连模板接口
  let direct;
  try {
    direct = await httpGet(`http://127.0.0.1:${SERVER_PORT}/api/templates`);
  } catch (e) {
    throw new StageError('前后端连通检查', `后端模板接口不可达: ${e.message}`);
  }
  if (direct.status !== 200 || !Array.isArray(direct.json)) {
    throw new StageError(
      '前后端连通检查',
      `后端 /api/templates 异常(HTTP ${direct.status}), 请检查服务端路由。`,
      SERVICES.server.logFile
    );
  }
  const names = direct.json.map((t) => t.name).join(' / ');
  ok(`后端模板数据正常(${direct.json.length} 个: ${names})`);

  // 2) 经前端 Vite 代理访问后端 —— 这是页面真实使用的链路
  let proxied;
  try {
    proxied = await httpGetAny(loopbackUrls('/api/health', CLIENT_PORT));
  } catch (e) {
    throw new StageError(
      '前后端连通检查',
      `通过前端地址访问后端失败(${e.message})。后端本身正常, 问题在 Vite 代理(/api -> http://localhost:${SERVER_PORT}), 请检查 client/vite.config.ts。`
    );
  }
  if (proxied.status !== 200 || !proxied.json || proxied.json.status !== 'ok') {
    throw new StageError(
      '前后端连通检查',
      `前端代理 /api/health 返回异常: HTTP ${proxied.status} ${proxied.text.slice(0, 200)}。后端直连正常, 说明页面到后端的代理链路有问题。`
    );
  }
  ok(`页面 -> Vite 代理 -> 后端链路通畅(/api/health = ok)`);
}

function printBanner() {
  console.log(`\n${c.green(c.bold('✓ 全部就绪, 统一启动完成'))}`);
  console.log(`  ${c.bold('画板访问入口')}:  ${c.cyan(`http://localhost:${CLIENT_PORT}`)}`);
  console.log(`  ${c.bold('后端健康检查')}:  ${c.cyan(`http://localhost:${SERVER_PORT}/api/health`)}`);
  console.log(`  ${c.bold('模板数据接口')}:  ${c.cyan(`http://localhost:${SERVER_PORT}/api/templates`)} (会议纪要 / 流程梳理 / 周计划)`);
  console.log(`  ${c.gray(`日志目录: ${path.relative(ROOT, RUNTIME_DIR)}/  | 查看日志: npm run dev:logs | 停止: npm run dev:stop`)}`);
}

/** 前台模式: 合并输出两端日志, Ctrl-C 时一并回收 */
function tailBoth(onExit) {
  const streams = {};
  for (const [key, svc] of Object.entries(SERVICES)) {
    const tag = key === 'server' ? c.yellow('[server]') : c.cyan('[client]');
    let offset = 0;
    try {
      offset = fs.statSync(svc.logFile).size;
    } catch {
      offset = 0;
    }
    const pump = () => {
      let stat;
      try {
        stat = fs.statSync(svc.logFile);
      } catch {
        return;
      }
      if (stat.size < offset) offset = 0; // 日志被轮转/重建
      if (stat.size > offset) {
        const fd = fs.openSync(svc.logFile, 'r');
        const buf = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset = stat.size;
        process.stdout.write(
          buf
            .toString('utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => `${tag} ${l}`)
            .join('\n') + '\n'
        );
      }
    };
    streams[key] = fs.watch(svc.logFile, { persistent: true }, pump);
    pump();
  }

  const shutdown = () => {
    Object.values(streams).forEach((w) => w.close());
    onExit();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------
async function cmdUp({ forceInstall, force, detach }) {
  ensureRuntimeDir();
  const started = [];
  try {
    stageEnvironment();

    const live = collectManagedLive();
    // 两端均为本脚本托管且都健康 -> 幂等复用, 不重复启动
    const liveKeys = Object.keys(live);
    if (liveKeys.length === 2 && !force && !forceInstall) {
      const healthy = await Promise.all(
        liveKeys.map(async (key) => {
          try {
            const res = await httpGetAny(loopbackUrls(SERVICES[key].healthPath, SERVICES[key].port));
            return res.status === 200;
          } catch {
            return false;
          }
        })
      );
      if (healthy.every(Boolean)) {
        info('检测到服务已在运行且健康, 直接复用(如需重启请用 npm run dev:restart)');
        await stageConnectivity();
        printBanner();
        return;
      }
    }

    await stagePorts(live, force);
    stageDeps(forceInstall);
    const serverMeta = await stageServer();
    started.push(serverMeta.pid);
    const clientMeta = await stageClient();
    started.push(clientMeta.pid);
    await stageConnectivity();
    printBanner();

    if (detach) {
      info('后台运行中, 关闭终端不会停止; 停止请执行 npm run dev:stop');
      return;
    }

    console.log(c.gray('\n--- 实时日志(Ctrl-C 停止前后端, 进程会被一并清理) ---'));
    tailBoth(() => cleanupStarted(started, { silent: true }));
  } catch (e) {
    cleanupStarted(started, { silent: true });
    printFailure(e);
    process.exit(1);
  }
}

function cleanupStarted(pids, { silent } = {}) {
  for (const pid of pids) killTree(pid);
  // 同步清理本次写入但进程已死的 pid 文件
  for (const svc of Object.values(SERVICES)) {
    const meta = readPidMeta(svc.pidFile);
    if (meta && (!isAlive(meta.pid) || pids.includes(meta.pid))) {
      fs.rmSync(svc.pidFile, { force: true });
    }
  }
  if (!silent) info('本次启动的进程已回收');
}

function printFailure(e) {
  if (e instanceof StageError) {
    console.log(`\n${c.red(c.bold('✗ 启动失败'))}  环节: ${c.bold(c.red(`[${e.stage}]`))}`);
    for (const line of String(e.message).split('\n')) console.log(`    ${line}`);
    if (e.logFile && fs.existsSync(e.logFile)) {
      const tail = tailLines(e.logFile, 20);
      if (tail) {
        console.log(`\n    ${c.yellow(`日志末尾(${path.relative(ROOT, e.logFile)}):`)}`);
        for (const line of tail.split('\n')) console.log(`    ${c.gray(line)}`);
      }
    }
    console.log(`\n    ${c.bold('修复后直接重跑即可')}: npm run dev  (旧进程会被自动清理, 数据不会丢失)`);
  } else {
    console.log(`\n${c.red(c.bold('✗ 启动失败'))}: ${e && e.stack ? e.stack : e}`);
  }
}

function cmdStop() {
  ensureRuntimeDir();
  const live = collectManagedLive();
  const keys = Object.keys(live);
  if (keys.length === 0) {
    info('没有由本脚本启动的在运行进程。');
  } else {
    for (const key of keys) {
      killTree(live[key].pid);
      fs.rmSync(SERVICES[key].pidFile, { force: true });
      ok(`${SERVICES[key].name} 已停止(PID ${live[key].pid})`);
    }
  }
  // 兜底: pid 文件丢失但端口仍被“疑似本项目”进程占用时给出提示(不擅自结束)
  for (const svc of Object.values(SERVICES)) {
    const busy = spawnSync(process.execPath, [
      '-e',
      `require('net').createServer().on('error',()=>process.exit(1)).listen(${svc.port},'127.0.0.1',function(){this.close(()=>process.exit(0))})`,
    ]).status;
    if (busy === 1) warn(`端口 ${svc.port} 仍被占用, 如确认是残留进程可执行: node scripts/dev-launcher.js up --force`);
  }
}

async function cmdStatus() {
  const live = collectManagedLive();
  let allHealthy = true;
  console.log(c.bold('\n服务状态'));
  for (const [key, svc] of Object.entries(SERVICES)) {
    const meta = live[key];
    let state = c.red('未运行');
    let detail = '';
    if (meta) {
      try {
        const res = await httpGetAny(loopbackUrls(svc.healthPath, svc.port));
        if (res.status === 200) {
          state = c.green('运行中/健康');
          detail = `PID ${meta.pid}, 启动于 ${meta.startedAt}`;
        } else {
          state = c.yellow('进程在, 但健康检查异常');
          detail = `HTTP ${res.status}`;
          allHealthy = false;
        }
      } catch (e) {
        state = c.yellow('进程在, 但端口无响应');
        detail = e.message;
        allHealthy = false;
      }
    } else {
      allHealthy = false;
    }
    console.log(`  ${svc.name.padEnd(22)} ${state}  端口 ${svc.port}  ${c.gray(detail)}`);
  }

  if (allHealthy) {
    try {
      const res = await httpGetAny(loopbackUrls('/api/health', CLIENT_PORT));
      const linked = res.status === 200 && res.json && res.json.status === 'ok';
      console.log(`  ${'前后端代理链路'.padEnd(22)} ${linked ? c.green('正常') : c.red('异常')}`);
      console.log(`\n  访问入口: ${c.cyan(`http://localhost:${CLIENT_PORT}`)}`);
    } catch {
      console.log(`  ${'前后端代理链路'.padEnd(22)} ${c.red('异常')}`);
      allHealthy = false;
    }
  }
  process.exit(allHealthy ? 0 : 1);
}

function cmdLogs(target) {
  const key = target === 'server' || target === 'client' ? target : null;
  const targets = key ? [key] : Object.keys(SERVICES);
  for (const k of targets) {
    const svc = SERVICES[k];
    if (!fs.existsSync(svc.logFile)) {
      warn(`${svc.name}暂无日志(${path.relative(ROOT, svc.logFile)}), 请先 npm run dev`);
      continue;
    }
    const tag = k === 'server' ? c.yellow('[server]') : c.cyan('[client]');
    const print = (text) =>
      process.stdout.write(text.split('\n').filter(Boolean).map((l) => `${tag} ${l}`).join('\n') + '\n');
    print(tailLines(svc.logFile, 50));
    let offset = fs.statSync(svc.logFile).size;
    fs.watch(svc.logFile, () => {
      const stat = fs.statSync(svc.logFile);
      if (stat.size < offset) offset = 0;
      if (stat.size > offset) {
        const fd = fs.openSync(svc.logFile, 'r');
        const buf = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset = stat.size;
        print(buf.toString('utf8'));
      }
    });
  }
  console.log(c.gray('--- 实时跟踪日志(Ctrl-C 退出, 不会停止服务) ---'));
  setInterval(() => {}, 1 << 30);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  return {
    forceInstall: argv.includes('--install'),
    force: argv.includes('--force'),
    detach: argv.includes('--detach') || argv.includes('-d'),
    positional: argv.filter((a) => !a.startsWith('--') && a !== '-d'),
  };
}

(async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'up';
  const args = parseArgs(command === argv[0] ? argv.slice(1) : argv);

  switch (command) {
    case 'up':
      await cmdUp(args);
      break;
    case 'stop':
      cmdStop();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'restart':
      cmdStop();
      await cmdUp(args);
      break;
    case 'logs':
      cmdLogs(args.positional[0]);
      break;
    default:
      console.log(`未知命令: ${command}\n可用: up | stop | status | restart | logs [server|client]`);
      process.exit(2);
  }
})().catch((e) => {
  printFailure(e);
  process.exit(1);
});
