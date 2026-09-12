// 市区町村名から、観測所・予報区・座標を解決して config/locations.json を作る。
// 座標を手で埋めない。埋めると典型的な写し間違いが入り、しかも気づけない。
//
//   実測の観測所  etrn の観測所一覧から、要素数と距離を天秤にかけて選ぶ
//   予報区        bosai の area.json から class10（府県天気予報の単位）を引く
//   モデルの座標  市区町村の代表点。番地レベルの座標は持たない
//
// 使い方: node scripts/resolve-locations.js [--force]
import { fetchPrefCodes, fetchStations, fetchAreaTable, fetchAmedasTable } from './lib/jma.js';
import { writeJson, readJson } from './lib/store.js';
import { LOCATIONS_PATH } from './lib/paths.js';

/**
 * 対象地点。座標は市区町村役所・役場のおおよその位置（代表点）。
 * 個人の住所は書かない。
 */
const TARGETS = [
  { key: 'setagaya', label: '東京都世田谷区', pref: '東京都', lat: 35.646, lon: 139.653, areaName: '東京地方' },
  { key: 'kawasaki', label: '神奈川県川崎市', pref: '神奈川県', lat: 35.531, lon: 139.703, areaName: '東部' },
  { key: 'sagamihara', label: '神奈川県相模原市', pref: '神奈川県', lat: 35.571, lon: 139.373, areaName: '西部' },
  { key: 'atami', label: '静岡県熱海市', pref: '静岡県', lat: 35.096, lon: 139.072, areaName: '伊豆' },
];

/** 大円距離（km）。観測所の遠近を測るだけなので球で十分 */
export function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** 検証したい要素。観測していない要素はその変数の検証ができない */
const WANTED_ELEMS = ['hasPrcp', 'hasTemp', 'hasSun', 'hasWind', 'hasHumidity'];

/** これより遠い観測所は、要素が揃っていても真値に使わない */
const MAX_DISTANCE_KM = 25;

/**
 * 真値に使う観測所を選ぶ。
 *
 * 最寄りを機械的に取ると、雨量と気温しか観測していない観測所に当たることがある。
 * 湿度と風の検証ができなくなるので、要素数と距離を天秤にかける。
 * 距離 10km を要素1つ分と見なす。熱海では 2.4km で3要素の熱海伊豆山より、
 * 5.9km で5要素の網代を選ぶ。
 *
 * 気温を観測していない観測所（世田谷・相模原中央などの雨量計）は最初から外す。
 */
export function pickStation(stations, lat, lon) {
  const scored = stations
    .filter((s) => s.hasTemp)
    .map((s) => {
      const distanceKm = haversineKm(lat, lon, s.lat, s.lon);
      const elems = WANTED_ELEMS.filter((k) => s[k]).length;
      return { ...s, distanceKm, elems, score: elems - distanceKm / 10 };
    })
    .filter((s) => s.distanceKm <= MAX_DISTANCE_KM);

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm);
  return scored[0];
}

/** area.json の class10 から、府県名と予報区名で予報区コードを引く */
export function pickAreaCode(areaTable, prefName, areaName) {
  const offices = Object.entries(areaTable.offices ?? {});
  const office = offices.find(([, v]) => v.name === prefName);
  if (!office) throw new Error(`bosai: 府県が見つからない: ${prefName}`);
  const [officeCode, officeVal] = office;

  const children = officeVal.children ?? [];
  const matched = children.find((c) => areaTable.class10s?.[c]?.name === areaName);
  if (!matched) {
    const names = children.map((c) => areaTable.class10s?.[c]?.name).join(' / ');
    throw new Error(`bosai: 予報区が見つからない: ${prefName} の "${areaName}"（候補: ${names}）`);
  }
  return { officeCode, class10: matched, class10Name: areaTable.class10s[matched].name };
}

