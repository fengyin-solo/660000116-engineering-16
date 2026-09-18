#!/usr/bin/env bash
# 统一本地开发启动 / 检查 / 停止脚本（白板前端 + 会议纪要与业务流程服务）
#
# 用法:
#   ./scripts/dev.sh up       准备依赖 -> 启动前后端 -> 就绪检查 -> 端到端检查 -> 输出访问入口
#   ./scripts/dev.sh status   查看前后端进程与就绪状态（只读，不改动任何进程）
#   ./scripts/dev.sh check    对已经运行中的服务做端到端检查（页面 / API 代理 / WebSocket）
#   ./scripts/dev.sh stop     停止由本脚本启动的前后端进程
#   ./scripts/dev.sh restart  等价于 stop + up
#   ./scripts/dev.sh logs [server|client] [-f]   查看 / 跟踪服务日志
#
# 可选环境变量: PORT(服务端, 默认3001)  CLIENT_PORT(前端, 默认5173)

set -u -o pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT_DIR/server"
CLIENT_DIR="$ROOT_DIR/client"
RUN_DIR="$ROOT_DIR/.dev"
SERVER_PIDFILE="$RUN_DIR/server.pid"
CLIENT_PIDFILE="$RUN_DIR/client.pid"
SERVER_LOG="$RUN_DIR/server.log"
CLIENT_LOG="$RUN_DIR/client.log"

SERVER_PORT="${PORT:-3001}"
CLIENT_PORT="${CLIENT_PORT:-5173}"
READY_TIMEOUT=60   # 单个服务就绪等待上限（秒）

# ---------- 输出 ----------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_CYAN=$'\033[36m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_CYAN=""
fi

