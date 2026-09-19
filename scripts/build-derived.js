// 生データから、画面が読む派生データを作り直す。
//
// 増分更新にせず、毎回まるごと計算し直す。データ量が小さいので数秒で終わるし、
// 計算の仕方を直したとき過去に遡って効く。増分にすると、直した日より前の値が
// 古いロジックのまま残り、グラフに段差ができる。
//
// 使い方: node scripts/build-derived.js [--loc setagaya]
import { readNdjsonDir, readJson, writeJson } from './lib/store.js';
import {
  LOCATIONS_PATH, fcstDir, fcstSuppDir, jmaFcstDir, obsDir, archiveDir, outPath, hourlyPath,
} from './lib/paths.js';
import { normalsPath } from './collect-normals.js';
import { MODELS } from './lib/openmeteo.js';
import { toJstDate, addDays, nowJstIso, monthKey, normalKey } from './lib/time.js';
import {
  continuousScores, categoricalScores, probabilityScores, reliabilityBins,
  coverage, usableObs, pairUp, RAIN_THRESHOLD_MM,
} from './lib/verify.js';
import {
  groupForecasts, buildSamples, fitContinuousMos, fitRainProbability, fitInterval,
} from './lib/calibrate.js';
import { blendOne, blendRainProbability, blendInterval, log1p } from './lib/blend.js';
import { yearlyStats, era5Offset, normalFor } from './lib/normals.js';
import { readCollectLog } from './lib/log.js';
import { runJob } from './lib/log.js';
import { runIfMain } from './lib/main.js';

/** MOS を学習する連続値の変数 */
const MOS_VARS = ['tmax', 'tmin', 'rh', 'wind'];

/** 予測区間を出す変数。全部に出すと計算が重いわりに読まれない */
const INTERVAL_VARS = ['tmax', 'tmin'];

/** 検証するリードタイム */
const LEADS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

/** 画面に出す予報の日数 */
const FORECAST_DAYS = 16;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

// ------------------------------------------------------------------ 検証

/**
 * モデル別・リードタイム別の成績を出す。
 * 自作の合議も、単独モデルも、気象庁予報も、同じ関数で採点する。
 */
function scoreAll(grouped, jmaRows, obsByDate, mosByVarLead) {
  const rows = [];

  for (const lead of LEADS) {
    const keys = [...grouped.keys()].filter((k) => Number(k.split('|')[0]) === lead);
    if (keys.length === 0) continue;

    // 単独モデル
    for (const model of MODELS) {
      const fcsts = keys.map((k) => {
        const r = grouped.get(k).get(model);
        return r ? { ...r, target: k.split('|')[1] } : null;
      }).filter(Boolean);
      if (fcsts.length === 0) continue;
      rows.push(...scoreOne(`model:${model}`, model, lead, fcsts, obsByDate));
    }

    // 補正なしの単純平均。MOS がこれに勝てなければ意味がない
    const meanFcsts = keys.map((k) => {
      const slot = grouped.get(k);
      const target = k.split('|')[1];
      const out = { target };
      for (const v of [...MOS_VARS, 'prcp']) {
        const vals = MODELS.map((m) => slot.get(m)?.[v]).filter((x) => x !== null && x !== undefined && Number.isFinite(x));
        out[v] = vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null;
      }
      return out;
    });
    rows.push(...scoreOne('baseline:mean', null, lead, meanFcsts, obsByDate));

    // MOS による合議。前向き検証の予測をそのまま採点する
    const mosFcsts = buildMosForecastRows(mosByVarLead, lead);
    if (mosFcsts.length > 0) {
      rows.push(...scoreOne('blend:mos', null, lead, mosFcsts, obsByDate));
    }
  }

  // 気象庁予報
  const jmaByLead = new Map();
  for (const r of jmaRows) {
    if (r.block !== 'weekly') continue;
    if (!jmaByLead.has(r.lead)) jmaByLead.set(r.lead, []);
    jmaByLead.get(r.lead).push(r);
  }
  for (const [lead, list] of jmaByLead) {
    rows.push(...scoreOne('jma:official', 'jma_official', lead, list, obsByDate, {
      tempComparable: list[0]?.tempMatch !== false,
    }));
  }

  return rows;
}

