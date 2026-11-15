#!/bin/bash
# 一键查看：分享链接 + 服务健康 + 当前状态能否撑住
PORT=${PORT:-8899}
DOC=${1:-}
KIT="${ANNOTATOR_KIT:-$(cd "$(dirname "$0")" && pwd)}"
LABEL_PREFIX="${LABEL_PREFIX:-com.naruto}"

readport() { [ -f "$1" ] && tr -d '[:space:]' < "$1" 2>/dev/null || true; }

echo "════ 分享链接 ════"
BOREPORT=$(readport "$KIT/logs/bore-port.txt")
if [ -n "$BOREPORT" ] && curl -s -m 6 -o /dev/null "http://bore.pub:$BOREPORT/api/health"; then
  echo "  公网（任何网络都能开，发这个）："
  echo "    http://bore.pub:$BOREPORT/$DOC"
else
  echo "  公网：✗ 不通（launchctl list | grep "$LABEL_PREFIX.html-annotator-bore"）"
fi

echo
echo "  局域网（同事在公司网时更快）："
found=0
for i in $(ifconfig -l); do
  ip=$(ipconfig getifaddr "$i" 2>/dev/null)
  [ -z "$ip" ] && continue
  case "$ip" in 127.*) continue ;; esac
  found=1
  echo -n "    http://$ip:$PORT/$DOC"
  case "$ip" in
    10.18.*|10.19.*) echo "   ← 公司网段，可直连" ;;
    192.168.*|10.*|172.1[6-9].*|172.2*.*|172.3[01].*) echo "   ← 私有网络，同事打不开" ;;
    *) echo ;;
  esac
done
[ "$found" -eq 0 ] && echo "    （没有可用网卡地址）"

echo
echo "════ 在线能否维持 ════"
if pmset -g assertions 2>/dev/null | grep -q caffeinate; then
  echo "  防休眠：⚠️ 有 caffeinate 在跑（临时保持在线中）"
else
  echo "  防休眠：✗ 已关闭（空闲到点会睡 → 链接会断）"
fi
if pmset -g assertions 2>/dev/null | grep -q "^ *PreventUserIdleDisplaySleep *1"; then
  echo "  屏幕：✓ 常亮（不会自动黑屏）"
else
  echo "  屏幕：✗ 会按设置自动黑屏（不影响服务）"
fi
BATT=$(pmset -g batt 2>/dev/null | head -1)
case "$BATT" in
  *"AC Power"*) echo "  电源：✓ 已插电，可长时间在线" ;;
  *"Battery Power"*) echo "  电源：⚠️ 正在用电池 —— 拔电/电量耗尽会休眠，链接会断" ;;
  *) echo "  电源：$BATT" ;;
esac
if pmset -g | grep -qi "SleepDisabled.*1"; then
  echo "  合盖：⚠️ 合盖即休眠已被禁用（SleepDisabled=1），机器会一直运行。恢复请执行："
  echo "          sudo pmset -a disablesleep 0"
else
  echo "  合盖：✓ 合盖即休眠 → 链接会断（开盖后自动恢复，端口通常不变、链接不用重发）"
  echo "          需要临时合盖不断时：caffeinate -d -m -s &（用完 kill 掉）"
fi
echo
echo "════ 一站式入口（改 + 批注，同事零安装）════"
STUDIOPORT=$(readport "$KIT/logs/studio-bore-port.txt")
if [ -n "$STUDIOPORT" ] && curl -s -m 6 -o /dev/null "http://bore.pub:$STUDIOPORT/__anno/api/health"; then
  echo "  公网：  http://bore.pub:$STUDIOPORT/     ← 打开后能改也能批注"
else
  echo "  公网：  ✗ 隧道未通（launchctl list | grep "$LABEL_PREFIX.html-studio-bore"）"
fi
echo "  局域网：http://<你的IP>:7788/           （需 server.py --host 0.0.0.0）"
echo "  其余：关机/断网/休眠期间链接不可用"

echo
echo "════ 服务与数据 ════"
for lbl in html-annotator html-annotator-bore html-annotator-backup html-studio html-studio-bore; do
  pid=$(launchctl list 2>/dev/null | awk -v l="$LABEL_PREFIX.$lbl" '$3==l {print $1}')
  if [ "$pid" = "-" ]; then state="待触发（定时任务）"; elif [ -n "$pid" ]; then state="运行中 (pid $pid)"; else state="未加载"; fi
  printf "  %-26s %s\n" "$lbl" "$state"
done
if [ -n "$DOC" ]; then
  CNT=$(curl -s -m 5 "http://127.0.0.1:$PORT/api/state?doc=$DOC" \
    | python3 -c "import json,sys; print(len(json.load(sys.stdin)['annotations']))" 2>/dev/null)
  BK=${ANNO_BACKUP_DIR:-$HOME/Documents/批注备份}
  echo "  批注数：${CNT:-?} 条   备份快照：$(ls "$BK/$DOC" 2>/dev/null | wc -l | tr -d ' ') 份"
else
  echo "  （要看某份稿子的批注数，传 docId：./share-link.sh <docId>）"
fi
