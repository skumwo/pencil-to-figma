// 1:1 check: compare Pencil's render of a frame with Figma's render of the import.
//
// A plain pixel diff is useless here. Pencil and Figma rasterize text with different
// engines, so every line of copy lands 1–4px off at its far end and edges are
// antialiased differently — a naive diff flags every slide. The comparison below
// forgives exactly that: a pixel counts as different only when its colour lies
// outside the range the OTHER render has within ±RADIUS px of the same spot. A
// shifted glyph edge passes; a missing element, a wrong colour, a stroke of the
// wrong weight or a line that wrapped differently does not.
//
// Inside text boxes the horizontal slack is wider (TEXT_RX): the two engines' glyph
// advances differ by up to ~0.5%, which drifts the end of a 1600px line by ~9px.
// That is invisible; a word that wraps to the next line is hundreds of px and is
// still caught.
//
// Calibrated on the AI BAQYLAU brandbook: slides known to match come out at 0
// pixels; the one slide whose heading wrapped differently is caught.

import { PNG } from "pngjs";

const RADIUS = 3;      // px of positional slack
const TEXT_RX = 12;    // horizontal slack inside text boxes
const TOLERANCE = 28;  // per-channel difference that still counts as "same colour"
const BLOCK = 16;      // region grouping grid
const MIN_REGION_PX = 24;

function flatten(png) {
  // RGBA over white → RGB planes (Pencil exports can carry transparency).
  const { width, height, data } = png;
  const n = width * height;
  const out = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) {
      out[c][i] = Math.round(data[i * 4 + c] * a + 255 * (1 - a));
    }
  }
  return out;
}

// Separable min/max filter over a (2rx+1)×(2ry+1) window.
function rangeFilter(plane, w, h, rx, ry = rx) {
  const r = rx;
  const tmin = new Uint8Array(w * h), tmax = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let mn = 255, mx = 0;
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let k = x0; k <= x1; k++) {
        const v = plane[row + k];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      tmin[row + x] = mn;
      tmax[row + x] = mx;
    }
  }
  const mn = new Uint8Array(w * h), mx = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let a = 255, b = 0;
      const y0 = Math.max(0, y - ry), y1 = Math.min(h - 1, y + ry);
      for (let k = y0; k <= y1; k++) {
        const i = k * w + x;
        if (tmin[i] < a) a = tmin[i];
        if (tmax[i] > b) b = tmax[i];
      }
      mn[y * w + x] = a;
      mx[y * w + x] = b;
    }
  }
  return { mn, mx };
}

// 1 where some channel of `a` falls outside `b`'s neighbourhood range by > TOLERANCE.
// `wide` (optional) is used instead of `narrow` wherever `inText` is set.
function outsideMask(a, narrow, wide, inText, w, h, mask) {
  for (let c = 0; c < 3; c++) {
    const p = a[c];
    const n = narrow[c], t = wide ? wide[c] : null;
    for (let i = 0; i < w * h; i++) {
      const r = t && inText[i] ? t : n;
      const v = p[i];
      if (v + TOLERANCE < r.mn[i] || v > r.mx[i] + TOLERANCE) mask[i] = 1;
    }
  }
}

function textMask(boxes, w, h) {
  const m = new Uint8Array(w * h);
  for (const b of boxes || []) {
    // Centred and right-aligned lines drift left as well as right.
    const x0 = Math.max(0, Math.floor(b[0]) - TEXT_RX), y0 = Math.max(0, Math.floor(b[1]) - 4);
    const x1 = Math.min(w, Math.ceil(b[0] + b[2]) + TEXT_RX), y1 = Math.min(h, Math.ceil(b[1] + b[3]) + 4);
    for (let y = y0; y < y1; y++) m.fill(1, y * w + x0, y * w + x1);
  }
  return m;
}

// Morphological opening (3×3 erode, then dilate): drops isolated specks.
function open3(mask, w, h) {
  const er = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!mask[(y + dy) * w + x + dx]) { all = 0; break; }
        }
      }
      er[y * w + x] = all;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!er[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) out[(y + dy) * w + x + dx] = 1;
      }
    }
  }
  return out;
}

// Group differing pixels into rectangles over a coarse grid (8-connected blocks).
function regions(mask, w, h) {
  const bw = Math.ceil(w / BLOCK), bh = Math.ceil(h / BLOCK);
  const count = new Uint32Array(bw * bh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) count[Math.floor(y / BLOCK) * bw + Math.floor(x / BLOCK)]++;
    }
  }
  const seen = new Uint8Array(bw * bh);
  const out = [];
  for (let b = 0; b < bw * bh; b++) {
    if (!count[b] || seen[b]) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, px = 0;
    const stack = [b];
    seen[b] = 1;
    while (stack.length) {
      const cur = stack.pop();
      const cx = cur % bw, cy = Math.floor(cur / bw);
      px += count[cur];
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
          const nb = ny * bw + nx;
          if (count[nb] && !seen[nb]) { seen[nb] = 1; stack.push(nb); }
        }
      }
    }
    if (px < MIN_REGION_PX) continue;
    out.push({
      x: x0 * BLOCK, y: y0 * BLOCK,
      w: Math.min(w, (x1 + 1) * BLOCK) - x0 * BLOCK,
      h: Math.min(h, (y1 + 1) * BLOCK) - y0 * BLOCK,
      px,
    });
  }
  return out.sort((a, b) => b.px - a.px);
}

