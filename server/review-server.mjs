#!/usr/bin/env node
/**
 * review-server.mjs — 「自动注入批注引擎」的静态服务器 + 实时协作后端
 *
 * 和 server.mjs 的区别：
 *   server.mjs        —— 只服务已经挂好引擎的 HTML（要先 build 或手改）
 *   review-server.mjs —— 服务任何 HTML 时，自动把批注引擎注入进 </body> 前
 *                        → AI 生成的 HTML 原样丢进目录，打开就带批注 + 实时协作
 *
 * 零依赖（只用 Node 内置模块）。批注存 data/<docId>.json，SSE 实时推送。
 *
 * 启动：
 *   node review-server.mjs                 # 默认端口 8899，服务当前目录
 *   PORT=8080 node review-server.mjs
 *   ROOT=~/reports node review-server.mjs  # 只服务指定目录
 *   NO_INJECT=1 node review-server.mjs     # 关掉自动注入（退化成 server.mjs）
 *
 * 访问：
 *   本机  http://localhost:8899/
 *   同事  http://<你的局域网IP>:8899/     （同一 WiFi 即可）
 *
 * 链接转换（把别人的 HTML 链接当场变成可批注版）：
 *   http://localhost:8899/p/https://file.c-ctrip.com/files/6/xxx/abc.html
 *   http://localhost:8899/p/<百分号编码的URL>?download=1     # 下载成单文件，离线可批注
 *   http://localhost:8899/api/convert?url=<URL>             # 返回 JSON（给脚本用）
 *   内网地址默认禁抓，需要时 PROXY_ALLOW_PRIVATE=1
 *
 * 注入规则：
 *   1) 页面里已经有引擎（data-anno-self / HtmlAnnotator / annotator.js）→ 跳过，不重复注入
 *   2) URL 带 ?anno=off → 本次跳过注入（方便看原稿）
 *   3) docId 自动从文件路径推导（/reports/q3.html → reports_q3）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8899;
const ROOT = process.env.ROOT ? path.resolve(process.env.ROOT.replace(/^~/, os.homedir())) : __dirname;
const DATA_DIR = path.join(__dirname, 'data');
const INJECT = process.env.NO_INJECT !== '1';

/* ---------- 访问口令（HTTP Basic Auth） ----------
   优先读环境变量 AUTH_USER / AUTH_PASS；没设就读同目录 access-code.txt（内容即口令）。
   两处都为空 → 不鉴权（兼容旧用法）。 */
const AUTH_USER = process.env.AUTH_USER || 'review';
let AUTH_PASS = process.env.AUTH_PASS || '';
if (!AUTH_PASS) {
  try { AUTH_PASS = fs.readFileSync(path.join(__dirname, 'access-code.txt'), 'utf8').trim(); } catch (e) {}
}
const AUTH_ON = !!AUTH_PASS;
const AUTH_HEADER = 'Basic ' + Buffer.from(AUTH_USER + ':' + AUTH_PASS).toString('base64');
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
function authed(req) {
  if (!AUTH_ON) return true;
  const h = req.headers.authorization || '';
  if (!/^Basic /i.test(h)) return false;
  return safeEqual(h.replace(/^Basic /i, '').trim(), AUTH_HEADER.replace(/^Basic /, ''));
}

/* ---------- 身份令牌：把「署名」绑定到首次使用它的浏览器 ----------
   只靠前端 localStorage 的署名，别人把名字改成「张三」就能删张三的批注。
   这里给每个浏览器发一个 HttpOnly cookie，署名首次使用时就绑定到它，
   之后该署名只能由同一个浏览器操作（删/标记已解决）。绑定关系落盘，重启不丢。 */
