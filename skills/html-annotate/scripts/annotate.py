#!/usr/bin/env python3
"""
annotate.py — 给任意 HTML 注入「划词批注」能力，产出一个自包含的可批注版

设计原则（这是别的 skill 复现时最容易踩坑的三点，都在这里解决了）：
  1) 纯标准库，零依赖：不需要 node、不需要 pip install、不需要装浏览器扩展
  2) CSP：原稿常带 script-src nonce / connect-src 'none'，会拦掉注入的引擎和 /api 请求；
     这里把 CSP 换成一份「能跑批注」的宽松版本（保留外链 CDN 可用，不必内联 echarts）
  3) 引擎内联而不是外链：一个文件发出去就能用，离线也能批注（走 localStorage）

用法：
    python3 annotate.py report.html                       # → report.annotated.html
    python3 annotate.py report.html -o out.html           # 指定输出
    python3 annotate.py https://x.com/a.html -o a.html    # 直接吃网址
    python3 annotate.py report.html --remote http://1.2.3.4:8899   # 指向多人实时后端
    python3 annotate.py report.html --doc-id heping --author 小明
    python3 annotate.py report.html --no-csp              # 不动 CSP（自担被拦风险）

批注数据：
    单机模式    → 存浏览器 localStorage（换机器/换浏览器看不到）
    多人实时    → 用 --remote 指向 `serve.py` 起的服务，或直接把产物丢进 serve.py 的 --dir
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(HERE)


def find_engine() -> str:
    for p in (os.path.join(ROOT_DIR, "lib", "annotator.js"),
              os.path.join(ROOT_DIR, "extension", "lib", "annotator.js")):
        if os.path.isfile(p):
            return p
    return ""


# 一份「批注能跑、外链还能用」的 CSP：不放松到 default-src *，但也不再挡 CDN 和 /api
RELAXED_CSP = (
    "default-src 'self' https: http: data: blob: 'unsafe-inline' 'unsafe-eval'; "
    "script-src 'self' https: http: 'unsafe-inline' 'unsafe-eval'; "
    "style-src 'self' https: http: 'unsafe-inline'; "
    "img-src 'self' https: http: data: blob:; "
    "font-src 'self' https: http: data:; "
    "connect-src 'self' https: http:; "
    "object-src 'none'; base-uri 'self'; form-action 'self'"
)

CSP_META_RE = re.compile(r"""<meta[^>]+http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>""", re.I)
HAS_ENGINE_RE = re.compile(r"HtmlAnnotator|data-anno-self|annotator(\.min)?\.js")
BODY_CLOSE_RE = re.compile(r"</body>", re.I)


def slugify(s: str) -> str:
    s = re.sub(r"\.html?$", "", s, flags=re.I)
    s = re.sub(r"[^\w.-]+", "-", s, flags=re.U).strip("-._")
    return s or "doc"


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def read_source(src: str) -> str:
    if re.match(r"^https?://", src, re.I):
        log(f"▸ 下载 {src}")
        req = urllib.request.Request(src, headers={"User-Agent": "html-annotate/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
        log(f"  ✓ {len(raw) / 1024:.0f}KB")
        return raw.decode("utf-8", errors="replace")
    with open(src, encoding="utf-8", errors="replace") as f:
        return f.read()


def compute_doc_id(html: str, src: str, explicit: str | None) -> str:
    if explicit:
        return slugify(explicit)
    # 1) 原稿自己声明过就沿用，保证「重新注入」不改 docId、不丢历史批注
    m = re.search(r'<meta[^>]+name=["\']anno-doc-id["\'][^>]*content=["\']([^"\']+)', html, re.I)
    if not m:
        m = re.search(r'<script[^>]+data-doc-id=["\']([^"\']+)', html, re.I)
    if m:
        return m.group(1)
    # 2) 网页源：用路径末段；本地文件：用文件名
    if re.match(r"^https?://", src, re.I):
        tail = re.sub(r"^\w+://[^/]+/?", "", src).split("?")[0]
        tail = [p for p in tail.split("/") if p]
        if tail:
            base = tail[-1]
            # CDN 那种纯随机 id（28u0e12000ufu1qw8750E）当 docId 毫无意义
            if re.fullmatch(r"[A-Za-z0-9]{15,}", base.rsplit(".", 1)[0]):
                return slugify(tail[-2] if len(tail) > 1 else os.path.basename(src))
            return slugify(base)
    return slugify(os.path.basename(src))


def build_tags(engine: str, doc_id: str, author: str | None, remote: str | None) -> str:
    # </script 会提前闭合宿主 script；转义后再内联
    engine = re.sub(r"</script", r"<\\/script", engine, flags=re.I)
    engine = engine.replace("window.__ANNO_DISABLE_AUTOINIT__ = true;", "")  # 扩展副本的手动开关

    doc_meta = (
        "<script>(function(){try{var m=document.createElement('meta');"
        "m.setAttribute('name','anno-doc-id');m.setAttribute('content',"
        + json.dumps(doc_id, ensure_ascii=False) +
        ");(document.head||document.documentElement).appendChild(m);}"
        "catch(e){}})();</script>\n"
    )
    attrs = f' data-anno-self="1" data-doc-id="{doc_id.replace(chr(34), "&quot;")}"'
    if author:
        attrs += f' data-author="{author.replace(chr(34), "&quot;")}"'
    tag = "\n<!-- html-annotate: 自动注入批注引擎 -->\n"
    # 引擎在 DOMContentLoaded 才 init，那时 document.currentScript 已为 null，
    # 所以 data-author 读不到（docId 有 meta 兜底，author 没有）。
    # 用 localStorage 预置默认署名，且仅在用户还没有署名时生效。
    if author:
        tag += (
            "<script>(function(){try{if(!localStorage.getItem('anno-author-name'))"
            "localStorage.setItem('anno-author-name'," + json.dumps(author, ensure_ascii=False) +
            ");}catch(e){}})();</script>\n"
        )
    # file:// 直开时引擎会探 /api/health，浏览器会报一条 ERR_FILE_NOT_FOUND。
    # 引擎自身的 catch 已经兑底，但控制台红字会让人误以为坏了。
    # 这里只拦 file: 协议下的那四个端点，不影响页面自己的请求。
    tag += (
        "<script>(function(){if(location.protocol!=='file:')return;"
        "var f=window.fetch;window.fetch=function(u,o){try{var s=String((u&&u.url)||u);"
        "if(/\\/api\\/(health|state|op|stream)(\\?|$)/.test(s))"
        "{return Promise.resolve(new Response('{}',{status:200,"
        "headers:{'Content-Type':'application/json'}}));}}catch(e){}"
        "return f.apply(this,arguments);};})();</script>\n"
    )
    tag += doc_meta
    tag += "<script" + attrs + ">\n" + engine + "\n</script>\n"

    if remote:
        base = remote.rstrip("/")
        # 引擎的 detectAndConnect 只探同源；跨域要显式 connect。
        # connectRemote 有 `if (A.remote) return;` 早退，所以抢在自动探测之前接上即可。
        tag += (
            "<script>window.addEventListener('DOMContentLoaded',function(){try{"
            "if(window.HtmlAnnotator)HtmlAnnotator.connect(" + json.dumps(base, ensure_ascii=False) + ");"
            "}catch(e){}});</script>\n"
        )
    return tag


def main() -> int:
    ap = argparse.ArgumentParser(
        description="给 HTML 注入划词批注能力（纯标准库，零依赖）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="例：python3 annotate.py report.html --remote http://127.0.0.1:8899")
    ap.add_argument("src", help="原稿：本地 .html 路径或 http(s) 网址")
    ap.add_argument("-o", "--out", help="输出文件，默认 <原稿名>.annotated.html")
    ap.add_argument("--doc-id", help="文档 ID（批注按它归档；重注入会自动沿用原值）")
    ap.add_argument("--author", help="批注者默认昵称")
    ap.add_argument("--remote", help="多人实时后端地址，如 http://1.2.3.4:8899")
    ap.add_argument("--no-csp", action="store_true", help="不改写 CSP meta（严格 CSP 下引擎会被拦）")
    ap.add_argument("-f", "--force", action="store_true", help="输出已存在也覆盖")
    args = ap.parse_args()

    engine_path = find_engine()
    if not engine_path:
        log("✗ 找不到 lib/annotator.js，无法注入")
        return 1
    with open(engine_path, encoding="utf-8") as f:
        engine = f.read()

    if not os.path.exists(args.src) and not re.match(r"^https?://", args.src, re.I):
        log(f"✗ 找不到文件: {args.src}")
        return 1

    out = args.out
    if not out:
        if re.match(r"^https?://", args.src, re.I):
            out = slugify(os.path.basename(args.src)) + ".annotated.html"
        else:
            stem, ext = os.path.splitext(args.src)
            out = f"{stem}.annotated{ext or '.html'}"
    if os.path.exists(out) and not args.force and os.path.abspath(out) != os.path.abspath(args.src):
        log(f"✗ {out} 已存在（加 -f 覆盖）")
        return 1

    html = read_source(args.src)

    if HAS_ENGINE_RE.search(html):
        log("⚠ 页面里已经有批注引擎，跳过注入（不会重复挂载）")
    else:
        doc_id = compute_doc_id(html, args.src, args.doc_id)

        if not args.no_csp:
            hits = CSP_META_RE.findall(html)
            if hits:
                html = CSP_META_RE.sub(
                    f'<meta http-equiv="Content-Security-Policy" content="{RELAXED_CSP}">', html)
                log(f"▸ 改写 CSP {len(hits)} 处（原稿会拦掉引擎和 /api）")
            else:
                log("▸ 原稿无 CSP meta，无需改写")

        # CSP 改成 unsafe-inline 后 nonce 属性就没用了，留着反而误导
        html, n_nonce = re.subn(r'\s+nonce="[^"]*"', "", html)
        if n_nonce:
            log(f"▸ 去掉 nonce 属性 {n_nonce} 处")

        tags = build_tags(engine, doc_id, args.author, args.remote)
        if BODY_CLOSE_RE.search(html):
            html = BODY_CLOSE_RE.sub(lambda m: tags + "</body>", html, count=1)
        else:
            log("⚠ 没有 </body>，追加到文件末尾")
            html += tags
        log(f"▸ 注入引擎 docId={doc_id}" + (f" remote={args.remote}" if args.remote else ""))

    # ---- 自检 ----
    body_closes = len(BODY_CLOSE_RE.findall(html))
    left_ext = re.findall(r'<script[^>]*src="(?:https?:)?//[^"]+"', html)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"✓ {out}  {len(html.encode()) / 1024:.0f}KB  </body> x{body_closes}")
    if body_closes != 1:
        print(f"⚠ </body> 出现 {body_closes} 次，注入位置可能不唯一", file=sys.stderr)
    if left_ext:
        print(f"ℹ 仍有 {len(left_ext)} 个外部脚本（外链需联网；CSP 已放宽，能加载）", file=sys.stderr)
    print("\n下一步：", file=sys.stderr)
    print(f"  直接开：  open '{out}'            # 单机批注，数据在本浏览器 localStorage", file=sys.stderr)
    print(f"  多人实时： python3 scripts/serve.py --dir '{os.path.dirname(os.path.abspath(out)) or '.'}'", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
