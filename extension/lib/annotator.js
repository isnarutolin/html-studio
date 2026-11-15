/**
 * HTML Studio — 批注引擎（手动初始化版）
 *
 * 与 html-annotator-kit/annotator.js 同源，差异只有两处：
 *   1) 文件头设 __ANNO_DISABLE_AUTOINIT__，由宿主（content.js）按需调用 init，
 *      避免在用户没开批注模式时就在每个页面挂上悬浮按钮
 *   2) 依赖宿主控制显隐：HtmlAnnotator.setActive(true/false)
 */
window.__ANNO_DISABLE_AUTOINIT__ = true;
/*! html-annotator v1.0.0 — 单文件网页批注工具（飞书文档风格）
 * 引入方式：在页面底部加一行 script 标签指向 annotator.js
 * 可选配置：data-doc-id="my-doc" data-author="你的名字"
 * 或在 head 里放 meta name="anno-doc-id" content="my-doc"
 */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';

  /* ==================== 工具函数 ==================== */
  function uid() {
    return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtTime(ts) {
    var d = new Date(ts), now = new Date();
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
    var y = new Date(now.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return '昨天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }
  var AVATAR_COLORS = ['#3370FF', '#14C9C9', '#F5319D', '#FF7D00', '#7BC616', '#B65CD9', '#0E42D2', '#D83931'];
  function colorOf(name) {
    var h = 0, s = String(name || '?');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }
  function initial(name) {
    var s = String(name || '?').trim();
    return s ? s.slice(0, 1).toUpperCase() : '?';
  }

  /* ==================== 锚点：文本范围 <-> 字符偏移 ==================== */
  function getTextNodes(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !node.nodeValue.length) return NodeFilter.FILTER_REJECT;
        var p = node.parentNode;
        if (p && p.closest && p.closest('.anno-ui')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var arr = [], n;
    while ((n = walker.nextNode())) arr.push(n);
    return arr;
  }
  function rootText(root) {
    return getTextNodes(root).map(function (n) { return n.nodeValue; }).join('');
  }
  // 与 rootText/locate 使用同一套计数口径（TreeWalker 文本节点累加），
  // 避免 Range.toString() 在块级元素之间插入换行导致的字符偏移漂移
  function charOffset(root, node, offset) {
    var nodes = getTextNodes(root), acc = 0, i;
    if (node.nodeType === 3) {
      for (i = 0; i < nodes.length; i++) {
        if (nodes[i] === node) return acc + Math.min(offset, nodes[i].nodeValue.length);
        acc += nodes[i].nodeValue.length;
      }
      return acc;
    }
    // 元素节点边界（offset 为子节点索引）：取 [root 起点, node@offset) 区间内的文本长度
    try {
      var r = document.createRange();
      r.setStart(root, 0);
      r.setEnd(node, offset);
      for (i = 0; i < nodes.length; i++) {
        if (r.intersectsNode(nodes[i])) acc += nodes[i].nodeValue.length;
        else if (acc > 0) break;
      }
      return acc;
    } catch (e) { return 0; }
  }
  function locate(root, offset) {
    var nodes = getTextNodes(root), acc = 0;
    for (var i = 0; i < nodes.length; i++) {
      var len = nodes[i].nodeValue.length;
      if (acc + len >= offset) return { node: nodes[i], offset: Math.max(0, offset - acc) };
      acc += len;
    }
    var last = nodes[nodes.length - 1];
    return last ? { node: last, offset: last.nodeValue.length } : { node: root, offset: 0 };
  }
  function serializeRange(range, root) {
    var start = charOffset(root, range.startContainer, range.startOffset);
    var end = charOffset(root, range.endContainer, range.endOffset);
    if (start > end) { var t = start; start = end; end = t; }
    var full = rootText(root);
    return {
      start: start, end: end,
      text: full.slice(start, end),
      prefix: full.slice(Math.max(0, start - 24), start),
      suffix: full.slice(end, end + 24)
    };
  }
  function rangeFromAnchor(anchor, root) {
    // 先用字符偏移定位；若定位结果与记录的原文不符，则用 prefix/suffix 上下文重新搜索（抗漂移）
    var r = tryRangeByOffset(anchor, root);
    if (r && !r.collapsed && (!anchor.text || r.toString() === anchor.text)) return r;
    var found = searchByContext(anchor, root);
    if (found) return found;
    return r;
  }
  function tryRangeByOffset(anchor, root) {
    try {
      var s = locate(root, anchor.start), e = locate(root, anchor.end);
      var r = document.createRange();
      r.setStart(s.node, s.offset);
      r.setEnd(e.node, e.offset);
      return r;
    } catch (err) { return null; }
  }
  function searchByContext(anchor, root) {
    if (!anchor || !anchor.text) return null;
    var nodes = getTextNodes(root);
    var full = nodes.map(function (n) { return n.nodeValue; }).join('');
    var idx = -1;
    if (anchor.prefix) {
      var pi = full.indexOf(anchor.prefix);
      while (pi !== -1) {
        var cand = pi + anchor.prefix.length;
        if (full.substr(cand, anchor.text.length) === anchor.text) { idx = cand; break; }
        pi = full.indexOf(anchor.prefix, pi + 1);
      }
    }
    if (idx === -1) idx = full.indexOf(anchor.text);
    if (idx === -1) return null;
    try {
      var s = locate(root, idx), e = locate(root, idx + anchor.text.length);
      var r = document.createRange();
      r.setStart(s.node, s.offset);
      r.setEnd(e.node, e.offset);
      return r;
    } catch (err) { return null; }
  }

  /* ==================== 高亮渲染 ==================== */
  function unwrapHighlights(root) {
    var els = root.querySelectorAll('.anno-hl');
    for (var i = els.length - 1; i >= 0; i--) {
      var el = els[i], parent = el.parentNode;
      if (!parent) continue;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      parent.normalize();
    }
  }
  /* 只包文本节点：绝不把块级元素包进 inline <span>。
     否则浏览器会把 inline 拆成匿名块（block-in-inline），正文里凭空多出空行、行高变化；
     且每次重渲染都会越包越大（嵌套 span）。 */
  function textSegmentsInRange(range, root) {
    var nodes = getTextNodes(root), out = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      try { if (!range.intersectsNode(n)) continue; } catch (e) { continue; }
      var start = 0, end = n.nodeValue.length;
      if (n === range.startContainer) start = range.startOffset;
      if (n === range.endContainer) end = range.endOffset;
      if (end > start) out.push({ node: n, start: start, end: end });
    }
    return out;
  }
  // 一条批注可能对应多个高亮片段（跳行划选时按文本节点切开）
  function highlightsOf(id) {
    if (!A.root) return [];
    return Array.prototype.slice.call(A.root.querySelectorAll('.anno-hl[data-anno-id="' + id + '"]'));
  }
  function wrapRange(range, id, status) {
    var cls = 'anno-hl' + (status === 'resolved' ? ' anno-hl-resolved' : '') + (status === 'draft' ? ' anno-hl-draft' : '');
    var segs = textSegmentsInRange(range, A.root);
    if (!segs.length) return null;
    var first = null;
    // 从后往前处理：切分/插入只影响当前节点之后的部分，前面待处理节点的引用依旧有效
    for (var i = segs.length - 1; i >= 0; i--) {
      var seg = segs[i];
      if (!seg.node.parentNode) continue;
      var r = document.createRange();
      r.setStart(seg.node, seg.start);
      r.setEnd(seg.node, seg.end);
      var span = document.createElement('span');
      span.className = cls;
      span.setAttribute('data-anno-id', id);
      span.setAttribute('role', 'mark');
      span.appendChild(r.extractContents());   // 纯文本，不会带出块级元素
      r.insertNode(span);
      first = span;
    }
    return first;
  }

  /* ==================== 样式 ==================== */
  var CSS = [
    '.anno-ui{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;}',
    '.anno-ui *{box-sizing:border-box;}',

    /* 高亮 */
    /* 飞书文档风格：淡黄底 + 黄色下划线；用 inset box-shadow 画下划线，避免 border 改变行高造成抖动 */
    '.anno-hl{background:#FFF3C4;box-shadow:inset 0 -2px 0 #F5C33B;cursor:pointer;border-radius:2px;transition:background .15s,box-shadow .15s;}',
    '.anno-hl:hover{background:#FFEBA0;}',
    '.anno-hl.anno-hl-active{background:rgba(51,112,255,.22);box-shadow:inset 0 -2px 0 #3370FF;}',
    '.anno-hl.anno-hl-resolved{background:rgba(0,0,0,.045);box-shadow:inset 0 -2px 0 rgba(0,0,0,.18);}',
    '.anno-hl.anno-hl-draft{background:rgba(51,112,255,.22);box-shadow:inset 0 -2px 0 #3370FF;}',
    /* 宿主页面关闭批注层时（扩展用）：隐藏 UI + 去掉高亮，但不动 DOM */
    '.anno-hidden .anno-ui,.anno-hidden .anno-fab{display:none !important;}',
    '.anno-hidden .anno-hl{background:transparent !important;box-shadow:none !important;cursor:auto;}',
    '.anno-hidden .anno-shift{padding-right:0 !important;}',

    /* 浮动气泡 */
    '.anno-bubble{position:absolute;z-index:2147483000;background:#1F2329;color:#fff;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.28);padding:4px;display:none;}',
    '.anno-bubble button{all:unset;display:inline-flex;align-items:center;gap:6px;padding:6px 12px;font-size:13px;border-radius:6px;cursor:pointer;color:#fff;}',
    '.anno-bubble button:hover{background:rgba(255,255,255,.15);}',

    /* 悬浮预览 */
    '.anno-tip{position:absolute;z-index:2147483000;max-width:280px;background:#fff;border:1px solid #E5E6EB;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.14);padding:10px 12px;font-size:13px;line-height:1.55;color:#1F2329;display:none;pointer-events:none;}',
    '.anno-tip .anno-tip-name{font-weight:600;color:#3370FF;margin-bottom:2px;font-size:12px;}',

    /* 侧栏 */
    '.anno-sidebar{position:fixed;top:0;right:0;height:100%;width:340px;background:#fff;border-left:1px solid #E5E6EB;box-shadow:-4px 0 20px rgba(0,0,0,.06);z-index:2147482000;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .22s ease;}',
    '.anno-sidebar.anno-open{transform:translateX(0);}',
    /* 侧栏打开时给正文让出宽度，避免高亮被侧栏遮住（飞书同款行为） */
    '.anno-shift{padding-right:340px !important;transition:padding-right .22s ease;}',
    '.anno-head{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid #F0F1F5;}',
    '.anno-head h3{font-size:15px;font-weight:600;margin:0;color:#1F2329;flex:1;}',
    '.anno-head .anno-count{font-size:12px;color:#8A9099;background:#F2F3F5;border-radius:10px;padding:1px 8px;}',
    /* 当前署名 chip（点击可改名，多人评审时用于区分「谁说的」） */
    '.anno-who{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:4px;max-width:96px;padding:2px 6px 2px 2px;border-radius:999px;}',
    '.anno-who:hover{background:#F2F3F5;}',
    '.anno-who .anno-av{width:16px;height:16px;border-radius:50%;color:#fff;font-size:10px;font-weight:600;display:flex;align-items:center;justify-content:center;flex:0 0 auto;}',
    '.anno-who .anno-who-name{font-size:11px;color:#646A73;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.anno-name-input{width:88px;font:inherit;font-size:11px;color:#1F2329;border:1px solid #4F9CF9;border-radius:6px;padding:1px 4px;outline:none;}',
    '.anno-iconbtn{all:unset;width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#646A73;}',
    '.anno-iconbtn:hover{background:#F2F3F5;color:#1F2329;}',
    '.anno-iconbtn[disabled]{opacity:.28;cursor:not-allowed;}',
    '.anno-iconbtn[disabled]:hover{background:transparent;color:#646A73;}',
    '.anno-subbar{display:flex;align-items:center;gap:6px;padding:8px 16px;border-bottom:1px solid #F0F1F5;font-size:12px;color:#646A73;}',
    '.anno-subbar button{all:unset;cursor:pointer;padding:4px 8px;border-radius:6px;color:#646A73;}',
    '.anno-subbar button:hover{background:#F2F3F5;}',
    '.anno-list{flex:1;overflow-y:auto;padding:12px;}',
    '.anno-empty{color:#A5AAB3;font-size:13px;text-align:center;padding:40px 12px;line-height:1.7;}',

    /* 卡片 */
    '.anno-card{border:1px solid #E5E6EB;border-radius:10px;padding:12px;margin-bottom:12px;background:#fff;transition:box-shadow .15s,border-color .15s;}',
    '.anno-card:hover{border-color:#C9CDD4;}',
    '.anno-card.anno-card-active{border-color:#3370FF;box-shadow:0 0 0 3px rgba(51,112,255,.12);}',
    '.anno-card.anno-resolved{background:#FAFAFB;border-style:dashed;}',
    '.anno-card-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;}',
    '.anno-avatar{width:24px;height:24px;border-radius:50%;color:#fff;font-size:12px;display:flex;align-items:center;justify-content:center;flex:0 0 auto;font-weight:600;}',
    '.anno-name{font-size:13px;font-weight:600;color:#1F2329;}',
    '.anno-time{font-size:11px;color:#A5AAB3;flex:1;}',
    '.anno-card-head .anno-iconbtn{width:24px;height:24px;font-size:14px;}',
    '.anno-quote{font-size:12px;color:#646A73;background:#F7F8FA;border-left:3px solid #D9DCE0;border-radius:0 6px 6px 0;padding:6px 10px;margin:0 0 8px;line-height:1.5;max-height:66px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;}',
    '.anno-body{font-size:13px;line-height:1.65;color:#1F2329;white-space:pre-wrap;word-break:break-word;}',
    '.anno-reply{display:flex;gap:8px;margin-top:10px;padding-top:10px;border-top:1px dashed #F0F1F5;}',
    '.anno-reply .anno-avatar{width:20px;height:20px;font-size:11px;}',
    '.anno-reply-main{flex:1;min-width:0;}',
    '.anno-reply-meta{font-size:11px;color:#A5AAB3;margin-bottom:2px;}',
    '.anno-reply-meta b{color:#4E5969;font-weight:600;font-size:12px;}',
    '.anno-reply-body{font-size:13px;line-height:1.6;color:#1F2329;white-space:pre-wrap;word-break:break-word;}',
    '.anno-replybox{display:flex;gap:8px;margin-top:10px;align-items:flex-end;}',
    '.anno-replybox textarea{flex:1;resize:none;border:1px solid #E5E6EB;border-radius:8px;padding:7px 10px;font-size:13px;font-family:inherit;line-height:1.5;height:34px;max-height:120px;outline:none;color:#1F2329;}',
    '.anno-replybox textarea:focus{border-color:#3370FF;}',
    '.anno-btn{all:unset;cursor:pointer;background:#3370FF;color:#fff;font-size:13px;padding:7px 14px;border-radius:8px;font-weight:500;}',
    '.anno-btn:hover{background:#245BDB;}',
    '.anno-btn.anno-ghost{background:#F2F3F5;color:#4E5969;}',
    '.anno-btn.anno-ghost:hover{background:#E5E6EB;}',
    '.anno-draft{border:1px solid #3370FF;border-radius:10px;padding:12px;margin-bottom:12px;box-shadow:0 0 0 3px rgba(51,112,255,.12);}',
    '.anno-draft textarea{width:100%;resize:vertical;border:1px solid #E5E6EB;border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit;line-height:1.6;min-height:70px;outline:none;color:#1F2329;}',
    '.anno-draft textarea:focus{border-color:#3370FF;}',
    '.anno-draft-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px;}',
    '.anno-draft-hint{font-size:11px;color:#A5AAB3;margin-top:6px;}',

    /* 悬浮开关 */
    '.anno-fab{position:fixed;right:16px;bottom:20px;z-index:2147482000;display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #E5E6EB;border-radius:22px;padding:8px 14px;box-shadow:0 6px 18px rgba(0,0,0,.12);cursor:pointer;font-size:13px;font-weight:600;color:#1F2329;}',
    '.anno-fab:hover{border-color:#3370FF;color:#3370FF;}',
    '.anno-fab .anno-fab-badge{background:#3370FF;color:#fff;font-size:11px;border-radius:9px;padding:1px 7px;font-weight:600;}',
    '.anno-fab .anno-fab-badge.anno-zero{background:#E5E6EB;color:#8A9099;}',

    '.anno-presence{font-size:11px;color:#8A9099;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;}',
    '.anno-presence .anno-dot{width:6px;height:6px;border-radius:50%;background:#A5AAB3;flex:0 0 auto;}',
    '.anno-presence.anno-live .anno-dot{background:#34C724;box-shadow:0 0 0 3px rgba(52,199,36,.18);}',
    '.anno-presence.anno-off .anno-dot{background:#F53F3F;}',
    '.anno-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);z-index:2147483600;background:#1F2329;color:#fff;font-size:13px;padding:9px 16px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.25);opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;}',
    '.anno-toast.anno-show{opacity:1;transform:translateX(-50%) translateY(0);}',

    '@media (max-width:640px){.anno-sidebar{width:100%;}}'
  ].join('');

  /* ==================== 主对象 ==================== */
  var A = {
    version: VERSION,
    cfg: null,
    root: null,
    state: { annotations: [] },
    draft: null,
    showResolved: false,
    activeId: null,
    els: {},
    remote: null,          // 实时协作连接（null = 离线模式）
    clientId: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  };

  function injectCSS() {
    if (document.getElementById('anno-style')) return;
    var st = document.createElement('style');
    st.id = 'anno-style';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ---------- 存储 ---------- */
  function storageKey() {
    return A.cfg.storageKeyPrefix + A.cfg.docId;
  }
  function save() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify({ version: 1, docId: A.cfg.docId, annotations: A.state.annotations }));
    } catch (e) { console.warn('[annotator] 保存失败', e); }
  }
  function load() {
    // 1) 页面内联的种子批注（分发的独立 HTML 自带）
    var seeded = [];
    if (global.__ANNO_SEED__ && Array.isArray(global.__ANNO_SEED__.annotations)) {
      seeded = global.__ANNO_SEED__.annotations;
    }
    // 2) 本地已存的批注
    var local = [];
    try {
      var raw = localStorage.getItem(storageKey());
      if (raw) {
        var data = JSON.parse(raw);
        if (data && Array.isArray(data.annotations)) local = data.annotations;
      }
    } catch (e) { console.warn('[annotator] 读取失败', e); }
    // 合并：以 id 去重，本地优先（本地 = 我更新的编辑），种子里的回复并入
    var byId = {};
    seeded.forEach(function (a) { byId[a.id] = JSON.parse(JSON.stringify(a)); });
    local.forEach(function (a) {
      if (!byId[a.id]) { byId[a.id] = a; return; }
      var ex = byId[a.id];
      var ids = {}; (ex.replies || []).forEach(function (r) { ids[r.id] = 1; });
      (a.replies || []).forEach(function (r) { if (!ids[r.id]) { ex.replies = ex.replies || []; ex.replies.push(r); } });
      ex.body = a.body; ex.status = a.status; ex.anchor = a.anchor; ex.author = a.author;
    });
    A.state.annotations = Object.keys(byId).map(function (k) { return byId[k]; });
  }

  /* ==================== 实时协作层（v2） ==================== */
  function toast(msg) {
    if (!A.els.toast) {
      var t = document.createElement('div');
      t.className = 'anno-ui anno-toast';
      document.body.appendChild(t);
      A.els.toast = t;
    }
    A.els.toast.textContent = msg;
    A.els.toast.classList.add('anno-show');
    clearTimeout(A.els.toastTimer);
    A.els.toastTimer = setTimeout(function () { A.els.toast.classList.remove('anno-show'); }, 2200);
  }

  // 在本地应用一个操作（与服务端 applyOp 语义一致）
  function applyOpLocal(op) {
    var list = A.state.annotations;
    var find = function (id) { return list.filter(function (a) { return a.id === id; })[0]; };
    if (op.type === 'add') {
      if (op.annotation && !find(op.annotation.id)) list.push(op.annotation);
    } else if (op.type === 'reply') {
      var a = find(op.id);
      if (a) {
        a.replies = a.replies || [];
        if (!a.replies.some(function (r) { return r.id === op.reply.id; })) a.replies.push(op.reply);
      }
    } else if (op.type === 'status') {
      var b = find(op.id); if (b) b.status = op.status;
    } else if (op.type === 'delete') {
      var i = -1;
      for (var k = 0; k < list.length; k++) if (list[k].id === op.id) { i = k; break; }
      if (i >= 0) list.splice(i, 1);
    }
  }

  // 提交操作：本地立即生效，若已连服务则推送给其他人
  function commit(op) {
    applyOpLocal(op);
    save();
    applyHighlights();
    renderList();
    if (A.remote && A.remote.connected) postOp(op, false);
    return op;
  }

  // 署名被占用时，把已经应用到本地的署名改成新名字（不丢用户写的内容）
  function renameLocalAuthor(op, name) {
    if (op.type === 'add' && op.annotation) op.annotation.author = { name: name };
    if (op.type === 'reply' && op.reply) op.reply.author = { name: name };
    var i, a;
    if (op.type === 'add') {
      for (i = 0; i < A.state.annotations.length; i++) {
        a = A.state.annotations[i];
        if (a.id === op.annotation.id) a.author = { name: name };
      }
    } else if (op.type === 'reply') {
      for (i = 0; i < A.state.annotations.length; i++) {
        a = A.state.annotations[i];
        if (a.id === op.id) (a.replies || []).forEach(function (r) { if (r.id === op.reply.id) r.author = { name: name }; });
      }
    }
    save(); applyHighlights(); renderList();
  }

  function postOp(op, isRetry) {
    op.actor = A.cfg.author.name;          // 服务端据此校验身份
    fetch(A.remote.base + '/api/op?doc=' + encodeURIComponent(A.cfg.docId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc: A.cfg.docId, op: op })
    }).then(function (r) {
      if (r.status === 401) { toast('没有访问权限，请重新打开链接并输入口令'); return null; }
      return r.json().catch(function () { return null; });
    }).then(function (j) {
      if (!j || j.ok !== false) return;
      if (!isRetry && /占用/.test(j.error || '')) {
        // 名字被同组其他人占了：提示改名，改完自动重发（不用 prompt，iframe 里也能用）
        toast('这个名字已被别人用了，请改个署名');
        askAuthorName(function (ok) {
          if (!ok) { toast(j.error || '操作被服务端拒绝'); resync(); return; }
          renameLocalAuthor(op, A.cfg.author.name);
          postOp(op, true);          // 换名后重试，内容不丢
        });
        return;
      }
      toast(j.error || '操作被服务端拒绝');
      resync();
    }).catch(function () { toast('网络异常，已存本地'); });
  }

  // 服务端拒绝后，以服务端为准回滚本地（撤销越权/冲突的本地改动）
  function resync() {
    if (!A.remote) return;
    fetch(A.remote.base + '/api/state?doc=' + encodeURIComponent(A.cfg.docId))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && Array.isArray(data.annotations)) {
          A.state.annotations = data.annotations.slice();
          save(); applyHighlights(); renderList();
        }
      }).catch(function () {});
  }

  // 远端为准，仅把本地同 id 的回复并入（防丢）
  function mergeRemote(remoteList) {
    var localById = {};
    A.state.annotations.forEach(function (a) { localById[a.id] = a; });
    return remoteList.map(function (a) {
      var out = JSON.parse(JSON.stringify(a));
      out.replies = out.replies || [];
      var l = localById[a.id];
      if (l && l.replies && l.replies.length) {
        var ids = {}; out.replies.forEach(function (r) { ids[r.id] = 1; });
        l.replies.forEach(function (r) { if (!ids[r.id]) out.replies.push(r); });
      }
      return out;
    });
  }

  function setPresence(count, live) {
    if (!A.els.presence) return;
    A.els.presence.style.display = A.remote ? 'inline-flex' : 'none';
    A.els.presence.className = 'anno-presence' + (live ? ' anno-live' : ' anno-off');
    A.els.presence.innerHTML = '<span class="anno-dot"></span>' + (live ? count + ' 人在线' : '离线');
  }

  // 连接实时服务（如果检测到后端）
  function connectRemote(base) {
    base = normalizeBase(base);
    if (A.remote) return;
    A.remote = { base: base, connected: false, es: null, retry: 0 };
    A.cfg.storageKeyPrefix = A.cfg.storageKeyPrefix; // 保留

    // 1) 拉全量状态
    fetch(base + '/api/state?doc=' + encodeURIComponent(A.cfg.docId))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && Array.isArray(data.annotations)) {
          A.state.annotations = mergeRemote(data.annotations);
          applyHighlights(); renderList();
        }
        openStream();
      })
      .catch(function () { A.remote = null; setPresence(0, false); });

    // 2) 订阅实时推送
    function openStream() {
      if (!A.remote) return;
      var es = new EventSource(base + '/api/stream?doc=' + encodeURIComponent(A.cfg.docId));
      A.remote.es = es;
      es.onopen = function () { A.remote.connected = true; A.remote.retry = 0; };
      es.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.type === 'sync') {
          if (Array.isArray(msg.annotations)) {
            A.state.annotations = mergeRemote(msg.annotations);
            save(); applyHighlights(); renderList();
          }
        } else if (msg.type === 'op') {
          applyOpLocal(msg.op);
          save(); applyHighlights(); renderList();
        } else if (msg.type === 'presence') {
          setPresence(msg.count, true);
        }
      };
      es.onerror = function () {
        A.remote.connected = false;
        setPresence(0, false);
        // EventSource 会自动重连；这里只在彻底断开时提示
        A.remote.retry++;
      };
    }
    setPresence(0, true);
  }

  // 探测同源是否有协作后端
  // 后端地址归一化：页面里可能有 <base href>（代理/保存的稿子会加），
  // 它会把 '/api/health' 这种相对地址解析到远端域名去，导致跨域被拦、实时接不上。
  // 所以空 base 一律钉到 location.origin（file: 下为空字符串，走离线兜底）。
  function normalizeBase(b) {
    if (!b) {
      try {
        var o = global.location && global.location.origin;
        return /^https?:/i.test(o || '') ? o : '';
      } catch (e) { return ''; }
    }
    return String(b).replace(/\/+$/, '');
  }

  function detectAndConnect(base) {
    var b = normalizeBase(base);
    fetch(b + '/api/health', { method: 'GET' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (h) { if (h && h.ok) connectRemote(b); })
      .catch(function () { /* 无后端，纯离线 */ });
  }

  /* ---------- 渲染高亮 ---------- */
  function applyHighlights() {
    if (!A.root) return;
    unwrapHighlights(A.root);
    var list = A.state.annotations.slice().sort(function (a, b) { return a.anchor.start - b.anchor.start; });
    list.forEach(function (a) {
      try {
        var r = rangeFromAnchor(a.anchor, A.root);
        if (r.collapsed) return;
        wrapRange(r, a.id, a.status);
      } catch (e) { /* 锚点失效则跳过 */ }
    });
    if (A.draft) {
      try {
        var dr = rangeFromAnchor(A.draft.anchor, A.root);
        if (!dr.collapsed) wrapRange(dr, A.draft.id, 'draft');
      } catch (e) {}
    }
  }

  /* ---------- 权限：只能改自己的批注 ---------- */
  function sameAuthor(a) {
    var mine = String(A.cfg.author.name || '').trim();
    return !!mine && !!a && !!a.author && String(a.author.name || '').trim() === mine;
  }

  /* ---------- 侧栏渲染 ---------- */
  function openCount() {
    return A.state.annotations.filter(function (a) { return a.status !== 'resolved'; }).length;
  }
  function renderList() {
    var list = A.els.list;
    var items = A.state.annotations.slice().sort(function (a, b) { return a.anchor.start - b.anchor.start; });
    if (!A.showResolved) items = items.filter(function (a) { return a.status !== 'resolved'; });

    var html = '';
    if (!items.length && !A.draft) {
      html = '<div class="anno-empty">还没有批注<br>在正文里划选文字，点击「批注」即可</div>';
    } else {
      // 草稿卡片也按它在正文中的位置插入，而不是永远钉在最顶部
      var seq = items.slice();
      if (A.draft) {
        var at = seq.length;
        for (var i = 0; i < seq.length; i++) {
          if ((seq[i].anchor.start || 0) > A.draft.anchor.start) { at = i; break; }
        }
        seq.splice(at, 0, { __draft: true });
      }
      html = seq.map(function (it) { return it.__draft ? draftCardHTML(A.draft) : cardHTML(it); }).join('');
    }
    list.innerHTML = html;
    A.els.count.textContent = openCount();
    A.els.badge.textContent = openCount();
    A.els.badge.className = 'anno-fab-badge' + (openCount() ? '' : ' anno-zero');
    A.els.subbar.style.display = (A.state.annotations.some(function (a) { return a.status === 'resolved'; })) ? 'flex' : 'none';
    A.els.resolveToggle.textContent = A.showResolved ? '隐藏已解决' : '显示已解决';

    var draftTA = list.querySelector('.anno-draft textarea');
    if (draftTA) { draftTA.focus(); }
    if (A.activeId) {
      var actCard = list.querySelector('.anno-card[data-id="' + A.activeId + '"]');
      if (actCard) actCard.classList.add('anno-card-active');
    }
  }
  function draftCardHTML(d) {
    return '' +
      '<div class="anno-draft" data-id="' + d.id + '">' +
        '<blockquote class="anno-quote">' + esc(d.anchor.text) + '</blockquote>' +
        '<textarea placeholder="写下你的批注…">' + esc(d.body || '') + '</textarea>' +
        '<div class="anno-draft-hint">⌘/Ctrl + Enter 提交</div>' +
        '<div class="anno-draft-actions">' +
          '<button class="anno-btn anno-ghost" data-act="cancel">取消</button>' +
          '<button class="anno-btn" data-act="submit">批注</button>' +
        '</div>' +
      '</div>';
  }
  function cardHTML(a) {
    var resolved = a.status === 'resolved';
    // 权限：只有作者本人能标记已解决 / 删除自己的批注（服务端同样校验）
    var mine = sameAuthor(a);
    var resolveTitle = mine ? (resolved ? '重新打开' : '标记为已解决') : '只有作者本人可以标记已解决';
    var deleteTitle = mine ? '删除' : '只有作者本人可以删除';
    var replies = (a.replies || []).map(function (r) {
      return '' +
        '<div class="anno-reply">' +
          '<span class="anno-avatar" style="background:' + colorOf(r.author.name) + '">' + esc(initial(r.author.name)) + '</span>' +
          '<div class="anno-reply-main">' +
            '<div class="anno-reply-meta"><b>' + esc(r.author.name) + '</b> · ' + fmtTime(r.createdAt) + '</div>' +
            '<div class="anno-reply-body">' + esc(r.body) + '</div>' +
          '</div>' +
        '</div>';
    }).join('');

    return '' +
      '<div class="anno-card' + (resolved ? ' anno-resolved' : '') + '" data-id="' + a.id + '">' +
        '<div class="anno-card-head">' +
          '<span class="anno-avatar" style="background:' + colorOf(a.author.name) + '">' + esc(initial(a.author.name)) + '</span>' +
          '<span class="anno-name">' + esc(a.author.name) + '</span>' +
          '<span class="anno-time">' + fmtTime(a.createdAt) + (resolved ? ' · 已解决' : '') + '</span>' +
          '<button class="anno-iconbtn" data-act="resolve" title="' + resolveTitle + '"' + (mine ? '' : ' disabled') + '>' + (resolved ? '↺' : '✓') + '</button>' +
          '<button class="anno-iconbtn" data-act="delete" title="' + deleteTitle + '"' + (mine ? '' : ' disabled') + '>✕</button>' +
        '</div>' +
        '<blockquote class="anno-quote">' + esc(a.anchor.text) + '</blockquote>' +
        '<div class="anno-body">' + esc(a.body) + '</div>' +
        (replies ? '<div class="anno-replies">' + replies + '</div>' : '') +
        '<div class="anno-replybox">' +
          '<textarea rows="1" placeholder="回复…"></textarea>' +
          '<button class="anno-btn" data-act="reply">回复</button>' +
        '</div>' +
      '</div>';
  }

  /* ---------- 选中气泡 ---------- */
  function hideBubble() { A.els.bubble.style.display = 'none'; }
  function showBubble(rect) {
    var b = A.els.bubble;
    b.style.display = 'block';
    var top = rect.top + window.scrollY - b.offsetHeight - 8;
    var left = rect.left + window.scrollX + rect.width / 2 - b.offsetWidth / 2;
    if (top < window.scrollY + 4) top = rect.bottom + window.scrollY + 8;
    if (left < 8) left = 8;
    if (left + b.offsetWidth > document.documentElement.clientWidth - 8) {
      left = document.documentElement.clientWidth - b.offsetWidth - 8;
    }
    b.style.top = top + 'px';
    b.style.left = left + 'px';
  }
  function currentSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    if (!A.root.contains(range.commonAncestorContainer)) return null;
    var node = range.commonAncestorContainer;
    var el = node.nodeType === 1 ? node : node.parentNode;
    if (el && el.closest && el.closest('.anno-ui')) return null;
    if (!range.toString().trim()) return null;
    return range;
  }

  /* ---------- 交互：创建批注 ---------- */
  function beginDraft(range) {
    A.draft = {
      id: uid(),
      anchor: serializeRange(range, A.root),
      body: ''
    };
    window.getSelection().removeAllRanges();
    hideBubble();
    applyHighlights();
    openSidebar();
    renderList();
  }
  function submitDraft() {
    if (!A.draft) return;
    var ta = A.els.list.querySelector('.anno-draft textarea');
    var body = ta ? ta.value.trim() : '';
    if (!body) { ta && ta.focus(); return; }
    // 首次批注且还是临时访客名 → 不弹窗阻塞提交，先存下，再提示可以改署名
    if (isGuestName(A.cfg.author.name) && !A.askedName) {
      A.askedName = true;
      toast('当前是临时署名「' + A.cfg.author.name + '」，点侧栏右上角名字可改');
    }
    var ann = {
      id: A.draft.id,
      createdAt: Date.now(),
      author: { name: A.cfg.author.name },
      anchor: A.draft.anchor,
      body: body,
      status: 'open',
      replies: []
    };
    var id = ann.id;
    A.draft = null;
    commit({ type: 'add', annotation: ann });
    activate(id);
  }
  function cancelDraft() {
    A.draft = null;
    applyHighlights();
    renderList();
  }

  /* ---------- 侧栏开关 ---------- */
  function openSidebar() {
    A.els.sidebar.classList.add('anno-open');
    A.els.fab.style.display = 'none';
    if (A.root) A.root.classList.add('anno-shift');
    suppressUntil = 0;
    notifyReflow();
    syncFromScroll();
  }
  function closeSidebar() {
    A.els.sidebar.classList.remove('anno-open');
    A.els.fab.style.display = 'flex';
    if (A.root) A.root.classList.remove('anno-shift');
    notifyReflow();
  }
  /* 侧栏开合靠 .anno-shift 改正文宽度，window 尺寸并没变，
     图表库（echarts 等）收不到 resize 就不会重排 → 图表会被侧栏遮住。
     这里在过渡开始和结束各派发一次 resize，让宿主页面自行重排。 */
  var reflowTimers = [];
  function notifyReflow() {
    reflowTimers.forEach(clearTimeout);
    reflowTimers = [0, 260].map(function (d) {
      return setTimeout(function () {
        try { window.dispatchEvent(new Event('resize')); } catch (e) {}
      }, d);
    });
  }
  function toggleSidebar() {
    if (A.els.sidebar.classList.contains('anno-open')) closeSidebar();
    else openSidebar();
  }

  /* ---------- 高亮 <-> 卡片联动 ---------- */
  function clearActive() {
    A.els.list.querySelectorAll('.anno-card-active').forEach(function (c) { c.classList.remove('anno-card-active'); });
    A.root.querySelectorAll('.anno-hl-active').forEach(function (h) { h.classList.remove('anno-hl-active'); });
    A.activeId = null;
  }

  // 滚动联动状态
  var syncRAF = null;
  var suppressUntil = 0;
  // 只高亮侧栏卡片（绝不滚动页面），供滚动联动使用
  function setCardActive(id) {
    A.activeId = id;
    A.els.list.querySelectorAll('.anno-card-active').forEach(function (c) { c.classList.remove('anno-card-active'); });
    A.root.querySelectorAll('.anno-hl-active').forEach(function (h) { h.classList.remove('anno-hl-active'); });
    var card = A.els.list.querySelector('.anno-card[data-id="' + id + '"]');
    if (!card) return;
    card.classList.add('anno-card-active');
    var list = A.els.list, ct = card.offsetTop, cb = ct + card.offsetHeight;
    if (ct < list.scrollTop || cb > list.scrollTop + list.clientHeight) {
      list.scrollTo({ top: Math.max(0, ct - list.clientHeight / 2 + card.offsetHeight / 2), behavior: 'smooth' });
    }
  }
  // 滚动正文时反查当前可见的高亮，联动侧栏卡片（飞书同款行为）
  function syncFromScroll() {
    if (syncRAF) return;
    syncRAF = requestAnimationFrame(function () {
      syncRAF = null;
      if (!A.els.sidebar.classList.contains('anno-open')) return;
      if (Date.now() < suppressUntil) return;
      if (A.draft) return;
      // 以视口中线为「阅读位置」，取中心离它最近的一条高亮
      var refY = window.innerHeight * 0.5;
      var hls = A.root.querySelectorAll('.anno-hl[data-anno-id]');
      var best = null, bestScore = Infinity;
      for (var i = 0; i < hls.length; i++) {
        var r = hls[i].getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) continue;
        var score = (r.top <= refY && r.bottom >= refY) ? -1 : Math.abs((r.top + r.height / 2) - refY);
        if (score < bestScore) { bestScore = score; best = hls[i]; }
      }
      if (!best) return;
      var id = best.getAttribute('data-anno-id');
      if (id === A.activeId) return;
      setCardActive(id);
    });
  }
  // 统一激活：同时选中侧栏卡片与正文高亮，并把两者分别滚到各自可见区中央
  function activate(id) {
    clearActive();
    A.activeId = id;
    suppressUntil = Date.now() + 800; // 程序化滚动期间抑制联动，避免把自己顶掉
    // 1) 侧栏卡片：只滚侧栏内部（绝不能用 scrollIntoView，否则会连外层页面一起滚，导致正文高亮漂移）
    var card = A.els.list.querySelector('.anno-card[data-id="' + id + '"]');
    if (card) {
      card.classList.add('anno-card-active');
      var list = A.els.list;
      list.scrollTo({ top: Math.max(0, card.offsetTop - list.clientHeight / 2 + card.offsetHeight / 2), behavior: 'smooth' });
    }
    // 2) 正文高亮：垂直居中于「侧栏之外的可见区」（一条批注可能有多段高亮）
    var hls = highlightsOf(id);
    if (hls.length) {
      hls.forEach(function (h) { h.classList.add('anno-hl-active'); });
      requestAnimationFrame(function () {
        var r = hls[0].getBoundingClientRect();
        var target = window.scrollY + r.top - (window.innerHeight - r.height) / 2;
        window.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
      });
    }
  }

  /* ---------- 导出 / 导入 ---------- */
  function exportJSON() {
    var payload = {
      version: 1,
      docId: A.cfg.docId,
      exportedAt: new Date().toISOString(),
      pageTitle: document.title,
      pageUrl: location.href,
      annotations: A.state.annotations
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (A.cfg.docId || 'annotations') + '.anno.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function importJSON(text) {
    var data = JSON.parse(text);
    var incoming = (data && data.annotations) || [];
    if (!Array.isArray(incoming)) throw new Error('格式不正确');
    // 以 id 合并：新来的补充/更新，本地已有的保留
    var byId = {};
    A.state.annotations.forEach(function (a) { byId[a.id] = a; });
    var added = 0;
    incoming.forEach(function (a) {
      if (!byId[a.id]) { A.state.annotations.push(a); added++; }
      else {
        // 合并回复（按 id 去重）
        var ex = byId[a.id];
        var ids = {}; (ex.replies || []).forEach(function (r) { ids[r.id] = 1; });
        (a.replies || []).forEach(function (r) { if (!ids[r.id]) { ex.replies = ex.replies || []; ex.replies.push(r); } });
      }
    });
    save();
    applyHighlights();
    renderList();
    return added;
  }
  function importFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var added = importJSON(reader.result);
        alert('导入成功，新增 ' + added + ' 条批注');
      } catch (e) { alert('导入失败：' + e.message); }
    };
    reader.readAsText(file);
  }

  /* ---------- 构建 DOM ---------- */
  function build() {
    injectCSS();
    A.root = document.querySelector(A.cfg.contentSelector) || document.body;

    // 浮动开关
    var fab = document.createElement('div');
    fab.className = 'anno-ui anno-fab';
    fab.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg><span>批注</span><span class="anno-fab-badge anno-zero">0</span>';
    document.body.appendChild(fab);

    // 侧栏
    var sb = document.createElement('div');
    sb.className = 'anno-ui anno-sidebar';
    sb.innerHTML = '' +
      '<div class="anno-head">' +
        '<h3>批注</h3>' +
        '<span class="anno-count">0</span>' +
        '<span class="anno-presence" style="display:none"></span>' +
        '<button class="anno-who" data-act="who" title="点击修改我的署名（会显示在你的批注上）"></button>' +
        '<button class="anno-iconbtn" data-act="export" title="导出批注 JSON">⬇</button>' +
        '<button class="anno-iconbtn" data-act="import" title="导入批注 JSON">⬆</button>' +
        '<button class="anno-iconbtn" data-act="export-html" title="导出带批注的独立 HTML（发给别人）">⤓</button>' +
        '<button class="anno-iconbtn" data-act="close" title="收起">✕</button>' +
      '</div>' +
      '<div class="anno-subbar" style="display:none">' +
        '<span style="flex:1"></span>' +
        '<button data-act="toggle-resolved">显示已解决</button>' +
      '</div>' +
      '<div class="anno-list"></div>';
    document.body.appendChild(sb);

    // 气泡
    var bubble = document.createElement('div');
    bubble.className = 'anno-ui anno-bubble';
    bubble.innerHTML = '<button data-act="add">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>批注</button>';
    document.body.appendChild(bubble);

    // 悬浮预览
    var tip = document.createElement('div');
    tip.className = 'anno-ui anno-tip';
    document.body.appendChild(tip);

    // 隐藏的文件输入
    var fileInput = document.createElement('input');
    fileInput.className = 'anno-ui anno-fileinput';  // 带 anno-ui：宿主保存时能一键剥干净
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);

    A.els = {
      fab: fab, sidebar: sb, list: sb.querySelector('.anno-list'),
      count: sb.querySelector('.anno-count'), bubble: bubble, tip: tip,
      subbar: sb.querySelector('.anno-subbar'),
      resolveToggle: sb.querySelector('[data-act="toggle-resolved"]'),
      presence: sb.querySelector('.anno-presence'),
      who: sb.querySelector('.anno-who'),
      fileInput: fileInput, badge: fab.querySelector('.anno-fab-badge')
    };

    bindEvents();
  }

  function bindEvents() {
    var els = A.els;

    // 划词
    document.addEventListener('mouseup', function (e) {
      if (e.target.closest && e.target.closest('.anno-ui')) return;
      setTimeout(function () {
        var range = currentSelection();
        if (range) showBubble(range.getBoundingClientRect());
        else hideBubble();
      }, 0);
    });
    document.addEventListener('mousedown', function (e) {
      if (!(e.target.closest && e.target.closest('.anno-bubble'))) hideBubble();
    });
    window.addEventListener('scroll', hideBubble, true);
    // 滚动正文 → 侧栏卡片联动高亮（非捕获，避免响应侧栏内部滚动造成循环）
    window.addEventListener('scroll', syncFromScroll, { passive: true });

    // 气泡按钮
    els.bubble.addEventListener('mousedown', function (e) { e.preventDefault(); });
    els.bubble.addEventListener('click', function () {
      var range = currentSelection();
      if (range) beginDraft(range);
    });

    // 悬浮开关
    els.fab.addEventListener('click', openSidebar);

    // 侧栏头部按钮
    els.sidebar.querySelector('.anno-head').addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      var a = act.getAttribute('data-act');
      if (a === 'close') closeSidebar();
      else if (a === 'who') askAuthorName();
      else if (a === 'export') exportJSON();
      else if (a === 'import') els.fileInput.click();
      else if (a === 'export-html') exportStandalone();
    });
    els.resolveToggle.addEventListener('click', function () {
      A.showResolved = !A.showResolved;
      renderList();
    });
    els.fileInput.addEventListener('change', function () {
      if (els.fileInput.files[0]) { importFile(els.fileInput.files[0]); els.fileInput.value = ''; }
    });

    // 列表事件（事件委托）
    els.list.addEventListener('click', function (e) {
      var actEl = e.target.closest('[data-act]');
      var card = e.target.closest('[data-id]');
      var id = card && card.getAttribute('data-id');

      if (actEl) {
        var act = actEl.getAttribute('data-act');
        if (act === 'submit') return submitDraft();
        if (act === 'cancel') return cancelDraft();
        if (act === 'reply') return doReply(id, card);
        if (act === 'resolve' || act === 'delete') {
          var target = A.state.annotations.filter(function (x) { return x.id === id; })[0];
          if (target && !sameAuthor(target)) {
            toast('只有作者本人（' + target.author.name + '）可以' + (act === 'delete' ? '删除' : '标记已解决'));
            return;
          }
          if (act === 'resolve') return toggleResolve(id);
          return doDelete(id);
        }
      }
      if (id) activate(id);
    });
    els.list.addEventListener('keydown', function (e) {
      var draft = e.target.closest('.anno-draft');
      if (draft && (e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitDraft(); }
      if (e.target.tagName === 'TEXTAREA' && e.target.closest('.anno-replybox') && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        var card = e.target.closest('.anno-card');
        doReply(card.getAttribute('data-id'), card);
      }
    });
    // 输入同步草稿
    els.list.addEventListener('input', function (e) {
      if (A.draft && e.target.closest('.anno-draft')) A.draft.body = e.target.value;
    });

    // 点击高亮
    A.root.addEventListener('click', function (e) {
      var hl = e.target.closest && e.target.closest('.anno-hl');
      if (!hl) return;
      var id = hl.getAttribute('data-anno-id');
      openSidebar();
      if (A.state.annotations.some(function (x) { return x.id === id && x.status === 'resolved'; })) A.showResolved = true;
      renderList();
      activate(id);
    });
    // 悬浮高亮预览
    var tipTimer;
    A.root.addEventListener('mouseover', function (e) {
      var hl = e.target.closest && e.target.closest('.anno-hl');
      if (!hl) return;
      clearTimeout(tipTimer);
      tipTimer = setTimeout(function () {
        var id = hl.getAttribute('data-anno-id');
        var a = A.state.annotations.filter(function (x) { return x.id === id; })[0];
        if (!a) return;
        els.tip.innerHTML = '<div class="anno-tip-name">' + esc(a.author.name) + '</div>' + esc(a.body).slice(0, 160);
        els.tip.style.display = 'block';
        var r = hl.getBoundingClientRect();
        els.tip.style.top = (r.bottom + window.scrollY + 8) + 'px';
        els.tip.style.left = (r.left + window.scrollX) + 'px';
      }, 220);
    });
    A.root.addEventListener('mouseout', function (e) {
      if (e.target.closest && e.target.closest('.anno-hl')) { clearTimeout(tipTimer); els.tip.style.display = 'none'; }
    });
    window.addEventListener('resize', function () { els.tip.style.display = 'none'; });
  }

  function doReply(id, card) {
    var ta = card.querySelector('.anno-replybox textarea');
    var body = ta.value.trim();
    if (!body) { ta.focus(); return; }
    var a = A.state.annotations.filter(function (x) { return x.id === id; })[0];
    if (!a) return;
    var reply = { id: uid(), createdAt: Date.now(), author: { name: A.cfg.author.name }, body: body };
    commit({ type: 'reply', id: id, reply: reply });
    activate(id);
  }
  function toggleResolve(id) {
    var a = A.state.annotations.filter(function (x) { return x.id === id; })[0];
    if (!a) return;
    var next = a.status === 'resolved' ? 'open' : 'resolved';
    commit({ type: 'status', id: id, status: next });
  }
  function doDelete(id) {
    if (!confirm('确定删除这条批注？')) return;
    commit({ type: 'delete', id: id });
  }

  /* ==================== 初始化 ==================== */
  function resolveDocId() {
    var m = document.querySelector('meta[name="anno-doc-id"]');
    if (m && m.content) return m.content;
    var cs = document.currentScript;
    if (cs && cs.getAttribute('data-doc-id')) return cs.getAttribute('data-doc-id');
    return location.pathname.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'index';
  }
  /* ---------- 署名：多人评审时用来区分「谁说的」 ---------- */
  var GUEST_RE = /^(访客|匿名|我$)/;
  function isGuestName(n) { return !n || GUEST_RE.test(String(n)); }
  function renderWho() {
    var el = A.els && A.els.who;
    if (!el) return;
    var name = A.cfg.author.name;
    el.innerHTML = '<span class="anno-av" style="background:' + colorOf(name) + '">' + esc(initial(name)) +
      '</span><span class="anno-who-name">' + esc(name) + '</span>';
  }
  function setAuthorName(name) {
    name = String(name || '').trim().slice(0, 24);
    if (!name) return false;
    A.cfg.author.name = name;
    try { localStorage.setItem('anno-author-name', name); } catch (e) {}
    renderWho();
    return true;
  }
  // 改署名：用侧栏里的内联输入，不用 window.prompt
  // （prompt 是阻塞式原生弹窗：在 iframe 里会被浏览器忽略→批注静默失败；无头环境直接卡死主线程）
  // 返回 true 表示编辑器已打开（不等结果），结果通过回调告知
  function askAuthorName(done) {
    var el = A.els && A.els.who;
    if (!el) return false;
    var old = el.querySelector('input');
    if (old) { old.focus(); return true; }
    var cur = isGuestName(A.cfg.author.name) ? '' : A.cfg.author.name;
    el.innerHTML = '<input class="anno-name-input" maxlength="24" placeholder="你的署名" value="' + esc(cur) + '">';
    var inp = el.querySelector('input');
    var finished = false;
    function finish(save) {
      if (finished) return;
      finished = true;
      var val = (inp.value || '').trim();
      renderWho();
      var ok = false;
      if (save && val) ok = !!setAuthorName(val);
      if (typeof done === 'function') done(ok);
    }
    try { inp.focus(); inp.select(); } catch (e) {}
    inp.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', function () { finish(true); });
    return true;
  }

  function resolveAuthor() {
    var cs = document.currentScript;
    if (cs && cs.getAttribute('data-author')) return cs.getAttribute('data-author');
    try {
      var stored = localStorage.getItem('anno-author-name');
      if (stored) return stored;
      // 首次进入给一个可区分的临时署名，避免多人共享时全部显示「我」
      var guest = '访客' + Math.random().toString(36).slice(2, 5).toUpperCase();
      localStorage.setItem('anno-author-name', guest);
      return guest;
    } catch (e) { return '访客'; }
  }

  /* ---------- 导出独立 HTML（把批注内联进页面快照） ---------- */
  function getSelfSource() {
    var scripts = document.scripts, found = '';
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      if (s.getAttribute('data-anno-self') === '1') { found = s.textContent; break; }
      var src = s.getAttribute('src') || '';
      if (/annotator(\.min)?\.js(\?|$)/.test(src)) {
        if (!s.getAttribute('src') || s.textContent.length > 200) { found = s.textContent; }
        else {
          try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', src, false);
            xhr.send(null);
            if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) found = xhr.responseText;
          } catch (e) { /* file:// 下读不到，走离线兜底 */ }
        }
        break;
      }
    }
    return found;
  }
  function unwrapIn(root) { unwrapHighlights(root); }
  function exportStandalone() {
    var src = getSelfSource();
    if (!src) {
      alert('无法读取引擎源码（file:// 下受限）。请改用命令行打包：node build.mjs <你的稿子.html>');
      return;
    }
    var clone = document.documentElement.cloneNode(true);
    // 清掉运行时注入的 UI 与高亮包裹，还原干净正文
    clone.querySelectorAll('.anno-ui, #anno-style, .anno-tip, .anno-bubble, .anno-fab, .anno-sidebar').forEach(function (n) { n.remove(); });
    clone.querySelectorAll('.anno-shift').forEach(function (n) { n.classList.remove('anno-shift'); });
    unwrapIn(clone);
    // 去掉原来的引擎引用 script
    clone.querySelectorAll('script').forEach(function (s) {
      var sr = s.getAttribute('src') || '';
      if (/annotator(\.min)?\.js/.test(sr)) s.remove();
      else if (s.getAttribute('data-anno-self') === '1') s.remove();
      else if (s.textContent && s.textContent.indexOf('__ANNO_SEED__') !== -1 && s.textContent.indexOf('annotations') !== -1) s.remove();
    });
    // 注入种子数据 + 内联引擎
    var seed = document.createElement('script');
    seed.textContent = 'window.__ANNO_SEED__=' + JSON.stringify({ docId: A.cfg.docId, annotations: A.state.annotations }) + ';';
    var eng = document.createElement('script');
    eng.setAttribute('data-anno-self', '1');
    eng.textContent = '\n' + src.replace(/<\/script/gi, '<\\/script') + '\n';
    clone.appendChild(seed);
    clone.appendChild(eng);

    var html = '<!DOCTYPE html>\n' + clone.outerHTML;
    var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (A.cfg.docId || 'review') + '.review.html';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  A.init = function (opts) {
    opts = opts || {};
    A.cfg = {
      contentSelector: opts.contentSelector || 'body',
      docId: opts.docId || resolveDocId(),
      storageKeyPrefix: opts.storageKeyPrefix || 'htmlanno:',
      author: opts.author || { name: resolveAuthor() }
    };
    A.showResolved = !!opts.showResolved;
    build();
    load();
    applyHighlights();
    renderList();
    renderWho();
    if (opts.startOpen !== false && openCount() > 0) openSidebar();
    // v2: 实时协作 —— 显式指定 remote 优先，否则同源自动探测
    if (opts.remote) {
      connectRemote(typeof opts.remote === 'string' ? opts.remote : '');
    } else if (opts.remote !== false) {
      detectAndConnect('');
    }
    return A;
  };
  A.add = function (opts) { /* 供外部程序化添加 */ };
  A.connect = function (base) { connectRemote(base || ''); };
  A.isLive = function () { return !!(A.remote && A.remote.connected); };
  A.isInited = function () { return !!A.root; };
  // 宿主页面（浏览器扩展等）用：按需开关整个批注层，不销毁数据
  A.setActive = function (on) {
    if (!A.root) return;
    document.documentElement.classList.toggle('anno-hidden', !on);
    if (!on) closeSidebar();
  };
  A.isActive = function () {
    return !!A.root && !document.documentElement.classList.contains('anno-hidden');
  };
  A.openSidebar = openSidebar;
  A.closeSidebar = closeSidebar;
  A.toggleSidebar = function () {
    if (!A.root) return;
    A.els.sidebar.classList.contains('anno-open') ? closeSidebar() : openSidebar();
  };

  // 自动初始化
  function autoInit() {
    if (global.__ANNO_DISABLE_AUTOINIT__) return;
    A.init({});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoInit);
  else autoInit();

  global.HtmlAnnotator = A;
})(window);
