// PWA のアイコンを作る。画像ライブラリを入れず、node:zlib だけで PNG を書く。
//
// 図柄は「雲の後ろの太陽」。48px でも何のアプリか分かる形を優先する。
// 細い線や文字は入れない。ホーム画面では実寸 48〜60px で表示される。
//
// 出力:
//   icon-192.png            Android のホーム画面
//   icon-512.png            スプラッシュ画面と一覧
//   icon-maskable-512.png   端末側で好きな形に切り抜かれる版。安全域を広く取る
//   apple-touch-icon.png    iOS のホーム画面（180px、角丸は OS が付ける）
//   favicon.png             タブ用の 48px
//   icon.svg                ベクタ版。タブのアイコンに使う
//
// 使い方: node scripts/make-icons.js
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Canvas, circle, roundedRect, union, ray } from './lib/png.js';
import { PUBLIC_DIR } from './lib/paths.js';
import { runIfMain } from './lib/main.js';

const ICON_DIR = join(PUBLIC_DIR, 'icons');

/** 配色。画面の系列色と揃える */
const BRAND = [42, 120, 214];      // --series-1 の青
const BRAND_DEEP = [28, 92, 171];  // 下側をわずかに沈ませる
const SUN = [250, 178, 25];        // --warning の琥珀
const SUN_EDGE = [255, 205, 84];
const CLOUD = [255, 255, 255];
const CLOUD_SHADE = [222, 233, 246];

/**
 * アイコンを1枚描く。
 * @param {number} size 一辺の画素数
 * @param {object} opts
 * @param {boolean} opts.maskable 端末が切り抜く前提。図柄を小さくして安全域を取る
 * @param {boolean} opts.rounded 角を丸める。maskable では丸めない（全面を塗る）
 */
function drawIcon(size, { maskable = false, rounded = true } = {}) {
  const c = new Canvas(size, size, { samples: size <= 96 ? 6 : 4 });
  const u = size / 100; // 100 を基準にした相対単位

  // --- 背景。上から下へ連続的に沈ませる。
  // 途中で色を切り替えると、その境目が1本の線として見えてしまう
  const bgShape = maskable || !rounded
    ? () => true
    : roundedRect(0, 0, size, size, 22 * u);
  c.fillVerticalGradient(bgShape, BRAND, BRAND_DEEP);

  // --- 図柄の配置。maskable は内側 62% に収める
  const scale = maskable ? 0.62 : 0.82;
  const cx = size / 2;
  const cy = size / 2;
  const P = (px, py) => [cx + (px - 50) * u * scale, cy + (py - 50) * u * scale];
  const L = (len) => len * u * scale;

  // --- 太陽。左上に置き、雲の後ろから覗かせる
  const [sunX, sunY] = P(38, 34);
  const sunR = L(17);

  for (let i = 0; i < 8; i++) {
    c.fill(ray(sunX, sunY, i * 45, sunR + L(7), sunR + L(13), L(3.2)), SUN_EDGE, 0.95);
  }
  c.fill(circle(sunX, sunY, sunR + L(2.5)), SUN_EDGE);
  c.fill(circle(sunX, sunY, sunR), SUN);

  // --- 雲。円3つと底の角丸長方形の和
  const [c1x, c1y] = P(44, 62);
  const [c2x, c2y] = P(60, 55);
  const [c3x, c3y] = P(72, 64);
  const [baseX, baseY] = P(36, 62);
  const cloud = union(
    circle(c1x, c1y, L(14)),
    circle(c2x, c2y, L(17)),
    circle(c3x, c3y, L(13)),
    roundedRect(baseX, baseY, L(42), L(15), L(7.5)),
  );

  // 雲の下側をうっすら沈ませて立体に見せる。
  // ここも色を切り替えると雲を横切る直線になるので、連続的に混ぜる
  const cloudTop = c2y - L(17);
  const cloudBottom = baseY + L(15);
  c.fillVerticalGradient(
    cloud, CLOUD, CLOUD_SHADE,
    { from: (cloudTop + (cloudBottom - cloudTop) * 0.45) / size, to: cloudBottom / size },
  );

  return c;
}

/** タブ用のベクタ版。PNG と同じ図柄を手で書き起こす */
function svgIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="天気予報の精度検証">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a78d6"/>
      <stop offset="1" stop-color="#1c5cab"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="22" fill="url(#bg)"/>
  <g transform="translate(50 50) scale(0.82) translate(-50 -50)">
    <g stroke="#ffcd54" stroke-width="6.8" stroke-linecap="round">
      <line x1="38" y1="10" x2="38" y2="3"/>
      <line x1="38" y1="58" x2="38" y2="65"/>
      <line x1="14" y1="34" x2="7" y2="34"/>
      <line x1="62" y1="34" x2="69" y2="34"/>
      <line x1="21" y1="17" x2="16" y2="12"/>
      <line x1="55" y1="51" x2="60" y2="56"/>
      <line x1="21" y1="51" x2="16" y2="56"/>
      <line x1="55" y1="17" x2="60" y2="12"/>
    </g>
    <circle cx="38" cy="34" r="19.5" fill="#ffcd54"/>
    <circle cx="38" cy="34" r="17" fill="#fab219"/>
    <path fill="#ffffff" d="M36 77h42a7.5 7.5 0 0 0 0-15h-42a7.5 7.5 0 0 0 0 15z"/>
    <circle cx="44" cy="62" r="14" fill="#ffffff"/>
    <circle cx="60" cy="55" r="17" fill="#ffffff"/>
    <circle cx="72" cy="64" r="13" fill="#ffffff"/>
  </g>
</svg>
`;
}

async function main() {
  await mkdir(ICON_DIR, { recursive: true });

  const targets = [
    { name: 'icon-192.png', size: 192, opts: {} },
    { name: 'icon-512.png', size: 512, opts: {} },
    { name: 'icon-maskable-512.png', size: 512, opts: { maskable: true } },
    // iOS は角丸を OS 側で付けるので、こちらは四角のまま出す
    { name: 'apple-touch-icon.png', size: 180, opts: { rounded: false } },
    { name: 'favicon.png', size: 48, opts: {} },
  ];

  for (const t of targets) {
    const png = drawIcon(t.size, t.opts).toPng();
    await writeFile(join(ICON_DIR, t.name), png);
    console.log(`${t.name.padEnd(24)} ${t.size}x${t.size}  ${(png.length / 1024).toFixed(1)}KB`);
  }

  await writeFile(join(ICON_DIR, 'icon.svg'), svgIcon(), 'utf8');
  console.log('icon.svg                 ベクタ版');
}

runIfMain(import.meta.url, main);

export { drawIcon, svgIcon };
