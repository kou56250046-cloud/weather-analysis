// 天気のアイコン。WMO の天気コードから描き分ける。
//
// 外部のアイコンフォントも画像も使わない。その場で SVG を組み立てる。
// 色は CSS 変数から取るので、明暗どちらの配色でも同じ形が読める。
//
// 形だけに意味を持たせない。必ず短い名前（晴れ・雨など）を添えて呼ぶこと。
// 色と形だけで情報を伝えると、判別できない人に何も届かない。
import { el } from './dom.js';

/** WMO 4677 の天気コードを、描き分ける種別と日本語名に対応づける */
const CODE_MAP = new Map([
  [0, ['clear', '快晴']],
  [1, ['mostly-clear', 'おおむね晴れ']],
  [2, ['partly-cloudy', '晴れ時々曇り']],
  [3, ['cloudy', '曇り']],
  [45, ['fog', '霧']],
  [48, ['fog', '霧氷']],
  [51, ['drizzle', '弱い霧雨']],
  [53, ['drizzle', '霧雨']],
  [55, ['drizzle', '強い霧雨']],
  [56, ['sleet', '弱い着氷性の霧雨']],
  [57, ['sleet', '着氷性の霧雨']],
  [61, ['rain', '弱い雨']],
  [63, ['rain', '雨']],
  [65, ['heavy-rain', '強い雨']],
  [66, ['sleet', '弱い着氷性の雨']],
  [67, ['sleet', '着氷性の雨']],
  [71, ['snow', '弱い雪']],
  [73, ['snow', '雪']],
  [75, ['heavy-snow', '強い雪']],
  [77, ['snow', '霧雪']],
  [80, ['showers', 'にわか雨']],
  [81, ['showers', 'にわか雨']],
  [82, ['heavy-rain', '激しいにわか雨']],
  [85, ['snow', 'にわか雪']],
  [86, ['heavy-snow', '強いにわか雪']],
  [95, ['thunder', '雷雨']],
  [96, ['thunder', '雷雨（ひょう）']],
  [99, ['thunder', '雷雨（ひょう）']],
]);

/** 天気コードから種別と名前を引く。未知のコードは曇り扱いにする */
export function describeCode(code) {
  if (code === null || code === undefined) return { kind: 'unknown', label: '不明' };
  const hit = CODE_MAP.get(Number(code));
  if (hit) return { kind: hit[0], label: hit[1] };
  return { kind: 'cloudy', label: '曇り' };
}

/**
 * 天気コードが無いときの代替。
 * 降水量と降水確率から、おおよその見た目を決める。
 * 合議した予報にはコードが付かない日があるので、その穴を埋める。
 */
export function inferKind({ prcp = null, pop = null, tmax = null } = {}) {
  const snowy = tmax !== null && tmax <= 2;
  if (prcp !== null && prcp >= 10) return snowy ? 'heavy-snow' : 'heavy-rain';
  if (prcp !== null && prcp >= 1) return snowy ? 'snow' : 'rain';
  if (prcp !== null && prcp >= 0.2) return 'drizzle';
  if (pop !== null && pop >= 0.5) return 'showers';
  if (pop !== null && pop >= 0.2) return 'partly-cloudy';
  return 'clear';
}

const SUN = 'var(--warning)';
const CLOUD = 'var(--text-secondary)';
const CLOUD_LIGHT = 'var(--text-muted)';
const DROP = 'var(--series-1)';
const SNOW = 'var(--seq-250)';
const BOLT = 'var(--warning)';

/** 太陽。中心と半径を指定する */
function sun(cx, cy, r, { rays = true } = {}) {
  const parts = [el('circle', { cx, cy, r, fill: SUN })];
  if (!rays) return parts;
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    parts.push(el('line', {
      x1: cx + Math.cos(a) * (r + 2.2),
      y1: cy + Math.sin(a) * (r + 2.2),
      x2: cx + Math.cos(a) * (r + 5),
      y2: cy + Math.sin(a) * (r + 5),
      stroke: SUN,
      'stroke-width': 2,
      'stroke-linecap': 'round',
    }));
  }
  return parts;
}

/** 雲。3つの円と底辺で作る形を1つのパスで描く */
function cloud(x, y, w, color = CLOUD) {
  const s = w / 30;
  return el('path', {
    transform: `translate(${x} ${y}) scale(${s})`,
    d: 'M7.5 22h15a6 6 0 0 0 .7-11.96A8 8 0 0 0 8.2 8.6 5.6 5.6 0 0 0 7.5 22z',
    fill: color,
  });
}

/** 雨粒 */
function drops(xs, y, { color = DROP, length = 5, width = 2 } = {}) {
  return xs.map((x) => el('line', {
    x1: x, y1: y, x2: x - 1.5, y2: y + length,
    stroke: color, 'stroke-width': width, 'stroke-linecap': 'round',
  }));
}

