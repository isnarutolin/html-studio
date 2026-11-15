#!/usr/bin/env bash
# install.sh — 把仓库里的「常驻服务层」部署成开机自启的一组服务（macOS launchd）
#
# 部署什么：
#   8899  review-server.mjs   批注服务 + /p/<url> 链接转换网关 + 实时同步
#   7788  server.py           网页版一站式（能改 + 能批注）
#   隧道  bore-tunnel.sh      给上面两个各挂一条公网隧道（带看门狗）
#
# 用法：
#   ./install.sh                      # 部署脚本到 ~/html-annotator-kit（不碰 launchd）
#   ./install.sh --plists --load      # 再生成 plist 并加载/重启服务
#   ./install.sh --check              # 只对比仓库与已部署目录，有漂移就退出码 1
#   ./install.sh --uninstall          # 卸载 plist（不删数据）
#
# 常用选项：
#   --to DIR        部署目录，默认 $HOME/html-annotator-kit
#   --root DIR      8899 服务对外暴露的 HTML 目录，默认 $HOME/Desktop/reports
#   --home DIR      7788 网页版的工作目录（能看到/改到哪些 HTML），默认 $HOME
#   --label-prefix  服务名前缀，默认 com.naruto
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
TO="$HOME/html-annotator-kit"
ROOT_DIR="$HOME/Desktop/reports"
APP_HOME="$HOME"
PREFIX="com.naruto"
DO_PLISTS=0; DO_LOAD=0; DO_CHECK=0; DO_UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --to) TO="$2"; shift 2 ;;
    --root) ROOT_DIR="$2"; shift 2 ;;
    --home) APP_HOME="$2"; shift 2 ;;
    --label-prefix) PREFIX="$2"; shift 2 ;;
    --plists) DO_PLISTS=1; shift ;;
    --load) DO_LOAD=1; DO_PLISTS=1; shift ;;
    --check) DO_CHECK=1; shift ;;
    --uninstall) DO_UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
info() { printf '  %s\n' "$1"; }

FILES="review-server.mjs anno-url.sh bore-tunnel.sh share-link.sh"
ENGINE="$REPO/skills/html-annotate/lib/annotator.js"

# ---------- 卸载 ----------
if [ "$DO_UNINSTALL" -eq 1 ]; then
  for n in review-server bore web-app web-app-bore; do
    label="$PREFIX.html-$n"
    [ "$n" = "review-server" ] && label="$PREFIX.html-annotator"
    [ "$n" = "bore" ] && label="$PREFIX.html-annotator-bore"
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null && ok "已停止 $label"
    rm -f "$HOME/Library/LaunchAgents/$label.plist" && ok "已删除 $label.plist"
  done
  echo "数据没动（$TO/data 与 $TO/logs 保留）"
  exit 0
fi

# ---------- 检查漂移 ----------
if [ "$DO_CHECK" -eq 1 ]; then
  echo "▸ 仓库 $HERE  →  部署目录 $TO"
  drift=0
  for f in $FILES; do
    if [ ! -f "$TO/$f" ]; then bad "$f 未部署"; drift=1
    elif cmp -s "$HERE/$f" "$TO/$f"; then ok "$f 一致"
    else bad "$f 已分叉（仓库版本更新）"; drift=1; fi
  done
  if [ ! -f "$TO/annotator.js" ]; then bad "annotator.js 未部署"; drift=1
  elif cmp -s "$ENGINE" "$TO/annotator.js"; then ok "annotator.js 与引擎真源一致"
  else bad "annotator.js 与引擎真源不一致"; drift=1; fi
  [ "$drift" -eq 0 ] && { echo; echo "部署目录与仓库一致"; exit 0; }
  echo; echo "修复：$0 --to \"$TO\"   （或加 --plists --load 一并重启服务）"
  exit 1
fi

# ---------- 部署脚本 ----------
echo "▸ 部署到 $TO"
mkdir -p "$TO/logs"
for f in $FILES; do
  cp "$HERE/$f" "$TO/$f" && chmod +x "$TO/$f" && ok "$f"
done
if [ -f "$ENGINE" ]; then
  cp "$ENGINE" "$TO/annotator.js" && ok "annotator.js（引擎真源副本）"
else
  bad "找不到引擎 $ENGINE"
fi

NODE="$(command -v node || true)"
PYTHON="$(command -v python3 || true)"
info "node:   ${NODE:-未找到}"
info "python: ${PYTHON:-未找到}"

