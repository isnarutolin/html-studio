/**
 * HTML Studio — 「页」识别与删除
 *
 * AI 生成的多页 HTML 大致三种形态：
 *   1. 显式分页：<section class="slide"> / <div class="page"> / swiper / [data-page]
 *      —— 隐藏页常是 display:none，量不出高度，只能靠类名认。
 *   2. 竖排长页：一串「接近满屏」的 <section>/<div> 依次排下来。
 *      —— 量高度：同一父元素下，多个子元素高度 ≥ 视口一半。
 *   3. 堆叠：子元素 position:absolute 叠在一起，用 active 类切换。
 *      —— 高度可量，落在形态 2 的判定里（可见的那个满屏）。
 *
 * 优先用 1（信号最强），没有再退回 2/3，最后用 body 直接子元素兜底。
 */
window.HS_Pages = (function () {
  'use strict';

  // 类名/属性里带这些词的，基本就是「一页」
  const KNOWN_SELECTORS = [
    '.slide',
    '.swiper-slide',
    '.reveal .slides > section',
    '.slides > section',
    '.carousel-item',
    '.screen',
    '[data-page]',
    '[data-slide]',
    '[data-page-index]',
  ];

  const PAGE_TAGS = /^(DIV|SECTION|ARTICLE|MAIN|LI|FIGURE)$/;

  function hasSize(el, minH) {
    const r = el.getBoundingClientRect();
    return r.height >= (minH || 40) && r.width >= 100;
  }

  /** 正常文档流里的元素（绝对定位的往往是遮罩/水印/悬浮层，不是「页」） */
  function inFlow(el) {
    const cs = getComputedStyle(el);
    return cs.position !== 'absolute' && cs.position !== 'fixed' && cs.position !== 'sticky';
  }

  /** 同一层堆叠才算「页」；互相重叠的更像图层叠加 */
  function noOverlap(els) {
    const rs = els
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.height > 0)
      .sort((a, b) => a.top - b.top);
    for (let i = 1; i < rs.length; i += 1) {
      if (rs[i].top < rs[i - 1].bottom - 4) return false;
    }
    return true;
  }

  function vh() {
    return window.innerHeight || document.documentElement.clientHeight || 800;
  }

  /** 按文档顺序排好，去掉互相嵌套的重复项 */
  function normalize(els) {
    const uniq = [];
    els.forEach((el) => { if (el && el.isConnected && uniq.indexOf(el) < 0) uniq.push(el); });
    uniq.sort((a, b) => {
      if (a === b) return 0;
      // eslint-disable-next-line no-bitwise
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    return uniq.filter((el) => !uniq.some((other) => other !== el && other.contains(el)));
  }

  function detect() {
    if (!document.body) return { els: [], strategy: null };
    const viewportH = vh();
    const groups = [];

    const addGroup = (els, score, strategy) => {
      const list = normalize(els.filter(Boolean));
      if (list.length < 2) return;
      groups.push({ els: list, score, strategy });
    };

    // ---- 1. 已知类名 / 属性 ----
    KNOWN_SELECTORS.forEach((sel) => {
      let all = [];
      try { all = Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (_) { return; }
      if (all.length < 2) return;
      const byParent = new Map();
      all.forEach((el) => {
        const p = el.parentElement;
        if (!p) return;
        if (!byParent.has(p)) byParent.set(p, []);
        byParent.get(p).push(el);
      });
      byParent.forEach((els) => {
        if (els.length < 2) return;
        // 至少有一个是有高度的（隐藏页高度为 0，不需要全部可见）
        if (!els.some((el) => hasSize(el, 40))) return;
        addGroup(els, 200 + els.length, 'selector:' + sel);
      });
    });

    // ---- 2/3. 结构：同一父元素下多个接近满屏的子元素 ----
    let best = null;
    const containers = [document.body].concat(
      Array.prototype.slice.call(document.body.querySelectorAll('*'), 0, 3000));
    containers.forEach((c) => {
      const kids = Array.prototype.filter.call(c.children, (k) => PAGE_TAGS.test(k.tagName));
      if (kids.length < 2) return;
      const tall = kids.filter((k) => {
        const r = k.getBoundingClientRect();
        return r.height >= viewportH * 0.5 && r.width >= 120 && inFlow(k);
      });
      if (tall.length < 2 || !noOverlap(tall)) return;
      if (!best || tall.length > best.tall.length) best = { kids, tall };
    });
    if (best) addGroup(best.kids, 120 + best.tall.length, 'structure');

    // ---- 4. body 直接子元素兜底 ----
    const bodyKids = Array.prototype.filter.call(document.body.children, (k) => PAGE_TAGS.test(k.tagName));
    if (bodyKids.length >= 2 && bodyKids.length <= 60) {
      const visible = bodyKids.filter((k) => hasSize(k, viewportH * 0.4) && inFlow(k));
      if (visible.length >= 2 && noOverlap(visible)) addGroup(bodyKids, 60 + visible.length, 'body');
    }

    if (!groups.length) return { els: [], strategy: null };
    groups.sort((a, b) => b.score - a.score);
    const winner = groups[0];
    return { els: winner.els, strategy: winner.strategy };
  }

  /** 给一页起个名字：优先取标题，其次取前几十个字 */
  function label(el) {
    if (!el) return '';
    let text = '';
    const head = el.querySelector('h1, h2, h3, [class*="title"], [class*="Title"], [class*="heading"]');
    if (head) text = head.textContent || '';
    if (!text.trim()) text = el.textContent || '';
    text = text.replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 36);
    const img = el.querySelector('img');
    if (img) return '（图片）' + (img.getAttribute('alt') || '');
    return '（无文字）';
  }

  function isHidden(el) {
    if (!el) return true;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    const r = el.getBoundingClientRect();
    return r.width === 0 && r.height === 0;
  }

  /** 列表用：{ el, index, label, hidden } */
  function list() {
    const { els, strategy } = detect();
    return {
      strategy,
      items: els.map((el, i) => ({
        el,
        index: i,
        label: label(el),
        hidden: isHidden(el),
      })),
    };
  }

  function remove(el) {
    if (!el || !el.parentElement) return false;
    // 兜底：别把整页删空
    if (el === document.body || el === document.documentElement) return false;
    el.remove();
    return true;
  }

  return { detect, list, label, remove, isHidden };
})();
