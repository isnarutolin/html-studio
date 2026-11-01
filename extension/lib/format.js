/**
 * HTML Studio — 字体 / 字号
 *
 * 为什么不用 document.execCommand('fontName' / 'fontSize')：
 *   1. 产出的是 <font face> / <font size="1..7">，跟我们要的精确 CSS 值不是一回事；
 *   2. 更致命的是它是「开关式」的：给已经是 32px 的文字再标一次（32px 和 size=7 同为
 *      xxx-large 档）会被当成「取消格式」，把用户原来的字号连带删掉。
 *
 * 所以这里自己按 Range 包 <span style="...">：
 *   - 选区正好是某个内联元素的全部内容 → 直接合并样式到它身上，不会一层层套娃；
 *   - 否则把选区覆盖到的文本节点逐个切出来（splitText）各包一个 span。
 * 全程只改动选中范围，标签结构不会被重排。
 *
 * 光标没有选中任何文字时，样式作用在光标所在的整个块元素上（符合直觉：
 * 点进一段话里改字号，就是想改这段）。
 */
window.HS_Format = (function () {
  'use strict';

  // 只放常见的几款：选择太多反而选不出来
  const FONTS = [
    ['inherit', '系统默认'],
    ['"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif', '苹方 / PingFang SC'],
    ['"Microsoft YaHei", "PingFang SC", sans-serif', '微软雅黑'],
    ['SimHei, "Heiti SC", sans-serif', '黑体'],
    ['SimSun, "Songti SC", serif', '宋体'],
    ['"Kaiti SC", KaiTi, "STKaiti", serif', '楷体'],
    ['Georgia, "Songti SC", serif', 'Georgia'],
    ['"Times New Roman", Times, serif', 'Times New Roman'],
    ['Arial, Helvetica, sans-serif', 'Arial'],
    ['Helvetica, Arial, sans-serif', 'Helvetica'],
    ['"Courier New", Courier, monospace', 'Courier New'],
    ['ui-monospace, Menlo, Monaco, "Courier New", monospace', '等宽 / Menlo'],
  ];

  const SIZES = [11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28, 32, 36, 40, 44, 48, 56, 64, 72, 88, 96];

  // 这些标签即使 display 变成别的，也按「块」看待
  const BLOCK_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'DIV', 'SECTION', 'ARTICLE',
    'ASIDE', 'HEADER', 'FOOTER', 'MAIN', 'NAV', 'BLOCKQUOTE', 'TD', 'TH', 'DD',
    'DT', 'PRE', 'ADDRESS', 'UL', 'OL', 'TABLE', 'FIGURE', 'FIGCAPTION', 'BODY',
  ]);

  // 选区正好覆盖其全部文字时，可以直接把样式合并上去的内联元素
  const INLINE_TAGS = /^(SPAN|FONT|B|I|U|EM|STRONG|A|MARK|SMALL|BIG|CODE|S|SUB|SUP)$/;

  // 这些容器里的文字不参与（脚本内容、SVG 文本塞 span 会坏掉）
  const SKIP_SELECTOR = 'script,style,noscript,textarea,title,svg';

  function kebab(k) {
    return k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  }

  /** 光标/选区所在的块元素（用于「没选中文字就改整段」） */
  function blockOf(node) {
    let el = node && node.nodeType === 3 ? node.parentElement : node;
    let fallback = null;
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (!fallback) fallback = el;
      const cs = getComputedStyle(el);
      if (BLOCK_TAGS.has(el.tagName) || !/^inline/.test(cs.display)) return el;
      el = el.parentElement;
    }
    return fallback || document.body;
  }

  /** 选区当前实际生效的字体 / 字号 */
  function current() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const node = sel.anchorNode;
    const el = node && node.nodeType === 3 ? node.parentElement : node;
    if (!el || el.nodeType !== 1) return null;
    const cs = getComputedStyle(el);
    return {
      fontFamily: cs.fontFamily || '',
      fontSize: Math.round(parseFloat(cs.fontSize) || 16),
    };
  }

  function reselect(spans) {
    if (!spans || !spans.length) return;
    try {
      const r = document.createRange();
      r.setStartBefore(spans[0]);
      r.setEndAfter(spans[spans.length - 1]);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (_) { /* 选不回来不影响样式已经写进元素 */ }
  }

  function skipped(el) {
    if (!el || el.nodeType !== 1) return true;
    try {
      return !!el.closest(SKIP_SELECTOR);
    } catch (_) {
      return false;
    }
  }

  /** 把选区覆盖到的文本节点切出来，各包一个带样式的 span */
  function wrapTextNodes(range, cssText) {
    const root = range.commonAncestorContainer;
    const host = root && root.nodeType === 1 ? root : (root && root.parentElement);
    if (!host) return [];

    const texts = [];
    try {
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, null);
      let n = walker.nextNode();
      while (n) {
        if (n.nodeValue && !/^\s*$/.test(n.nodeValue) && !skipped(n.parentElement)
            && range.intersectsNode(n)) {
          texts.push(n);
        }
        n = walker.nextNode();
      }
    } catch (_) {
      return [];
    }

    const spans = [];
    texts.forEach((t) => {
      let start = 0;
      let end = t.nodeValue.length;
      if (t === range.startContainer) start = range.startOffset;
      if (t === range.endContainer) end = range.endOffset;
      if (start >= end) return;

      let target = t;
      try {
        // 先切尾再切头：切完尾之后 target 仍是 [0, end)
        if (end < target.nodeValue.length) target.splitText(end);
        if (start > 0) target = target.splitText(start);
      } catch (_) {
        return;
      }
      if (!target.parentNode) return;

      const span = document.createElement('span');
      span.setAttribute('style', cssText);
      target.parentNode.insertBefore(span, target);
      span.appendChild(target);
      spans.push(span);
    });
    return spans;
  }

  /** 选区里的第一个文本节点（用它的祖先链找可合并的内联元素） */
  function firstTextIn(range) {
    const root = range.commonAncestorContainer;
    if (root && root.nodeType === 3) return root;
    const host = root && root.nodeType === 1 ? root : (root && root.parentElement);
    if (!host) return null;
    try {
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, null);
      let n = walker.nextNode();
      while (n) {
        if (n.nodeValue && !/^\s*$/.test(n.nodeValue) && range.intersectsNode(n)) return n;
        n = walker.nextNode();
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  function apply(styles) {
    const keys = Object.keys(styles || {});
    if (!keys.length) return { ok: false, reason: '没有要应用的样式' };

    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return { ok: false, reason: '先把光标放到要改的文字上' };
    const range = sel.getRangeAt(0);

    // 1) 光标未选中文字 → 作用于整段
    if (range.collapsed) {
      const block = blockOf(sel.anchorNode);
      if (!block) return { ok: false, reason: '没找到可以应用样式的元素' };
      keys.forEach((k) => { block.style[k] = styles[k]; });
      return { ok: true, block: true, count: 1 };
    }

    const cssText = keys.map((k) => `${kebab(k)}:${styles[k]}`).join(';');
    const text = range.toString();

    // 2) 选区正好是某个内联元素的全部文字 → 合并到它身上，避免层层套 span
    //    取最外层的那个：重复调字号/字体时样式都长在同一个元素上，不会越套越深
    const ft = firstTextIn(range);
    let best = null;
    for (let cur = ft && ft.parentElement; cur && cur !== document.body; cur = cur.parentElement) {
      if (INLINE_TAGS.test(cur.tagName) && cur.textContent === text && !skipped(cur)) best = cur;
    }
    if (best && best.tagName === 'A') best = null; // 不动链接本身，交给下面的包裹逻辑
    if (best) {
      keys.forEach((k) => { best.style[k] = styles[k]; });
      reselect([best]);
      return { ok: true, block: false, count: 1 };
    }

    // 3) 其余情况 → 按文本节点切分包裹
    const spans = wrapTextNodes(range, cssText);
    if (!spans.length) return { ok: false, reason: '这段内容改不了样式（可能是图片或控件）' };
    reselect(spans);
    return { ok: true, block: false, count: spans.length };
  }

  /** 供面板显示用：把计算出来的字体名简化成「看得懂」的写法 */
  function shortFamily(family) {
    const first = String(family || '').split(',')[0].replace(/["']/g, '').trim();
    return first || '默认';
  }

  return { FONTS, SIZES, apply, current, blockOf, shortFamily };
})();