# ---------- 生成并加载 plist ----------
if [ "$DO_PLISTS" -eq 1 ]; then
  [ -z "$NODE" ] && { bad "没有 node，8899 服务无法启动"; exit 1; }
  [ -z "$PYTHON" ] && { bad "没有 python3，7788 服务无法启动"; exit 1; }
  mkdir -p "$HOME/Library/LaunchAgents"

  render() {   # render <模板> <输出> <替换...>
    local tpl="$1" out="$2"; shift 2
    local s; s="$(cat "$tpl")"
    while [ $# -gt 1 ]; do s="${s//$1/$2}"; shift 2; done
    printf '%s\n' "$s" > "$out"
  }

  L="$HOME/Library/LaunchAgents"
  render "$HERE/launchd/review-server.plist.tmpl" "$L/$PREFIX.html-annotator.plist" \
    __LABEL__ "$PREFIX.html-annotator" __NODE__ "$NODE" __DIR__ "$TO" __ROOT__ "$ROOT_DIR"
  ok "$PREFIX.html-annotator.plist（8899，目录 ${ROOT_DIR}）"

  render "$HERE/launchd/bore.plist.tmpl" "$L/$PREFIX.html-annotator-bore.plist" \
    __LABEL__ "$PREFIX.html-annotator-bore" __DIR__ "$TO" __LOCAL_PORT__ "8899" \
    __PORTS__ "44589 44590 44591 44592 44593" \
    __PORTFILE__ "$TO/logs/bore-port.txt" __LOG__ "$TO/logs/bore.log" __HEALTH__ "/api/health"
  ok "$PREFIX.html-annotator-bore.plist（8899 的公网隧道）"

  render "$HERE/launchd/web-app.plist.tmpl" "$L/$PREFIX.html-studio.plist" \
    __LABEL__ "$PREFIX.html-studio" __PYTHON__ "$PYTHON" __HTMLSTUDIO__ "$REPO" \
    __HOME__ "$APP_HOME" __ANNO_DATA__ "$TO/data"
  ok "$PREFIX.html-studio.plist（7788 一站式，目录 ${APP_HOME}）"

  render "$HERE/launchd/bore.plist.tmpl" "$L/$PREFIX.html-studio-bore.plist" \
    __LABEL__ "$PREFIX.html-studio-bore" __DIR__ "$TO" __LOCAL_PORT__ "7788" \
    __PORTS__ "44596 44597 44598 44599" \
    __PORTFILE__ "$TO/logs/studio-bore-port.txt" __LOG__ "$TO/logs/studio-bore.log" \
    __HEALTH__ "/__anno/api/health"
  ok "$PREFIX.html-studio-bore.plist（7788 的公网隧道）"

  for p in "$L/$PREFIX.html-annotator.plist" "$L/$PREFIX.html-annotator-bore.plist" \
           "$L/$PREFIX.html-studio.plist" "$L/$PREFIX.html-studio-bore.plist"; do
    plutil -lint "$p" >/dev/null || { bad "plist 格式错误: $p"; exit 1; }
  done
  ok "plist 格式校验通过"

  for label in "$PREFIX.html-annotator" "$PREFIX.html-annotator-bore" \
               "$PREFIX.html-studio" "$PREFIX.html-studio-bore"; do
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null
    launchctl bootstrap "gui/$(id -u)" "$L/$label.plist" 2>/dev/null \
      && ok "已加载 $label" || bad "加载失败 $label"
  done
fi

if [ "$DO_LOAD" -eq 1 ]; then
  for label in "$PREFIX.html-annotator" "$PREFIX.html-annotator-bore" \
               "$PREFIX.html-studio" "$PREFIX.html-studio-bore"; do
    launchctl kickstart -k "gui/$(id -u)/$label" 2>/dev/null && ok "已重启 $label"
  done
  sleep 3
  printf '  8899 健康: %s\n' "$(curl -s -m 5 http://127.0.0.1:8899/api/health || echo '无响应')"
  printf '  7788 健康: %s\n' "$(curl -s -m 5 http://127.0.0.1:7788/__anno/api/health || echo '无响应')"
fi

echo
echo "下一步："
echo "  $TO/share-link.sh                      # 看当前链接与健康状态"
echo "  $TO/anno-url.sh <某个HTML链接>          # 把链接转成可批注地址"
[ "$DO_PLISTS" -eq 0 ] && echo "  $0 --plists --load                     # 生成 launchd 并开机自启"
exit 0