const IDENTITY_FILE = path.join(DATA_DIR, 'identity.json');
let identities = (() => {
  try { const j = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8')); return (j && typeof j === 'object') ? j : {}; } catch (e) { return {}; }
})();   // { token: name }
function saveIdentities() {
  try { fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identities, null, 2)); } catch (e) {}
}
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  });
  return out;
}
function tokenOf(req) { return parseCookies(req).anno_id || ''; }
function nameOfToken(token) {
  for (const t in identities) if (t === token) return identities[t];
  return null;
}
function tokenOfName(name) {
  for (const t in identities) if (identities[t] === name) return t;
  return null;
}
// 校验「这个令牌能否以 name 身份操作」；能则绑定（首次）并返回 null，不能则返回错误文案
function claimName(token, name) {
  name = String(name || '').trim();
  if (!name) return '缺少署名，请刷新页面后重试';
  if (!token) return '缺少身份标识，请刷新页面后重试（需允许本站 cookie）';
  const owner = tokenOfName(name);
  if (owner && owner !== token) return '「' + name + '」这个署名已被别人占用，请点标题栏改成别的名字';
  if (!owner) { identities[token] = name; saveIdentities(); }
  return null;
}
function challenge(res) {
  res.writeHead(401, Object.assign({
    'Content-Type': 'text/html; charset=utf-8',
    'WWW-Authenticate': 'Basic realm="HTML Review", charset="UTF-8"'
  }, CORS));
  res.end('<!doctype html><meta charset="utf-8"><title>需要口令</title>' +
    '<body style="font:15px/1.7 -apple-system,PingFang SC,sans-serif;max-width:520px;margin:90px auto;padding:0 24px;color:#1c1410">' +
    '<h2>需要访问口令</h2><p>这份评审稿是受保护的，请输入口令（用户名 <code>review</code>）。</p>' +
    '<p style="color:#888;font-size:13px">没收到口令的话，找发链接给你的人要。</p></body>');
}

/* 引擎源码（注入用）。去掉 </script 兜底，防止把宿主页面的 script 提前截断 */
const ENGINE_PATH = [
  path.join(__dirname, 'annotator.js'),                                  // 与脚本同目录（部署态）
  path.resolve(__dirname, '../skills/html-annotate/lib/annotator.js'),    // 仓库内（真源副本）
].find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } })
  || path.join(__dirname, 'annotator.js');
let ENGINE_SAFE = '';
try {
  ENGINE_SAFE = fs.readFileSync(ENGINE_PATH, 'utf8').replace(/<\/script/gi, '<\\/script');
} catch (e) {
  console.warn('[warn] 找不到 annotator.js，自动注入已关闭：' + e.message);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ROOT, { recursive: true });

/* ---------- 内存状态 + 持久化 ---------- */
const docs = Object.create(null);
const docMtimes = Object.create(null);   // 跨进程一致性用
const clients = new Map();

/* 保留 unicode 字母/数字（中文文件名可用），避免「中文全变 _」导致不同文档写同一文件 */
function safeName(s) { return String(s || 'default').replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 120) || 'default'; }
function docFile(doc) { return path.join(DATA_DIR, safeName(doc) + '.json'); }

function loadDoc(doc) {
  // 同一份 JSON 可能被多个服务（8899 批注服务 / 7788 网页版）同时读写，
  // 缓存必须按 mtime 失效，否则两边会互相覆盖。
  const f = docFile(doc);
  let m = 0;
  try { m = fs.statSync(f).mtimeMs; } catch (e) { m = 0; }
  if (docs[doc] && docMtimes[doc] === m) return docs[doc];
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    docs[doc] = Array.isArray(raw.annotations) ? raw.annotations : [];
  } catch (e) { docs[doc] = []; }
  docMtimes[doc] = m;
  return docs[doc];
}

const saveTimers = Object.create(null);
function persist(doc) {
  // 不防抖：另一个进程（7788 网页版）可能共享同一份 JSON，
  // 延迟 250ms 写盘会让对方读到旧数据并在写回时覆盖掉本次修改（丢更新）。
  // 批注是低频操作，同步写完全能承受。
  clearTimeout(saveTimers[doc]);
  try {
    fs.writeFileSync(docFile(doc), JSON.stringify({ doc, updatedAt: new Date().toISOString(), annotations: docs[doc] }, null, 2));
    try { docMtimes[doc] = fs.statSync(docFile(doc)).mtimeMs; } catch (e) { docMtimes[doc] = 0; }
  } catch (e) { console.error('[persist] 写入失败', e.message); }
}

