#!/usr/bin/env bash
# 端到端就绪检查（可独立运行: ./scripts/check.sh [服务端端口] [前端端口]）
# 检查链路:
#   1. 服务端直连健康检查          http://localhost:<server>/api/health
#   2. 前端页面可达                http://localhost:<client>/
#   3. API 经 Vite 代理可达        /api/health
#   4. 模板数据经代理可读取        /api/templates （内置会议纪要/流程梳理模板）
#   5. WebSocket 经代理可握手      socket.io-client -> http://localhost:<client>
#
# 全部通过退出码 0；任一失败退出码 1，并打印具体失败环节与原因。

set -u -o pipefail

SERVER_PORT="${1:-3001}"
CLIENT_PORT="${2:-5173}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
else
  C_RESET=""; C_RED=""; C_GREEN=""
fi

FAILED=0
pass() { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
fail() { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$1"; FAILED=1; }
section() { printf '\n%s%s%s\n' '' "$1" ''; }

# http_get <url> -> 输出 "http_code body文件"；统一 5s 超时
tmp_body="$(mktemp)"
trap 'rm -f "$tmp_body"' EXIT

http_get() {
  local url="$1"
  local code
  code="$(curl -s -m 5 -o "$tmp_body" -w '%{http_code}' "$url" 2>/dev/null || echo 000)"
  echo "$code"
}

section "1) 服务端直连 (http://localhost:$SERVER_PORT)"
code="$(http_get "http://localhost:$SERVER_PORT/api/health")"
if [[ "$code" == "200" ]] && grep -q '"status":"ok"' "$tmp_body"; then
  pass "服务端 /api/health 返回 ok（本地文件存储，不依赖外部数据库）"
else
  fail "服务端健康检查失败 (HTTP $code)"
  [[ "$code" == "000" ]] && printf '      原因：连不上端口，服务端未启动或已崩溃\n'
fi

section "2) 前端页面 (http://localhost:$CLIENT_PORT)"
code="$(http_get "http://localhost:$CLIENT_PORT/")"
if [[ "$code" == "200" ]] && grep -q 'id="root"' "$tmp_body"; then
  pass "Vite 页面返回 HTML 且包含 #root 挂载点"
else
  fail "前端页面不可达 (HTTP $code)"
  [[ "$code" == "000" ]] && printf '      原因：连不上端口，Vite 未启动或依赖损坏导致进程退出\n'
fi

section "3) API 代理 (前端 :$CLIENT_PORT -> 服务端 :$SERVER_PORT)"
code="$(http_get "http://localhost:$CLIENT_PORT/api/health")"
if [[ "$code" == "200" ]] && grep -q '"status":"ok"' "$tmp_body"; then
  pass "/api 经 Vite 代理转发正常"
else
  fail "经前端代理访问 /api/health 失败 (HTTP $code)"
  printf '      原因：服务端未就绪，或 vite.config.ts 的 /api 代理配置有误\n'
fi

section "4) 模板数据"
code="$(http_get "http://localhost:$CLIENT_PORT/api/templates")"
if [[ "$code" == "200" ]] && grep -q '会议纪要' "$tmp_body" && grep -q '流程梳理' "$tmp_body"; then
  count="$(grep -o '"_id"' "$tmp_body" | wc -l | tr -d ' ')"
  pass "模板接口返回 $count 个内置模板（含会议纪要、流程梳理），手工/模板创建入口可用"
else
  fail "模板数据读取失败 (HTTP $code)"
  printf '      原因：服务端 templates 模块异常，或代理未生效\n'
fi

section "5) WebSocket 实时协作通道 (/socket.io 经代理升级)"
ws_out="$(
  cd "$ROOT_DIR/client" && node -e '
    const { io } = require("socket.io-client");
    const url = process.argv[1];
    const s = io(url, { transports: ["websocket"], timeout: 4000, reconnection: false });
    const done = (ok, msg) => { console.log((ok ? "OK " : "ERR ") + msg); s.close(); process.exit(ok ? 0 : 1); };
    s.on("connect", () => done(true, s.id));
    s.on("connect_error", (e) => done(false, e.message));
    setTimeout(() => done(false, "握手超时(4s)"), 5000);
  ' "http://localhost:$CLIENT_PORT" 2>&1
)" || true
if [[ "$ws_out" == OK* ]]; then
  pass "WebSocket 经 Vite 代理握手成功 (socket id: ${ws_out#OK })"
else
  reason="${ws_out#ERR }"
  [[ -z "$reason" ]] && reason="未知错误（socket.io-client 不可用或前端未运行）"
  fail "WebSocket 握手失败：$reason"
  printf '      原因：/socket.io 未配置 ws 代理、服务端未运行，或被其它程序占用端口\n'
fi

echo
if [[ "$FAILED" == 0 ]]; then
  printf '%s全部检查通过，打开 http://localhost:%s/ 即可使用%s\n' "$C_GREEN" "$CLIENT_PORT" "$C_RESET"
  exit 0
fi
printf '%s存在未通过的检查项，请按上面的环节与原因排查%s\n' "$C_RED" "$C_RESET"
exit 1
