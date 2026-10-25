/**
 * HTML Studio — 内容脚本
 * 在 file:// 的 html 页面上注入一个悬浮编辑条，直接改内容，Cmd+S 存回原文件。
 * 文件读写通过 native messaging 交给本地 python host 完成（带备份）。
 */
(() => {
  'use strict';
  if (window.__HTML_STUDIO_LOADED__) return;
  window.__HTML_STUDIO_LOADED__ = true;

  const HOST_NAME = 'com.narutolin.htmlstudio';
  const MARK = '__html_studio_host__';
  const STYLE_ID = '__html_studio_style__';

  /* ---------------- 只在 html 页面上工作 ---------------- */
  const p = decodeURIComponent(location.pathname || '');
  if (!/\.(html?|xhtml)$/i.test(p)) return;
  if (document.contentType && !/html/i.test(document.contentType)) return;

  const filePath = window.__HTML_STUDIO_PATH_OVERRIDE__ || (
    location.protocol === 'file:'
      ? decodeURIComponent(location.href.replace(/^file:\/\//, '')).replace(/[?#].*$/, '')
      : p
  );

  /* ---------------- 状态 ---------------- */
  const S = {
    active: false,
    dirty: false,
    origCE: document.body ? document.body.getAttribute('contenteditable') : null,
    origSpell: document.body ? document.body.getAttribute('spellcheck') : null,
    lastBackup: null,
    shadow: null,
    host: null,
    popup: null,
    toastTimer: null,
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
      '这个文件不在你的主目录里，出于安全考虑不允许写入。\n' +
      '把文件移到主目录下再打开（例如 ~/或者 ~/Downloads）。'],
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
    document.body.setAttribute('contenteditable', 'true');
    document.body.setAttribute('spellcheck', 'false');
    injectPageStyle();
    render();
    toast('编辑模式已开启 · 直接点文字改，Cmd+S 保存');
  }

  function deactivate() {
    if (!S.active) return;
    S.active = false;
    if (document.body) {
      if (S.origCE == null) document.body.removeAttribute('contenteditable');
      else document.body.setAttribute('contenteditable', S.origCE);
      if (S.origSpell == null) document.body.removeAttribute('spellcheck');
      else document.body.setAttribute('spellcheck', S.origSpell);
    }
    removePageStyle();
    closePopup();
    render();
  }

  function toggle() { S.active ? deactivate() : activate(); }

  function injectPageStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = 'a{cursor:text!important}img{cursor:pointer}:focus{outline:none}';
    (document.head || document.documentElement).appendChild(st);
  }
  const removePageStyle = () => { const n = document.getElementById(STYLE_ID); if (n) n.remove(); };

  function markDirty() {
    if (S.dirty) return;
    S.dirty = true;
    render();
  }

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

  function serialize() {
    const clone = document.documentElement.cloneNode(true);
    const ui = clone.querySelector('#' + MARK);
    if (ui) ui.remove();
    const st = clone.querySelector('#' + STYLE_ID);
    if (st) st.remove();
    const b = clone.querySelector('body');
    if (b) {
      if (S.origCE == null) b.removeAttribute('contenteditable');
      else b.setAttribute('contenteditable', S.origCE);
      if (S.origSpell == null) b.removeAttribute('spellcheck');
      else b.setAttribute('spellcheck', S.origSpell);
    }
    const dt = document.doctype;
    const doctype = dt
      ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ''}${dt.systemId ? ` "${dt.systemId}"` : ''}>`
      : '';
    return compactSVG((doctype ? doctype + '\n' : '') + clone.outerHTML);
  }

  /* ---------------- 动作 ---------------- */
  async function doSave(asPath) {
    try {
      const html = serialize();
      const r = await call({
        op: asPath ? 'save-as' : 'save',
        path: asPath || filePath,
        html,
      });
      if (asPath) {
        toast('已另存为 ' + r.path);
      } else {
        S.dirty = false;
        S.lastBackup = r.backup || null;
        render();
        const stat = (r.added || r.removed) ? ` · +${r.added} −${r.removed} 行` : '';
        toast('已保存' + stat + (r.backup ? ' · 备份 ' + r.backup : ''));
      }
    } catch (e) {
      toast('保存失败：' + e.message, true);
    }
  }

  async function doUndo() {
    if (!confirm('撤销上一次保存，恢复到保存前的内容？')) return;
    try {
      await call({ op: 'undo-last', path: filePath });
      location.reload();
    } catch (e) {
      toast('撤销失败：' + e.message +
        '\n如果只是想丢掉这次没保存成功的修改，用工具条上的「放弃改动」或 Cmd+Z。', true);
    }
  }

  async function openBackups() {
    if (S.popup === 'backups') return closePopup();
    closePopup();
    let r;
    try {
      r = await call({ op: 'backups', path: filePath });
    } catch (e) {
      return toast('读取备份失败：' + e.message, true);
    }
    const wrap = el('div', 'pop');
    wrap.appendChild(el('div', 'pop-h', `备份历史（${r.backups.length}）`));
    if (!r.backups.length) {
      wrap.appendChild(el('div', 'pop-empty', '还没有备份。第一次保存时会自动生成。'));
    } else {
      r.backups.slice(0, 40).forEach((b) => {
        const row = el('div', 'pop-row');
        row.appendChild(el('div', 'pop-t', b.name + '\n' + b.when + ' · ' + (b.size / 1024).toFixed(1) + ' KB'));
        const rb = el('button', '', '恢复');
        rb.onclick = async () => {
          if (!confirm('用这个备份覆盖当前文件？')) return;
          try {
            await call({ op: 'restore', path: filePath, backup: b.name });
            location.reload();
          } catch (e) { toast('恢复失败：' + e.message, true); }
        };
        row.appendChild(rb);
        wrap.appendChild(row);
      });
    }
    S.shadow.appendChild(wrap);
    S.popup = 'backups';
    const box = S.shadow.querySelector('[data-anchor="left"]');
    wrap.style.left = Math.max(12, box.getBoundingClientRect().left) + 'px';
  }

  function closePopup() {
    S.popup = null;
    if (S.shadow) S.shadow.querySelectorAll('.pop').forEach((n) => n.remove());
  }

  function exec(cmd, val) {
    if (!S.active) return toast('先开启编辑模式');
    document.execCommand(cmd, false, val || null);
    markDirty();
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

  async function uploadAndInsert(file) {
    const dataUrl = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(file);
    });
    const r = await call({ op: 'upload', path: filePath, dataUrl });
    insertHTML(`<img src="${escapeAttr(r.src)}" alt="">`);
    toast('图片已存入 assets/ 并插入');
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
    if (!S.active) return;
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
    // 自己在捕获阶段接管撤销/重做：交给 execCommand（和工具条 ↶↷ 同一个通道，
    // 已在真实浏览器里验证有效），不依赖页面的 keydown 处理器和浏览器默认行为。
    if (mod && k === 'z' && S.active) {
      e.preventDefault();
      document.execCommand(e.shiftKey ? 'redo' : 'undo', false, null);
      markDirty();
      return;
    }
    if (e.key === 'Escape') { if (S.popup) closePopup(); else if (S.active) deactivate(); }
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
  .pop{position:fixed;bottom:70px;z-index:2147483647;width:min(420px,86vw);max-height:52vh;overflow:auto;
       background:rgba(22,26,33,.98);color:#e6ebf2;border:1px solid #2b3441;border-radius:11px;
       box-shadow:0 16px 44px rgba(0,0,0,.5);padding:8px;font-size:12px}
  .pop-h{font-weight:700;padding:2px 4px 8px;color:#8fc0ff;font-size:12px}
  .pop-empty{color:#8b97a8;padding:8px 4px}
  .pop-row{display:flex;align-items:center;gap:8px;padding:6px;border-top:1px solid #232a34}
  .pop-t{flex:1;min-width:0;white-space:pre-wrap;word-break:break-all;color:#c9d3e0;line-height:1.4}
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
    shadow.querySelectorAll('.bar,.fab,.toast').forEach((n) => n.remove());

    if (!S.active) {
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
    add('↶', '撤销', () => exec('undo'));
    add('↷', '重做', () => exec('redo'));
    bar.appendChild(el('span', 'sep'));
    add('另存为', '保存到另一个文件', () => {
      const def = filePath.replace(/\.html?$/i, '-copy.html');
      const v = prompt('另存为（绝对路径）', def);
      if (v && v.trim()) doSave(v.trim());
    });
    // 不依赖本地程序：即使保存链路坏了，也能一键回到磁盘上的内容
    add('放弃改动', '丢弃未保存的修改，重新从文件加载', () => {
      if (!S.dirty || confirm('放弃未保存的修改，恢复到文件里的内容？')) location.reload();
    });
    const bkBtn = add('备份', '备份历史 / 恢复', openBackups);
    bkBtn.dataset.a = 'backups';
    const undoBtn = add('撤销保存', '回到上一次保存前', doUndo);
    const saveBtn = add('保存', '保存到原文件 (Cmd+S)', () => doSave(), 'save');
    saveBtn.dataset.a = 'save';
    add('退出', '关闭编辑模式 (Esc)', deactivate);

    bar.appendChild(el('span', 'hintk', 'Cmd+S 保存'));
    shadow.appendChild(bar);
  }

  function toast(msg, isErr) {
    const shadow = S.shadow;
    if (!shadow) return;
    shadow.querySelectorAll('.toast').forEach((n) => n.remove());
    const t = el('div', 'toast show' + (isErr ? ' err' : ''), msg);
    shadow.appendChild(t);
    clearTimeout(S.toastTimer);
    // 错误提示里有操作指引，给足阅读时间
    S.toastTimer = setTimeout(() => t.classList.remove('show'),
      isErr ? 12000 : 3000);
  }

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
    activate, deactivate, toggle, serialize, doSave, call,
    get state() { return S; },
  };
})();