/* ---------- 操作应用 ---------- */
function applyOp(list, op) {
  const find = (id) => list.find((a) => a.id === id);
  if (op.type === 'add') {
    if (op.annotation && !find(op.annotation.id)) list.push(op.annotation);
  } else if (op.type === 'reply') {
    const a = find(op.id);
    if (a) { a.replies = a.replies || []; if (!a.replies.some((r) => r.id === op.reply.id)) a.replies.push(op.reply); }
  } else if (op.type === 'status') {
    const a = find(op.id); if (a) a.status = op.status;
  } else if (op.type === 'delete') {
    const i = list.findIndex((a) => a.id === op.id); if (i >= 0) list.splice(i, 1);
  }
  return list;
}
/* 越权校验：只有作者本人能标记已解决 / 删除自己的批注。
   身份 = 浏览器令牌（cookie），不是可随意伪造的署名 */
function checkPermission(list, op, token) {
  if (op.type !== 'status' && op.type !== 'delete') return null;
  const a = list.find((x) => x.id === op.id);
  if (!a) return null;                       // 不存在就当幂等成功
  const owner = String((a.author && a.author.name) || '').trim();
  const mine = identities[token];
  // 注意：这里绝不隐式绑定署名。否则任何人拿到链接、改个名就能认领别人的历史批注。
  if (!mine) return '你还没在这份稿子留过批注，不能操作别人的批注（先发一条批注完成身份登记）';
  if (mine !== owner) return '只有作者本人（' + owner + '）可以' + (op.type === 'delete' ? '删除' : '标记已解决') + '别人的批注';
  return null;
}

/* ---------- SSE ---------- */
function sseSend(res, payload) { try { res.write('data: ' + JSON.stringify(payload) + '\n\n'); } catch (e) {} }
function broadcast(doc, payload, except) {
  const set = clients.get(doc); if (!set) return;
  set.forEach((res) => { if (res !== except) sseSend(res, payload); });
}
function presence(doc) { return (clients.get(doc) || new Set()).size; }
function broadcastPresence(doc) { broadcast(doc, { type: 'presence', count: presence(doc), doc }); }

/* ---------- HTTP 工具 ---------- */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
function json(res, obj, code = 200) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }, CORS));
  res.end(JSON.stringify(obj));
}
const COMPRESSIBLE = /\.(html?|js|mjs|css|json|svg|txt|map)$/i;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
};

/* ---------- 自动注入 ---------- */
function docIdFor(pathname) {
  let s = pathname;
  try { s = decodeURIComponent(s); } catch (e) {}
  return s.replace(/^\/+/, '').replace(/\.html?$/i, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/^_+|_+$/g, '') || 'index';
}
function hasEngine(html) {
  return /data-anno-self|HtmlAnnotator|annotator(\.min)?\.js/.test(html);
}
function injectEngine(html, docId) {
  if (!INJECT || !ENGINE_SAFE || hasEngine(html)) return html;
  // 用 meta 传 docId：引擎在 DOMContentLoaded 才 init，那时 document.currentScript 已为 null，
  // 读不到 <script data-doc-id>，会回退成对 URL 做替换（结果不可读且可能碰撞）。
  const meta = '<script>(function(){try{var m=document.createElement("meta");' +
    'm.setAttribute("name","anno-doc-id");m.setAttribute("content",' + JSON.stringify(docId) + ');' +
    '(document.head||document.documentElement).appendChild(m);}catch(e){}})();</script>\n';
  const eng = '<script data-anno-self="1" data-doc-id="' + docId.replace(/"/g, '&quot;') + '">\n' +
    ENGINE_SAFE + '\n</script>\n';
  const tag = '\n<!-- html-annotator: 自动注入 -->\n' + meta + eng;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, tag + '</body>');
  return html + tag;
}