step()  { printf '\n%s==> %s%s\n' "$C_BOLD$C_BLUE" "$1" "$C_RESET"; }
info()  { printf '  %s\n' "$1"; }
ok()    { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
warn()  { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
fail()  { printf '  %s✗ %s%s\n' "$C_RED" "$1" "$C_RESET"; }

die() {
  # die <阶段名> <原因> [额外提示...]
  local stage="$1"; shift
  local reason="$1"; shift
  printf '\n%s启动失败 · 环节：%s%s\n' "$C_BOLD$C_RED" "$stage" "$C_RESET"
  printf '  原因：%s\n' "$reason"
  local tip
  for tip in "$@"; do printf '  %s\n' "$tip"; done
  exit 1
}

# ---------- 通用工具 ----------
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "环境检查" "找不到必需命令: $1" "请先安装后重跑 ./scripts/dev.sh up"
}

# 通过 HTTP 探测端口是否已有服务在监听（0=通, 非0=不通）
http_probe() {
  curl -s -o /dev/null -m 2 "$1"
}

# 判断 pidfile 中的进程是否仍存活
pid_alive() {
  local pidfile="$1"
  [[ -f "$pidfile" ]] || return 1
  local pid
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  [[ -n "${pid:-}" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

# 停掉整个进程组（setsid 启动时 pid === pgid），回退到 kill 单进程
kill_pid_group() {
  local pidfile="$1"
  pid_alive "$pidfile" || { rm -f "$pidfile"; return 0; }
  local pid
  pid="$(cat "$pidfile")"
  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || { rm -f "$pidfile"; return 0; }
    sleep 0.25
  done
  warn "进程 $pid 未在 5s 内退出，发送 SIGKILL"
  kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  rm -f "$pidfile"
}

# 查找本机上本项目遗留的、但不归当前 pidfile 管理的 dev 进程
# 依据：cwd 恰为 server/ 或 client/，且命令行明确是本项目的开发栈
# （只匹配 nodemon / vite / src/index.js，避免误杀在这些目录下开着的普通 shell）
find_stray_dev_pids() {
  local p pid cwd cmdline
  for p in /proc/[0-9]*; do
    pid="${p#/proc/}"
    [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
    cwd="$(readlink "$p/cwd" 2>/dev/null || true)" || continue
    case "$cwd" in
      "$SERVER_DIR"|"$CLIENT_DIR") ;;
      *) continue ;;
    esac
    cmdline="$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null || true)"
    case "$cmdline" in
      *nodemon*|*src/index.js*|*vite*) printf '%s\n' "$pid" ;;
    esac
  done
}

# ---------- 停止 ----------
do_stop() {
  step "停止本地开发服务"
  local stopped=0
  if pid_alive "$CLIENT_PIDFILE"; then
    kill_pid_group "$CLIENT_PIDFILE"
    ok "前端已停止 (vite :$CLIENT_PORT)"
    stopped=1
  else
    rm -f "$CLIENT_PIDFILE"
    info "前端未在运行"
  fi
  if pid_alive "$SERVER_PIDFILE"; then
    kill_pid_group "$SERVER_PIDFILE"
    ok "服务端已停止 (:$SERVER_PORT)"
    stopped=1
  else
    rm -f "$SERVER_PIDFILE"
    info "服务端未在运行"
  fi
  [[ "$stopped" == 0 ]] && info "没有需要停止的进程"
}

# ---------- 状态 ----------
show_status() {
  local name pidfile port
  for item in "服务端:$SERVER_PIDFILE:$SERVER_PORT" "前端:$CLIENT_PIDFILE:$CLIENT_PORT"; do
    name="${item%%:*}"; rest="${item#*:}"; pidfile="${rest%%:*}"; port="${rest##*:}"
    if pid_alive "$pidfile"; then
      printf '  %s%s%s  pid=%s  http://localhost:%s\n' "$C_GREEN" "$name" "$C_RESET" "$(cat "$pidfile")" "$port"
    else
      printf '  %s%s%s  未运行\n' "$C_DIM" "$name" "$C_RESET"
    fi
  done
}

# ---------- 依赖 ----------
# 校验依赖是否真实可用；返回 0=可用, 1=缺失/损坏（需要安装）
deps_ok() {
  local app="$1"
  [[ -d "$ROOT_DIR/$app/node_modules" ]] || return 1
  case "$app" in
    server)
      (cd "$SERVER_DIR" && node -e "require('express');require('socket.io');require('dotenv');require('uuid');require('cors')" ) >/dev/null 2>&1
      ;;
    client)
      # 关键：node_modules 可能是在其它平台安装的（npm optionalDependencies bug），
      # 必须真正加载 rollup 原生模块才能暴露平台二进制缺失
      (cd "$CLIENT_DIR" && node -e "require(require.resolve('rollup',{paths:[process.cwd()]}))" ) >/dev/null 2>&1 \
        && [[ -x "$CLIENT_DIR/node_modules/.bin/vite" ]]
      ;;
  esac
}

ensure_deps() {
  local app="$1" dir="$2"
  if deps_ok "$app"; then
    ok "$app 依赖已就绪，跳过安装（不重复安装）"
    return 0
  fi
  if [[ -d "$dir/node_modules" ]]; then
    warn "$app 依赖存在但不完整（常见于换平台后缺少原生可选依赖）"
    info "删除损坏的 $app/node_modules 后按 lockfile 重装（package-lock.json 与模板数据不动）..."
    rm -rf "$dir/node_modules"
  else
    info "$app/node_modules 不存在，开始安装依赖..."
  fi
  info "执行: npm ci --no-audit --no-fund  (目录: $dir)"
  local log="$RUN_DIR/${app}-npm-install.log"
  if ! (cd "$dir" && npm ci --no-audit --no-fund) >"$log" 2>&1; then
    rm -rf "$dir/node_modules"
    tail -n 30 "$log" | sed 's/^/      /'
    die "依赖准备 ($app)" "npm ci 失败，完整日志: $log" "修复网络 / registry / lockfile 问题后直接重跑 ./scripts/dev.sh up"
  fi
  if ! deps_ok "$app"; then
    rm -rf "$dir/node_modules"
    die "依赖准备 ($app)" "安装完成后依赖仍无法加载（可能是平台不匹配或 lockfile 损坏）" "可查看 $log；必要时删除 $app/package-lock.json 后用 npm install 重新生成"
  fi
  ok "$app 依赖安装并校验通过"
}