/** 前向き検証で出した MOS の予測を、採点用の行に組み直す */
function buildMosForecastRows(mosByVarLead, lead) {
  const byDate = new Map();
  for (const v of [...MOS_VARS, 'prcp']) {
    const fit = mosByVarLead.get(`${v}|${lead}`);
    if (!fit) continue;
    fit.dates.forEach((date, i) => {
      const p = fit.predictions[i];
      if (p === null) return;
      if (!byDate.has(date)) byDate.set(date, { target: date });
      byDate.get(date)[v] = p;
    });
  }

  // 較正後の降水確率。ロジスティックの前向き検証予測を pop として採点へ回す。
  // ここを通さないと blend:mos の pop 行が生成されず、成績タブの信頼度図は
  // 較正前のアンサンブル比率（単独モデルの行）へ落ちる。
  // 画面に「較正済み」と書いてある確率と、採点している確率が別物になってしまう。
  const rainFit = mosByVarLead.get(`rain|${lead}`);
  if (rainFit) {
    rainFit.dates.forEach((date, i) => {
      const p = rainFit.predictions[i];
      if (p === null) return;
      if (!byDate.has(date)) byDate.set(date, { target: date });
      byDate.get(date).pop = p;
    });
  }

  return [...byDate.values()];
}

function scoreOne(source, model, lead, forecasts, obsByDate, extra = {}) {
  const out = [];
  for (const v of [...MOS_VARS]) {
    const pairs = pairUp(forecasts, obsByDate, v).map(([f, o]) => [f, o]);
    const s = continuousScores(pairs);
    if (s) out.push({ source, model, lead, variable: v, ...s, ...extra });
  }

  // 降水は量と有無を分けて見る
  const prcpPairs = pairUp(forecasts, obsByDate, 'prcp').map(([f, o]) => [f, o]);
  const cat = categoricalScores(prcpPairs);
  if (cat) out.push({ source, model, lead, variable: 'rain', ...cat, ...extra });

  // 確率予報がある場合のみ
  const popPairs = [];
  for (const f of forecasts) {
    if (f.pop === null || f.pop === undefined) continue;
    const o = obsByDate.get(f.target);
    const ov = usableObs(o, 'prcp');
    if (ov === null) continue;
    popPairs.push([f.pop, ov]);
  }
  if (popPairs.length > 0) {
    const prob = probabilityScores(popPairs);
    if (prob) {
      out.push({
        source, model, lead, variable: 'pop', ...prob,
        reliability: reliabilityBins(popPairs), ...extra,
      });
    }
  }
  return out;
}

/**
 * WMO の天気コードを荒天の度合いで並べた順。小さいほど穏やか。
 * ここに無いコードは「曇り」の位置に置く。
 */
const CODE_SEVERITY = [
  0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57,
  61, 80, 63, 81, 65, 82, 66, 67, 71, 85, 73, 75, 86, 77, 95, 96, 99,
];

/**
 * 複数モデルの天気コードから1つを決める。
 *
 * 単純な多数決だと、7モデルがすべて違うコードを出したときに先頭が勝ってしまう。
 * 荒天の度合いで並べて中央の値を採る。1つのモデルだけが極端でも引きずられない。
 */
