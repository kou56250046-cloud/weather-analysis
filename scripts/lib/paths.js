// プロジェクト内のパスを一箇所で決める。相対パスを各スクリプトに散らかさない。
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const DATA_DIR = join(ROOT, 'data');
export const CONFIG_DIR = join(ROOT, 'config');
export const PUBLIC_DIR = join(ROOT, 'public');
export const OUT_DIR = join(PUBLIC_DIR, 'data');

export const LOCATIONS_PATH = join(CONFIG_DIR, 'locations.json');

export const fcstDir = (loc) => join(DATA_DIR, 'fcst', loc);
export const jmaFcstDir = (loc) => join(DATA_DIR, 'jma-fcst', loc);
export const obsDir = (loc) => join(DATA_DIR, 'obs', loc);
export const archiveDir = (loc) => join(DATA_DIR, 'archive', loc);

/** 時間別予報の最新の1枚。履歴は残さないので上書きしていく */
export const hourlyPath = (loc) => join(DATA_DIR, 'hourly', `${loc}.json`);

export const fcstPath = (loc, monthKey) => join(fcstDir(loc), `${monthKey}.ndjson`);
export const jmaFcstPath = (loc, monthKey) => join(jmaFcstDir(loc), `${monthKey}.ndjson`);
export const obsPath = (loc, year) => join(obsDir(loc), `${year}.ndjson`);
export const archivePath = (loc) => join(archiveDir(loc), 'era5-daily.ndjson');

export const outPath = (name) => join(OUT_DIR, name);
