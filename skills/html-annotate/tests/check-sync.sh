#!/usr/bin/env bash
# check-sync.sh — 防止三份 annotator.js 分叉（开发机专用；外部用户缺文件会自动跳过）
#
# 真源：$ANNOTATOR_KIT/annotator.js（默认 ~/html-annotator-kit/annotator.js）
#   ├── skills/html-annotate/lib/annotator.js   必须与真源**字节一致**
#   └── extension/lib/annotator.js              真源 + 固定 9 行文件头（扩展要按需初始化）
#
# 文件头用**内置常量**校验，不从被检查文件里读 —— 否则把头改坏了会自己跟自己比、查不出来。
#
# 用法：
#   bash tests/check-sync.sh          # 只检查
#   bash tests/check-sync.sh --fix    # 以真源为准，自动修复另外两份
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

SKILL_LIB="$HERE/lib/annotator.js"
EXT_LIB="$REPO/extension/lib/annotator.js"
KIT_LIB="${ANNOTATOR_KIT:-$HOME/html-annotator-kit}/annotator.js"
HEADER_LINES=9

FIX=0
[ "${1:-}" = "--fix" ] && FIX=1

ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; }
skip(){ printf '  \033[33m–\033[0m %s\n' "$1"; }

# 扩展副本的固定文件头（唯一真源在这里，改头要同时改 HEADER_LINES）
EXPECT_HEADER='/**
 * HTML Studio — 批注引擎（手动初始化版）
 *
 * 与 html-annotator-kit/annotator.js 同源，差异只有两处：
 *   1) 文件头设 __ANNO_DISABLE_AUTOINIT__，由宿主（content.js）按需调用 init，
 *      避免在用户没开批注模式时就在每个页面挂上悬浮按钮
 *   2) 依赖宿主控制显隐：HtmlAnnotator.setActive(true/false)
 */
window.__ANNO_DISABLE_AUTOINIT__ = true;'

echo "▸ 真源：$KIT_LIB"
if [ ! -f "$KIT_LIB" ]; then
  skip "找不到真源（外部用户/没装 kit 时正常），跳过全部同步检查"
  exit 0
fi

FAIL=0
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ---- 1) skill 副本：必须与真源字节一致 ----
if [ ! -f "$SKILL_LIB" ]; then
  bad "缺少 $SKILL_LIB"
  FAIL=1
elif cmp -s "$KIT_LIB" "$SKILL_LIB"; then
  ok "skill 副本与真源一致"
else
  bad "skill 副本已分叉（与真源不同）"
  FAIL=1
  [ "$FIX" -eq 1 ] && cp "$KIT_LIB" "$SKILL_LIB" && { ok "已用真源覆盖 skill 副本"; FAIL=0; }
fi

# ---- 2) 扩展副本：文件头单独校验，正文与真源逐字节校验 ----
if [ ! -f "$EXT_LIB" ]; then
  skip "没有 extension/lib/annotator.js（非本仓库使用者正常）"
else
  printf '%s\n' "$EXPECT_HEADER" > "$TMP/want_header"
  head -n "$HEADER_LINES" "$EXT_LIB" > "$TMP/got_header"
  tail -n +"$((HEADER_LINES + 1))" "$EXT_LIB" > "$TMP/got_body"

  HEAD_OK=1; BODY_OK=1
  cmp -s "$TMP/want_header" "$TMP/got_header" || HEAD_OK=0
  cmp -s "$KIT_LIB"         "$TMP/got_body"   || BODY_OK=0

  if [ "$HEAD_OK" -eq 1 ] && [ "$BODY_OK" -eq 1 ]; then
    ok "扩展副本 = 真源 + ${HEADER_LINES} 行文件头"
  else
    [ "$HEAD_OK" -eq 0 ] && bad "扩展副本的文件头被改过（应按内置常量）"
    [ "$BODY_OK" -eq 0 ] && bad "扩展副本的正文已分叉（与真源不同）"
    FAIL=1
    if [ "$FIX" -eq 1 ]; then
      { printf '%s\n' "$EXPECT_HEADER"; cat "$KIT_LIB"; } > "$EXT_LIB"
      ok "已用 真源+内置文件头 重写扩展副本"
      FAIL=0
    fi
  fi

  # 顺便确认扩展副本确实关了自动初始化（否则页面会一进来就挂悬浮按钮）
  grep -q '__ANNO_DISABLE_AUTOINIT__ = true' "$EXT_LIB" \
    && ok "扩展副本保留 __ANNO_DISABLE_AUTOINIT__" \
    || { bad "扩展副本丢了 __ANNO_DISABLE_AUTOINIT__（扩展会到处自动挂批注）"; FAIL=1; }
fi

echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m引擎三份同源\033[0m  '; 
  (md5 -q "$KIT_LIB" 2>/dev/null || md5sum "$KIT_LIB" | cut -d' ' -f1)
  exit 0
fi
echo "修复：bash tests/check-sync.sh --fix"
echo "（改引擎请只改真源，再同步；不要直接改副本）"
exit 1