// Is anything actually drawn outside the two renders' shared area?
function drawnOutside(png, w, h) {
  const { width, height, data } = png;
  for (let y = 0; y < height; y++) {
    for (let x = y < h ? w : 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) return true;
    }
  }
  return false;
}

function isBlank(planes) {
  // A render of one flat colour — Pencil occasionally returns an empty frame.
  const [r, g, b] = planes;
  for (let i = 1; i < r.length; i += 97) {
    if (r[i] !== r[0] || g[i] !== g[0] || b[i] !== b[0]) return false;
  }
  return true;
}

/**
 * @param {Buffer} pencilPng
 * @param {Buffer} figmaPng
 * @param {number[][]} [textBoxes]  [x, y, w, h] of every text layer, frame space
 * @returns {{status: "match"|"differs"|"size"|"pencil-blank", width: number, height: number,
 *            px: number, regions: {x,y,w,h,px}[], overlay: Buffer|null}}
 */
export function compareRenders(pencilPng, figmaPng, textBoxes = []) {
  const a = PNG.sync.read(pencilPng);
  const b = PNG.sync.read(figmaPng);
  // A frame that hugs its content can end up a few px shorter in Figma. Refusing to
  // compare would hide everything else on it, so only a wholly different frame is
  // left uncompared; otherwise the shared area is compared and the size reported.
  const dw = a.width - b.width, dh = a.height - b.height;
  const tooDifferent = Math.abs(dw) > Math.max(16, a.width * 0.02) || Math.abs(dh) > Math.max(16, a.height * 0.02);
  if (tooDifferent) {
    return { status: "size", width: a.width, height: a.height, figmaWidth: b.width, figmaHeight: b.height, px: 0, regions: [], overlay: null };
  }
  // Pencil's PNG can carry a few fully transparent rows past the content — the
  // "Состояния элементов" board exports 1406px tall around 1401px of content. That is
  // not a size difference worth reporting; anything drawn out there is.
  const cw = Math.min(a.width, b.width), ch = Math.min(a.height, b.height);
  const sizeNote = (drawnOutside(a, cw, ch) || drawnOutside(b, cw, ch))
    ? { pencil: [a.width, a.height], figma: [b.width, b.height] }
    : null;
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  const crop = (png) => {
    if (png.width === w && png.height === h) return png;
    const out = new PNG({ width: w, height: h });
    PNG.bitblt(png, out, 0, 0, w, h, 0, 0);
    return out;
  };
  const pa = flatten(crop(a)), pb = flatten(crop(b));
  if (isBlank(pa) && !isBlank(pb)) {
    return { status: "pencil-blank", width: w, height: h, px: 0, regions: [], overlay: null };
  }

  const inText = textMask(textBoxes, w, h);
  const hasText = textBoxes && textBoxes.length > 0;
  const ra = pa.map((p) => rangeFilter(p, w, h, RADIUS));
  const rb = pb.map((p) => rangeFilter(p, w, h, RADIUS));
  const wa = hasText ? pa.map((p) => rangeFilter(p, w, h, TEXT_RX, RADIUS)) : null;
  const wb = hasText ? pb.map((p) => rangeFilter(p, w, h, TEXT_RX, RADIUS)) : null;
  const mask = new Uint8Array(w * h);
  outsideMask(pa, rb, wb, inText, w, h, mask);
  outsideMask(pb, ra, wa, inText, w, h, mask);
  const clean = open3(mask, w, h);
  let px = 0;
  for (let i = 0; i < w * h; i++) px += clean[i];
  const regs = px ? regions(clean, w, h) : [];

  let overlay = null;
  if (regs.length) {
    // Pencil's render with the differing pixels painted red and each region boxed.
    const img = new PNG({ width: w, height: h });
    for (let i = 0; i < w * h; i++) {
      const hit = clean[i];
      img.data[i * 4] = hit ? 255 : pa[0][i];
      img.data[i * 4 + 1] = hit ? 0 : pa[1][i];
      img.data[i * 4 + 2] = hit ? 0 : pa[2][i];
      img.data[i * 4 + 3] = 255;
    }
    for (const r of regs) {
      for (let x = r.x; x < r.x + r.w; x++) {
        for (const y of [r.y, r.y + r.h - 1]) {
          const i = (y * w + x) * 4;
          img.data[i] = 255; img.data[i + 1] = 0; img.data[i + 2] = 255;
        }
      }
      for (let y = r.y; y < r.y + r.h; y++) {
        for (const x of [r.x, r.x + r.w - 1]) {
          const i = (y * w + x) * 4;
          img.data[i] = 255; img.data[i + 1] = 0; img.data[i + 2] = 255;
        }
      }
    }
    overlay = PNG.sync.write(img);
  }
  return {
    status: regs.length || sizeNote ? "differs" : "match",
    width: w, height: h, px, regions: regs, overlay,
    size: sizeNote,
  };
}
