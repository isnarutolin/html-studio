#!/usr/bin/env bash
# smoke.sh — 自检：不联网、不用浏览器，验证注入与服务两条链路的关键行为
# 用法：bash tests/smoke.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PY="${PYTHON:-python3}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null' EXIT

PASS=0; FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
check(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

SRC="$HERE/tests/fixture.html"

echo "▸ 单机注入"
"$PY" "$HERE/scripts/annotate.py" "$SRC" -o "$TMP/out.html" >/dev/null 2>&1
OUT="$TMP/out.html"
check "产出文件存在"            "[ -s '$OUT' ]"
check "引擎已注入"              "grep -q 'HtmlAnnotator' '$OUT'"
check "带 data-anno-self 标记"  "grep -q 'data-anno-self' '$OUT'"
check "CSP 已放宽(unsafe-inline)" "grep -q \"script-src 'self' https: http: 'unsafe-inline'\" '$OUT'"
check "nonce 已移除"            "! grep -q 'nonce=' '$OUT'"
check "docId 取自文件名"        "grep -q 'data-doc-id=\"fixture\"' '$OUT'"
# 回归：引擎 init 时 document.currentScript 已为 null，data-author 读不到，
# 必须靠 localStorage 预置默认署名（之前的 --author 是静默失效的）
"$PY" "$HERE/scripts/annotate.py" "$SRC" -o "$TMP/author.html" --author 小明 -f >/dev/null 2>&1
check "--author 预置到 localStorage" "grep -qF \"setItem('anno-author-name'\" '$TMP/author.html' && grep -qF '小明' '$TMP/author.html'"
check "</body> 仍然唯一"        "[ \"\$(grep -o '</body>' '$OUT' | wc -l | tr -d ' ')\" = 1 ]"

echo "▸ 幂等性（重复注入不叠加）"
"$PY" "$HERE/scripts/annotate.py" "$OUT" -o "$TMP/out2.html" >/dev/null 2>&1
check "二次注入被跳过"          "grep -q '已经有批注引擎' <(\"$PY\" '$HERE/scripts/annotate.py' '$OUT' -o '$TMP/out3.html' -f 2>&1)"
# 不能数 'data-anno-self' 字符串：引擎源码里本身就引用了这个名字。查注入注释标记才准。
check "注入标记只有一处"        "[ \"\$(grep -c 'html-annotate: 自动注入批注引擎' '$TMP/out2.html' | tr -d ' ')\" = 1 ]"
check "docId 沿用未变"          "grep -q 'data-doc-id=\"fixture\"' '$TMP/out2.html'"

echo "▸ 多人实时服务"
cp "$SRC" "$TMP/src.html"   # 未注入的原稿，用于验证服务端注入
PORT=$("$PY" - <<'EOF'
import socket
s = socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1]); s.close()
EOF
)
"$PY" "$HERE/scripts/serve.py" --dir "$TMP" --port "$PORT" --data "$TMP/data" --quiet >"$TMP/serve.log" 2>&1 &
SRV_PID=$!
for _ in $(seq 1 40); do
  curl -s -m 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.2
done
HEALTH="$(curl -s -m 3 "http://127.0.0.1:$PORT/api/health")"
check "/api/health 返回 ok"     "echo '$HEALTH' | grep -q '\"ok\": true'"
# 存成文件再 grep：页面 HTML 里带单引号，拼进 eval 会把引号弄乱
curl -s -m 5 "http://127.0.0.1:$PORT/src" -o "$TMP/page.html" 2>/dev/null
curl -s -m 5 "http://127.0.0.1:$PORT/out" -o "$TMP/page2.html" 2>/dev/null
check "服务端自动注入引擎"      "grep -q 'HtmlAnnotator' '$TMP/page.html'"
check "注入时带上 docId"        "grep -q 'data-anno-self' '$TMP/page.html'"
check "服务端不重复注入已处理页" "[ \"\$(grep -c 'html-annotate: 自动注入批注引擎' '$TMP/page2.html')\" = 1 ]"

echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m全通过\033[0m（%d 项）\n' "$PASS"
  exit 0
else
  printf '\033[31m失败 %d 项\033[0m（通过 %d 项）\n' "$FAIL" "$PASS"
  echo "服务日志：$TMP/serve.log"; cat "$TMP/serve.log"
  exit 1
fi