/** 雪の結晶。細かく描いても小さいと潰れるので、線3本の星にする */
function flakes(xs, y, { color = SNOW, r = 2.6 } = {}) {
  const parts = [];
  for (const x of xs) {
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI) / 3;
      parts.push(el('line', {
        x1: x - Math.cos(a) * r, y1: y - Math.sin(a) * r,
        x2: x + Math.cos(a) * r, y2: y + Math.sin(a) * r,
        stroke: color, 'stroke-width': 1.4, 'stroke-linecap': 'round',
      }));
    }
  }
  return parts;
}

/** 種別ごとの中身。24×24 の座標系で描く */
function glyph(kind) {
  switch (kind) {
    case 'clear':
      return sun(12, 12, 5.2);
    case 'mostly-clear':
      return [...sun(10, 10, 4.6), cloud(8, 11, 15, CLOUD_LIGHT)];
    case 'partly-cloudy':
      return [...sun(9, 8.5, 4.2, { rays: false }), cloud(5, 9, 17)];
    case 'cloudy':
      return [cloud(9, 5, 14, CLOUD_LIGHT), cloud(2, 8, 19)];
    case 'fog':
      return [
        cloud(3, 3, 18, CLOUD_LIGHT),
        ...[16, 19].map((y, i) => el('line', {
          x1: 3 + i * 2, y1: y, x2: 21 - i * 2, y2: y,
          stroke: CLOUD, 'stroke-width': 1.8, 'stroke-linecap': 'round',
        })),
      ];
    case 'drizzle':
      return [cloud(3, 2, 18), ...drops([8, 12, 16], 17, { length: 3, width: 1.6 })];
    case 'rain':
      return [cloud(3, 2, 18), ...drops([8, 12, 16], 16)];
    case 'heavy-rain':
      return [cloud(2, 1, 20), ...drops([7, 11, 15, 19], 16, { length: 6, width: 2.2 })];
    case 'showers':
      return [...sun(6, 6, 3.6, { rays: false }), cloud(4, 3, 17), ...drops([10, 15], 17)];
    case 'snow':
      return [cloud(3, 2, 18), ...flakes([8, 16], 18), ...flakes([12], 20.5)];
    case 'heavy-snow':
      return [cloud(2, 1, 20), ...flakes([7, 13, 19], 18), ...flakes([10, 16], 21)];
    case 'sleet':
      return [cloud(3, 2, 18), ...drops([9], 17), ...flakes([15], 18)];
    case 'thunder':
      return [
        cloud(3, 2, 18),
        el('path', {
          d: 'M13 15l-4 5.5h3L11 24l4.5-6h-3L14 15z',
          fill: BOLT,
        }),
      ];
    default:
      return [el('text', {
        x: 12, y: 16, 'text-anchor': 'middle',
        fill: CLOUD_LIGHT, 'font-size': 13,
      }, '—')];
  }
}

/**
 * 天気アイコンを作る。
 * @param {object} opts
 * @param {number|null} opts.code WMO の天気コード
 * @param {string} [opts.kind] コードが無いときに直接指定する種別
 * @param {number} [opts.size] 画素
 * @param {string} [opts.label] 読み上げと title に使う名前
 */
export function weatherIcon({ code = null, kind = null, size = 24, label = null } = {}) {
  const described = kind ? { kind, label: label ?? KIND_LABEL[kind] ?? '' } : describeCode(code);
  const name = label ?? described.label;

  return el(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      role: 'img',
      'aria-label': name,
      class: 'wicon',
    },
    el('title', {}, name),
    glyph(described.kind),
  );
}

/** 種別から名前を引く。コードが無い日の表示に使う */
export const KIND_LABEL = {
  clear: '晴れ',
  'mostly-clear': 'おおむね晴れ',
  'partly-cloudy': '晴れ時々曇り',
  cloudy: '曇り',
  fog: '霧',
  drizzle: '霧雨',
  rain: '雨',
  'heavy-rain': '強い雨',
  showers: 'にわか雨',
  snow: '雪',
  'heavy-snow': '強い雪',
  sleet: 'みぞれ',
  thunder: '雷雨',
  unknown: '不明',
};

/**
 * 1日分の予報からアイコンと名前を決める。
 * 合議した天気コードがあればそれを使い、無ければ降水量と確率から推し量る。
 */
export function iconForDay(day, { size = 24 } = {}) {
  if (day.code !== null && day.code !== undefined) {
    const d = describeCode(day.code);
    return { node: weatherIcon({ code: day.code, size }), label: d.label, inferred: false };
  }
  const kind = inferKind({
    prcp: day.prcp?.value ?? null,
    pop: day.pop?.value ?? null,
    tmax: day.tmax?.value ?? null,
  });
  return {
    node: weatherIcon({ kind, size, label: `${KIND_LABEL[kind]}（推定）` }),
    label: KIND_LABEL[kind],
    inferred: true,
  };
}
