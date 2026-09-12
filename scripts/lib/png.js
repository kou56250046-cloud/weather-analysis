// 最小限の PNG 書き出しと、単純な図形のラスタライザ。
//
// アイコンを作るためだけに画像ライブラリを入れたくないので自前で持つ。
// 使うのは node:zlib の deflate だけ。
//
// 対応するのは RGBA 8bit・非インターレース・フィルタ 0 のみ。
// 写真を扱うわけではないので圧縮率は気にしない。
import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------- PNG 書き出し

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * RGBA のバイト列を PNG にする。
 * @param {Uint8ClampedArray} rgba 長さ width*height*4
 */
export function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // ビット深度
  ihdr[9] = 6;  // カラータイプ: RGBA
  ihdr[10] = 0; // 圧縮方式
  ihdr[11] = 0; // フィルタ方式
  ihdr[12] = 0; // 非インターレース

  // 各行の先頭にフィルタ種別のバイトを置く。0 = フィルタなし
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------ ラスタライザ

/**
 * 図形を重ねて描く小さなキャンバス。
 * 輪郭を滑らかにするため、1画素を SS×SS に分割して被覆率を数える。
 */
export class Canvas {
  constructor(width, height, { samples = 4 } = {}) {
    this.width = width;
    this.height = height;
    this.ss = samples;
    // 事前乗算しない素の RGBA を持つ
    this.data = new Float64Array(width * height * 4);
  }

  /**
   * 形を塗る。
   * @param {(x:number, y:number) => boolean} inside 画素座標が図形の内側か
   * @param {[number,number,number]} rgb 0-255
   * @param {number} alpha 0-1
   */
  fill(inside, rgb, alpha = 1) {
    const { width, height, ss, data } = this;
    const step = 1 / ss;
    const offset = step / 2;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let hits = 0;
        for (let sy = 0; sy < ss; sy++) {
          for (let sx = 0; sx < ss; sx++) {
            if (inside(x + offset + sx * step, y + offset + sy * step)) hits++;
          }
        }
        if (hits === 0) continue;
        const a = alpha * (hits / (ss * ss));
        const i = (y * width + x) * 4;
        // 通常のアルファ合成
        const dstA = data[i + 3];
        const outA = a + dstA * (1 - a);
        if (outA <= 0) continue;
        for (let c = 0; c < 3; c++) {
          data[i + c] = (rgb[c] * a + data[i + c] * dstA * (1 - a)) / outA;
        }
        data[i + 3] = outA;
      }
    }
  }

  /**
   * 形を縦方向のグラデーションで塗る。
   * 2色を境目で切り替えると帯が線として見えてしまうので、連続的に混ぜる。
   */
  fillVerticalGradient(inside, rgbTop, rgbBottom, { from = 0, to = 1 } = {}) {
    const { height } = this;
    const y0 = from * height;
    const y1 = to * height;
    for (let y = 0; y < height; y++) {
      const t = Math.max(0, Math.min(1, (y + 0.5 - y0) / Math.max(1e-6, y1 - y0)));
      const rgb = [
        rgbTop[0] + (rgbBottom[0] - rgbTop[0]) * t,
        rgbTop[1] + (rgbBottom[1] - rgbTop[1]) * t,
        rgbTop[2] + (rgbBottom[2] - rgbTop[2]) * t,
      ];
      // 1行だけを対象にした塗り
      this.fill((x, yy) => yy >= y && yy < y + 1 && inside(x, yy), rgb, 1);
    }
  }

  /** 全面を塗る。背景に使う */
  clear(rgb, alpha = 1) {
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = rgb[0];
      this.data[i + 1] = rgb[1];
      this.data[i + 2] = rgb[2];
      this.data[i + 3] = alpha;
    }
  }

  toRgba() {
    const out = new Uint8ClampedArray(this.width * this.height * 4);
    for (let i = 0; i < out.length; i += 4) {
      out[i] = Math.round(this.data[i]);
      out[i + 1] = Math.round(this.data[i + 1]);
      out[i + 2] = Math.round(this.data[i + 2]);
      // 内部では不透明度を 0〜1 で持っている。PNG は 0〜255
      out[i + 3] = Math.round(this.data[i + 3] * 255);
    }
    return out;
  }

  toPng() {
    return encodePng(this.toRgba(), this.width, this.height);
  }
}

// ------------------------------------------------------------------ 図形

export const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

export const roundedRect = (x0, y0, w, h, r) => (x, y) => {
  if (x < x0 || y < y0 || x > x0 + w || y > y0 + h) return false;
  const dx = Math.max(x0 + r - x, 0, x - (x0 + w - r));
  const dy = Math.max(y0 + r - y, 0, y - (y0 + h - r));
  return dx * dx + dy * dy <= r * r;
};

/** 図形の和 */
export const union = (...shapes) => (x, y) => shapes.some((s) => s(x, y));

/** 左の図形から右の図形を抜く */
export const subtract = (a, b) => (x, y) => a(x, y) && !b(x, y);

/**
 * 太陽の光条。線分からの距離で表すので端が丸くなる。
 * 角を立てると 48px では潰れてただの四角に見える。
 */
export const ray = (cx, cy, angleDeg, inner, outer, halfWidth) => {
  const rad = (angleDeg * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  const ax = cx + ux * inner;
  const ay = cy + uy * inner;
  const bx = cx + ux * outer;
  const by = cy + uy * outer;
  return (x, y) => {
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len2));
    const px = ax + vx * t;
    const py = ay + vy * t;
    return (x - px) ** 2 + (y - py) ** 2 <= halfWidth * halfWidth;
  };
};