# ---------- 启动与就绪等待 ----------
start_service() {
  # start_service <server|client> <pidfile> <log> <就绪URL> <就绪标志grep>
  local app="$1" pidfile="$2" log="$3" url="$4" ready_grep="$5"
  : > "$log"

  local dir
  if [[ "$app" == server ]]; then
    dir="$SERVER_DIR"
  else
    dir="$CLIENT_DIR"
  fi

  info "启动 $app ..."
  # 短时开启作业控制(set -m)：后台命令会自成新进程组，
  # 记录的 pid 即进程组 id，stop 时可整组（npm -> nodemon -> node）一起回收；
  # macOS / Linux 均适用，不依赖 setsid。
  local svc_pid
  if [[ "$app" == server ]]; then
    set -m
    ( cd "$dir" && PORT="$SERVER_PORT" npm run dev ) >"$log" 2>&1 &
    svc_pid=$!
    set +m
  else
    set -m
    ( cd "$dir" && npm run dev -- --port "$CLIENT_PORT" --strictPort ) >"$log" 2>&1 &
    svc_pid=$!
    set +m
  fi
  echo "$svc_pid" > "$pidfile"

  local start_ts=$SECONDS
  while true; do
    if ! kill -0 "$svc_pid" 2>/dev/null; then
      tail -n 30 "$log" | sed 's/^/      /'
      rm -f "$pidfile"
      die "服务启动 ($app)" "进程已退出（多半是依赖缺失或端口被占），见上方日志 / $log"
    fi
    if grep -q "$ready_grep" "$log" 2>/dev/null && http_probe "$url"; then
      ok "$app 就绪 (耗时 $((SECONDS - start_ts))s)"
      return 0
    fi
    if (( SECONDS - start_ts >= READY_TIMEOUT )); then
      tail -n 30 "$log" | sed 's/^/      /'
      die "就绪检查 ($app)" "等待 ${READY_TIMEOUT}s 后仍无法访问 $url" \
        "可能原因：端口被其它程序占用 / 启动慢 / 依赖未装全" \
        "可用 lsof -i :${url##*:} 排查占用，修复后重跑 ./scripts/dev.sh up（会先自动清理旧进程）"
    fi
    sleep 1
  done
}

