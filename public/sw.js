// サービスワーカー。オフラインでも最後に見たデータを表示できるようにする。
//
// 方針は2つに分ける。
//
//   画面の部品（HTML / CSS / JS / アイコン）
//     キャッシュを先に返し、裏で取り直す。表示が速く、次回から新しくなる。
//
//   データ（data/*.json）
//     ネットワークを先に試し、失敗したらキャッシュ。
//     予報は毎日更新されるので、繋がっているときに古い値を見せない。
//
// キャッシュ名に版を付けてある。中身の持ち方を変えたら CACHE_VERSION を上げる。
// 上げると古いキャッシュは activate 時に消える。

// v2: 実況モジュール（live.js）と時間別データを足したので入れ直す
const CACHE_VERSION = 'v2';
const SHELL_CACHE = `shell-${CACHE_VERSION}`;
const DATA_CACHE = `data-${CACHE_VERSION}`;

/** 最初に入れておく部品。これだけあれば画面は立ち上がる */
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/style.css',
  './assets/app.js',
  './assets/dom.js',
  './assets/tip.js',
  './assets/chart-svg.js',
  './assets/chart-canvas.js',
  './assets/weather-icon.js',
  './assets/live.js',
  './assets/tab-forecast.js',
  './assets/tab-scores.js',
  './assets/tab-normals.js',
  './assets/tab-analysis.js',
  './icons/icon-192.png',
  './icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 1つでも失敗すると addAll 全体が落ちるので、個別に入れる
    await Promise.all(SHELL_ASSETS.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        console.warn('[sw] 取得できなかった', url, err.message);
      }
    }));
    // 古い版を待たずに入れ替える。画面は起動時にデータを読み直すので問題ない
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, DATA_CACHE]);
    for (const key of await caches.keys()) {
      if (!keep.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // 別オリジンには手を出さない。
  // 「現在の天気の詳細」は気象庁と Open-Meteo を直接叩く。
  // 押した瞬間の値が欲しいので、ここで挟んでキャッシュしてはいけない
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes('/data/')) {
    event.respondWith(networkFirst(request));
  } else {
    event.respondWith(staleWhileRevalidate(request));
  }
});

/**
 * データ用。繋がっていれば必ず新しいものを返す。
 * 落ちていたら最後に取れたものを返し、それも無ければ 503 を返す。
 */
async function networkFirst(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ error: 'オフラインで、このデータはまだ保存されていない' }),
      { status: 503, headers: { 'content-type': 'application/json; charset=utf-8' } },
    );
  }
}

/**
 * 部品用。キャッシュを即返しつつ、裏で取り直して次回に備える。
 * ナビゲーションで取れなかったときは index.html を返す。
 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);

  const fetching = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (cached) return cached;

  const fresh = await fetching;
  if (fresh) return fresh;

  if (request.mode === 'navigate') {
    const fallback = await cache.match('./index.html');
    if (fallback) return fallback;
  }
  return new Response('オフライン', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
