#!/bin/bash
# anno-url.sh — 给一个 HTML 链接，直接出「可批注版」的所有地址
#
# 用法：
#   anno-url.sh https://file.c-ctrip.com/files/6/xxx/abc.html
#   anno-url.sh https://x.com/a.html --open      # 顺手在本机浏览器打开
#
# 它不做任何处理，只是把 review-server 的 /p/<url> 入口拼好并体检一遍。
set -uo pipefail

KIT="${ANNOTATOR_KIT:-$(cd "$(dirname "$0")" && pwd)}"
PORT="${PORT:-8899}"

SRC=""; OPEN=0
for a in "$@"; do
  case "$a" in
    --open|-o) OPEN=1 ;;
    -*) echo "未知参数: $a"; exit 1 ;;
    *) [ -z "$SRC" ] && SRC="$a" ;;
  esac
done

if [ -z "$SRC" ]; then
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

ENC=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$SRC")
BASE_LOCAL="http://127.0.0.1:$PORT/p/$ENC"

echo "════ 可批注版地址 ════"
echo "  源：$SRC"
echo

# 体检：真的抓一遍，确认能转（顺便拿到 docId 与改写情况）
HDR=$(curl -s -m 60 -D - -o /dev/null "$BASE_LOCAL" 2>/dev/null)
CODE=$(printf '%s' "$HDR" | awk 'NR==1{print $2}')
DOCID=$(printf '%s' "$HDR" | grep -i '^X-Anno-DocId:' | tr -d '\r' | awk '{print $2}')
CSPN=$(printf '%s' "$HDR" | grep -i '^X-Anno-Csp-Relaxed:' | tr -d '\r' | awk '{print $2}')

if [ "$CODE" = "200" ] && [ -n "$DOCID" ]; then
  echo "  ✓ 转换可用（docId=${DOCID}，改写 CSP ${CSPN:-0} 处）"
else
  echo "  ✗ 转换失败（服务没起？目标抓不到？内网链接需 PROXY_ALLOW_PRIVATE=1）"
  echo "    launchctl list | grep html-annotator     # 看服务状态"
  echo "    tail -30 $KIT/logs/out.log              # 看报错"
  exit 1
fi
echo

echo "  本机：     $BASE_LOCAL"
for i in $(ifconfig -l 2>/dev/null); do
  ip=$(ipconfig getifaddr "$i" 2>/dev/null); [ -z "$ip" ] && continue
  case "$ip" in 127.*|169.254.*) continue ;; esac
  tag=""
  case "$ip" in 10.18.*|10.19.*) tag="  ← 公司网段，同事可直连" ;; 192.168.*|10.*) tag="  ← 私有网络" ;; esac
  echo "  局域网：   http://$ip:$PORT/p/$ENC$tag"
done
BOREPORT=$(tr -d '[:space:]' < "$KIT/logs/bore-port.txt" 2>/dev/null)
if [ -n "$BOREPORT" ] && curl -s -m 6 -o /dev/null "http://bore.pub:$BOREPORT/api/health"; then
  echo "  公网：     http://bore.pub:$BOREPORT/p/$ENC"
else
  echo "  公网：     ✗ 隧道未通（launchctl list | grep html-annotator-bore）"
fi
echo
echo "  单文件：   $BASE_LOCAL?download=1"
echo "             ↑ 下载后引擎已内联，离线也能批注；要改内容就用扩展（⇧⌘E）"
echo
echo "  直接改：   原链接本身就能改 —— 浏览器装 html-studio 扩展，打开后 ⌘⇧E 进入编辑，⌘S 存到 ~/Downloads"
echo "             批注是加一层，编辑是改正文，两者互斥"

[ "$OPEN" -eq 1 ] && open "$BASE_LOCAL"
exit 0