# ---------- 主流程 ----------
do_up() {
  require_cmd node
  require_cmd npm
  require_cmd curl

  mkdir -p "$RUN_DIR"

  step "0/5 清理旧进程，避免端口与重复连接"
  local stray
  stray="$(find_stray_dev_pids || true)"
  if [[ -n "$stray" ]]; then
    warn "发现本项目遗留的 dev 进程: $(echo "$stray" | tr '\n' ' ')"
    # shellcheck disable=SC2086
    kill -TERM $stray 2>/dev/null || true
    sleep 1
    # shellcheck disable=SC2086
    kill -KILL $stray 2>/dev/null || true
    ok "遗留进程已清理"
  fi
  # 本脚本管理的旧实例（含整个进程组）
  pid_alive "$CLIENT_PIDFILE" && { kill_pid_group "$CLIENT_PIDFILE"; ok "旧的前端进程组已停止"; }
  pid_alive "$SERVER_PIDFILE" && { kill_pid_group "$SERVER_PIDFILE"; ok "旧的服务端进程组已停止"; }
  rm -f "$SERVER_PIDFILE" "$CLIENT_PIDFILE"
  [[ -z "$stray" ]] && info "未发现遗留进程"

  # 端口占用预检（无 lsof 环境下用 HTTP 探测）
  if http_probe "http://localhost:$SERVER_PORT/api/health"; then
    die "环境检查" "端口 $SERVER_PORT 上已有服务响应，但不是本脚本管理的进程" \
      "请确认该服务来源并停止它（例如手工启动的 server），然后重跑 ./scripts/dev.sh up"
  fi
  if http_probe "http://localhost:$CLIENT_PORT/"; then
    die "环境检查" "端口 $CLIENT_PORT 上已有服务响应，但不是本脚本管理的进程" \
      "请停止占用该端口的程序后重跑 ./scripts/dev.sh up"
  fi
  ok "端口 $SERVER_PORT / $CLIENT_PORT 空闲"

  step "1/5 依赖准备（已就绪则跳过，绝不重复安装）"
  ensure_deps server "$SERVER_DIR"
  ensure_deps client "$CLIENT_DIR"

  step "2/5 启动服务端（会议纪要与业务流程服务, :$SERVER_PORT）"
  start_service server "$SERVER_PIDFILE" "$SERVER_LOG" "http://localhost:$SERVER_PORT/api/health" "Server running on port"

  step "3/5 启动画板前端（vite, :$CLIENT_PORT）"
  start_service client "$CLIENT_PIDFILE" "$CLIENT_LOG" "http://localhost:$CLIENT_PORT/" "Local:.*http"

  step "4/5 端到端检查"
  if ! bash "$ROOT_DIR/scripts/check.sh" "$SERVER_PORT" "$CLIENT_PORT"; then
    die "端到端检查" "页面 / API 代理 / WebSocket 中至少一项未通过" \
      "服务端日志: $SERVER_LOG" "前端日志: $CLIENT_LOG" \
      "修复后可先 ./scripts/dev.sh check 复测，再不行 ./scripts/dev.sh restart 整体重启"
  fi

  step "5/5 访问入口"
  printf '  %s看板工作台%s   %s\n' "$C_BOLD" "$C_RESET" "$C_CYAN http://localhost:$CLIENT_PORT/ $C_RESET"
  info "前端经 Vite 代理访问服务端：/api/* 与 /socket.io/* -> http://localhost:$SERVER_PORT"
  info "服务端健康检查:                 http://localhost:$SERVER_PORT/api/health"
  info "模板中心数据:                   http://localhost:$SERVER_PORT/api/templates"
  echo
  info "日志:  ./scripts/dev.sh logs server | client   (-f 实时跟踪)"
  info "状态:  ./scripts/dev.sh status      停止: ./scripts/dev.sh stop"
  printf '  %s模板数据（server/src/templates）与手工 cd server/client + npm run dev 的启动方式保持不变%s\n' "$C_DIM" "$C_RESET"
}

case "${1:-up}" in
  up)
    do_up
    ;;
  stop)
    do_stop
    ;;
  status)
    step "本地开发服务状态"; show_status
    ;;
  check)
    exec bash "$ROOT_DIR/scripts/check.sh" "$SERVER_PORT" "$CLIENT_PORT"
    ;;
  restart)
    do_stop
    do_up
    ;;
  logs)
    target="${2:-}"
    follow="${3:-}"
    case "$target" in
      server) logfile="$SERVER_LOG" ;;
      client) logfile="$CLIENT_LOG" ;;
      ""|-f)  logfile="$RUN_DIR" ;;
      *) die "参数" "未知目标: $target（可选 server / client）" ;;
    esac
    if [[ -d "$logfile" ]]; then
      if [[ "$target" == "-f" || "$follow" == "-f" ]]; then
        exec tail -n 20 -f "$RUN_DIR"/server.log "$RUN_DIR"/client.log
      fi
      for f in "$RUN_DIR"/server.log "$RUN_DIR"/client.log; do
        printf '\n%s--- %s ---%s\n' "$C_BOLD" "$f" "$C_RESET"
        [[ -f "$f" ]] && tail -n 30 "$f" || info "日志不存在"
      done
      exit 0
    fi
    [[ -f "$logfile" ]] || die "日志" "$logfile 不存在（服务还没启动过？）"
    if [[ "$target" == "-f" || "$follow" == "-f" ]]; then
      exec tail -n 50 -f "$logfile"
    fi
    exec tail -n 50 "$logfile"
    ;;
  *)
    die "参数" "未知子命令: $1" "可用: up | stop | restart | status | check | logs [server|client] [-f]"
    ;;
esac
