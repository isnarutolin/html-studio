#!/bin/bash
# 公网隧道：把本机某个端口暴露到 bore.pub
# 优先复用上次的端口 → 链接尽量保持不变；固定端口都被占用才退化成随机端口
#
# 默认给 8899（批注服务）。换端口用环境变量，例如 7788 网页版：
#   LOCAL_PORT=7788 BORE_PORTS="44596 44597 44598" \
#   BORE_PORTFILE=~/logs/studio-port.txt BORE_LOG=~/logs/studio-bore.log ./bore-tunnel.sh
LOCAL_PORT="${LOCAL_PORT:-8899}"
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="${BORE_LOG:-$HERE/logs/bore.log}"
PORTFILE="${BORE_PORTFILE:-$HERE/logs/bore-port.txt}"
mkdir -p "$(dirname "$LOG")" "$(dirname "$PORTFILE")"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }
strip() { sed $'s/\033\\[[0-9;]*m//g'; }

# 免费 bore.pub 会悄悄弄丢空闲连接：进程还活着、日志不再打、但公网已不可达。
# launchd 的 KeepAlive 只在进程退出时才拉起，所以必须自己体检。
WD_SECS="${BORE_WD_SECS:-90}"      # 体检间隔
WD_FAILS="${BORE_WD_FAILS:-2}"     # 连续失败几次才判定僵死
BORE_HEALTH="${BORE_HEALTH:-/api/health}"   # 体检用的路径（7788 用 /__anno/api/health）

watchdog() {
  local pid="$1" port="$2" fails=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep "$WD_SECS"
    if curl -s -m 8 -o /dev/null "http://bore.pub:$port${BORE_HEALTH:-/api/health}"; then
      fails=0
    else
      fails=$((fails + 1))
      log "公网体检失败 ${fails}/${WD_FAILS}（port=${port}）"
      if [ "$fails" -ge "$WD_FAILS" ]; then
        log "隧道疑似僵死，杀掉 bore 让 launchd 重拉（会重新抢 ${port}）"
        kill "$pid" 2>/dev/null
        wait "$pid" 2>/dev/null
        return 0
      fi
    fi
  done
}

PREF=$(tr -d '[:space:]' < "$PORTFILE" 2>/dev/null)
CANDIDATES=()
[ -n "$PREF" ] && CANDIDATES+=("$PREF")
for p in ${BORE_PORTS:-44589 44590 44591 44592 44593}; do CANDIDATES+=("$p"); done

try_port() {
  local port="$1" tmp pid actual i
  tmp=$(mktemp)
  bore local "$LOCAL_PORT" --to bore.pub --port "$port" >"$tmp" 2>&1 &
  pid=$!
  for i in $(seq 1 12); do
    if grep -q "listening at bore.pub" "$tmp" 2>/dev/null; then
      cat "$tmp" >> "$LOG"
      actual=$(strip < "$tmp" | sed -n 's/.*listening at bore.pub:\([0-9]*\).*/\1/p' | head -1)
      echo "${actual:-$port}" > "$PORTFILE"
      log "公网链接 http://bore.pub:${actual:-$port}/  →  本机 :$LOCAL_PORT"
      watchdog "$pid" "${actual:-$port}"
      rm -f "$tmp"
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  cat "$tmp" >> "$LOG"; rm -f "$tmp"
  return 1
}

for p in "${CANDIDATES[@]}"; do
  log "尝试端口 $p"
  try_port "$p" && exit 0
  log "端口 $p 不可用，换下一个"
done

log "固定端口都不可用，退化为随机端口"
bore local "$LOCAL_PORT" --to bore.pub 2>&1 | while IFS= read -r line; do
  echo "$line" >> "$LOG"
  clean=$(printf '%s' "$line" | strip)
  case "$clean" in
    *"listening at bore.pub:"*)
      port=$(echo "$clean" | sed -n 's/.*listening at bore.pub:\([0-9]*\).*/\1/p')
      [ -n "$port" ] && { echo "$port" > "$PORTFILE"; log "公网链接 http://bore.pub:$port/  →  本机 :$LOCAL_PORT"; } ;;
  esac
done
