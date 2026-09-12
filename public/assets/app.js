// 画面の組み立て。タブ4枚と地点切り替え。
//
// この画面の主張は「予報は外れる。どれくらい外れるかを先に言う」。
// なので、予報の数字の隣には必ず実績誤差を置く。精度を伏せた予報は出さない。
import { el, replace, fmt, fmtSigned, fmtPct, fmtDate, cssVar } from './dom.js';
import { renderForecast } from './tab-forecast.js';
import { renderScores } from './tab-scores.js';
import { renderNormals } from './tab-normals.js';
import { renderAnalysis } from './tab-analysis.js';

const TABS = [
  { id: 'forecast', label: '予報', render: renderForecast },
  { id: 'scores', label: '成績', render: renderScores },
  { id: 'normals', label: '平年比', render: renderNormals },
  { id: 'analysis', label: '分析', render: renderAnalysis },
];

const state = {
  meta: null,
  loc: null,
  tab: 'forecast',
  cache: new Map(),
};

async function loadJson(name) {
  if (state.cache.has(name)) return state.cache.get(name);
  const res = await fetch(`data/${name}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${name} を読めない (HTTP ${res.status})`);
  const data = await res.json();
  state.cache.set(name, data);
  return data;
}

/** タブが要るファイルをまとめて読む。1つ欠けても他は出す */
async function loadFor(tab, loc) {
  const names = {
    forecast: [`forecast-${loc}.json`, `scores-${loc}.json`],
    scores: [`scores-${loc}.json`, `coef-${loc}.json`, 'leakcheck.json'],
    normals: [`normals-${loc}.json`],
    analysis: [`history-${loc}.json`, `normals-${loc}.json`],
  }[tab];

  const results = await Promise.allSettled(names.map(loadJson));
  const out = {};
  results.forEach((r, i) => {
    const key = names[i].replace(`-${loc}`, '').replace('.json', '');
    out[key] = r.status === 'fulfilled' ? r.value : null;
    if (r.status === 'rejected') console.warn(names[i], r.reason.message);
  });
  return out;
}

function renderHeader() {
  const locSelect = el(
    'select',
    {
      'aria-label': '地点',
      onchange: (ev) => { state.loc = ev.target.value; persist(); render(); },
    },
    state.meta.locations.map((l) => el(
      'option',
      { value: l.key, selected: l.key === state.loc },
      l.label,
    )),
  );

  const themeBtn = el('button', {
    class: 'ghost',
    title: '配色を切り替える',
    onclick: toggleTheme,
  }, themeLabel());

  const tabs = el(
    'nav',
    { class: 'tabs', role: 'tablist' },
    TABS.map((t) => el('button', {
      role: 'tab',
      'aria-selected': String(t.id === state.tab),
      onclick: () => { state.tab = t.id; persist(); render(); },
    }, t.label)),
  );

  const last = state.meta.lastCollect ?? {};
  const stale = staleness(last);

  return el(
    'header',
    { class: 'top' },
    el(
      'div',
      { class: 'title-row' },
      el('h1', {}, '天気予報の精度検証'),
      el('span', { class: 'updated' },
        `更新 ${(state.meta.generatedAt ?? '').slice(0, 16).replace('T', ' ')}`,
        stale ? ` ・ ${stale}` : ''),
      el('div', { class: 'controls' }, locSelect, themeBtn),
    ),
    tabs,
  );
}

/** 収集が止まったら気づけるようにする */
function staleness(last) {
  const times = Object.values(last).filter(Boolean).sort();
  if (times.length === 0) return '収集記録なし';
  const newest = new Date(times.at(-1));
  const hours = (Date.now() - newest.getTime()) / 3600_000;
  if (hours > 48) return `⚠ 収集が ${Math.floor(hours / 24)} 日止まっている`;
  if (hours > 30) return '⚠ 収集が1日以上止まっている';
  return '';
}

function themeLabel() {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' ? '☾ 暗' : t === 'light' ? '☀ 明' : '◐ 自動';
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme;
  const next = cur === 'light' ? 'dark' : cur === 'dark' ? '' : 'light';
  if (next) document.documentElement.dataset.theme = next;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('theme', next); } catch { /* 使えない環境もある */ }
  render();
}

function persist() {
  try {
    localStorage.setItem('loc', state.loc);
    localStorage.setItem('tab', state.tab);
  } catch { /* プライベートウィンドウなどでは保存できない */ }
}

function restore() {
  try {
    const theme = localStorage.getItem('theme');
    if (theme) document.documentElement.dataset.theme = theme;
    const loc = localStorage.getItem('loc');
    if (loc && state.meta.locations.some((l) => l.key === loc)) state.loc = loc;
    const tab = localStorage.getItem('tab');
    if (tab && TABS.some((t) => t.id === tab)) state.tab = tab;
  } catch { /* 読めなくても既定値で動く */ }
}

function renderFooter() {
  const a = state.meta.attribution ?? {};
  const loc = state.meta.locations.find((l) => l.key === state.loc);
  return el(
    'footer',
    {},
    el('div', {}, `真値の観測所: ${loc?.station.name ?? '—'}（地点から ${fmt(loc?.station.distanceKm, 1)}km、標高 ${loc?.station.alt ?? '—'}m）`),
    el('div', {}, a.openMeteo ?? 'Weather data by Open-Meteo.com (CC BY 4.0)'),
    el('div', {}, a.jma ?? '観測値・平年値・府県天気予報: 気象庁'),
    el('div', {}, '気象庁の防災情報 JSON は公式 API として提供されたものではなく、仕様変更で取得が止まることがある。'),
  );
}

async function render() {
  const app = document.getElementById('app');
  const main = el('main', {}, el('p', { class: 'empty' }, '読み込み中…'));
  replace(app, renderHeader(), main, renderFooter());

  const tab = TABS.find((t) => t.id === state.tab);
  try {
    const data = await loadFor(state.tab, state.loc);
    const loc = state.meta.locations.find((l) => l.key === state.loc);
    replace(main, ...tab.render({ data, loc, meta: state.meta }));
  } catch (err) {
    console.error(err);
    replace(main, el('div', { class: 'panel' },
      el('p', { class: 'empty' }, `表示できなかった: ${err.message}`)));
  }
}

async function main() {
  try {
    state.meta = await loadJson('meta.json');
  } catch (err) {
    document.getElementById('app').appendChild(el('div', { class: 'panel' },
      el('p', { class: 'empty' },
        'データがまだ無い。scripts/build-derived.js を走らせてから開く。'),
      el('p', { class: 'empty' }, err.message)));
    return;
  }
  state.loc = state.meta.locations[0]?.key ?? null;
  restore();
  render();
  // 画面幅が変わると Canvas の図を描き直す必要がある
  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(render, 250);
  });
}

main();

export { state, fmt, fmtSigned, fmtPct, fmtDate, cssVar };
