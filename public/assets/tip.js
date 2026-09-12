// ツールチップ。マウスとタッチの両方で出す。
// 図の上に数値を全部書くと読めなくなるので、直接ラベルは要点だけにして
// 残りはここで見せる。

import { el, replace } from './dom.js';

let tipEl = null;

function ensure() {
  if (!tipEl) {
    tipEl = el('div', { id: 'tip', role: 'tooltip', 'aria-hidden': 'true' });
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

/**
 * 中身を差し替えて表示する。
 * @param {{title:string, rows:Array<{k:string, v:string, color?:string}>}} content
 */
export function showTip(content, x, y) {
  const node = ensure();
  replace(
    node,
    el('div', { class: 't-title' }, content.title),
    ...content.rows.map((r) => el(
      'div',
      { class: 't-row' },
      el('span', { class: 'k' },
        r.color ? el('i', { class: 'swatch', style: { background: r.color } }) : null,
        r.k),
      el('span', { class: 'v' }, r.v),
    )),
    content.footer ? el('div', { class: 'k', style: { marginTop: '4px', fontSize: '11.5px' } }, content.footer) : null,
  );
  node.dataset.show = '1';
  node.setAttribute('aria-hidden', 'false');
  moveTip(x, y);
}

/** 画面の端からはみ出さないように置く */
export function moveTip(x, y) {
  const node = ensure();
  const rect = node.getBoundingClientRect();
  const pad = 12;
  let left = x + 14;
  let top = y + 14;
  if (left + rect.width + pad > window.innerWidth) left = x - rect.width - 14;
  if (top + rect.height + pad > window.innerHeight) top = y - rect.height - 14;
  node.style.left = `${Math.max(pad, left)}px`;
  node.style.top = `${Math.max(pad, top)}px`;
}

export function hideTip() {
  if (!tipEl) return;
  tipEl.dataset.show = '0';
  tipEl.setAttribute('aria-hidden', 'true');
}

/**
 * 要素にツールチップを結び付ける。
 * 当たり判定は見た目より大きくしたいので、呼び出し側で透明な矩形を重ねて渡す。
 * @param {Element} node
 * @param {() => object} build ツールチップの中身を作る関数
 */
export function bindTip(node, build) {
  const show = (ev) => {
    const p = ev.touches?.[0] ?? ev;
    showTip(build(), p.clientX, p.clientY);
  };
  node.addEventListener('mouseenter', show);
  node.addEventListener('mousemove', (ev) => moveTip(ev.clientX, ev.clientY));
  node.addEventListener('mouseleave', hideTip);
  node.addEventListener('touchstart', (ev) => { show(ev); }, { passive: true });
  node.addEventListener('touchend', hideTip);
  return node;
}

/** 図の外に出たら消す。折れ線の十字カーソル用 */
export function bindTipArea(node, findAt) {
  const handle = (ev) => {
    const p = ev.touches?.[0] ?? ev;
    const rect = node.getBoundingClientRect();
    const content = findAt(
      ((p.clientX - rect.left) / rect.width) * node.viewBox.baseVal.width,
      ((p.clientY - rect.top) / rect.height) * node.viewBox.baseVal.height,
    );
    if (content) showTip(content, p.clientX, p.clientY);
    else hideTip();
  };
  node.addEventListener('mousemove', handle);
  node.addEventListener('mouseleave', hideTip);
  node.addEventListener('touchstart', handle, { passive: true });
  node.addEventListener('touchmove', handle, { passive: true });
  node.addEventListener('touchend', hideTip);
  return node;
}