export function consensusCode(codes) {
  if (!codes || codes.length === 0) return null;
  const rankOf = (c) => {
    const i = CODE_SEVERITY.indexOf(Number(c));
    return i >= 0 ? i : CODE_SEVERITY.indexOf(3);
  };
  const sorted = [...codes].sort((a, b) => rankOf(a) - rankOf(b));
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

// ------------------------------------------------------------------ 湿度と風の補完

/**
 * 予報行の rh / wind が null で、同じ (model, fetched, target) の補完行があれば、その値で埋める。
 * 補完行は、気温と降水だけで遡って取った過去予報に、後から湿度と風を足したもの（data/fcst-supp）。
 * 既存の予報行は追記専用なので書き換えず、読むときに合流する。
 *
 * - 埋めるのは null の項目だけ。数値が入っている行（毎日の収集）には触らない
 * - 気温・降水には一切触らない。気温と降水の成績は補完の有無で変わらない
 * - 対応する予報行が無い補完行は捨てる（気温が足りず予報行が作られなかった日など）
 * 元の行は変えず、埋めた行だけ新しいオブジェクトにする。
 */
export function mergeSupplement(fcstRows, suppRows, stats = {}) {
  stats.supp = suppRows?.length ?? 0;
  stats.filled = 0;
  if (!suppRows?.length) return fcstRows;
  const supp = new Map();
  for (const s of suppRows) supp.set(`${s.model}|${s.fetched}|${s.target}`, s);

  return fcstRows.map((r) => {
    if (r.rh !== null && r.rh !== undefined && r.wind !== null && r.wind !== undefined) return r;
    const s = supp.get(`${r.model}|${r.fetched}|${r.target}`);
    if (!s) return r;
    const rh = r.rh ?? s.rh ?? null;
    const wind = r.wind ?? s.wind ?? null;
    if (rh === (r.rh ?? null) && wind === (r.wind ?? null)) return r;
    stats.filled++;
    return { ...r, rh, wind };
  });
}

// ------------------------------------------------------------------ 地点ごとの処理

async function buildLocation(loc, meta) {
  const [rawFcstRows, suppRows, jmaRows, obsRows, archiveRows, normals] = await Promise.all([
    readNdjsonDir(fcstDir(loc.key)),
    readNdjsonDir(fcstSuppDir(loc.key)),
    readNdjsonDir(jmaFcstDir(loc.key)),
    readNdjsonDir(obsDir(loc.key)),
    readNdjsonDir(archiveDir(loc.key)),
    readJson(normalsPath(loc.key)),
  ]);
  const hourly = await readJson(hourlyPath(loc.key));
  const supp = {};
  const fcstRows = mergeSupplement(rawFcstRows, suppRows, supp);
  // 予報行の fetched の作り方が変わると、補完が1行も対応せず黙って効かなくなる。気づけるように出す
  if (supp.supp > 0 && supp.filled < supp.supp * 0.5) {
    console.warn(`${loc.key}: 湿度・風の補完 ${supp.supp} 行のうち ${supp.filled} 行しか予報に対応しなかった。`
      + '予報行の fetched の組み立てが変わっていないか確かめること');
  }

  // NDJSON は追記順に並ぶ。バックフィルを後から走らせると、
  // 8月・9月の次に1月〜7月が続くような並びになる。
  // 「直近N日」や「最後の観測日」が壊れるので、日付順に直してから使う。
  obsRows.sort((a, b) => a.date.localeCompare(b.date));
  archiveRows.sort((a, b) => a.date.localeCompare(b.date));

  const obsByDate = new Map(obsRows.map((r) => [r.date, r]));
  const grouped = groupForecasts(fcstRows);

  // --- MOS の学習（前向き検証つき）
  const mosByVarLead = new Map();
  const intervalByVarLead = new Map();
  const leak = [];

  for (const lead of LEADS) {
    for (const v of MOS_VARS) {
      const samples = buildSamples(grouped, obsByDate, { variable: v, lead, models: MODELS });
      const fit = fitContinuousMos(samples);
      if (!fit) continue;
      mosByVarLead.set(`${v}|${lead}`, fit);
      leak.push({
        loc: loc.key, variable: v, lead,
        n: fit.n, lambda: fit.lambda,
        evaluatedFrom: fit.walkForward.evaluatedFrom,
        lastTrainTo: fit.walkForward.lastTrainTo,
        retrains: fit.walkForward.retrains,
        mae: fit.walkForward.mae,
      });
      if (INTERVAL_VARS.includes(v)) {
        const iv = fitInterval(samples);
        if (iv) intervalByVarLead.set(`${v}|${lead}`, iv);
      }
    }
    // 降水は量を log1p して回帰し、有無は別にロジスティックで学習する
    const prcpSamples = buildSamples(grouped, obsByDate, {
      variable: 'prcp', lead, models: MODELS, transform: log1p,
    });
    const prcpFit = fitContinuousMos(prcpSamples);
    if (prcpFit) {
      // 予測は log 空間なので戻す
      prcpFit.predictions = prcpFit.predictions.map((p) => (p === null ? null : Math.max(0, Math.expm1(p))));
      prcpFit.observed = prcpFit.observed.map((y) => Math.max(0, Math.expm1(y)));
      mosByVarLead.set(`prcp|${lead}`, prcpFit);
    }
    const rainFit = fitRainProbability(prcpSamples);
    if (rainFit) {
      mosByVarLead.set(`rain|${lead}`, rainFit);
      // 確率も前向き検証であることを示せるよう、気温と同じ形で記録する。
      // ロジスティックは MAE を持たないので、そこだけ null になる
      leak.push({
        loc: loc.key, variable: 'rain', lead,
        n: rainFit.n, lambda: rainFit.lambda,
        evaluatedFrom: rainFit.walkForward.evaluatedFrom,
        lastTrainTo: rainFit.walkForward.lastTrainTo,
        retrains: rainFit.walkForward.retrains,
        mae: null,
      });
    }
  }

  // --- 成績
  const scores = scoreAll(grouped, jmaRows, obsByDate, mosByVarLead);

  // lead ごとの実績 MAE。予報タブの信頼度表示に使う
  const leadMae = {};
  for (const s of scores) {
    if (s.source !== 'blend:mos' && s.source !== 'baseline:mean') continue;
    const key = `${s.variable}|${s.lead}`;
    if (s.source === 'blend:mos' || leadMae[key] === undefined) leadMae[key] = s.mae ?? null;
  }

  // --- これからの予報
  const today = toJstDate(new Date());
  const forecast = [];
  for (let d = 0; d < FORECAST_DAYS; d++) {
    const target = addDays(today, d);
    // 同じ target で最も小さい lead（＝最も新しい予報）を使う
    let slot = null;
    let usedLead = null;
    for (const lead of LEADS) {
      const s = grouped.get(`${lead}|${target}`);
      if (s && s.size > 0) { slot = s; usedLead = lead; break; }
    }
    if (!slot) continue;

    const day = { date: target, lead: usedLead, dow: new Date(`${target}T00:00:00+09:00`).getDay() };
    for (const v of MOS_VARS) {
      day[v] = blendOne(slot, MODELS, target, { variable: v, coef: mosByVarLead.get(`${v}|${usedLead}`) });
      day[`${v}Mae`] = leadMae[`${v}|${usedLead}`] ?? null;
    }
    day.prcp = blendOne(slot, MODELS, target, {
      variable: 'prcp', coef: mosByVarLead.get(`prcp|${usedLead}`),
      transform: log1p, inverse: (x) => Math.max(0, Math.expm1(x)),
    });

    const ensSlot = [...slot.values()].find((r) => r.pop !== null && r.pop !== undefined);
    day.pop = blendRainProbability(slot, MODELS, target, {
      coef: mosByVarLead.get(`rain|${usedLead}`),
      fallbackPop: ensSlot?.pop ?? null,
    });

    // 天気マーク。モデルごとに違うコードを出すので、荒天の度合いで並べて中央を取る
    const codes = MODELS.map((m) => slot.get(m)?.code)
      .filter((v) => v !== null && v !== undefined && Number.isFinite(v));
    day.code = consensusCode(codes);
    day.codeModels = codes.length;

    for (const v of INTERVAL_VARS) {
      const q = [...slot.values()].find((r) => r.q?.[v])?.q?.[v] ?? null;
      day[`${v}Interval`] = blendInterval(slot, MODELS, target, {
        variable: v,
        intervalCoef: intervalByVarLead.get(`${v}|${usedLead}`),
        ensembleQ: q,
        leadMae: leadMae[`${v}|${usedLead}`] ?? null,
        center: day[v]?.value ?? null,
      });
    }

    // 平年値との差
    day.normal = normals ? {
      tmax: normalFor(normals, target, 'tmax'),
      tmin: normalFor(normals, target, 'tmin'),
    } : null;

    // 気象庁予報を重ねる
    const jmaCandidates = jmaRows.filter((r) => r.target === target);
    const jmaWeekly = jmaCandidates.filter((r) => r.block === 'weekly').sort((a, b) => b.report.localeCompare(a.report))[0];
    const jmaShort = jmaCandidates.filter((r) => r.block === 'short').sort((a, b) => b.report.localeCompare(a.report))[0];
    day.jma = jmaWeekly || jmaShort ? {
      tmax: jmaWeekly?.tmax ?? null,
      tmin: jmaWeekly?.tmin ?? null,
      pop: jmaShort?.pop ?? jmaWeekly?.pop ?? null,
      code: jmaShort?.code ?? jmaWeekly?.code ?? null,
      reliability: jmaWeekly?.reliability ?? null,
      tempComparable: jmaWeekly?.tempMatch ?? null,
      tempAreaName: jmaWeekly?.tempAreaName ?? null,
      report: jmaWeekly?.report ?? jmaShort?.report ?? null,
    } : null;

    forecast.push(day);
  }

  // --- 予測区間の被覆率
  const coverageByLead = {};
  for (const v of INTERVAL_VARS) {
    for (const lead of LEADS) {
      const iv = intervalByVarLead.get(`${v}|${lead}`);
      if (!iv) continue;
      const triples = iv.dates.map((date, i) => [
        iv[0.1].predictions[i], iv[0.9].predictions[i], iv.observed[i],
      ]).filter(([lo, hi]) => lo !== null && hi !== null)
        .map(([lo, hi, o]) => [Math.min(lo, hi), Math.max(lo, hi), o]);
      const c = coverage(triples);
      if (c) coverageByLead[`${v}|${lead}`] = c;
    }
  }

  // --- 平年比
  const thisYear = today.slice(0, 4);
  const recentObs = obsRows.filter((r) => r.date >= `${Number(thisYear) - 1}-01-01`);
  const vsNormal = recentObs.map((r) => ({
    date: r.date,
    tmax: usableObs(r, 'tmax'),
    tmin: usableObs(r, 'tmin'),
    prcp: usableObs(r, 'prcp'),
    nTmax: normals ? normalFor(normals, r.date, 'tmax') : null,
    nTmin: normals ? normalFor(normals, r.date, 'tmin') : null,
    nPrcp: normals ? normalFor(normals, r.date, 'prcp') : null,
  }));

  // --- 長期
  const obsYearly = yearlyStats(obsRows, { source: 'obs' });
  const era5Yearly = yearlyStats(archiveRows, { source: 'era5' });
  const offset = era5Offset(archiveRows, obsRows, 'tmax');

  return {
    fcstRows, jmaRows, obsRows, archiveRows, normals, hourly, supp,
    scores, leak, forecast, coverageByLead, vsNormal,
    obsYearly, era5Yearly, offset,
    mosByVarLead, leadMae,
  };
}

// ------------------------------------------------------------------ 出力

/** 長期データは列指向にして軽くする。日付は連番から復元する */
function columnar(rows) {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const out = { start: sorted[0].date, n: sorted.length, date: [], tmax: [], tmin: [], prcp: [] };
  for (const r of sorted) {
    out.date.push(r.date);
    out.tmax.push(r.tmax ?? null);
    out.tmin.push(r.tmin ?? null);
    out.prcp.push(r.prcp ?? null);
  }
  return out;
}

async function main() {
  const only = arg('--loc');
  const cfg = await readJson(LOCATIONS_PATH);
  if (!cfg) throw new Error('config/locations.json が無い');

  await runJob('derive', async (errors) => {
    const log = await readCollectLog();
    const lastOk = {};
    for (const e of log) if (e.ok) lastOk[e.job] = e.ts;

    const summaries = [];
    const allLeak = [];

    for (const loc of cfg.locations) {
      if (only && loc.key !== only) continue;
      const t0 = Date.now();
      try {
        const r = await buildLocation(loc, cfg);
        allLeak.push(...r.leak);

        await writeJson(outPath(`forecast-${loc.key}.json`), {
          v: 1, loc: loc.key, label: loc.label,
          generatedAt: nowJstIso(),
          days: r.forecast,
        });
        await writeJson(outPath(`scores-${loc.key}.json`), {
          v: 1, loc: loc.key, label: loc.label,
          generatedAt: nowJstIso(),
          rows: r.scores,
          coverage: r.coverageByLead,
          station: loc.station,
        });
        await writeJson(outPath(`coef-${loc.key}.json`), {
          v: 1, loc: loc.key,
          models: MODELS,
          featureNames: ['切片', ...MODELS, 'sin(季節)', 'cos(季節)'],
          coefficients: [...r.mosByVarLead.entries()].map(([key, fit]) => {
            const [variable, lead] = key.split('|');
            return {
              variable, lead: Number(lead), kind: fit.kind,
              lambda: fit.lambda ?? null, n: fit.n,
              beta: fit.beta ? fit.beta.map((b) => Math.round(b * 10000) / 10000) : null,
              mae: fit.walkForward?.mae ?? null,
            };
          }),
        });
        // 時間別は今日と明日の2日分。補正は当てていないので、そのことも渡す
        await writeJson(outPath(`hourly-${loc.key}.json`), {
          v: 1, loc: loc.key, label: loc.label,
          generatedAt: nowJstIso(),
          fetched: r.hourly?.fetched ?? null,
          corrected: false,
          models: MODELS,
          rows: r.hourly?.rows ?? [],
        });
        await writeJson(outPath(`normals-${loc.key}.json`), {
          v: 1, loc: loc.key,
          normals: r.normals,
          vsNormal: r.vsNormal,
        });
        await writeJson(outPath(`history-${loc.key}.json`), {
          v: 1, loc: loc.key,
          obsYearly: r.obsYearly,
          era5Yearly: r.era5Yearly,
          era5Offset: r.offset,
          obs: columnar(r.obsRows),
          era5: columnar(r.archiveRows),
        });

        const mosMae = r.scores.filter((s) => s.source === 'blend:mos' && s.variable === 'tmax');
        summaries.push({
          loc: loc.key,
          label: loc.label,
          station: loc.station.name,
          obsDays: r.obsRows.length,
          fcstRows: r.fcstRows.length,
          era5Days: r.archiveRows.length,
          mosLeads: mosMae.length,
          ms: Date.now() - t0,
        });
        console.log(
          `${loc.key.padEnd(12)} 実測 ${String(r.obsRows.length).padStart(5)} 日 / `
          + `予報 ${String(r.fcstRows.length).padStart(6)} 行 / ERA5 ${String(r.archiveRows.length).padStart(6)} 日 / `
          + `補完 ${r.supp.filled}/${r.supp.supp} 行 / MOS ${mosMae.length} lead / ${Date.now() - t0}ms`,
        );
      } catch (err) {
        errors.push(`${loc.key}: ${err.message}`);
        console.error(`${loc.key}: ${err.stack}`);
      }
    }

    await writeJson(outPath('meta.json'), {
      v: 1,
      generatedAt: nowJstIso(),
      locations: cfg.locations.map((l) => ({
        key: l.key, label: l.label, lat: l.lat, lon: l.lon,
        station: {
          name: l.station.name, distanceKm: l.station.distanceKm,
          alt: l.station.alt, has: l.station.has,
          // 画面から直接アメダスの実況を取るのに使う
          amedasCode: l.station.amedasCode ?? null,
        },
        jma: l.jma,
      })),
      models: MODELS,
      lastCollect: lastOk,
      recentLog: log.slice(-30),
      summaries,
      attribution: {
        openMeteo: 'Weather data by Open-Meteo.com (CC BY 4.0)',
        jma: '観測値・平年値・府県天気予報: 気象庁',
      },
    });
    await writeJson(outPath('leakcheck.json'), { v: 1, generatedAt: nowJstIso(), rows: allLeak });

    return { added: summaries.length };
  });
}

runIfMain(import.meta.url, main);

export { buildLocation, scoreAll, columnar };