/* ---------- 目录页（分发入口） ---------- */
function listHtmlFiles() {
  try {
    return fs.readdirSync(ROOT).filter((f) => /\.html?$/i.test(f))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(ROOT, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) { return []; }
}
function directoryPage() {
  const files = listHtmlFiles();
  const rows = files.map((f) => {
    const id = docIdFor('/' + f.name);
    return '<li><a href="/' + encodeURIComponent(f.name) + '">' + f.name + '</a>' +
      '<span class="m">' + f.mtime.toLocaleString() + '</span>' +
      '<code>docId: ' + id + '</code></li>';
  }).join('\n');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>批注服务器 · 目录</title>
<style>
body{font:15px/1.6 -apple-system,"PingFang SC",sans-serif;max-width:760px;margin:60px auto;padding:0 24px;color:#1c1410}
h1{font-size:24px} .hint{color:#888;font-size:13px;margin-bottom:24px}
ul{list-style:none;padding:0} li{padding:14px 0;border-bottom:1px solid #eee}
a{color:#d8000f;text-decoration:none;font-weight:600;font-size:17px} a:hover{text-decoration:underline}
.m{color:#aaa;font-size:12px;margin-left:12px}
code{display:block;color:#999;font-size:12px;margin-top:4px}
.empty{color:#999}
</style></head><body>
<h1>批注服务器</h1>
<div class="hint">把任意 HTML 丢进 <code style="display:inline">${ROOT}</code>，打开即带批注 + 实时协作。以下 ${files.length} 份稿子：</div>
<ul>${rows || '<li class="empty">目录里还没有 .html 文件</li>'}</ul>
</body></html>`;
}

/* ---------- 静态服务 ---------- */
function serveStatic(req, res, pathname, query) {
  let p = decodeURIComponent(pathname);
  const fp = path.normalize(path.join(ROOT, p));
  if (!fp.startsWith(ROOT)) return json(res, { error: 'forbidden' }, 403);

  fs.stat(fp, (err, st) => {
    if (!err && st.isDirectory()) return sendFile(req, res, path.join(fp, 'index.html'), pathname, query);
    sendFile(req, res, fp, pathname, query);
  });
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function sendFile(req, res, fp, pathname, query, isRetry) {
  fs.readFile(fp, (err, buf) => {
    if (err) {
      // 常见的少写扩展名（/doc → /doc.html）：自动补一次 .html 重试
      // docId 仍按请求路径算，所以 /doc 与 /doc.html 共用同一份批注
      if (!isRetry && !path.extname(fp)) {
        const alt = fp + '.html';
        try {
          if (fs.statSync(alt).isFile()) return sendFile(req, res, alt, pathname, query, true);
        } catch (e) { /* 没有就继续走 404 */ }
      }
      res.writeHead(404, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, CORS));
      const list = listHtmlFiles().map((f) =>
        '<li><a href="/' + encodeURIComponent(f.name) + '">' + escapeHtml(f.name) + '</a></li>').join('');
      return res.end('<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>404 · 找不到这份稿子</title>' +
        '<style>body{font:15px/1.7 -apple-system,"PingFang SC",sans-serif;max-width:620px;margin:80px auto;padding:0 24px;color:#1c1410}' +
        'code{background:#f3f3f5;padding:2px 6px;border-radius:4px;font-size:13px}a{color:#d8000f}</style></head><body>' +
        '<h2>找不到这份稿子</h2>' +
        '<p>请求路径：<code>' + escapeHtml(pathname) + '</code></p>' +
        '<p>目录里现有：</p><ul>' + (list || '<li>（空）</li>') + '</ul>' +
        '<p><a href="/">← 回目录页</a></p></body></html>');
    }
    const ext = path.extname(fp).toLowerCase();
    const headers = Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, CORS);

    // 只对 HTML 做注入；?anno=off 可临时关闭
    let out;
    if ((ext === '.html' || ext === '.htm') && INJECT && query.get('anno') !== 'off') {
      out = Buffer.from(injectEngine(buf.toString('utf8'), docIdFor(pathname)), 'utf8');
    } else {
      out = buf;
    }
    // gzip：内联了 echarts 的稿子 1MB+，压后 ~300KB。
    // 局域网只是快点，但对公网隧道（云端有单响应体积/超时限制）就是能不能打开的差别。
    //
    // ETag/304：隧道带宽只有 ~24KB/s，380KB 要传 15 秒。重复打开不该每次都重传，
    // 带上 ETag 后，浏览器第二次就是 304（几百字节），秒开。
    let etag = null;
    try {
      const st2 = fs.statSync(fp);
      etag = 'W/"' + Math.round(st2.mtimeMs).toString(36) + '-' + out.length.toString(36) +
             '-' + encodeURIComponent(docIdFor(pathname)) + '"';
    } catch (e) { /* 拿不到 stat 就不发 ETag */ }
    if (etag) {
      if (String(req.headers['if-none-match'] || '') === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
        return res.end();
      }
      headers['ETag'] = etag;
    }
    const wantGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (wantGzip && out.length > 1024 && COMPRESSIBLE.test(ext)) {
      out = zlib.gzipSync(out, { level: 6 });
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
    }
    headers['Content-Length'] = out.length;
    res.writeHead(200, headers).end(out);
  });
}

/* ---------- URL 转「可批注版」（/p/<url>） ----------
   给一个现成的 HTML 链接（CDN、别人发你的报告），当场转成可批注页面：
     http://localhost:8899/p/https://file.c-ctrip.com/files/6/xxx/abc.html
   百分号编码形式还能下载成单文件（引擎内联，离线可批注、也能用扩展直接改）：
     http://localhost:8899/p/https%3A%2F%2Ffile.c-ctrip.com%2F...html?download=1

   为什么要代理而不是让浏览器直连：
     · 目标页的 CSP 通常挡内联脚本，必须服务端改写（rejectRelaxedCsp）
     · 相对路径要靠 <base href> 才能正常解析
     · 批注数据走本站 /api/*，所以页面必须同源，否则多人同步会挂掉

   SSRF 防护：默认禁止抓内网/回环地址（127/10/172.16-31/192.168/169.254/.local 等），
   确需抓内网稿子再 PROXY_ALLOW_PRIVATE=1。 */
const PROXY_ALLOW_PRIVATE = process.env.PROXY_ALLOW_PRIVATE === '1';
const PROXY_TIMEOUT = Number(process.env.PROXY_TIMEOUT) || 20000;
const PROXY_MAX_BYTES = 12 << 20;

const RELAXED_CSP = "default-src 'self' https: http: data: blob: 'unsafe-inline' 'unsafe-eval'; " +
  "script-src 'self' https: http: 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' https: http: 'unsafe-inline'; " +
  "img-src 'self' https: http: data: blob:; font-src 'self' https: http: data:; " +
  "connect-src 'self' https: http:; object-src 'none'; base-uri 'self'; form-action 'self'";

function privateReason(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return '空主机名';
  if (h === 'localhost' || h.endsWith('.localhost')) return 'localhost';
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return '内网域名';
  if (h === '::1' || h === '0.0.0.0') return '回环地址';
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 0 || a === 10) return '内网地址';
    if (a === 169 && b === 254) return '链路本地地址';
    if (a === 192 && b === 168) return '内网地址';
    if (a === 172 && b >= 16 && b <= 31) return '内网地址';
  }
  return '';
}

function relaxCspOf(html) {
  const re = /<meta[^>]+http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/gi;
  const n = (html.match(re) || []).length;
  return [html.replace(re, '<meta http-equiv="Content-Security-Policy" content="' + RELAXED_CSP + '">')
    .replace(/\s+nonce="[^"]*"/g, ''), n];
}

// 相对路径（./a.css、/img/x.png）在 /p/<url> 这种“假目录”下会解析错，必须补 <base>
function ensureBase(html, absoluteUrl) {
  if (/<base\s/i.test(html)) return html;
  const tag = '<base href="' + escapeHtml(absoluteUrl) + '">';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + '\n' + tag);
  return html.replace(/<html[^>]*>/i, (m) => m + '\n<head>' + tag + '</head>');
}

function docIdForUrl(rawUrl) {
  const u = new URL(rawUrl);
  const base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname)
    .replace(/\.html?$/i, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  const h = crypto.createHash('sha1').update(rawUrl).digest('hex').slice(0, 6);
  return (base || 'url') + '-' + h;
}

async function fetchHtmlChain(startUrl, depth = 0) {
  if (depth > 3) throw new Error('重定向次数过多');
  let u;
  try { u = new URL(startUrl); } catch (e) { throw new Error('URL 不合法'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http/https');
  const why = privateReason(u.hostname);
  if (why && !PROXY_ALLOW_PRIVATE) {
    throw new Error('拒绝访问' + why + '（' + u.hostname + '）；确需抓内网链接请设 PROXY_ALLOW_PRIVATE=1');
  }
  const r = await fetch(u, {
    redirect: 'manual',
    signal: AbortSignal.timeout(PROXY_TIMEOUT),
    headers: { 'User-Agent': 'html-annotator-review-server/1.0', 'Accept': 'text/html,application/xhtml+xml' },
  });
  if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
    return fetchHtmlChain(new URL(r.headers.get('location'), u).toString(), depth + 1);
  }
  if (!r.ok) throw new Error('目标返回 ' + r.status);
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (!/text\/html|application\/xhtml/.test(ct)) throw new Error('目标不是 HTML（content-type: ' + (ct || '未知') + '）');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > PROXY_MAX_BYTES) throw new Error('目标文件过大（' + (buf.length / 1048576).toFixed(1) + 'MB）');
  return { html: buf.toString('utf8'), finalUrl: r.url || u.toString() };
}

async function handleProxy(req, res, rawRest, searchParams, encoded) {
  let target = rawRest;
  if (encoded) { try { target = decodeURIComponent(rawRest); } catch (e) { /* 保持原样 */ } }
  if (!/^https?:\/\//i.test(target)) {
    return html503(res, 'URL 不合法', '<p>用法：<code>/p/https://example.com/a.html</code></p>');
  }
  try {
    const { html, finalUrl } = await fetchHtmlChain(target);
    let out = html;
    const [relaxed, cspCount] = relaxCspOf(out);
    out = ensureBase(relaxed, finalUrl);
    const docId = docIdForUrl(finalUrl);   // 用最终 URL：同一页面不论哪种写法都归到同一个 docId
    out = injectEngine(out, docId);   // 引擎同源 → /api/* 自动连上，多人实时可用

    const download = encoded && searchParams.get('download') === '1';
    const name = docId + '.html';
    const headers = Object.assign({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Anno-Source': finalUrl,
      'X-Anno-DocId': docId,
      'X-Anno-Csp-Relaxed': String(cspCount),
    }, CORS);
    if (download) headers['Content-Disposition'] = 'attachment; filename="' + name + '"';
    res.writeHead(200, headers).end(out);
  } catch (e) {
    const msg = (e && e.name === 'TimeoutError') ? ('抓取超时（' + PROXY_TIMEOUT + 'ms）') : (e.message || String(e));
    return html503(res, '转换失败', '<p>' + escapeHtml(msg) + '</p><p>源：<code>' + escapeHtml(target) + '</code></p>');
  }
}

function html503(res, title, bodyHtml) {
  res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, CORS)).end(
    '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>' + title + '</title>' +
    '<style>body{font:15px/1.7 -apple-system,"PingFang SC",sans-serif;max-width:680px;margin:80px auto;padding:0 24px;color:#1c1410}' +
    'code{background:#f3f3f5;padding:2px 6px;border-radius:4px;font-size:13px;word-break:break-all}</style></head><body>' +
    '<h2>' + title + '</h2>' + bodyHtml + '<p><a href="/">← 回目录页</a></p></body></html>');
}

/* ---------- 路由 ---------- */
const server = http.createServer((req, res) => {
  const rawUrl = req.url || '/';
  const u = new URL(req.url, 'http://localhost');
  const doc = u.searchParams.get('doc') || 'default';

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  // 所有请求（页面、API、SSE）都要过口令
  if (!authed(req)) return challenge(res);

  // 给每个浏览器发一个身份令牌（HttpOnly，JS 读不到、但会随请求自动带上）
  let token = tokenOf(req);
  if (!token) {
    token = 't_' + crypto.randomUUID().replace(/-/g, '');
    res.setHeader('Set-Cookie', 'anno_id=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000');
  }

  if (u.pathname === '/api/health') {
    return json(res, { ok: true, docs: Object.keys(docs), uptime: process.uptime(), inject: INJECT, root: ROOT });
  }
  if (u.pathname === '/api/state') {
    return json(res, { doc, annotations: loadDoc(doc), presence: presence(doc) });
  }
  if (u.pathname === '/api/stream') {
    res.writeHead(200, Object.assign({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
    }, CORS));
    res.write('retry: 3000\n\n');
    if (!clients.has(doc)) clients.set(doc, new Set());
    clients.get(doc).add(res);
    sseSend(res, { type: 'sync', doc, annotations: loadDoc(doc) });
    broadcastPresence(doc);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => {
      clearInterval(hb);
      const set = clients.get(doc);
      if (set) { set.delete(res); if (!set.size) clients.delete(doc); }
      broadcastPresence(doc);
    });
    return;
  }
  if (u.pathname === '/api/op' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const d = parsed.doc || doc;
        const op = parsed.op;
        if (!op || !op.type) throw new Error('缺少 op');
        const list = loadDoc(d);
        const denied = checkPermission(list, op, token);
        if (denied) return json(res, { ok: false, error: denied }, 403);
        // 新写的批注/回复：把署名绑定到这个浏览器，防止别人冒名
        let claimErr = null;
        if (op.type === 'add' && op.annotation && op.annotation.author) {
          claimErr = claimName(token, op.annotation.author.name);
        } else if (op.type === 'reply' && op.reply && op.reply.author) {
          claimErr = claimName(token, op.reply.author.name);
        }
        if (claimErr) return json(res, { ok: false, error: claimErr }, 409);
        applyOp(list, op);
        persist(d);
        broadcast(d, { type: 'op', doc: d, op });
        json(res, { ok: true });
      } catch (e) { json(res, { ok: false, error: e.message }, 400); }
    });
    return;
  }

  if (u.pathname === '/api/convert') {
    // 给脚本用：URL → 可批注链接（不抓取，只生成）
    const target = u.searchParams.get('url') || '';
    if (!/^https?:\/\//i.test(target)) return json(res, { ok: false, error: '缺少合法的 url 参数' }, 400);
    const enc = encodeURIComponent(target);
    return json(res, {
      ok: true, source: target, doc_id: docIdForUrl(target),
      proxy: '/p/' + enc,
      download: '/p/' + enc + '?download=1',
    });
  }
  if (rawUrl.startsWith('/p/')) {
    return handleProxy(req, res, rawUrl.slice(3), u.searchParams, /^https?%3A/i.test(rawUrl.slice(3)));
  }

  if (u.pathname === '/' || u.pathname === '/index.html') {
    const idx = path.join(ROOT, 'index.html');
    if (!fs.existsSync(idx)) {
      return res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, CORS)).end(directoryPage());
    }
  }

  return serveStatic(req, res, u.pathname, u.searchParams);
});

server.listen(PORT, () => {
  const ips = [];
  const ifs = os.networkInterfaces();
  for (const k in ifs) for (const a of ifs[k]) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  console.log('\n  HTML 批注 · 自动注入服务器已启动');
  console.log('  ──────────────────────────────────');
  console.log('  目录:  ' + ROOT);
  console.log('  注入:  ' + (INJECT && ENGINE_SAFE ? '开（任何 HTML 自动带批注）' : '关'));
  console.log('  本机:  http://localhost:' + PORT + '/');
  ips.forEach((ip) => console.log('  同事:  http://' + ip + ':' + PORT + '/   （同一局域网）'));
  console.log('  数据:  ' + DATA_DIR);
  console.log('  Ctrl+C 停止\n');
});
