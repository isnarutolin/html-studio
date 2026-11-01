/**
 * HTML Studio — 内容脚本
 *
 * 两种页面都能改：
 *   本地文件（file://）  → Cmd+S 直接写回原文件，自动备份、可撤销
 *   网页（http/https）    → 第一次保存写成一个本地 html 文件（默认落在 ~/Downloads），
 *                          之后 Cmd+S 都写那个文件；相对路径的资源会转成绝对地址，
 *                          这样存到本地打开时样式和图片不会丢
 *
 * 磁盘读写由 native messaging 交给本地 python host（extension/native_host.py）完成。
 */
(() => {
  'use strict';
  if (window.__HTML_STUDIO_LOADED__) return;
  window.__HTML_STUDIO_LOADED__ = true;

  const HOST_NAME = 'com.narutolin.htmlstudio';
  const MARK = '__html_studio_host__';
  const STYLE_ID = '__html_studio_style__';

  /* ---------------- 只在 html 文档上工作 ---------------- */
  if (window.top !== window) return;
  if (document.contentType && !/html/i.test(document.contentType)) return;

  // 路径里带不合法百分号（比如 /100%/x）时 decodeURIComponent 会抛，兜住它
  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (_) { return s; }
  }

  const IS_FILE = location.protocol === 'file:';
  const PATHNAME = safeDecode(location.pathname || '');
  const IS_HTML_PATH = /\.(html?|xhtml)$/i.test(PATHNAME);

  // 本地 html 一律自动出现 ✎；网页只在地址本身像 html 文件时自动出现，
  // 其余网站（比如分享链接）点工具栏图标 / 右键菜单再进编辑，避免污染每个网站
  const AUTOSHOW = IS_FILE || IS_HTML_PATH;

  if (IS_FILE && !IS_HTML_PATH) return;

  const sourcePath = IS_FILE
    ? safeDecode(location.href.replace(/^file:\/\//, '')).replace(/[?#].*$/, '')
    : null;

  /* ---------------- 网页 → 本地文件的落点 ---------------- */
  const LS_KEY = 'hs:target:' + location.origin + location.pathname;

  function readSavedTarget() {
    try { return localStorage.getItem(LS_KEY) || null; } catch (_) { return null; }
  }
  function rememberTarget(p) {
    try { localStorage.setItem(LS_KEY, p); } catch (_) { /* 隐私模式下写不了，无所谓 */ }
  }

  /** https://a.com/b/c.html → ~/Downloads/a.com-b-c.html */
  function defaultRemotePath() {
    const host = (location.hostname || 'page').replace(/[^a-z0-9.-]/gi, '');
    let segs = (location.pathname || '/')
      .split('/')
      .filter(Boolean)
      .map((s) => s.replace(/[^a-z0-9._-]/gi, ''));
    let name = segs.pop() || 'index';
    if (!/\.html?$/i.test(name)) name += '.html';
    name = name.replace(/\.htm$/i, '.html');
    const prefix = segs.slice(-2).join('-');
    return '~/Downloads/' + host + (prefix ? '-' + prefix : '') + '-' + name;
  }

  /* ---------------- 状态 ---------------- */
  const S = {
    active: false,
    dirty: false,
    move: false,
    // 网页上默认不挂 ✎，激活过一次之后才一直挂着（方便再次打开）
    wasActivated: false,
    target: IS_FILE ? sourcePath : readSavedTarget(),
    origCE: document.body ? document.body.getAttribute('contenteditable') : null,
    origSpell: document.body ? document.body.getAttribute('spellcheck') : null,
    lastBackup: null,
    shadow: null,
    host: null,
    popup: null,
    toastTimer: null,
    range: null,
  };

  /* ---------------- native messaging ---------------- */
  // content script 不能直接调 chrome.runtime.sendNativeMessage（MV3 限制），
  // 必须经 background service worker 转发。

  // 浏览器给的是英文错误码，直接弹给用户等于没提示 —— 翻译成「该怎么办」。
  const HUMAN_HINTS = [
    [/native messaging host not found/i,
      '本地程序没注册上（或浏览器还没重启去读注册信息）。\n' +
      '在终端运行：python3 extension/install.py\n' +
      '然后按 Cmd+Q 完全退出浏览器再打开（关窗口不算）。'],
    [/access to the specified native messaging host is forbidden/i,
      '扩展 ID 和注册信息对不上。\n' +
      '运行：python3 extension/install.py --ext-id <你扩展卡片上的 ID>'],
    [/receiving end does not exist|could not establish connection/i,
      '扩展的后台服务没有响应。\n' +
      '到 chrome://extensions 点本扩展的「重新加载」，再刷新这个页面。'],
    [/host 无响应|no response/i,
      '本地程序启动后没有返回。看下日志：tail -20 ~/.html-studio/host.log'],
    [/只允许操作主目录内的文件/,
      '这个路径不在你的主目录里，出于安全考虑不允许写入。\n' +
      '改成主目录下的位置（例如 ~/Downloads/xxx.html）。'],
  ];

  function humanize(msg) {
    const s = String(msg || '');
    for (const [re, hint] of HUMAN_HINTS) {
      if (re.test(s)) return hint;
    }
    return s;
  }

  function call(msg) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      try {
        chrome.runtime.sendMessage({ type: 'hs-native', msg }, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) return done(reject, new Error(humanize(err.message || '无法连接本地 host')));
          if (!resp) return done(reject, new Error('本地 host 无响应'));
          if (resp.ok === false) return done(reject, new Error(humanize(resp.error || '本地 host 出错')));
          done(resolve, resp);
        });
      } catch (e) {
        done(reject, e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /* ---------------- 编辑状态 ---------------- */
  function activate() {
    if (!document.body || S.active) return;
    S.active = true;
    S.wasActivated = true;
    document.body.setAttribute('contenteditable', 'true');
    document.body.setAttribute('spellcheck', 'false');
    injectPageStyle();
    render();
    if (IS_FILE) {
      toast('编辑模式已开启 · 直接点文字改，Cmd+S 保存');
    } else {
      toast(S.target
        ? '编辑模式已开启 · Cmd+S 保存到 ' + S.target
        : '编辑模式已开启 · 这是网页，第一次 Cmd+S 会存成本地文件（' + defaultRemotePath() + '）');
    }
  }

  function deactivate() {
    if (!S.active) return;
    if (S.move) setMoveMode(false);
    S.active = false;
    releaseRange();
    if (document.body) {
      if (S.origCE == null) document.body.removeAttribute('contenteditable');
      else document.body.setAttribute('contenteditable', S.origCE);
      if (S.origSpell == null) document.body.removeAttribute('spellcheck');
      else document.body.setAttribute('spellcheck', S.origSpell);
    }
    removePageStyle();
    closePopup();
    if (S.shadow) S.shadow.querySelectorAll('.toast').forEach((n) => n.remove());
    render();
  }

  function toggle() { S.active ? deactivate() : activate(); }

  function injectPageStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      'a{cursor:text!important}',
      'img{cursor:pointer}',
      ':focus{outline:none}',
      'html.hs-move-mode,html.hs-move-mode *{cursor:grab!important}',
      'html.hs-move-mode.hs-dragging,html.hs-move-mode.hs-dragging *{cursor:grabbing!important}',
    ].join('');
    (document.head || document.documentElement).appendChild(st);
  }
  const removePageStyle = () => { const n = document.getElementById(STYLE_ID); if (n) n.remove(); };

  function markDirty() {
    if (S.dirty) return;
    S.dirty = true;
    render();
  }

  /* ---------------- 选区保存（点面板会把焦点抢走） ---------------- */
  function captureRange() {
    const sel = window.getSelection();
    S.range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  }
  function restoreRange() {
    const sel = window.getSelection();
    // 页面上还有有效的非空选区（用户没去点面板）→ 直接用，最准确
    if (sel && sel.rangeCount && !sel.isCollapsed && document.body.contains(sel.anchorNode)) return true;
    if (!S.range) return false;
    if (!sel) return false;
    // 面板里的 select/input 会抢走焦点，而 execCommand 作用在「获得焦点的可编辑区」上，
    // 所以先把焦点还给 body，再恢复选区（顺序反过来的话 focus 会把选区打回原形）。
    try {
      if (document.activeElement !== document.body) document.body.focus({ preventScroll: true });
    } catch (_) { /* 不支持 preventScroll 就算了 */ }
    try {
      sel.removeAllRanges();
      sel.addRange(S.range);
      return true;
    } catch (_) {
      return false;
    }
  }
  function releaseRange() { S.range = null; }

  /* ---------------- 序列化 ---------------- */
  // 浏览器序列化会把 <line/> 展开成 <line></line>，这里在 <svg> 范围内还原成自闭合，
  // 让保存后的 diff 只剩真正的改动（HTML5 在 SVG 外来内容里认自闭合语法，语义等价）。
  const SVG_SELF = new Set((
    'line polygon polyline circle ellipse rect path stop use image ' +
    'animate animateTransform animateMotion set feBlend feColorMatrix feComposite ' +
    'feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow ' +
    'feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMergeNode ' +
    'feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence'
  ).split(' '));

  function compactSVG(html) {
    const names = [...SVG_SELF].join('|');
    const re = new RegExp(`<(${names})(\\s[^>]*)?></\\1>`, 'g');
    return html.replace(/<svg[\s>][\s\S]*?<\/svg>/gi,
      (block) => block.replace(re, (m, tag, attrs) => `<${tag}${attrs || ''}/>`));
  }

  // 网页存成本地文件后，相对路径（./style.css、/img/a.png）都会指向磁盘上的空目录，
  // 打开就是裸文本。这里把相对地址一次性转成绝对地址，样式和图片就能继续加载。
  const REWRITE_ATTRS = ['src', 'href', 'poster', 'data-src', 'action', 'formaction'];

  function absoluteURL(value, base) {
    if (!value) return null;
    const v = String(value).trim();
    if (!v) return null;
    if (/^(data:|blob:|mailto:|tel:|javascript:|about:|#)/i.test(v)) return null;
    try {
      const u = new URL(v, base);
      if (u.protocol === 'file:' || u.protocol === 'blob:') return null;
      return u.href;
    } catch (_) {
      return null;
    }
  }

  function rewriteCssUrls(css, base) {
    if (!css) return css;
    return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, v) => {
      const abs = absoluteURL(v, base);
      return abs ? `url("${abs}")` : m;
    });
  }

  function absolutize(clone) {
    const base = document.baseURI || location.href;

    clone.querySelectorAll('*').forEach((el) => {
      REWRITE_ATTRS.forEach((attr) => {
        const v = el.getAttribute && el.getAttribute(attr);
        if (!v) return;
        const abs = absoluteURL(v, base);
        if (abs && abs !== v) el.setAttribute(attr, abs);
      });
      const srcset = el.getAttribute && el.getAttribute('srcset');
      if (srcset) {
        const fixed = srcset.split(',').map((part) => {
          const seg = part.trim().split(/\s+/);
          const abs = absoluteURL(seg[0], base);
          if (!abs) return part.trim();
          return [abs].concat(seg.slice(1)).join(' ');
        }).join(', ');
        el.setAttribute('srcset', fixed);
      }
      const style = el.getAttribute && el.getAttribute('style');
      if (style && style.indexOf('url(') >= 0) {
        el.setAttribute('style', rewriteCssUrls(style, base));
      }
    });

    clone.querySelectorAll('style').forEach((n) => {
      n.textContent = rewriteCssUrls(n.textContent, base);
    });
  }

  function serialize() {
    const clone = document.documentElement.cloneNode(true);
    const ui = clone.querySelector('#' + MARK);
    if (ui) ui.remove();
    const st = clone.querySelector('#' + STYLE_ID);
    if (st) st.remove();
    // 拖动时的 clone 幽灵（挂在 body 上，带 data-hs-drag）
    clone.querySelectorAll('[data-hs-drag]').forEach((n) => n.remove());
    clone.classList.remove('hs-move-mode', 'hs-dragging');

    const b = clone.querySelector('body');
    if (b) {
      if (S.origCE == null) b.removeAttribute('contenteditable');
      else b.setAttribute('contenteditable', S.origCE);
      if (S.origSpell == null) b.removeAttribute('spellcheck');
      else b.setAttribute('spellcheck', S.origSpell);
    }
    if (!IS_FILE) absolutize(clone);

    const dt = document.doctype;
    const doctype = dt
      ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ''}${dt.systemId ? ` "${dt.systemId}"` : ''}>`
      : '';
    return compactSVG((doctype ? doctype + '\n' : '') + clone.outerHTML);
  }

  /* ---------------- 保存 / 撤销 / 备份 ---------------- */
  function requireTarget(what) {
    if (S.target) return true;
    toast('这个网页还没存成本地文件，先按 Cmd+S 保存一次，' + what + '才可用', true);
    return false;
  }

  async function saveTo(path, allowCreate) {
    try {
      const html = serialize();
      const r = await call({
        op: allowCreate ? 'save-or-create' : 'save',
        path,
        html,
      });
      S.target = r.path || path;
      if (!IS_FILE) rememberTarget(S.target);
      S.dirty = false;
      S.lastBackup = r.backup || null;
      render();
      const stat = (r.added || r.removed) ? ` · +${r.added} −${r.removed} 行` : '';
      const where = IS_FILE ? '' : ' 到 ' + r.path;
      toast('已保存' + where + stat + (r.backup ? ' · 备份 ' + r.backup : ''));
    } catch (e) {
      // 目标文件被删/改名了：退化成新建，别把用户的改动卡死
      if (!allowCreate && /文件不存在/.test(e.message)) return saveTo(path, true);
      toast('保存失败：' + e.message, true);
    }
  }

  // 本地文件：写回原文件；网页：第一次存到 ~/Downloads，之后一直写那个文件
  function doSave() {
    if (IS_FILE) return saveTo(sourcePath, false);
    if (S.target) return saveTo(S.target, true);
    return saveTo(defaultRemotePath(), true);
  }

  function doSaveAs() {
    const base = S.target || (IS_FILE ? sourcePath : defaultRemotePath());
    const def = base.replace(/\.html?$/i, '-copy.html');
    const v = prompt('另存为（绝对路径，~ 代表主目录）', def);
    if (v && v.trim()) saveAs(v.trim());
  }

  // 本地文件：存一份副本（不覆盖已存在的文件，后续 Cmd+S 仍写原文件）
  // 网页：这才是「换个保存位置」的入口，所以落盘后会改指向新文件
  async function saveAs(path) {
    try {
      const html = serialize();
      if (IS_FILE) {
        const r = await call({ op: 'save-as', path, html });
        toast('已另存为 ' + r.path);
        return;
      }
      const r = await call({ op: 'save-or-create', path, html });
      S.target = r.path || path;
      rememberTarget(S.target);
      S.dirty = false;
      render();
      toast('已保存到 ' + r.path + '（之后的保存都写这个文件）');
    } catch (e) {
      toast('另存为失败：' + e.message, true);
    }
  }

  async function doUndo() {
    if (!requireTarget('撤销保存')) return;
    if (!confirm('撤销上一次保存，恢复到保存前的内容？')) return;
    try {
      await call({ op: 'undo-last', path: S.target });
      location.reload();
    } catch (e) {
      toast('撤销失败：' + e.message +
        '\n如果只是想丢掉这次没保存成功的修改，用「放弃改动」或 Cmd+Z。', true);
    }
  }

  async function openBackups() {
    if (!requireTarget('备份历史')) return;
    showPopup('backups', buildBackupsPopup, { capture: false });
  }

  /* ---------------- 编辑动作 ---------------- */
  function exec(cmd, val) {
    if (!S.active) return toast('先开启编辑模式');
    if (S.move) setMoveMode(false);
    document.execCommand(cmd, false, val || null);
    markDirty();
  }

  function applyFormat(styles) {
    if (!S.active) return toast('先开启编辑模式');
    if (S.move) setMoveMode(false);
    restoreRange();
    const r = HS_Format.apply(styles);
    if (!r.ok) return toast(r.reason || '没法应用样式', true);
    captureRange();
    markDirty();
    toast(r.block ? '已应用到整段' : '已应用到所选文字', false, 1600);
  }

  function insertHTML(html) {
    if (!S.active) return toast('先开启编辑模式');
    const sel = document.getSelection();
    if (sel && sel.rangeCount && document.body.contains(sel.anchorNode)) {
      document.execCommand('insertHTML', false, html);
    } else {
      const wrap = document.createElement('div');
      wrap.innerHTML = html;
      while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
    }
    markDirty();
  }

  function readAsDataURL(file) {
    return new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(file);
    });
  }

  async function uploadAndInsert(file) {
    const dataUrl = await readAsDataURL(file);
    if (!S.target) {
      // 还没有本地落点：内嵌成 dataURL，先保证图片不丢
      insertHTML(`<img src="${escapeAttr(dataUrl)}" alt="">`);
      toast('图片已内嵌（还没存成本地文件，内嵌最保险）');
      return;
    }
    const r = await call({ op: 'upload', path: S.target, dataUrl });
    insertHTML(`<img src="${escapeAttr(r.src)}" alt="">`);
    toast('图片已存入 assets/ 并插入');
  }

  /* ---------------- 移动模式 ---------------- */
  function setMoveMode(on) {
    if (S.move === on) return;
    if (on && !S.active) return toast('先开启编辑模式');
    S.move = on;
    if (on) {
      closePopup();
      HS_Move.init(APP);
      HS_Move.enable();
      document.body.setAttribute('contenteditable', 'false');
      document.documentElement.classList.add('hs-move-mode');
      toast('移动模式：拖住模块调整位置 · Shift 拖父级容器 · Esc 退出');
    } else {
      HS_Move.disable();
      document.documentElement.classList.remove('hs-move-mode');
      if (S.active) document.body.setAttribute('contenteditable', 'true');
    }
    render();
  }

  /* ---------------- 页面事件 ---------------- */
  document.addEventListener('click', (e) => {
    if (!S.active) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (a) e.preventDefault();
  }, true);

  // 编辑模式下，不让点击事件传到页面自己的监听器。
  // 很多 AI 生成的页面是「点一下翻下一页」的结构（document 上挂着 click），
  // 不拦住的话点工具条（尤其保存）会被当成翻页指令。
  // 只 stopPropagation 不 preventDefault —— 光标定位、选择文本等原生编辑行为必须保留。
  ['click', 'mousedown', 'mouseup', 'dblclick', 'pointerdown', 'pointerup',
   'touchstart', 'touchend', 'contextmenu'].forEach((type) => {
    document.addEventListener(type, (e) => {
      if (!S.active) return;
      // 工具条自己的事件要放行（否则连保存按钮都点不动），
      // 它们由 buildUI 里 host 层的 stopPropagation 拦住，不会传给页面
      let fromUI = false;
      try {
        const path = e.composedPath ? e.composedPath() : [];
        fromUI = path.includes(S.host) || e.target === S.host;
      } catch (_) {
        fromUI = e.target === S.host;
      }
      if (fromUI) return;
      e.stopPropagation();
    }, true);
  });

  document.addEventListener('submit', (e) => { if (S.active) e.preventDefault(); }, true);
  document.addEventListener('input', () => { if (S.active) markDirty(); }, true);
  document.addEventListener('selectionchange', () => {
    // 只有在页面里选东西时才记，避免把面板里 select/input 的选区（已塔缩）当成页面选区
    if (!S.active) return;
    if (S.shadow && S.shadow.activeElement) return;
    const sel = window.getSelection();
    if (sel && sel.rangeCount && document.body.contains(sel.anchorNode)) captureRange();
  });

  document.addEventListener('paste', async (e) => {
    if (!S.active) return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    let f = null;
    for (const it of items) if (it.kind === 'file' && it.type.startsWith('image/')) { f = it.getAsFile(); break; }
    if (!f) return;
    e.preventDefault();
    try { await uploadAndInsert(f); } catch (err) { toast('插入图片失败：' + err.message, true); }
  }, true);

  document.addEventListener('dblclick', (e) => {
    if (!S.active || S.move) return;
    const img = e.target.closest && e.target.closest('img');
    if (!img) return;
    const v = prompt('图片地址（留空取消）', img.getAttribute('src') || '');
    if (v == null || !v.trim()) return;
    img.setAttribute('src', v.trim());
    markDirty();
  }, true);

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === 's') { e.preventDefault(); if (S.active) doSave(); return; }
    if (mod && k === 'e' && S.active) { e.preventDefault(); toggle(); return; }
    if (mod && k === 'm' && S.active) { e.preventDefault(); setMoveMode(!S.move); return; }
    // 自己在捕获阶段接管撤销/重做：交给 execCommand（和工具条 ↶↷ 同一个通道，
    // 已在真实浏览器里验证有效），不依赖页面的 keydown 处理器和浏览器默认行为。
    if (mod && k === 'z' && S.active) {
      e.preventDefault();
      // 拖动是脚本直接改 DOM，浏览器自带的撤销追不到 —— 移动模式下先撤拖动
      if (S.move && !e.shiftKey && HS_Move.canUndo() && HS_Move.undoLast()) {
        markDirty();
        toast('已撤销上一步移动');
        return;
      }
      document.execCommand(e.shiftKey ? 'redo' : 'undo', false, null);
      markDirty();
      return;
    }
    if (e.key === 'Escape') {
      if (S.popup) closePopup();
      else if (S.move) setMoveMode(false);
      else if (S.active) deactivate();
    }
  }, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'html-studio-toggle') toggle();
  });

  window.addEventListener('beforeunload', (e) => {
    if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ---------------- UI（shadow DOM，隔离页面样式） ---------------- */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif}
  .bar{position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:6px;
       background:rgba(22,26,33,.97);color:#e6ebf2;border:1px solid #2b3441;border-radius:12px;
       box-shadow:0 12px 34px rgba(0,0,0,.38);padding:7px 9px;font-size:12.5px;
       backdrop-filter:blur(10px);max-width:calc(100vw - 32px);flex-wrap:wrap;justify-content:flex-end}
  button{font:inherit;font-size:12px;color:#e6ebf2;background:#1d232c;border:1px solid #2b3441;
         border-radius:7px;padding:4px 8px;cursor:pointer;line-height:1.35}
  button:hover{background:#252d38;border-color:#3a4657}
  button.on{background:#1b2b42;border-color:#2c4a72;color:#8fc0ff}
  button.save{background:#4f9cf9;border-color:#4f9cf9;color:#04101f;font-weight:700}
  button.save:hover{filter:brightness(1.08)}
  button[disabled]{opacity:.45;cursor:default}
  .sep{width:1px;height:16px;background:#2b3441;margin:0 2px}
  .dot{width:7px;height:7px;border-radius:50%;background:#e8a33d;display:none}
  .dot.show{display:block}
  .brand{font-weight:700;letter-spacing:.2px;padding-right:2px;color:#8fc0ff}
  .hintk{color:#8b97a8;font-size:11px}
  .fab{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:40px;height:40px;border-radius:50%;
       display:flex;align-items:center;justify-content:center;background:#4f9cf9;color:#04101f;font-size:17px;
       border:none;box-shadow:0 8px 24px rgba(0,0,0,.35);cursor:pointer;font-weight:700}
  .fab:hover{filter:brightness(1.08)}
  .toast{position:fixed;left:50%;bottom:76px;transform:translateX(-50%);z-index:2147483647;
         background:#20272f;color:#e6ebf2;border:1px solid #2b3441;border-radius:9px;padding:8px 14px;
         font-size:12.5px;box-shadow:0 10px 30px rgba(0,0,0,.45);opacity:0;transition:opacity .18s;
         max-width:min(680px,80vw);word-break:break-all;pointer-events:none}
  .toast.show{opacity:1}
  .toast.err{border-color:#5a2225;background:#2a1518;color:#ffc9cb}
  .pop{position:fixed;bottom:70px;left:16px;z-index:2147483647;width:min(440px,88vw);max-height:56vh;overflow:auto;
       background:rgba(22,26,33,.98);color:#e6ebf2;border:1px solid #2b3441;border-radius:11px;
       box-shadow:0 16px 44px rgba(0,0,0,.5);padding:8px;font-size:12px}
  .pop-h{font-weight:700;padding:2px 4px 8px;color:#8fc0ff;font-size:12px}
  .pop-empty{color:#8b97a8;padding:8px 4px;white-space:pre-wrap;line-height:1.55}
  .pop-row{display:flex;align-items:center;gap:8px;padding:6px;border-top:1px solid #232a34}
  .pop-t{flex:1;min-width:0;white-space:pre-wrap;word-break:break-all;color:#c9d3e0;line-height:1.4}
  .pop-t.link{cursor:pointer}
  .pop-t.link:hover{color:#8fc0ff}
  .pop-form{display:flex;align-items:center;gap:8px;padding:5px 4px}
  .pop-lab{flex:0 0 40px;color:#8b97a8}
  .pop-note{color:#8b97a8;font-size:11px;padding:6px 4px 2px;line-height:1.55;white-space:pre-wrap}
  .pop-sep{height:1px;background:#232a34;margin:6px 0}
  .pop-btn{display:block;width:100%;text-align:left;margin-top:4px}
  select{font:inherit;font-size:12px;color:#e6ebf2;background:#1d232c;border:1px solid #2b3441;
         border-radius:7px;padding:4px 6px;cursor:pointer;max-width:100%}
  select:hover{border-color:#3a4657}
  input[type=number]{font:inherit;font-size:12px;color:#e6ebf2;background:#1d232c;border:1px solid #2b3441;
         border-radius:7px;padding:4px 6px;width:74px}
  `;

  function buildUI() {
    const host = document.createElement('div');
    host.id = MARK;
    host.style.cssText = 'all:initial';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    S.shadow = shadow;
    S.host = host;
    // 双保险：即使上面的 document 层拦截失效（比如页面用捕获阶段监听），
    // 也不让工具条内的事件冒泡出去
    ['click', 'mousedown', 'mouseup', 'dblclick', 'pointerdown', 'pointerup',
     'touchstart', 'touchend', 'contextmenu', 'wheel'].forEach((type) => {
      host.addEventListener(type, (e) => e.stopPropagation(), false);
    });
    (document.documentElement || document.body).appendChild(host);
    render();
  }

  function render() {
    const shadow = S.shadow;
    if (!shadow) return;
    // 只重建工具条本身：toast / 拖动辅助层不归 render 管，
    // 不然「改一下字」就会把刚弹的提示抹掉
    shadow.querySelectorAll('.bar,.fab').forEach((n) => n.remove());

    if (!S.active) {
      if (!AUTOSHOW && !S.wasActivated) return;
      const fab = el('button', 'fab', '✎');
      fab.type = 'button';
      fab.title = 'HTML Studio：编辑这个页面';
      fab.onclick = () => activate();
      shadow.appendChild(fab);
      return;
    }

    const bar = el('div', 'bar');
    bar.dataset.anchor = 'left';
    const dot = el('span', 'dot' + (S.dirty ? ' show' : ''));
    S.dotEl = dot;

    const add = (label, title, fn, cls) => {
      const b = el('button', cls || '', label);
      b.type = 'button'; // 防止页面里残留未闭合的 <form> 把按钮当成提交按钮
      if (title) b.title = title;
      b.onmousedown = (e) => e.preventDefault(); // 保住选区
      b.onclick = fn;
      bar.appendChild(b);
      return b;
    };

    bar.appendChild(el('span', 'brand', 'HTML Studio'));
    bar.appendChild(dot);
    add('B', '加粗', () => exec('bold')).style.fontWeight = '700';
    add('I', '斜体', () => exec('italic')).style.fontStyle = 'italic';
    add('U', '下划线', () => exec('underline')).style.textDecoration = 'underline';
    bar.appendChild(el('span', 'sep'));
    add('H1', '标题 1', () => exec('formatBlock', 'h1'));
    add('H2', '标题 2', () => exec('formatBlock', 'h2'));
    add('正文', '正文段落', () => exec('formatBlock', 'p'));
    add('Aa', '字体 / 字号', () => {
      if (S.move) setMoveMode(false);
      showPopup('font', buildFontPopup);
    }).style.fontWeight = '700';
    bar.appendChild(el('span', 'sep'));
    add('链接', '插入/修改链接', () => {
      const u = prompt('链接地址', 'https://');
      if (u) exec('createLink', u);
    });
    add('图片', '插入本地图片', () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*';
      inp.onchange = async () => {
        if (!inp.files[0]) return;
        try { await uploadAndInsert(inp.files[0]); } catch (e) { toast('插入失败：' + e.message, true); }
      };
      inp.click();
    });
    add('清格式', '清除格式', () => exec('removeFormat'));
    bar.appendChild(el('span', 'sep'));
    add('移动', '拖动模块调整位置 (Cmd+M)', () => setMoveMode(!S.move), S.move ? 'on' : '');
    add('页面', '列出页面，可删除某一页', () => {
      if (S.move) setMoveMode(false);
      showPopup('pages', buildPagesPopup, { capture: false });
    });
    bar.appendChild(el('span', 'sep'));
    add('↶', '撤销', () => exec('undo'));
    add('↷', '重做', () => exec('redo'));
    const moreBtn = add('⋯', '更多：另存为 / 备份 / 撤销保存', () => showPopup('more', buildMorePopup, { capture: false }));
    moreBtn.dataset.a = 'more';
    bar.appendChild(el('span', 'sep'));
    const saveBtn = add('保存', IS_FILE ? '保存到原文件 (Cmd+S)' : '保存成本地文件 (Cmd+S)', () => doSave(), 'save');
    saveBtn.dataset.a = 'save';
    add('退出', '关闭编辑模式 (Esc)', deactivate);

    bar.appendChild(el('span', 'hintk', 'Cmd+S 保存'));
    shadow.appendChild(bar);
  }

  /* ---------------- 弹层 ---------------- */
  function closePopup() {
    S.popup = null;
    if (S.shadow) S.shadow.querySelectorAll('.pop').forEach((n) => n.remove());
  }

  function showPopup(name, build, opts) {
    const o = opts || {};
    // 以 DOM 里有没有这个面板为准，不只看 S.popup：
    // 面板节点被外部移除（或状态对不上）时也能正常打开，不会点一下只关个寂寞
    const open = S.shadow && S.shadow.querySelector(`.pop[data-pop="${name}"]`);
    if (open && o.toggle !== false) return closePopup();
    closePopup();
    if (o.capture !== false) captureRange();
    const wrap = el('div', 'pop');
    wrap.dataset.pop = name;
    build(wrap);
    S.shadow.appendChild(wrap);
    S.popup = name;
    requestAnimationFrame(() => {
      const bar = S.shadow.querySelector('.bar');
      const left = bar ? bar.getBoundingClientRect().left : 16;
      const max = Math.max(12, window.innerWidth - wrap.offsetWidth - 12);
      wrap.style.left = Math.max(12, Math.min(left, max)) + 'px';
    });
  }

  function buildFontPopup(wrap) {
    wrap.appendChild(el('div', 'pop-h', '字体与字号'));
    const cur = (window.HS_Format && HS_Format.current()) || {};

    const r1 = el('div', 'pop-form');
    r1.appendChild(el('span', 'pop-lab', '字体'));
    const fam = document.createElement('select');
    HS_Format.FONTS.forEach(([v, name]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = name;
      fam.appendChild(o);
    });
    const curFam = String(cur.fontFamily || '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();
    if (curFam) {
      const hit = HS_Format.FONTS.find(([v]) => v !== 'inherit' && v.toLowerCase().indexOf(curFam) >= 0);
      if (hit) fam.value = hit[0];
    }
    fam.onchange = () => applyFormat({ fontFamily: fam.value });
    r1.appendChild(fam);
    wrap.appendChild(r1);

    const r2 = el('div', 'pop-form');
    r2.appendChild(el('span', 'pop-lab', '字号'));
    const size = document.createElement('select');
    HS_Format.SIZES.forEach((px) => {
      const o = document.createElement('option');
      o.value = String(px);
      o.textContent = px + ' px';
      size.appendChild(o);
    });
    const curSize = cur.fontSize || 16;
    size.value = String(HS_Format.SIZES.indexOf(curSize) >= 0 ? curSize : 16);
    size.onchange = () => applyFormat({ fontSize: size.value + 'px' });
    r2.appendChild(size);

    const custom = document.createElement('input');
    custom.type = 'number';
    custom.min = '6';
    custom.max = '400';
    custom.placeholder = '自定义';
    custom.title = '自定义字号（px），回车应用';
    custom.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      const v = parseInt(custom.value, 10);
      if (v >= 6 && v <= 400) applyFormat({ fontSize: v + 'px' });
    };
    r2.appendChild(custom);
    wrap.appendChild(r2);

    const r3 = el('div', 'pop-form');
    r3.appendChild(el('span', 'pop-lab', '当前'));
    r3.appendChild(el('span', 'pop-t',
      HS_Format.shortFamily(cur.fontFamily) + ' · ' + (cur.fontSize || '?') + 'px'));
    wrap.appendChild(r3);

    wrap.appendChild(el('div', 'pop-note',
      '选中文字后改，改的是选中的部分；没选中时改光标所在的整段。\n字体和字号会写成内联样式，跟着这段文字一起保存。'));
  }

  function buildPagesPopup(wrap) {
    const { items, strategy } = HS_Pages.list();
    wrap.appendChild(el('div', 'pop-h', items.length ? `检测到 ${items.length} 页` : '没检测到分页结构'));

    if (!items.length) {
      wrap.appendChild(el('div', 'pop-empty',
        '这个页面看起来是普通单页文档，没有可删除的「页」。\n' +
        '分页识别支持：.slide / .page / .screen / swiper / [data-page] 这类结构，' +
        '以及「同一父元素下多个接近满屏的块」。'));
      return;
    }

    items.forEach((it) => {
      const r = el('div', 'pop-row');
      const t = el('div', 'pop-t link',
        `第 ${it.index + 1} 页 · ${it.label}` + (it.hidden ? '  （当前隐藏）' : ''));
      t.onclick = () => {
        try { it.el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) { it.el.scrollIntoView(); }
      };
      r.appendChild(t);
      const b = el('button', '', '删除');
      b.type = 'button';
      b.onclick = () => {
        if (!confirm(`删除第 ${it.index + 1} 页？\n\n${it.label}\n\n删掉后可以用 Cmd+Z 试试撤销；` +
          '不放心就先别保存，直接刷新页面即可还原。')) return;
        if (!HS_Pages.remove(it.el)) return toast('这一页删不了', true);
        markDirty();
        toast(`已删除第 ${it.index + 1} 页 · 剩余 ${items.length - 1} 页`);
        closePopup();
        showPopup('pages', buildPagesPopup, { capture: false, toggle: false });
      };
      r.appendChild(b);
      wrap.appendChild(r);
    });

    wrap.appendChild(el('div', 'pop-note',
      '识别依据：' + (strategy || '结构') + '\n删页只是把这个块从 HTML 里去掉，保存后生效。'));
  }

  async function buildBackupsPopup(wrap) {
    wrap.appendChild(el('div', 'pop-h', '备份历史'));
    let r;
    try {
      r = await call({ op: 'backups', path: S.target });
    } catch (e) {
      wrap.appendChild(el('div', 'pop-empty', '读取备份失败：' + e.message));
      return;
    }
    if (!r.backups.length) {
      wrap.appendChild(el('div', 'pop-empty', '还没有备份。第一次保存时会自动生成。'));
      return;
    }
    wrap.appendChild(el('div', 'pop-note', r.path));
    r.backups.slice(0, 40).forEach((b) => {
      const rowEl = el('div', 'pop-row');
      rowEl.appendChild(el('div', 'pop-t',
        b.name + '\n' + b.when + ' · ' + (b.size / 1024).toFixed(1) + ' KB'));
      const rb = el('button', '', '恢复');
      rb.type = 'button';
      rb.onclick = async () => {
        if (!confirm('用这个备份覆盖当前文件？')) return;
        try {
          await call({ op: 'restore', path: S.target, backup: b.name });
          location.reload();
        } catch (e) { toast('恢复失败：' + e.message, true); }
      };
      rowEl.appendChild(rb);
      wrap.appendChild(rowEl);
    });
  }

  function buildMorePopup(wrap) {
    wrap.appendChild(el('div', 'pop-h', IS_FILE ? '文件' : '网页 → 本地文件'));
    wrap.appendChild(el('div', 'pop-note', S.target ? '当前保存位置：\n' + S.target : '还没保存过。第一次保存会落到：\n' + defaultRemotePath()));

    const btn = (label, title, fn) => {
      const b = el('button', 'pop-btn', label);
      b.type = 'button';
      if (title) b.title = title;
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = fn;
      wrap.appendChild(b);
      return b;
    };

    btn('另存为…', '保存到另一个文件', () => { closePopup(); doSaveAs(); });
    btn('放弃改动', '丢弃未保存的修改，重新从文件加载', () => {
      if (!S.dirty || confirm('放弃未保存的修改，恢复到文件里的内容？')) location.reload();
    });
    wrap.appendChild(el('div', 'pop-sep'));
    const bk = btn('备份历史 / 恢复', '每次保存都会自动备份', () => openBackups());
    bk.dataset.a = 'backups';
    btn('撤销上一次保存', '回到上一次保存前', () => { closePopup(); doUndo(); });
    wrap.appendChild(el('div', 'pop-sep'));
    btn('自检 / 帮助', '检查扩展与本地服务是否正常', () => {
      chrome.runtime.sendMessage({ type: 'hs-open-help' });
    });
  }

  function toast(msg, isErr, ms) {
    const shadow = S.shadow;
    if (!shadow) return;
    shadow.querySelectorAll('.toast').forEach((n) => n.remove());
    const t = el('div', 'toast show' + (isErr ? ' err' : ''), msg);
    shadow.appendChild(t);
    clearTimeout(S.toastTimer);
    // 错误提示里有操作指引，给足阅读时间
    S.toastTimer = setTimeout(() => t.classList.remove('show'),
      ms || (isErr ? 12000 : 3000));
  }

  /* ---------------- 给 lib 用的门面 ---------------- */
  const APP = {
    get host() { return S.host; },
    get shadow() { return S.shadow; },
    markDirty,
    toast,
  };

  /* ---------------- boot ---------------- */
  function boot() {
    if (!document.body) return;
    S.origCE = document.body.getAttribute('contenteditable');
    S.origSpell = document.body.getAttribute('spellcheck');
    buildUI();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // 供测试/调试使用
  window.__HTML_STUDIO__ = {
    activate, deactivate, toggle, serialize, doSave, call, setMoveMode,
    get state() { return S; },
  };
})();
