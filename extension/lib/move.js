/**
 * HTML Studio — 拖动模块
 *
 * 「移动」模式下的行为：
 *   - 页面上任何「块」都能拖（标题、段落、图片、卡片、整段 section…）
 *   - 按住 Shift 拖父级容器（每次上一层）
 *   - 蓝色横线 / 竖线表示会插到哪儿；松手即移动，可 Cmd+Z 撤销
 *   - Esc 或再点一次「移动」退出
 *
 * 只做「同级重排」：插入位置永远是目标元素的前面或后面，
 * 所以不会产出 <div> 塞进 <p> 这种非法嵌套。
 * 想把模块 A 移到另一个容器 B 里，拖到 B 的子元素之间即可。
 */
window.HS_Move = (function () {
  'use strict';

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'NOSCRIPT', 'TEMPLATE',
    'BR', 'HR', 'HTML', 'BODY', 'IFRAME', 'CANVAS', 'COLGROUP', 'COL', 'TR',
    'THEAD', 'TBODY', 'TFOOT', 'OPTION', 'OPTGROUP', 'VIDEOSRC',
  ]);
  // 这些标签本身就是「可见的模块」，即使 display 是 inline 也允许拖
  const MEDIA_TAGS = new Set(['IMG', 'svg', 'SVG', 'VIDEO', 'PICTURE', 'AUDIO']);

  // 拖动是脚本直接改 DOM，浏览器的 Cmd+Z 追不到，所以自己记一份「搬到哪儿之前」
  const history = [];

  const st = {
    on: false,
    app: null,
    layer: null,
    box: null,
    line: null,
    drag: null,
    raf: 0,
    hoverKey: null,
    bound: {},
  };

  function init(app) {
    st.app = app;
  }

  /* ---------------- 视觉层（放在 shadow DOM 里，保存时被自动剔除） ---------------- */
  function ensureLayer() {
    if (st.layer && st.layer.isConnected) return st.layer;
    const layer = document.createElement('div');
    layer.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:2147483646';

    const box = document.createElement('div');
    box.style.cssText =
      'position:absolute;display:none;border:1px solid rgba(79,156,249,.85);' +
      'border-radius:4px;background:rgba(79,156,249,.10);transition:none';

    const line = document.createElement('div');
    line.style.cssText =
      'position:absolute;display:none;background:#4f9cf9;border-radius:2px;' +
      'box-shadow:0 0 0 1px rgba(255,255,255,.85)';

    layer.appendChild(box);
    layer.appendChild(line);
    st.app.shadow.appendChild(layer);
    st.layer = layer;
    st.box = box;
    st.line = line;
    return layer;
  }

  const HOVER_BOX = 'position:absolute;display:block;border:1px dashed rgba(79,156,249,.9);border-radius:4px;background:rgba(79,156,249,.06)';
  const DRAG_BOX = 'position:absolute;display:block;border:2px solid rgba(79,156,249,.95);border-radius:4px;background:rgba(79,156,249,.12)';

  function placeBox(rect, cssText) {
    const b = st.box;
    b.style.cssText = cssText;
    b.style.left = rect.left + 'px';
    b.style.top = rect.top + 'px';
    b.style.width = rect.width + 'px';
    b.style.height = rect.height + 'px';
  }
  function hideBox() { if (st.box) st.box.style.display = 'none'; }
  function hideLine() { if (st.line) st.line.style.display = 'none'; }

  function drawLine(rect, before, row) {
    const l = st.line;
    l.style.display = 'block';
    if (row) {
      l.style.left = (before ? rect.left - 2 : rect.right - 1) + 'px';
      l.style.top = rect.top + 'px';
      l.style.width = '3px';
      l.style.height = rect.height + 'px';
    } else {
      l.style.left = rect.left + 'px';
      l.style.top = (before ? rect.top - 2 : rect.bottom - 1) + 'px';
      l.style.width = rect.width + 'px';
      l.style.height = '3px';
    }
  }

  /* ---------------- 候选元素判定 ---------------- */
  function isOurs(node) {
    if (!node || node.nodeType !== 1) return false;
    const host = st.app.host;
    if (!host) return false;
    if (node === host) return true;
    try {
      return node.getRootNode && node.getRootNode() === st.app.shadow;
    } catch (_) {
      return false;
    }
  }

  function isBlock(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return false;
    if (isOurs(el) || el.hasAttribute('data-hs-drag')) return false;
    if (el === document.body || el === document.documentElement) return false;

    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    if (cs.pointerEvents === 'none') return false;
    if (cs.position === 'fixed' || cs.position === 'sticky') return false;
    if (/^(table-row|table-row-group|table-cell|contents)$/.test(cs.display)) return false;

    const media = MEDIA_TAGS.has(tag);
    if (!media && /^(inline|contents|none)$/.test(cs.display)) return false;

    const r = el.getBoundingClientRect();
    if (r.width < 12 || r.height < 12) return false;
    return true;
  }

  /** 从指针命中的元素往外，收集所有可拖的块（由内到外） */
  function blockChain(node) {
    const out = [];
    let el = node && node.nodeType === 1 ? node : (node && node.parentElement) || null;
    while (el && el !== document.body && el !== document.documentElement) {
      if (isBlock(el)) out.push(el);
      el = el.parentElement;
    }
    return out;
  }

  /** 指针下面应该拖哪个块：默认最内层，Shift 时往外一层 */
  function pick(node, shift) {
    const chain = blockChain(node);
    if (!chain.length) return null;
    return shift ? (chain[1] || chain[0]) : chain[0];
  }

  /* ---------------- 悬停高亮 ---------------- */
  function onHover(e) {
    if (!st.on || st.drag) return;
    if (isOurs(e.target)) { hideBox(); st.hoverKey = null; return; }
    if (st.raf) return;
    st.raf = requestAnimationFrame(() => {
      st.raf = 0;
      const el = pick(e.target, e.shiftKey);
      if (!el) { hideBox(); st.hoverKey = null; return; }
      if (el !== st.hoverKey) {
        st.hoverKey = el;
        placeBox(el.getBoundingClientRect(), HOVER_BOX);
      }
    });
  }

  function clearHover() {
    hideBox();
    st.hoverKey = null;
  }

  /* ---------------- 拖动 ---------------- */
  function onDown(e) {
    if (!st.on || e.button !== 0) return;
    if (isOurs(e.target)) return;
    const el = pick(e.target, e.shiftKey);
    if (!el) return;

    e.preventDefault();
    e.stopPropagation();

    const rect = el.getBoundingClientRect();
    st.drag = {
      el,
      rect,
      startX: e.clientX,
      startY: e.clientY,
      dx: e.clientX - rect.left,
      dy: e.clientY - rect.top,
      started: false,
      ghost: null,
      target: null,
      before: true,
      row: false,
      origOpacity: el.style.opacity,
      origZIndex: el.style.zIndex,
    };
    ensureLayer();
    placeBox(rect, DRAG_BOX);
  }

  function startDrag() {
    const d = st.drag;
    d.started = true;
    const ghost = d.el.cloneNode(true);
    ghost.setAttribute('data-hs-drag', 'ghost');
    const r = d.rect;
    ghost.style.cssText = [
      `position:fixed`, `left:${r.left}px`, `top:${r.top}px`,
      `width:${r.width}px`, `height:${r.height}px`,
      `margin:0`, `transform:none`, `pointer-events:none`,
      `z-index:2147483645`, `opacity:.92`, `overflow:hidden`,
      `box-shadow:0 18px 44px rgba(0,0,0,.4)`, `outline:2px solid #4f9cf9`,
      `border-radius:6px`,
    ].join(';');
    document.body.appendChild(ghost);
    d.ghost = ghost;

    d.el.style.opacity = '0.32';
    document.documentElement.classList.add('hs-dragging');
    hideBox();
  }

  function moveGhost(e) {
    const d = st.drag;
    if (!d.ghost) return;
    d.ghost.style.left = (e.clientX - d.dx) + 'px';
    d.ghost.style.top = (e.clientY - d.dy) + 'px';
  }

  function isRowContainer(parent) {
    if (!parent) return false;
    const cs = getComputedStyle(parent);
    if (!/flex|grid/.test(cs.display)) return false;
    if (cs.display === 'grid') return false; // 网格按行处理更直观
    const dir = cs.flexDirection || 'row';
    return dir.indexOf('row') === 0;
  }

  function sig(el) {
    if (!el) return '';
    const cls = typeof el.className === 'string' ? el.className : '';
    return el.tagName + '|' + cls;
  }

  /**
   * 指针在 under 上时，应该「插到谁的旁边」。
   * 关键在于别把模块塞进别人的内部：
   *   A. 优先找和拖动物同一父元素的可拖块（同级重排）—— 最常见的意图
   *   B. 退一步找「父容器与拖动物父容器同类」的块（换容器：卡片从 A 组挪到 B 组）
   *   C. 都不匹配才用最内层的块
   */
  function resolveTarget(under, d) {
    const chain = blockChain(under).filter((n) =>
      n !== d.el && !d.el.contains(n) && !isOurs(n) && !n.hasAttribute('data-hs-drag'));
    if (!chain.length) return null;

    const dl = d.el.parentElement;
    const sib = chain.find((n) => n.parentElement === dl);
    if (sib) return sib;

    if (dl) {
      const mine = sig(dl);
      const same = chain.find((n) => n.parentElement && sig(n.parentElement) === mine);
      if (same) return same;
    }
    return chain[0];
  }

  function updateDrop(e) {
    const d = st.drag;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    if (!under || isOurs(under)) { d.target = null; hideLine(); hideBox(); return; }

    const target = resolveTarget(under, d);
    if (!target) { d.target = null; hideLine(); hideBox(); return; }

    const rect = target.getBoundingClientRect();
    const row = isRowContainer(target.parentElement);
    const before = row
      ? e.clientX < rect.left + rect.width / 2
      : e.clientY < rect.top + rect.height / 2;

    d.target = target;
    d.before = before;
    d.row = row;
    placeBox(rect, DRAG_BOX);
    drawLine(rect, before, row);
  }

  function onMove(e) {
    if (!st.on) return;
    if (!st.drag) { onHover(e); return; }
    const d = st.drag;
    if (!d.started) {
      if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < 6) return;
      startDrag();
    }
    e.preventDefault();
    moveGhost(e);
    updateDrop(e);
  }

  function endDrag(cancelled) {
    const d = st.drag;
    st.drag = null;
    hideLine();
    hideBox();
    clearHover();
    document.documentElement.classList.remove('hs-dragging');
    if (!d) return;

    if (d.ghost) d.ghost.remove();
    d.el.style.opacity = d.origOpacity;
    d.el.style.zIndex = d.origZIndex;

    if (cancelled || !d.started || !d.target) return;
    if (d.target === d.el || d.el.contains(d.target)) return;

    const parent = d.target.parentElement;
    if (!parent) return;

    const ref = d.before ? d.target : d.target.nextSibling;
    if (ref === d.el) return; // 位置没变化

    const prevParent = d.el.parentElement;
    const prevNext = d.el.nextSibling;
    try {
      parent.insertBefore(d.el, ref);
      history.push({ el: d.el, parent: prevParent, next: prevNext });
      if (history.length > 80) history.shift();
      st.app.markDirty();
      st.app.toast('已移动 · Cmd+Z 可撤销');
    } catch (err) {
      st.app.toast('移动失败：' + (err && err.message ? err.message : err), true);
    }
  }

  function onUp() {
    if (!st.drag) return;
    endDrag(false);
  }

  function onKey(e) {
    if (e.key === 'Escape' && st.drag) {
      e.preventDefault();
      e.stopPropagation();
      endDrag(true);
    }
  }

  function blockNative(e) {
    if (st.on) e.preventDefault();
  }

  /* ---------------- 开关 ---------------- */
  function enable() {
    if (st.on) return;
    if (!st.app) throw new Error('HS_Move 未初始化');
    st.on = true;
    ensureLayer();
    const b = st.bound;
    b.down = onDown; b.move = onMove; b.up = onUp; b.key = onKey; b.drag = blockNative;
    b.hover = onHover;
    document.addEventListener('pointerdown', b.down, true);
    document.addEventListener('pointermove', b.move, true);
    document.addEventListener('pointerup', b.up, true);
    document.addEventListener('pointerover', b.hover, true);
    document.addEventListener('dragstart', b.drag, true);
    document.addEventListener('keydown', b.key, true);
    window.addEventListener('scroll', clearHover, true);
  }

  function disable() {
    if (!st.on) return;
    endDrag(true);
    st.on = false;
    const b = st.bound;
    document.removeEventListener('pointerdown', b.down, true);
    document.removeEventListener('pointermove', b.move, true);
    document.removeEventListener('pointerup', b.up, true);
    document.removeEventListener('pointerover', b.hover, true);
    document.removeEventListener('dragstart', b.drag, true);
    document.removeEventListener('keydown', b.key, true);
    window.removeEventListener('scroll', clearHover, true);
    st.bound = {};
    if (st.layer) { st.layer.remove(); }
    st.layer = st.box = st.line = null;
  }

  function canUndo() {
    return history.length > 0;
  }

  /** 撤销最近一次拖动（把元素搬回原位置） */
  function undoLast() {
    const h = history.pop();
    if (!h || !h.el || !h.el.isConnected || !h.parent || !h.parent.isConnected) return false;
    try {
      const ref = h.next && h.next.parentNode === h.parent ? h.next : null;
      h.parent.insertBefore(h.el, ref);
      return true;
    } catch (_) {
      return false;
    }
  }

  return {
    init,
    enable,
    disable,
    canUndo,
    undoLast,
    isOn: () => st.on,
    isDragging: () => !!(st.drag && st.drag.started),
  };
})();
