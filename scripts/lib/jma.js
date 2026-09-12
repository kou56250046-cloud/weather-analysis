// 気象庁のデータを取る。2系統ある。
//
//   1. etrn（過去の気象データ検索）  実測の日別値。数十年遡れる。HTML を読む
//   2. bosai（防災情報 JSON）        府県天気予報。比較対象の予報として使う
//
// どちらも公式 API として提供されたものではない。HTML の構造も JSON の仕様も
// 変わりうるので、パースに失敗したら黙って 0 件を返さず必ず投げる。
import { getJson, getText, buildUrl } from './http.js';

const ETRN = 'https://www.data.jma.go.jp/obd/stats/etrn';
const BOSAI = 'https://www.jma.go.jp/bosai';

// ---------------------------------------------------------------- 観測所の解決

/** 都府県名 → prec_no */
export async function fetchPrefCodes() {
  const html = await getText(`${ETRN}/select/prefecture00.php`);
  const pairs = [...html.matchAll(/<area[^>]*alt="([^"]+)"[^>]*href="prefecture\.php\?prec_no=(\d+)/g)]
    .map((m) => [m[1], m[2]]);
  if (pairs.length === 0) throw new Error('etrn: 都府県一覧のパースに失敗した');
  return new Map(pairs);
}

/**
 * 都府県内の観測所一覧。
 * area タグの onmouseover に viewPoint(...) の引数として全属性が入っている。
 * viewPoint('a', block_no, 漢字名, カナ名, 緯度度, 緯度分, 経度度, 経度分, 標高, e1..e6, ...)
 */
export async function fetchStations(precNo) {
  const html = await getText(
    buildUrl(`${ETRN}/select/prefecture.php`, { prec_no: precNo, block_no: '', year: '', month: '', day: '', view: '' }),
  );
  const calls = [...html.matchAll(/viewPoint\(([^)]*)\)/g)];
  if (calls.length === 0) throw new Error(`etrn: 観測所一覧のパースに失敗した (prec_no=${precNo})`);

  const byBlock = new Map();
  for (const [, argStr] of calls) {
    const a = argStr.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    if (a.length < 15) continue;
    const [kind, blockNo, kjName, knName, latD, latM, lonD, lonM, alt, ...elems] = a;
    if (kind !== 'a' && kind !== 's') continue;
    byBlock.set(blockNo, {
      precNo: String(precNo),
      blockNo,
      kind, // 'a' = アメダス, 's' = 気象官署
      name: kjName,
      kana: knName,
      lat: Number(latD) + Number(latM) / 60,
      lon: Number(lonD) + Number(lonM) / 60,
      alt: Number(alt),
      // 要素の有無。0 は観測していない。値の意味は気象庁側の内部表現なので
      // 「0 でなければ観測あり」とだけ解釈する
      hasPrcp: elems[0] !== '0',
      hasTemp: elems[1] !== '0',
      hasSun: elems[2] !== '0',
      hasWind: elems[3] !== '0',
      hasSnow: elems[4] !== '0',
      hasHumidity: elems[5] !== '0',
    });
  }
  if (byBlock.size === 0) throw new Error(`etrn: 観測所の抽出に失敗した (prec_no=${precNo})`);
  return [...byBlock.values()];
}

// ---------------------------------------------------------------- 実測の日別値

/** daily_a1（アメダス）の列位置 */
const COLS_A = {
  day: 0, prcp: 1, prcpMax1h: 2, prcpMax10m: 3,
  tavg: 4, tmax: 5, tmin: 6,
  rh: 7, rhMin: 8,
  wind: 9, windMax: 10, windMaxDir: 11, gust: 12, gustDir: 13, windDirMode: 14,
  sun: 15, snowfall: 16, snow: 17,
};

/** daily_s1（気象官署）の列位置。気圧2列と末尾の天気2列がある分ずれる */
const COLS_S = {
  day: 0, pressure: 1, pressureSea: 2,
  prcp: 3, prcpMax1h: 4, prcpMax10m: 5,
  tavg: 6, tmax: 7, tmin: 8,
  rh: 9, rhMin: 10,
  wind: 11, windMax: 12, windMaxDir: 13, gust: 14, gustDir: 15,
  sun: 16, snowfall: 17, snow: 18,
};

/** 取り出す変数と、その品質フラグを記録するかどうか */
const WANTED = ['tavg', 'tmax', 'tmin', 'prcp', 'prcpMax1h', 'rh', 'rhMin', 'wind', 'windMax', 'gust', 'sun', 'snow'];

/**
 * 1か月分の日別値を取る。
 * @param {{precNo:string, blockNo:string, kind:'a'|'s'}} station
 * @param {number} year
 * @param {number} month 1-12
 * @returns {Promise<Array<{day:number, values:object, flags:object}>>}
 */