async function main() {
  const force = process.argv.includes('--force');
  const existing = await readJson(LOCATIONS_PATH);
  if (existing && !force) {
    console.log(`${LOCATIONS_PATH} は既にある。作り直すなら --force`);
    printSummary(existing);
    return;
  }

  const prefCodes = await fetchPrefCodes();
  const areaTable = await fetchAreaTable();
  const amedas = await fetchAmedasTable();

  const stationCache = new Map();
  const locations = [];

  for (const t of TARGETS) {
    const precNo = prefCodes.get(t.pref);
    if (!precNo) throw new Error(`etrn: 府県コードが引けない: ${t.pref}`);

    if (!stationCache.has(precNo)) {
      stationCache.set(precNo, await fetchStations(precNo));
    }
    // 県境をまたぐ方が近いことがあるので、隣接県の観測所も候補に入れる
    const neighbours = neighbourPrefs(t.pref);
    const pool = [...stationCache.get(precNo)];
    for (const np of neighbours) {
      const npCode = prefCodes.get(np);
      if (!npCode) continue;
      if (!stationCache.has(npCode)) stationCache.set(npCode, await fetchStations(npCode));
      pool.push(...stationCache.get(npCode));
    }

    const station = pickStation(pool, t.lat, t.lon);
    if (!station) throw new Error(`気温を観測する観測所が見つからない: ${t.label}`);
    const area = pickAreaCode(areaTable, t.pref, t.areaName);

    // 府県天気予報の気温予報地点と突き合わせるため、bosai 側のコードも持つ
    const amedasHit = matchAmedas(amedas, station);

    locations.push({
      key: t.key,
      label: t.label,
      pref: t.pref,
      lat: t.lat,
      lon: t.lon,
      station: {
        precNo: station.precNo,
        blockNo: station.blockNo,
        kind: station.kind,
        name: station.name,
        lat: round(station.lat, 4),
        lon: round(station.lon, 4),
        alt: station.alt,
        distanceKm: round(station.distanceKm, 1),
        amedasCode: amedasHit?.code ?? null,
        amedasName: amedasHit?.name ?? null,
        has: {
          prcp: station.hasPrcp, temp: station.hasTemp, sun: station.hasSun,
          wind: station.hasWind, snow: station.hasSnow, humidity: station.hasHumidity,
        },
      },
      jma: area,
    });
  }

  await writeJson(LOCATIONS_PATH, { v: 1, updatedAt: new Date().toISOString(), locations }, { pretty: true });
  console.log(`書いた: ${LOCATIONS_PATH}`);
  printSummary({ locations });
}

/**
 * etrn の観測所に対応する bosai のアメダス観測所を座標で引く。
 * 2km 以内かつ名前が一致するものだけ採用する。取り違えると比較が無意味になる。
 */
function matchAmedas(amedas, station) {
  const near = amedas
    .map((a) => ({ ...a, d: haversineKm(station.lat, station.lon, a.lat, a.lon) }))
    .filter((a) => a.d <= 2)
    .sort((a, b) => a.d - b.d);
  const byName = near.find((a) => a.name === station.name);
  if (byName) return byName;
  if (near.length > 0) {
    console.warn(`警告: ${station.name} に一致するアメダス名が無い。最寄りは ${near[0].name} (${near[0].d.toFixed(2)}km)`);
  }
  return null;
}

/** 県境近くの地点のために、隣接県の観測所も候補に入れる */
function neighbourPrefs(pref) {
  const map = {
    '東京都': ['神奈川県', '埼玉県', '千葉県'],
    '神奈川県': ['東京都', '静岡県', '山梨県'],
    '静岡県': ['神奈川県', '山梨県', '愛知県'],
  };
  return map[pref] ?? [];
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function printSummary(cfg) {
  console.log('');
  console.log('地点              観測所            距離     標高    観測要素             予報区');
  console.log('----------------  ----------------  -------  ------  -------------------  ------------------');
  for (const l of cfg.locations) {
    const has = l.station.has;
    const elems = ['降水:prcp', '気温:temp', '日照:sun', '風:wind', '湿度:humidity']
      .map((e) => { const [jp, k] = e.split(':'); return has[k] ? jp : `(${jp})`; })
      .join(' ');
    console.log(
      `${pad(l.label, 18)}${pad(l.station.name, 18)}${pad(`${l.station.distanceKm}km`, 9)}${pad(`${l.station.alt}m`, 8)}${pad(elems, 21)}${l.jma.class10Name} (${l.jma.class10})`,
    );
  }
  console.log('');
  console.log('括弧付きの要素は観測していない。その変数は検証対象から外れる。');
  console.log('距離が不自然に遠い地点がないか確認すること。');
}

/** 全角を2幅として数える簡易パディング */
function pad(s, width) {
  const w = [...String(s)].reduce((n, ch) => n + (/[\x00-\x7F]/.test(ch) ? 1 : 2), 0);
  return String(s) + ' '.repeat(Math.max(1, width - w));
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

export { TARGETS, main };
