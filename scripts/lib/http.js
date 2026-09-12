// 外部 API を礼儀正しく叩くための fetch ラッパ。
// ホストごとに最低間隔を空け、タイムアウトと指数バックオフを持つ。
// 相手は無料で公開してくれているサービスなので、並列で殴らない。

const DEFAULT_GAP_MS = 300;

/** ホスト別の最低間隔（ミリ秒）。無料枠に配慮して控えめに */
const HOST_GAP_MS = {
  'api.open-meteo.com': 250,
  'ensemble-api.open-meteo.com': 400,
  'previous-runs-api.open-meteo.com': 400,
  'archive-api.open-meteo.com': 3000, // 長期間を一度に取ると 429 を返しやすい
  'www.jma.go.jp': 500,
};

const UA = 'weather-analysis/0.1 (personal forecast-verification dashboard; non-commercial)';

const lastRequestAt = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForSlot(host) {
  const gap = HOST_GAP_MS[host] ?? DEFAULT_GAP_MS;
  const prev = lastRequestAt.get(host) ?? 0;
  const wait = prev + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt.set(host, Date.now());
}

export class HttpError extends Error {
  constructor(message, { status = 0, url = '', body = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/**
 * JSON を取得する。
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=20000]
 * @param {number} [opts.retries=3]   429/5xx/ネットワーク断のときだけ再試行する
 * @param {string} [opts.etag]        条件付き GET。304 なら null を返す
 * @returns {Promise<{data: any, etag: string|null, notModified: boolean}>}
 */
export async function getJson(url, opts = {}) {
  const { timeoutMs = 20_000, retries = 3, etag = null } = opts;
  const host = new URL(url).host;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // 1.5s, 4.5s, 13.5s。相手が詰まっているときに畳みかけない
      await sleep(1500 * 3 ** (attempt - 1));
    }
    await waitForSlot(host);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const headers = { accept: 'application/json', 'user-agent': UA };
      if (etag) headers['if-none-match'] = etag;
      const res = await fetch(url, { signal: ac.signal, headers });

      if (res.status === 304) {
        return { data: null, etag, notModified: true };
      }
      if (res.status === 429 || res.status >= 500) {
        const body = await safeText(res);
        lastErr = new HttpError(`HTTP ${res.status}`, { status: res.status, url, body });
        continue; // 再試行する
      }
      if (!res.ok) {
        // 404 などは再試行しても無駄なので即座に投げる
        throw new HttpError(`HTTP ${res.status}`, {
          status: res.status, url, body: await safeText(res),
        });
      }
      return {
        data: await res.json(),
        etag: res.headers.get('etag'),
        notModified: false,
      };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // AbortError とネットワーク断はここ
      lastErr = new HttpError(`${err.name}: ${err.message}`, { url });
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new HttpError('unknown failure', { url });
}

/** テキストを取得する（latest_time.txt 用） */
export async function getText(url, opts = {}) {
  const { timeoutMs = 20_000 } = opts;
  const host = new URL(url).host;
  await waitForSlot(host);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'user-agent': UA } });
    if (!res.ok) throw new HttpError(`HTTP ${res.status}`, { status: res.status, url });
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** クエリ文字列を組み立てる。配列はカンマ区切り、null/undefined は落とす */
export function buildUrl(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    u.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return u.toString();
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}
