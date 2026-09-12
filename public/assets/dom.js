// DOM を組み立てる最小限のヘルパ。innerHTML に外部由来の文字列を渡さない。
// SVG と HTML で名前空間が違うので、タグ名から振り分ける。

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'clipPath', 'linearGradient', 'stop', 'title',
]);

/**
 * 要素を作る。
 *   el('div', { class: 'panel' }, el('h2', {}, '見出し'))
 *   el('rect', { x: 0, y: 0, width: 10, height: 4, fill: 'red' })
 * 属性が null / undefined / false のときは付けない。
 */
export function el(tag, attrs = {}, ...children) {
  const node = SVG_TAGS.has(tag)
    ? document.createElementNS(SVG_NS, tag)
    : document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else {
      node.setAttribute(key, String(value));
    }
  }

  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 子要素を全部差し替える */
export function replace(parent, ...children) {
  parent.replaceChildren(...children.flat(4).filter((c) => c !== null && c !== undefined && c !== false));
  return parent;
}

/** CSS 変数の実際の値を読む。Canvas 描画で色が要るときに使う */
export function cssVar(name, fallback = '#888') {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** 数値の表示。null は「—」 */
export function fmt(value, digits = 1, unit = '') {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits) + unit;
}

/** 符号付きの表示。平年差など */
export function fmtSigned(value, digits = 1, unit = '') {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const s = value > 0 ? '+' : '';
  return s + value.toFixed(digits) + unit;
}

/** 0〜1 を百分率に */
export function fmtPct(value, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

const DOW = ['日', '月', '火', '水', '木', '金', '土'];

/** '2026-09-15' → '9/15(火)' */
export function fmtDate(ymd, { withDow = true } = {}) {
  const m = Number(ymd.slice(5, 7));
  const d = Number(ymd.slice(8, 10));
  if (!withDow) return `${m}/${d}`;
  const dow = new Date(`${ymd}T00:00:00+09:00`).getDay();
  return `${m}/${d}(${DOW[dow]})`;
}

export { DOW };