export async function fetchDailyMonth(station, year, month) {
  const page = station.kind === 's' ? 'daily_s1.php' : 'daily_a1.php';
  const cols = station.kind === 's' ? COLS_S : COLS_A;
  const url = buildUrl(`${ETRN}/view/${page}`, {
    prec_no: station.precNo, block_no: station.blockNo, year, month, day: '', view: '',
  });
  const html = await getText(url, { timeoutMs: 30_000 });

  const rows = html.match(/<tr class="mtx"[\s\S]*?<\/tr>/g) ?? [];
  const out = [];
  for (const row of rows) {
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map((m) => m[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim());
    // ヘッダ行や注記行を落とす。日別表は 18 列（アメダス）か 21 列（官署）
    if (tds.length < 15) continue;
    const day = Number(tds[cols.day]);
    if (!Number.isInteger(day) || day < 1 || day > 31) continue;

    const values = {};
    const flags = {};
    for (const key of WANTED) {
      const idx = cols[key];
      if (idx === undefined) { values[key] = null; flags[key] = 3; continue; }
      const { value, flag } = parseCell(tds[idx]);
      values[key] = value;
      flags[key] = flag;
    }
    out.push({ day, values, flags });
  }
  if (out.length === 0) {
    throw new Error(`etrn: 日別表のパースに失敗した (${station.blockNo} ${year}-${month})`);
  }
  return out;
}

/**
 * セル1つを値と品質フラグに分ける。
 *   ''         欠測・未来日        → null, 3
 *   '///' '×'  欠測・観測実施せず  → null, 3
 *   '--'       現象なし            → 0,    0
 *   '5.5 )'    準正常値            → 5.5,  1
 *   '5.5 ]'    資料不足値          → 5.5,  2
 *   '5.5'      正常値              → 5.5,  0
 */
export function parseCell(raw) {
  const s = String(raw ?? '').trim();
  if (s === '' || s === '///' || s === '×' || s === '#') return { value: null, flag: 3 };
  if (s === '--') return { value: 0, flag: 0 };

  let flag = 0;
  let body = s;
  if (body.includes(']')) { flag = 2; body = body.replace(/\]/g, ''); }
  else if (body.includes(')')) { flag = 1; body = body.replace(/\)/g, ''); }
  body = body.replace(/[\s　]/g, '');

  if (body === '' || body === '--') return { value: body === '--' ? 0 : null, flag: body === '--' ? 0 : 3 };

  const n = Number(body);
  if (!Number.isFinite(n)) return { value: null, flag: 3 }; // 風向などの文字列
  return { value: n, flag };
}

// ---------------------------------------------------------------- 府県天気予報

/** 平年値表の列位置。アメダスと官署で列数が違う */
const NORMAL_COLS_A = { prcp: 0, tavg: 1, tmax: 2, tmin: 3, sun: 4 };
const NORMAL_COLS_S = { prcp: 0, tavg: 1, tmax: 2, tmin: 3, sun: 4 };

/**
 * 1991-2020 の日別平年値。1か月ぶんが1リクエストで返る。
 *
 * 30年分の日別値を集めて自分で平均するより桁違いに軽く、
 * しかも気象庁が公表している値そのものになる。観測所の移転補正も済んでいる。
 *
 * @returns {Promise<Array<{day:number, values:{prcp,tavg,tmax,tmin,sun}}>>}
 */
export async function fetchNormalsMonth(station, month) {
  const page = station.kind === 's' ? 'nml_sfc_d.php' : 'nml_amd_d.php';
  const cols = station.kind === 's' ? NORMAL_COLS_S : NORMAL_COLS_A;
  const url = buildUrl(`https://www.data.jma.go.jp/stats/etrn/view/${page}`, {
    prec_no: station.precNo, block_no: station.blockNo, year: '', month, day: '', view: '',
  });
  const html = await getText(url, { timeoutMs: 30_000 });

  const rows = html.match(/<tr class="mtx"[\s\S]*?<\/tr>/g) ?? [];
  const out = [];
  for (const row of rows) {
    // 日付は <th scope="rowgroup">1日</th> に入っている
    const th = row.match(/<th[^>]*>(\d+)日<\/th>/);
    if (!th) continue;
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map((m) => m[1].replace(/<[^>]*>/g, '').trim());
    const values = {};
    for (const [key, idx] of Object.entries(cols)) {
      values[key] = parseCell(tds[idx]).value;
    }
    out.push({ day: Number(th[1]), values });
  }
  if (out.length === 0) {
    throw new Error(`etrn: 平年値表のパースに失敗した (${station.blockNo} ${month}月)`);
  }
  return out;
}

/**
 * アメダス観測所表。
 * etrn の `block_no` と bosai の観測所コードは体系が違うので、座標で突き合わせる。
 * 府県天気予報の気温予報地点が、真値の観測所と同じ場所かを判定するのに要る。
 */
export async function fetchAmedasTable() {
  const { data } = await getJson(`${BOSAI}/amedas/const/amedastable.json`);
  if (!data || typeof data !== 'object') throw new Error('bosai: amedastable.json の構造が変わっている');
  return Object.entries(data).map(([code, v]) => ({
    code,
    name: v.kjName,
    lat: v.lat[0] + v.lat[1] / 60,
    lon: v.lon[0] + v.lon[1] / 60,
    alt: v.alt,
    type: v.type,
  }));
}

/** 予報区の一覧。市区町村名から class10 の予報区コードを引くのに使う */
export async function fetchAreaTable() {
  const { data } = await getJson(`${BOSAI}/common/const/area.json`);
  if (!data?.class10s) throw new Error('bosai: area.json の構造が変わっている');
  return data;
}

/**
 * 府県天気予報。Yahoo 天気の元データ。
 * forecast.json は [0] が3日予報（時系列3本）、[1] が週間予報。
 */
export async function fetchForecast(areaCode) {
  const { data } = await getJson(`${BOSAI}/forecast/data/forecast/${areaCode}.json`);
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`bosai: forecast の構造が変わっている (${areaCode})`);
  }
  return data;
}

export { ETRN, BOSAI, COLS_A, COLS_S, WANTED };
