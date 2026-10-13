/// <reference path="../../node_modules/@figma/plugin-typings/index.d.ts" />

// Pencil → Figma plugin
// Universal builder that turns a JSON tree exported from a .pen design into Figma nodes.
//
// Accepts Pencil's NATIVE schema as produced by `batch_get` with
// `resolveVariables: true, resolveInstances: true`:
//
// node = {
//   id?, name?, type: "frame"|"rectangle"|"ellipse"|"line"|"text"|"polygon"|"path",
//   width: number | "fill_container" | "fit_content",
//   height: number | "fill_container" | "fit_content",
//   x?, y?, rotation?,
//   fill?:   string | PencilFill | Array<string | PencilFill>,  // string = "#hex" hex shorthand
//   stroke?: { fill, thickness?, align? },
//   cornerRadius?: number | [tl, tr, br, bl],
//   opacity?, visible?, clip?, blendMode?,
//   effects?: Effect[],
//
//   // Auto-layout (Pencil flat fields, not nested):
//   layout?: "vertical" | "horizontal" | "none",
//   padding?: number | [v, h] | [t, r, b, l],
//   gap?: number,
//   alignItems?: "start"|"center"|"end"|"stretch",          // counter axis
//   justifyContent?: "start"|"center"|"end"|"space_between",// primary axis
//
//   // Text fields are inline on the node (not nested in `text:`):
//   content?: string,
//   fontFamily?, fontSize?, fontWeight?: string|number,
//   lineHeight?: number,        // multiplier — 1.05 = 105%
//   letterSpacing?: number,     // px
//   textAlign?, textCase?, textDecoration?,
//
//   children?: node[]
// }
//
// PencilFill = { type: "color", color: "#rrggbb", opacity?, enabled? }
//            | { type: "image", data?: base64, url?: string, mode: "fill"|"fit"|"crop"|"tile", opacity?, enabled? }
//            | { type: "gradient", kind: "linear"|"radial"|"angular"|"diamond", stops, transform?, opacity? }

figma.showUI(__html__, { width: 360, height: 540, themeColors: true });

type N = any;

// ─── Fonts ────────────────────────────────────────────────────────────────────

// Different Figma fonts spell their weight styles differently — Figma's
// bundled Inter exposes "Semi Bold" / "Extra Bold" / "Extra Light" (with
// spaces), while many other families ship the same weights as "SemiBold" /
// "ExtraBold". Try the most common alternates so we don't quietly fall back
// to Regular when the user has the font but under a slightly different label.
function styleAlternates(style: string): string[] {
  const out = [style];
  const spaced = style.replace(/([a-z])([A-Z])/g, "$1 $2");
  if (spaced !== style) out.push(spaced);          // "SemiBold" → "Semi Bold"
  const collapsed = style.replace(/\s+/g, "");
  if (collapsed !== style) out.push(collapsed);    // "Semi Bold" → "SemiBold"
  const lower = style.replace(/([a-z])([A-Z])/g, "$1$2").toLowerCase();
  const titled = lower.charAt(0).toUpperCase() + lower.slice(1);
  if (titled !== style && !out.includes(titled)) out.push(titled);
  return out;
}

const fontCache = new Set<string>();

// Fonts that did NOT load as specified, as "Family Style → what we used instead".
// A silent substitution is the single most visible way an import stops being 1:1 —
// every heading in the design changes typeface and weight at once — so record it and
// report it rather than letting the canvas be the only clue.
let fontFallbacks = new Map<string, string>();

// Weight behind a style name, for picking the closest one a family actually has.
const STYLE_WEIGHTS: Record<string, number> = {
  thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, book: 350,
  regular: 400, normal: 400, medium: 500, semibold: 600, demibold: 600, bold: 700,
  extrabold: 800, ultrabold: 800, black: 900, heavy: 900, extrablack: 950, ultrablack: 950,
};

function styleWeight(style: string): number {
  const s = String(style).toLowerCase().replace(/italic|oblique/g, "").replace(/[\s_-]/g, "");
  return STYLE_WEIGHTS[s] != null ? STYLE_WEIGHTS[s] : 400;
}

const isItalicStyle = (s: string) => /italic|oblique/i.test(String(s));

// family → the styles this editor actually has, read once.
let fontIndex: Map<string, string[]> | null = null;
async function stylesOf(family: string): Promise<string[]> {
  if (!fontIndex) {
    fontIndex = new Map();
    try {
      for (const f of await figma.listAvailableFontsAsync()) {
        const list = fontIndex.get(f.fontName.family) || [];
        list.push(f.fontName.style);
        fontIndex.set(f.fontName.family, list);
      }
    } catch (e: any) {
      console.warn("[pencil-import] could not list fonts:", e?.message || e);
    }
  }
  return fontIndex.get(family) || [];
}

// Does this family carry a weight axis? Then the exact weight can be set even when
// the style is named something this plugin can't guess.
const axisCache = new Map<string, string[] | null>();
function variationAxes(family: string): string[] | null {
  if (axisCache.has(family)) return axisCache.get(family)!;
  let axes: string[] | null = null;
  try {
    const fn = (figma as any).getFontFamilyVariationAxes;
    if (typeof fn === "function") axes = fn.call(figma, family);
  } catch { axes = null; }
  axisCache.set(family, axes);
  return axes;
}

type LoadedFont = { family: string; style: string; variationSettings?: { [axis: string]: number } };

/**
 * Load the closest thing this editor has to the font the design asks for.
 *
 * The style name is not something to rely on: macOS reports this machine's Unbounded
 * Bold as "Жирный", so `loadFontAsync({family: "Unbounded", style: "Bold"})` fails and
 * every heading in the cake catalogue came out Regular — 1014px of text against
 * Pencil's 1108. So: the exact name first, then the family's own weight axis (which
 * hits the requested weight whatever the style is called), then the nearest weight
 * among the styles the family really has, and only then Inter.
 */
async function ensureFont(family: string, style: string): Promise<LoadedFont> {
  const key = `${family}|${style}`;
  if (fontCache.has(key)) return { family, style };
  for (const candidate of styleAlternates(style)) {
    try {
      await figma.loadFontAsync({ family, style: candidate });
      fontCache.add(`${family}|${candidate}`);
      // An alternate spelling of the SAME weight ("SemiBold" vs "Semi Bold") is an
      // exact match as far as the design is concerned — not a fallback.
      return { family, style: candidate };
    } catch {
      // try the next spelling
    }
  }

  const want = styleWeight(style);
  const italic = isItalicStyle(style);
  const available = await stylesOf(family);

  // The family's weight axis reproduces the requested weight exactly.
  const axes = available.length ? variationAxes(family) : null;
  if (axes && axes.indexOf("wght") >= 0) {
    const base = available.find((s) => isItalicStyle(s) === italic) || available[0];
    const fontName = { family, style: base, variationSettings: { wght: want } };
    try {
      await figma.loadFontAsync(fontName as any);
      fontCache.add(`${family}|${base}|${want}`);
      return fontName;
    } catch { /* fall through to a named style */ }
  }

  // Nearest named weight the family actually has.
  if (available.length) {
    const ranked = available.slice().sort((a, b) => {
      const ia = isItalicStyle(a) === italic ? 0 : 1000;
      const ib = isItalicStyle(b) === italic ? 0 : 1000;
      return (ia + Math.abs(styleWeight(a) - want)) - (ib + Math.abs(styleWeight(b) - want));
    });
    for (const candidate of ranked) {
      try {
        await figma.loadFontAsync({ family, style: candidate });
        fontCache.add(`${family}|${candidate}`);
        if (styleWeight(candidate) !== want || isItalicStyle(candidate) !== italic) {
          fontFallbacks.set(`${family} ${style}`, `${family} ${candidate} (has: ${available.join(", ")})`);
        }
        return { family, style: candidate };
      } catch { /* try the next one */ }
    }
  }

  // Family missing entirely.
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  fontCache.add("Inter|Regular");
  fontFallbacks.set(`${family} ${style}`, "Inter Regular");
  return { family: "Inter", style: "Regular" };
}

// Pencil fontWeight can be a number (100..900) or string ("400","bold","800"). Map to Figma style names.
function weightToStyle(weight: any): string {
  if (weight == null) return "Regular";
  const w = typeof weight === "string" ? weight.trim().toLowerCase() : weight;
  if (typeof w === "number" || /^\d+$/.test(String(w))) {
    const n = +w;
    if (n <= 150) return "Thin";
    if (n <= 250) return "ExtraLight";
    if (n <= 350) return "Light";
    if (n <= 450) return "Regular";
    if (n <= 550) return "Medium";
    if (n <= 650) return "SemiBold";
    if (n <= 750) return "Bold";
    if (n <= 850) return "ExtraBold";
    return "Black";
  }
  const map: Record<string, string> = {
    thin: "Thin", hairline: "Thin",
    extralight: "ExtraLight", ultralight: "ExtraLight",
    light: "Light",
    regular: "Regular", normal: "Regular", book: "Regular",
    medium: "Medium",
    semibold: "SemiBold", demibold: "SemiBold",
    bold: "Bold",
    extrabold: "ExtraBold", ultrabold: "ExtraBold", heavy: "ExtraBold",
    black: "Black",
  };
  return map[String(w)] || "Regular";
}

// ─── Color / fills ────────────────────────────────────────────────────────────

function hexToRgb(hex: string): RGB {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const num = parseInt(h.slice(0, 6), 16);
  return {
    r: ((num >> 16) & 255) / 255,
    g: ((num >> 8) & 255) / 255,
    b: (num & 255) / 255,
  };
}
function parseColor(c: string): { rgb: RGB; a: number } {
  if (typeof c !== "string") return { rgb: { r: 0, g: 0, b: 0 }, a: 1 };
  const h = c.replace("#", "");
  if (h.length === 8) {
    const a = parseInt(h.slice(6, 8), 16) / 255;
    return { rgb: hexToRgb("#" + h.slice(0, 6)), a };
  }
  return { rgb: hexToRgb(c), a: 1 };
}
function base64ToBytes(b64: string): Uint8Array {
  const data = b64.includes(",") ? b64.split(",")[1] : b64;
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Per-fill blend modes (Pencil's camelCase → Figma's SCREAMING_SNAKE). This is
// distinct from the node-level `blendMap` below: a single layer can carry an
// image fill plus a `multiply` color/gradient scrim on top of it.
const fillBlendMap: Record<string, BlendMode> = {
  normal: "NORMAL", darken: "DARKEN", multiply: "MULTIPLY",
  linearburn: "LINEAR_BURN", colorburn: "COLOR_BURN",
  light: "LIGHTEN", lighten: "LIGHTEN", screen: "SCREEN",
  lineardodge: "LINEAR_DODGE", colordodge: "COLOR_DODGE",
  overlay: "OVERLAY", softlight: "SOFT_LIGHT", hardlight: "HARD_LIGHT",
  difference: "DIFFERENCE", exclusion: "EXCLUSION",
  hue: "HUE", saturation: "SATURATION", color: "COLOR", luminosity: "LUMINOSITY",
};
function fillBlendMode(bm: any): BlendMode | null {
  if (!bm || typeof bm !== "string") return null;
  return fillBlendMap[bm.toLowerCase()] || null;
}

// Convert Pencil's gradient direction (rotation°, center, size) into Figma's
// `gradientTransform` — the 2×3 affine that maps the node's normalized box
// space into gradient space, where x is the position along the gradient (0→1).
// Pencil never ships a ready-made matrix, so without this every gradient would
// default to a flat left→right ramp regardless of the design's real direction.
function pencilGradientTransform(fill: any, kind: string): number[][] {
  const cx = fill.center && fill.center.x != null ? fill.center.x : 0.5;
  const cy = fill.center && fill.center.y != null ? fill.center.y : 0.5;
  if (kind === "radial" || kind === "angular") {
    // `size` holds the ellipse DIAMETERS as a fraction of the box, `center` its
    // position, `rotation` its tilt. Figma maps object space → gradient space,
    // where the gradient is the circle centred on (0.5, 0.5) with radius 0.5 —
    // so the box-space point `center` must land on (0.5, 0.5) and a point one
    // semi-axis away must land 0.5 out from it.
    //
    // The previous matrix was this one INVERTED (gradient space → object
    // space). The two agree exactly when center=0.5,0.5 and size=1,1 — the
    // Pencil defaults — which is why every ordinary gradient looked fine and
    // only a moved or resized one gave itself away: a glow at center.y=0.8
    // with size 2.4 landed at y=0.375 with 1/2.4 of its radius, a spot 2.4×
    // too small in the wrong half of the poster.
    const sw = fill.size && fill.size.width != null && fill.size.width > 0 ? fill.size.width : 1;
    const sh = fill.size && fill.size.height != null && fill.size.height > 0 ? fill.size.height : 1;
    // Pencil's rotation is degrees CCW on screen (0° up, 90° left), i.e. the
    // matrix that carries "up" onto the linear ramp direction below. Its local
    // axes, so an elliptical radial tilts and an angular sweep starts, in the
    // same direction Pencil draws them.
    const rot = ((fill.rotation != null ? fill.rotation : 0) * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    // Local axes of the gradient in box space: x = (cos, -sin), y = (sin, cos).
    return [
      [cos / sw, -sin / sw, 0.5 - (cos * cx - sin * cy) / sw],
      [sin / sh,  cos / sh, 0.5 - (sin * cx + cos * cy) / sh],
    ];
  }
  // Linear. Pencil rotation is degrees CCW with 0°=up — the un-rotated gradient
  // runs along the vertical (height) axis. Direction of pos0→pos1 in y-down
  // screen space: rotating "up" (0,-1) by the angle gives (-sin, -cos).
  const rad = ((fill.rotation != null ? fill.rotation : 0) * Math.PI) / 180;
  const dx = -Math.sin(rad);
  const dy = -Math.cos(rad);
  // size.height = gradient length as a fraction of the box; <1 compresses it.
  const len = fill.size && fill.size.height != null && fill.size.height > 0 ? fill.size.height : 1;
  const ax = dx / len;
  const ay = dy / len;
  // Pin the gradient's midpoint (position 0.5) to `center` so rotation pivots
  // there and an axis-aligned gradient spans the full box edge-to-edge.
  return [
    [ax, ay, 0.5 - (ax * cx + ay * cy)],
    [-ay, ax, 0.5 - (-ay * cx + ax * cy)],
  ];
}

async function toPaint(fill: any): Promise<Paint | null> {
  if (fill == null || fill === false) return null;

  // Hex string shorthand: "#3F2D5A"
  if (typeof fill === "string") {
    const { rgb, a } = parseColor(fill);
    return { type: "SOLID", color: rgb, opacity: a };
  }

  if (typeof fill !== "object") return null;
  if (fill.enabled === false) return null;

  if (fill.type === "color") {
    const { rgb, a } = parseColor(fill.color);
    const paint: SolidPaint = { type: "SOLID", color: rgb, opacity: fill.opacity != null ? fill.opacity : a };
    const bm = fillBlendMode(fill.blendMode);
    if (bm) (paint as any).blendMode = bm;
    return paint;
  }

  if (fill.type === "image" && fill.data) {
    try {
      const bytes = base64ToBytes(fill.data);
      const img = figma.createImage(bytes);
      const modeMap: Record<string, ImagePaint["scaleMode"]> = {
        fill: "FILL", stretch: "FILL", fit: "FIT", crop: "CROP", tile: "TILE",
      };
      const paint: ImagePaint = {
        type: "IMAGE",
        imageHash: img.hash,
        scaleMode: modeMap[fill.mode || "fill"] || "FILL",
      };
      if (fill.opacity != null) (paint as any).opacity = fill.opacity;
      const bm = fillBlendMode(fill.blendMode);
      if (bm) (paint as any).blendMode = bm;
      return paint;
    } catch (e: any) {
      console.error("[pencil-import] image fill failed:", e?.message || e, "data length:", (fill.data || "").length);
      return null;
    }
  }
  if (fill.type === "image" && !fill.data && fill.url) {
    // Image fill arrived with only a URL and no embedded data — the exporter
    // failed to embed this image. Skip it so the SOLID background underneath shows.
    console.warn("[pencil-import] image fill missing data, url:", fill.url);
    return null;
  }

  if (fill.type === "gradient") {
    // Pencil's native gradient schema does NOT match Figma's:
    //   • stops live in `colors: [{color, position}]`        (not `stops`)
    //   • kind is `gradientType: linear|radial|angular`       (not `kind`)
    //   • direction is `rotation`°/`center`/`size`            (not `transform`)
    // The old code read the Figma-style names, so EVERY Pencil gradient was
    // dropped — e.g. the dark scrim layered over hero photos vanished and the
    // images came in undimmed. Read Pencil's fields, keep the old as fallback.
    const rawStops = Array.isArray(fill.colors) ? fill.colors
                   : Array.isArray(fill.stops) ? fill.stops : null;
    if (!rawStops || !rawStops.length) return null;
    const stops: ColorStop[] = rawStops.map((s: any) => {
      const c = typeof s.color === "string" ? parseColor(s.color) : { rgb: { r: 0, g: 0, b: 0 }, a: 1 };
      return {
        position: s.position != null ? s.position : 0,
        color: { ...c.rgb, a: s.opacity != null ? s.opacity : c.a },
      };
    });
    const kind = fill.gradientType || fill.kind || "linear";
    const typeMap: Record<string, GradientPaint["type"]> = {
      linear: "GRADIENT_LINEAR",
      radial: "GRADIENT_RADIAL",
      angular: "GRADIENT_ANGULAR",
      diamond: "GRADIENT_DIAMOND",
    };
    const paint: GradientPaint = {
      type: typeMap[kind] || "GRADIENT_LINEAR",
      gradientStops: stops,
      gradientTransform: (fill.transform || pencilGradientTransform(fill, kind)) as Transform,
    };
    if (fill.opacity != null) (paint as any).opacity = fill.opacity;
    const bm = fillBlendMode(fill.blendMode);
    if (bm) (paint as any).blendMode = bm;
    return paint;
  }

  return null;
}

async function toPaints(fill: any): Promise<Paint[]> {
  if (fill == null) return [];
  const arr = Array.isArray(fill) ? fill : [fill];
  const out: Paint[] = [];
  for (const f of arr) {
    const p = await toPaint(f);
    if (p) out.push(p);
  }
  return out;
}

// ─── Padding / sizing helpers ─────────────────────────────────────────────────

function expandPadding(p: any): { top: number; right: number; bottom: number; left: number } {
  if (p == null) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof p === "number") return { top: p, right: p, bottom: p, left: p };
  if (Array.isArray(p)) {
    if (p.length === 1) return { top: p[0], right: p[0], bottom: p[0], left: p[0] };
    if (p.length === 2) return { top: p[0], right: p[1], bottom: p[0], left: p[1] };
    if (p.length === 3) return { top: p[0], right: p[1], bottom: p[2], left: p[1] };
    if (p.length === 4) return { top: p[0], right: p[1], bottom: p[2], left: p[3] };
  }
  if (typeof p === "object") {
    return {
      top: p.top || 0,
      right: p.right || 0,
      bottom: p.bottom || 0,
      left: p.left || 0,
    };
  }
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

const alignMap: Record<string, "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN"> = {
  start: "MIN", min: "MIN", left: "MIN", top: "MIN",
  center: "CENTER", middle: "CENTER",
  end: "MAX", max: "MAX", right: "MAX", bottom: "MAX",
  space_between: "SPACE_BETWEEN", "space-between": "SPACE_BETWEEN",
  // Figma auto-layout has no space-around; SPACE_BETWEEN is the closest primary-axis
  // distribution it offers, and leaving it unset would collapse the row to `start`.
  space_around: "SPACE_BETWEEN", "space-around": "SPACE_BETWEEN",
  stretch: "MIN",
};

// ─── Pencil sizing behaviour ──────────────────────────────────────────────────
// A Pencil width/height is one of:
//   • a number                       → fixed px
//   • "fill_container"               → take the parent's size (Figma FILL)
//   • "fit_content"                  → size to children (Figma HUG)
//   • either keyword with a fallback in parens: "fit_content(100)" — the px value
//     Pencil falls back to when the behaviour can't apply (no layout / not in one).
// The fallback form is easy to miss: read naively it matches neither keyword and
// used to land in the FIXED branch, pinning the node at whatever stale size it
// happened to have.

type SizeMode = "FIXED" | "FILL" | "HUG";

function sizingMode(dim: any): SizeMode | null {
  if (dim == null) return null;
  if (typeof dim === "number") return Number.isFinite(dim) ? "FIXED" : null;
  if (typeof dim !== "string") return null;
  const s = dim.trim();
  if (/^fill_container\b/.test(s)) return "FILL";
  if (/^fit_content\b/.test(s)) return "HUG";
  const n = Number(s);
  return Number.isFinite(n) ? "FIXED" : null;
}

// The concrete px size this dimension implies, if any: the number itself, or the
// keyword's parenthesised fallback.
function sizingPx(dim: any): number | null {
  if (typeof dim === "number") return Number.isFinite(dim) ? dim : null;
  if (typeof dim !== "string") return null;
  const paren = dim.match(/\(\s*(-?[\d.]+)\s*\)/);
  if (paren) {
    const n = Number(paren[1]);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(dim.trim());
  return Number.isFinite(n) ? n : null;
}

function applyAutoLayout(frame: FrameNode, node: N): void {
  // Pencil schema rules (empirically derived from real .pen exports):
  //   layout: "vertical"   → vertical auto-layout
  //   layout: "horizontal" → horizontal auto-layout
  //   layout: "none" → absolutely-positioned children
  //   layout: missing → horizontal auto-layout, ALWAYS. Pencil documents the
  //     frame default as "default layout=horizontal, width=fit_content,
  //     height=fit_content", so a frame without `layout` IS a horizontal flex
  //     container — split frames, single-child wrappers, button rows, input
  //     fields and every component built on them rely on it.
  let mode = node.layout;
  if (mode !== "vertical" && mode !== "horizontal") {
    if (mode != null && mode !== "none") return; // unknown explicit layout — leave alone
    // An EXPLICIT layout: "none" means absolutely-positioned children, always —
    // the schema is unambiguous. Inferring a layout from it stacks the children
    // into a row: any deliberately overlapping composition — a badge over an
    // avatar, a scrim over a photo, children all sitting at 0,0 — came out
    // spread side by side.
    if (mode === "none") return;
    const kids = Array.isArray(node.children) ? node.children : [];
    if (kids.length === 0) return;  // no children, layout mode doesn't matter
    // A *missing* layout must NOT be re-read as absolute from the children's
    // x/y. Pencil is explicit that "Position ... IGNORED when parent uses flex
    // layout", so on a laid-out child x/y is stale bookkeeping, not intent —
    // and resolved instances carry it constantly (the hidden dropdown arrow in
    // the "Поле · фильтр" component resolves with x:98, y:11.5 while its two
    // visible siblings have none). Treating that as "genuine absolute layout"
    // stripped auto-layout from every button and filter field in the document:
    // padding, gap and alignItems were dropped, so the icon and the label both
    // collapsed onto 0,0 — label straddling the pill's top edge, icon buried
    // underneath it. Children that really do opt out of flex set
    // layoutPosition: "absolute", which is honoured separately below.
    mode = "horizontal";
  }
  frame.layoutMode = mode === "vertical" ? "VERTICAL" : "HORIZONTAL";
  // Figma's auto-layout counts a frame's own stroke towards its size by default, and
  // takes it out of the space it gives FILL children. Pencil's stroke never affects
  // layout: a K-POP list row with a 2px bottom rule came out 99px tall against
  // Pencil's 97 (×7 rows = 14px of drift down the card), and a photo inside a 4px
  // frame came out 8px smaller.
  try { frame.strokesIncludedInLayout = false; } catch {}

  // CRITICAL: Figma's DEFAULT primary/counterAxisSizingMode after enabling auto-layout
  // is FIXED — meaning the frame stays at its current 100×100 default size and children
  // overflow. We MUST explicitly switch to AUTO (hug content) for any axis that should
  // grow with content. Mapping:
  //   numeric        → FIXED (resize() will set the exact value)
  //   "fit_content"  → AUTO  (hug)
  //   missing        → AUTO  (Pencil treats this as hug-content by convention)
  //   "fill_container" → leave FIXED — the actual size comes from layoutSizing* on this
  //                      node later, when its parent's auto-layout allocates space.
  const primaryDim = mode === "vertical" ? node.height : node.width;
  const counterDim = mode === "vertical" ? node.width : node.height;
  const setSizingMode = (
    which: "primaryAxisSizingMode" | "counterAxisSizingMode",
    dim: any
  ) => {
    const m = sizingMode(dim);
    // HUG or unspecified → AUTO. FIXED stays FIXED (resize() sets the value).
    // FILL → FIXED here; the real size arrives via layoutSizing* once the parent's
    // auto-layout allocates space.
    const val: "FIXED" | "AUTO" = m === "HUG" || m === null ? "AUTO" : "FIXED";
    try { (frame as any)[which] = val; } catch {}
  };
  setSizingMode("primaryAxisSizingMode", primaryDim);
  setSizingMode("counterAxisSizingMode", counterDim);

  if (node.gap != null) frame.itemSpacing = node.gap;

  const pad = expandPadding(node.padding);
  frame.paddingTop = pad.top;
  frame.paddingRight = pad.right;
  frame.paddingBottom = pad.bottom;
  frame.paddingLeft = pad.left;

  // justifyContent = primary axis; alignItems = counter axis
  if (node.justifyContent && alignMap[node.justifyContent]) {
    let primary = alignMap[node.justifyContent];
    // Figma and Pencil disagree about space-between with a SINGLE item: Figma
    // centres the lone child, Pencil (like CSS flexbox) leaves it at the start.
    // A card header written as `space_between` so a future action link can sit on
    // the right therefore had its only child — the heading — pushed inward by half
    // the leftover space. Count only children that actually take part in the flow.
    if (primary === "SPACE_BETWEEN") {
      const kids = Array.isArray(node.children) ? node.children : [];
      const inFlow = kids.filter(
        (c: N) => c && typeof c === "object" &&
                  c.layoutPosition !== "absolute" &&
                  c.enabled !== false && c.visible !== false
      );
      if (inFlow.length < 2) primary = "MIN";
    }
    frame.primaryAxisAlignItems = primary;
  }
  if (node.alignItems && alignMap[node.alignItems]) {
    const v = alignMap[node.alignItems];
    if (v !== "SPACE_BETWEEN") frame.counterAxisAlignItems = v;
  }
  if (node.alignItems === "stretch" && "layoutAlign" in frame) {
    // alignment on children controlled by their own layoutAlign — handled in applyChildSizing
  }
}

// Pencil gates text sizing behind `textGrowth` ("Required before width/height take
// effect"): with the default "auto" the box always hugs its content and any
// width/height on the node is IGNORED by Pencil. Figma's equivalent is
// textAutoResize, so translate the three growth modes directly instead of guessing
// from whether a width happens to be present — guessing pinned "auto" text to a
// stale width and re-wrapped copy that Pencil renders on one line.
function textAutoResizeFor(node: N): "WIDTH_AND_HEIGHT" | "HEIGHT" | "NONE" {
  switch (node.textGrowth) {
    case "fixed-width": return "HEIGHT";
    case "fixed-width-height": return "NONE";
    default: return "WIDTH_AND_HEIGHT"; // "auto" and unspecified
  }
}

function applyChildSizing(n: SceneNode, node: N): void {
  // Pencil uses "fill_container" / "fit_content" / number for width and height.
  // In Figma, this maps to layoutSizing… on the child, when the parent has auto-layout.
  if (!("layoutSizingHorizontal" in n)) return;

  const isText = n.type === "TEXT";
  const growth = isText ? textAutoResizeFor(node) : null;

  // CRITICAL for text nodes: set textAutoResize BEFORE layoutSizing*, otherwise
  // setting FILL on a text node whose textAutoResize is the default WIDTH_AND_HEIGHT
  // can silently fail (Figma's plugin API quietly refuses to apply FILL to a
  // hug-content text), leaving the text invisible at zero width inside an
  // auto-layout column.
  if (isText && growth) {
    try { (n as TextNode).textAutoResize = growth; } catch {}
  }

  // Which axes this node actually controls. For text, `textGrowth` decides:
  //   auto               → both axes hug, ignore width/height entirely
  //   fixed-width        → width applies, height hugs
  //   fixed-width-height → both apply
  const useWidth = !isText || growth !== "WIDTH_AND_HEIGHT";
  const useHeight = !isText || growth === "NONE";

  const set = (axis: "Horizontal" | "Vertical", dim: any) => {
    const m = sizingMode(dim);
    if (m === null) return;
    (n as any)["layoutSizing" + axis] = m === "FILL" ? "FILL" : m === "HUG" ? "HUG" : "FIXED";
  };
  if (useWidth && node.width != null) {
    try { set("Horizontal", node.width); } catch {}
  }
  if (useHeight && node.height != null) {
    try { set("Vertical", node.height); } catch {}
  }

  // CRITICAL: Setting layoutSizing*=FIXED only LOCKS the current size — it does not
  // restore a numeric dimension that auto-layout has previously hugged away. So if
  // Pencil specified an explicit numeric width/height (e.g. card height: 340) and
  // applyAutoLayout reset the frame to HUG content, the actual size right now is
  // whatever the children needed (often much smaller). Re-call resize() with the
  // intended dimensions to force the frame back to spec.
  if ("resize" in n) {
    // Only re-assert a size for axes this node actually fixes. A FILL/HUG axis must
    // keep whatever auto-layout computed, even when the keyword carries a px
    // fallback — the fallback is for when the behaviour can't apply at all.
    const wNum = useWidth && sizingMode(node.width) === "FIXED" ? sizingPx(node.width) : null;
    const hNum = useHeight && sizingMode(node.height) === "FIXED" ? sizingPx(node.height) : null;
    if (wNum !== null || hNum !== null) {
      try {
        const w = wNum !== null ? wNum : n.width;
        const h = hNum !== null ? hNum : n.height;
        if (w > 0 && h > 0) (n as FrameNode).resize(w, h);
      } catch {}
    }
  }
}

// ─── Corner radius / effects ──────────────────────────────────────────────────

function applyCornerRadius(n: SceneNode, r: any): void {
  if (r == null) return;
  if (typeof r === "number" && "cornerRadius" in n) {
    (n as RectangleNode).cornerRadius = r;
    return;
  }
  if (Array.isArray(r) && r.length === 4 && "topLeftRadius" in n) {
    const rn = n as RectangleNode;
    // Pencil order: [topLeft, topRight, bottomRight, bottomLeft]
    rn.topLeftRadius = r[0];
    rn.topRightRadius = r[1];
    rn.bottomRightRadius = r[2];
    rn.bottomLeftRadius = r[3];
    return;
  }
  if (typeof r === "object" && "topLeftRadius" in n) {
    const rn = n as RectangleNode;
    if (r.topLeft != null) rn.topLeftRadius = r.topLeft;
    if (r.topRight != null) rn.topRightRadius = r.topRight;
    if (r.bottomLeft != null) rn.bottomLeftRadius = r.bottomLeft;
    if (r.bottomRight != null) rn.bottomRightRadius = r.bottomRight;
  }
}

// Pencil's effect schema:
//   { type: "shadow", shadowType?: "inner" | "outer", offset?: {x,y}, spread?, blur?, color?, enabled? }
//   { type: "blur",            radius?, enabled? }
//   { type: "background_blur", radius?, enabled? }
//
// Note the shapes that trip up a Figma-flavoured reader: a single `shadow` type
// discriminated by `shadowType` (not separate drop_shadow/inner_shadow types), the
// offset as a nested {x,y} (not offsetX/offsetY), and blur radius under `radius`
// (not `blur`). Reading the Figma-style names found nothing, so every shadow and
// blur in the design was silently dropped. The legacy spellings are still accepted
// so older exported JSON keeps working.
function applyEffects(n: SceneNode, raw: any): void {
  if (!("effects" in n) || raw == null) return;
  const effects = Array.isArray(raw) ? raw : [raw];
  const list: Effect[] = [];
  for (const e of effects) {
    if (!e || typeof e !== "object" || e.enabled === false) continue;
    const type = String(e.type || "");
    const offX = e.offset && e.offset.x != null ? e.offset.x : (e.offsetX || 0);
    const offY = e.offset && e.offset.y != null ? e.offset.y : (e.offsetY || 0);
    const blurRadius = e.radius != null ? e.radius : (e.blur != null ? e.blur : 0);

    if (type === "shadow" || type === "drop_shadow" || type === "drop-shadow" ||
        type === "inner_shadow" || type === "inner-shadow") {
      const inner =
        e.shadowType === "inner" || type === "inner_shadow" || type === "inner-shadow";
      const { rgb, a } = parseColor(e.color || "#00000040");
      const shadow: any = {
        type: inner ? "INNER_SHADOW" : "DROP_SHADOW",
        color: { ...rgb, a: e.opacity != null ? e.opacity : a },
        offset: { x: offX, y: offY },
        radius: blurRadius,
        spread: e.spread || 0,
        visible: true,
        blendMode: "NORMAL",
      };
      list.push(shadow as Effect);
    } else if (type === "blur" || type === "layer_blur") {
      list.push({ type: "LAYER_BLUR", radius: blurRadius, visible: true, blurType: "NORMAL" } as Effect);
    } else if (type === "background_blur" || type === "background-blur") {
      list.push({ type: "BACKGROUND_BLUR", radius: blurRadius, visible: true, blurType: "NORMAL" } as Effect);
    }
  }
  (n as FrameNode).effects = list;
}

const blendMap: Record<string, BlendMode> = {
  normal: "NORMAL", multiply: "MULTIPLY", screen: "SCREEN", overlay: "OVERLAY",
  darken: "DARKEN", lighten: "LIGHTEN",
  color_dodge: "COLOR_DODGE", "color-dodge": "COLOR_DODGE",
  color_burn: "COLOR_BURN", "color-burn": "COLOR_BURN",
  hard_light: "HARD_LIGHT", "hard-light": "HARD_LIGHT",
  soft_light: "SOFT_LIGHT", "soft-light": "SOFT_LIGHT",
  difference: "DIFFERENCE", exclusion: "EXCLUSION",
  hue: "HUE", saturation: "SATURATION", color: "COLOR", luminosity: "LUMINOSITY",
};

// ─── Strokes ──────────────────────────────────────────────────────────────────
// Pencil keeps stroke settings as SIBLINGS of the paint, not nested inside it:
//   stroke?: Fills                                  — the paint (or an array of them)
//   strokeWidth?: number | { top?, right?, bottom?, left? }
//   strokeAlignment?: "inner" | "center" | "outer"
//   strokeLinecap?, strokeLinejoin?
// Reading them as `stroke.thickness` / `stroke.align` (the shape an earlier guess
// assumed) always yields undefined: widths fell back to Figma's default 1px and a
// CSS-border-style `{bottom: 1}` underline became a full 1px box outline.

function strokeSideWeight(v: any): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function strokeWeights(node: N): {
  max: number; top: number; right: number; bottom: number; left: number; perSide: boolean;
} {
  const none = { max: 0, top: 0, right: 0, bottom: 0, left: 0, perSide: false };
  const legacy = node.stroke && typeof node.stroke === "object" && !Array.isArray(node.stroke)
    ? node.stroke.thickness
    : undefined;
  const w = node.strokeWidth != null ? node.strokeWidth : legacy;

  if (typeof w === "number") {
    return Number.isFinite(w)
      ? { max: w, top: w, right: w, bottom: w, left: w, perSide: false }
      : none;
  }
  if (w && typeof w === "object") {
    const top = strokeSideWeight(w.top);
    const right = strokeSideWeight(w.right);
    const bottom = strokeSideWeight(w.bottom);
    const left = strokeSideWeight(w.left);
    return { max: Math.max(top, right, bottom, left), top, right, bottom, left, perSide: true };
  }
  // A width we can't read — most likely an unresolved "$token" string that the
  // exporter didn't turn into a number. Something was asked for, so fall back to
  // Pencil's hairline rather than silently dropping a border.
  if (w != null) return { max: 1, top: 1, right: 1, bottom: 1, left: 1, perSide: false };
  // `stroke` set with NO width at all draws NOTHING in Pencil — verified against
  // the renderer: in a divider list whose rows carry {bottom: 1}, the last row
  // keeps the stroke colour, drops the width, and shows no rule. Treating that as
  // a 1px hairline boxed every such row on all four sides in Figma.
  return none;
}

function strokeAlignOf(node: N): "INSIDE" | "OUTSIDE" | "CENTER" | null {
  const legacy = node.stroke && typeof node.stroke === "object" && !Array.isArray(node.stroke)
    ? node.stroke.align
    : undefined;
  const a = node.strokeAlignment != null ? node.strokeAlignment : legacy;
  const map: Record<string, "INSIDE" | "OUTSIDE" | "CENTER"> = {
    inner: "INSIDE", inside: "INSIDE",
    outer: "OUTSIDE", outside: "OUTSIDE",
    center: "CENTER", middle: "CENTER",
  };
  return (a && map[String(a)]) || null;
}

// ─── SVG vectors (icons) ────────────────────────────────────────────────────

// Pull the tint out of a Pencil icon `fill`: the 6-digit hex plus its alpha.
// Icons are tinted with a solid colour. The alpha matters — a design can park an
// icon at "#00000000" to hide it in a state variant, and dropping the alpha (as
// slicing to 6 hex digits does) turns that invisible icon into a solid black one.
function iconTint(fill: any): { hex: string; alpha: number } {
  const f = Array.isArray(fill) ? fill.find((x) => x != null && x !== false) : fill;
  let hex: string | null = null;
  let opacity: number | null = null;
  if (typeof f === "string") hex = f;
  else if (f && f.type === "color" && typeof f.color === "string") {
    hex = f.color;
    if (typeof f.opacity === "number") opacity = f.opacity;
  }
  if (!hex) return { hex: "#000000", alpha: 1 };
  let h = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{3,8}$/.test(h)) return { hex: "#000000", alpha: 1 };
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  const alphaFromHex = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { hex: "#" + h.slice(0, 6), alpha: opacity != null ? opacity : alphaFromHex };
}

// Walk every node an imported SVG produced. createNodeFromSvg can nest groups and
// frames (any `<g>` in the source), so a direct-children-only pass misses geometry.
function eachSvgDescendant(root: FrameNode, visit: (n: SceneNode) => void): void {
  const stack: SceneNode[] = root.children.slice();
  while (stack.length) {
    const n = stack.pop()!;
    visit(n);
    if ("children" in n) stack.push(...(n as FrameNode).children);
  }
}

// Force an imported icon to the node's tint. Doing this on the Figma side (rather
// than trusting a `currentColor` substitution in the markup) is what makes all four
// icon libraries behave identically: lucide and feather draw with `stroke`, while
// Material Symbols and phosphor draw with `fill` — and Material declares no paint
// at all, so SVG defaults it to solid black. Retinting whichever channel actually
// carries geometry covers every case without special-casing the library.
//
// The tint's alpha is NOT put on the paint: Pencil draws a glyph as one shape, so a
// half-transparent icon is evenly half-transparent. A lucide glyph arrives as several
// overlapping strokes, and alpha on each stroke doubles up wherever they cross —
// the joints of a 50% "person-standing" came out as bright dots. The alpha goes on
// the icon's frame instead (iconOpacity), which composites the glyph as a whole.
function tintIconVectors(frame: FrameNode, tint: { hex: string; alpha: number }): void {
  const { rgb } = parseColor(tint.hex);
  const paint: SolidPaint = { type: "SOLID", color: rgb, opacity: 1 };
  eachSvgDescendant(frame, (c) => {
    const hasStroke = "strokes" in c && ((c as VectorNode).strokes || []).length > 0;
    const hasFill = "fills" in c && Array.isArray((c as VectorNode).fills) &&
                    ((c as VectorNode).fills as Paint[]).length > 0;
    if (hasStroke) {
      try { (c as VectorNode).strokes = [paint]; } catch {}
    }
    if (hasFill) {
      try { (c as VectorNode).fills = [paint]; } catch {}
    }
    if (!hasStroke && !hasFill && "fills" in c) {
      try { (c as VectorNode).fills = [paint]; } catch {}
    }
  });
}

// Layer opacity of an icon frame: the node's own opacity times its tint's alpha.
function isIconType(node: N): boolean {
  return !!node && (node.type === "icon" || node.type === "icon_font");
}

function iconOpacity(node: N): number {
  const own = typeof node.opacity === "number" ? node.opacity : 1;
  return own * iconTint(node.fill).alpha;
}

// Build a real vector node from an SVG string and scale it to the Pencil node's
// box. figma.createNodeFromSvg() returns a FRAME wrapping the imported vectors at
// the glyph's native size (24×24 for lucide).
//
// Stroke weight is the trap here: resize() with SCALE constraints stretches the
// geometry but leaves every stroke at its native width. Pencil scales the whole
// glyph, so a 230px lucide `person-standing` has ~19px limbs and its head (r=1,
// stroke 2) fills in to a solid dot — resized in Figma it came out as 2px sticks
// with a hairline ring for a head. rescale() is the Scale tool and scales strokes
// with the geometry, so the uniform part of the scale goes through it; resize()
// only absorbs whatever aspect change remains.
function vectorFromSvg(svg: string, w: any, h: any): FrameNode {
  const frame = figma.createNodeFromSvg(svg);
  eachSvgDescendant(frame, (c) => {
    if ("constraints" in c) {
      try { (c as any).constraints = { horizontal: "SCALE", vertical: "SCALE" }; } catch {}
    }
  });
  const wNum = sizingPx(w);
  const hNum = sizingPx(h);
  if (wNum && hNum && wNum > 0 && hNum > 0) {
    const uniform = Math.min(wNum / frame.width, hNum / frame.height);
    if (Number.isFinite(uniform) && uniform >= 0.01 && Math.abs(uniform - 1) > 1e-3) {
      try { frame.rescale(uniform); } catch {}
    }
    if (Math.abs(frame.width - wNum) > 0.01 || Math.abs(frame.height - hNum) > 0.01) {
      try { frame.resize(wNum, hNum); } catch {}
    }
  }
  try { frame.fills = []; } catch {}
  try { frame.clipsContent = false; } catch {}
  return frame;
}

// Mirror an icon/path inside its own SVG coordinate space. Pencil's flipX/flipY are
// plain booleans, but Figma has no flip property — you mirror via relativeTransform,
// which auto-layout ignores for its in-flow children. Baking the flip into the
// markup sidesteps that entirely and is exact.
function flipSvg(svg: string, flipX: boolean, flipY: boolean): string {
  if (!flipX && !flipY) return svg;
  const open = svg.match(/<svg\b[^>]*>/i);
  if (!open) return svg;
  const vb = open[0].match(/viewBox\s*=\s*"([^"]+)"/i);
  if (!vb) return svg;
  const p = vb[1].trim().split(/[\s,]+/).map(Number);
  if (p.length !== 4 || !(p[2] > 0) || !(p[3] > 0)) return svg;
  const sx = flipX ? -1 : 1;
  const sy = flipY ? -1 : 1;
  // Mirror about the viewBox centre so the glyph stays inside its box.
  const tx = flipX ? -(2 * p[0] + p[2]) : 0;
  const ty = flipY ? -(2 * p[1] + p[3]) : 0;
  const body = svg.slice(open.index! + open[0].length).replace(/<\/svg>\s*$/i, "");
  return `${open[0]}<g transform="scale(${sx} ${sy}) translate(${tx} ${ty})">${body}</g></svg>`;
}

// Build a REAL editable vector from a Pencil `path`/`vector` node's SVG geometry.
// Pencil paths carry `geometry` (SVG path data) + `viewBox`, usually a transparent
// fill and a `stroke` (often a thin or gradient decorative line). Rasterizing them
// to PNG loses thin strokes — a 1.5px line on a 1440px canvas nearly vanishes, so
// only the boldest of several overlaid lines survived — and isn't editable. Here we
// build a geometry-only SVG and let Figma create the vector, then style it with the
// node's OWN stroke/fill via our paint logic so gradients map through
// pencilGradientTransform exactly like every other gradient in the design. The
// stroke width/linecap/join go into the SVG (viewBox units) so they scale with the
// SCALE-constrained resize below; only the paint (solid/gradient) is overridden.
async function vectorFromPath(node: N): Promise<SceneNode> {
  const vbRaw = Array.isArray(node.viewBox) && node.viewBox.length === 4
    ? node.viewBox
    : [0, 0, sizingPx(node.width) || 100, sizingPx(node.height) || 100];
  const vx = Number(vbRaw[0]) || 0, vy = Number(vbRaw[1]) || 0;
  const vw = Number(vbRaw[2]) || 100, vh = Number(vbRaw[3]) || 100;
  // Path `d` never legitimately contains XML metacharacters; strip any just in case.
  const d = String(node.geometry || "").replace(/[<>&"]/g, " ");

  const sw = strokeWeights(node);
  const th = sw.max;
  const capSvg = ({ butt: "butt", round: "round", square: "square", none: "butt" } as Record<string, string>)[node.strokeLinecap] || "butt";
  const joinSvg = ({ miter: "miter", bevel: "bevel", round: "round" } as Record<string, string>)[node.strokeLinejoin] || "miter";
  const strokeSvg = th > 0
    ? `stroke="#000000" stroke-width="${th}" stroke-linecap="${capSvg}" stroke-linejoin="${joinSvg}"`
    : "";
  // fill-rule decides whether inner contours are holes or solid. Pencil defaults to
  // "nonzero"; an "evenodd" path (letterforms, ring logos, any shape with counters)
  // imported without it comes in as a filled-in blob.
  const ruleSvg = node.fillRule === "evenodd" ? ' fill-rule="evenodd"' : "";
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}"><path d="${d}" fill="none"${ruleSvg} ${strokeSvg}/></svg>`;
  svg = flipSvg(svg, node.flipX === true, node.flipY === true);
  const frame = figma.createNodeFromSvg(svg);

  const strokePaints = th > 0 ? await toPaints(node.stroke) : [];
  const fillPaints = await toPaints(node.fill);
  const capFig = ({ butt: "NONE", none: "NONE", round: "ROUND", square: "SQUARE" } as Record<string, StrokeCap>)[node.strokeLinecap];
  const joinFig = ({ miter: "MITER", bevel: "BEVEL", round: "ROUND" } as Record<string, StrokeJoin>)[node.strokeLinejoin];
  const alignFig = strokeAlignOf(node);
  eachSvgDescendant(frame, (c) => {
    if (c.type === "VECTOR") {
      const v = c as VectorNode;
      if (strokePaints.length) { try { v.strokes = strokePaints; } catch {} }
      if (capFig && "strokeCap" in v) { try { (v as any).strokeCap = capFig; } catch {} }
      if (joinFig && "strokeJoin" in v) { try { (v as any).strokeJoin = joinFig; } catch {} }
      if (alignFig) { try { v.strokeAlign = alignFig; } catch {} }
      // Path fill (often transparent → []); overrides the SVG's fill="none".
      try { v.fills = fillPaints; } catch {}
    }
    if ("constraints" in c) {
      try { (c as any).constraints = { horizontal: "SCALE", vertical: "SCALE" }; } catch {}
    }
  });
  const w = sizingPx(node.width) != null ? sizingPx(node.width)! : vw;
  const h = sizingPx(node.height) != null ? sizingPx(node.height)! : vh;
  if (w > 0 && h > 0) { try { frame.resize(w, h); } catch {} }
  try { frame.fills = []; } catch {}
  try { frame.clipsContent = false; } catch {}
  return frame;
}

// Stroke paint, width (uniform or per side), alignment, cap and join. Shared by
// fresh nodes and by layers inside a component instance.
async function applyStrokes(n: SceneNode, node: N): Promise<void> {
  if (!("strokes" in n) || node.stroke == null) return;
  // Pencil doesn't draw a stroke on text: the "Добавлять эффекты" wordmark in the
  // AI BAQYLAU brandbook carries a 2px #9CC0F5 stroke that Pencil's render simply
  // doesn't show, while Figma drew a light-blue outline around every glyph.
  if (n.type === "TEXT") {
    try { (n as TextNode).strokes = []; } catch {}
    return;
  }
  // `strokeWidth` is a number (uniform) OR an object with per-side values like
  // { bottom: 1 } — Pencil's CSS-border-style strokes, used for table rules and
  // panel dividers. Figma supports these via individual stroke weights, but
  // `strokeWeight` itself must be assigned a NUMBER first (it's the value used
  // when all sides agree); handing it the object fails validation outright.
  const sw = strokeWeights(node);

  if (sw.max <= 0) {
    // Zero total width means Pencil draws no stroke — leave the paint off
    // entirely. Assigning it and merely skipping the weight is NOT equivalent:
    // a fresh Figma frame starts at strokeWeight 1, so the paint alone would
    // still box the node on all four sides.
    try { (n as RectangleNode).strokes = []; } catch {}
  } else {
    // `stroke` is a Fills value (hex string, fill object, or an array of them).
    const sp = await toPaints(node.stroke);
    if (sp.length) (n as RectangleNode).strokes = sp;

    // Alignment first: Figma validates per-side weights against it, and INSIDE is
    // the only alignment that accepts them.
    const align = strokeAlignOf(node);
    if (align && "strokeAlign" in n) {
      try { (n as RectangleNode).strokeAlign = align; } catch {}
    }

    if (sw.perSide) {
      const rn = n as RectangleNode;
      try { rn.strokeWeight = sw.max; } catch {}
      try { if ("strokeTopWeight" in rn) rn.strokeTopWeight = sw.top; } catch {}
      try { if ("strokeRightWeight" in rn) rn.strokeRightWeight = sw.right; } catch {}
      try { if ("strokeBottomWeight" in rn) rn.strokeBottomWeight = sw.bottom; } catch {}
      try { if ("strokeLeftWeight" in rn) rn.strokeLeftWeight = sw.left; } catch {}
    } else {
      try { (n as RectangleNode).strokeWeight = sw.max; } catch {}
    }
  }

  const capFig = ({ butt: "NONE", none: "NONE", round: "ROUND", square: "SQUARE" } as Record<string, StrokeCap>)[node.strokeLinecap];
  if (capFig && "strokeCap" in n) { try { (n as any).strokeCap = capFig; } catch {} }
  const joinFig = ({ miter: "MITER", bevel: "BEVEL", round: "ROUND" } as Record<string, StrokeJoin>)[node.strokeLinejoin];
  if (joinFig && "strokeJoin" in n) { try { (n as any).strokeJoin = joinFig; } catch {} }
  
}

// ─── Node factories ───────────────────────────────────────────────────────────

async function createNode(node: N): Promise<SceneNode> {
  switch (node.type) {
    case "frame": return figma.createFrame();
    // A Pencil `group` only exists to nest and offset children — it has no size,
    // fill or layout of its own. A frame is the closest Figma container; leaving it
    // unclipped and transparent (see build()) keeps the children visible, and its
    // box is fitted to their bounds once they exist.
    case "group": return figma.createFrame();
    case "rectangle": return figma.createRectangle();
    case "ellipse": {
      const e = figma.createEllipse();
      // innerRadius (0 solid … 1 hollow) and startAngle/sweepAngle turn an ellipse
      // into a ring / pie / arc — the shape donut charts are built from. Figma keeps
      // all three in `arcData`, with angles in RADIANS measured clockwise, whereas
      // Pencil counts degrees counter-clockwise from 3 o'clock.
      const inner = typeof node.innerRadius === "number" ? node.innerRadius : 0;
      const startDeg = typeof node.startAngle === "number" ? node.startAngle : 0;
      const sweepDeg = typeof node.sweepAngle === "number" ? node.sweepAngle : 360;
      if (inner > 0 || startDeg !== 0 || Math.abs(sweepDeg) < 360) {
        const toRad = (d: number) => (-d * Math.PI) / 180; // flip CCW → CW
        const a = toRad(startDeg);
        const b = toRad(startDeg + sweepDeg);
        try {
          e.arcData = {
            startingAngle: Math.min(a, b),
            endingAngle: Math.max(a, b),
            innerRadius: Math.max(0, Math.min(1, inner)),
          };
        } catch (err: any) {
          console.error("[pencil-import] ellipse arcData failed:", err?.message || err);
        }
      }
      return e;
    }
    case "line": return figma.createLine();
    case "polygon": {
      const p = figma.createPolygon();
      if (typeof node.polygonCount === "number" && node.polygonCount >= 3) {
        try { p.pointCount = Math.round(node.polygonCount); } catch {}
      }
      return p;
    }
    // The schema has no `image` node type (images are fills), but Pencil's search
    // API lists one — accept it as a rectangle so the fill lands somewhere sane.
    case "image": return figma.createRectangle();
    // `script` generates its children from a JS file; by the time the tree reaches us
    // those children are already materialized, so the node just needs to be a
    // container. `connection` is a connector line with no Figma auto-layout analogue.
    case "script":
    case "connection": return figma.createFrame();
    case "path":
    case "vector": {
      // Preferred: build a REAL editable vector straight from the Pencil node's SVG
      // `geometry` + `viewBox` (see vectorFromPath). This reproduces every stroke
      // exactly — including thin/overlaid/gradient decorative lines that vanish when
      // rasterized — and keeps the shape editable. The bridge supplies `geometry`
      // (fetched with includePathGeometry).
      const geom = node.geometry;
      if (typeof geom === "string" && geom.length > 0 && geom !== "...") {
        try { return await vectorFromPath(node); }
        catch (e: any) { console.error("[pencil-import] path vector build failed:", e?.message || e); }
      }
      // Fallback: rasterized PNG from the bridge (`_rasterImage`) when geometry is
      // unavailable — render as a FIT image fill (paths are aspect-sensitive, so
      // FILL would crop). Last resort: an empty vector so the tree still nests.
      if (node._rasterImage) {
        const rect = figma.createRectangle();
        try {
          const bytes = base64ToBytes(node._rasterImage);
          const img = figma.createImage(bytes);
          rect.fills = [{ type: "IMAGE", imageHash: img.hash, scaleMode: "FIT" } as ImagePaint];
        } catch (e: any) {
          console.error("[pencil-import] path raster fill failed:", e?.message || e);
          rect.fills = [];
        }
        return rect;
      }
      return figma.createVector();
    }
    // Pencil's node type for a library glyph is `icon`:
    //   { type: "icon", library: "Material Symbols Rounded", icon: "space_dashboard",
    //     width: 20, height: 20, fill: "#FFFFFF" }
    // Only `icon_font` used to be handled here, so every real icon fell through to
    // the `default:` branch and became a plain frame — which then got painted with
    // the icon's own tint, turning each one into a solid coloured square.
    // There is no native Figma equivalent either way, so: the bridge resolves the
    // glyph's source SVG into `_iconSvg` and we import it as REAL editable vectors;
    // if a library or name can't be resolved, the bridge rasterizes it to PNG
    // (`_iconImage`) and we fall back to that.
    case "icon":
    case "icon_font": {
      const tint = iconTint(node.fill);
      if (node._iconSvg) {
        try {
          // Substitute the tint into the markup AND retint the imported vectors:
          // Material Symbols carry no `currentColor` to substitute, so the paint
          // has to be forced on the Figma side to cover every library.
          let svg = String(node._iconSvg).replace(/currentColor/g, tint.hex);
          svg = flipSvg(svg, node.flipX === true, node.flipY === true);
          const frame = vectorFromSvg(svg, node.width, node.height);
          tintIconVectors(frame, tint);
          frame.opacity = iconOpacity(node);
          return frame;
        } catch (e: any) {
          console.error("[pencil-import] icon svg import failed:", e?.message || e,
                        "-", node.library, node.icon);
        }
      }
      const rect = figma.createRectangle();
      if (node._iconImage) {
        try {
          const bytes = base64ToBytes(node._iconImage);
          const img = figma.createImage(bytes);
          rect.fills = [{ type: "IMAGE", imageHash: img.hash, scaleMode: "FIT" } as ImagePaint];
        } catch (e: any) {
          console.error("[pencil-import] icon raster fill failed:", e?.message || e);
          rect.fills = [];
        }
      } else {
        // Neither vector nor raster — leave the slot transparent. An unresolved
        // icon must never render as a coloured box; a missing glyph is far less
        // damaging to the layout than a solid square sitting in its place.
        console.warn("[pencil-import] unresolved icon:", node.library, node.icon);
        rect.fills = [];
      }
      return rect;
    }
    // `note` / `prompt` / `context` are annotation nodes: same TextStyle + content
    // as text, so they import as text rather than vanishing into a blank frame.
    case "text":
    case "note":
    case "prompt":
    case "context": {
      const txt = figma.createText();
      await applyTextProps(txt, node);
      // text fonts will get their textGrowth in applyChildSizing via layoutSizing
      return txt;
    }
    default:
      // Unknown type (`ref` never gets here — build() turns it into an instance).
      // Make a placeholder frame so the tree still nests, but say so — this is data
      // loss, and it used to happen completely silently.
      console.warn(
        "[pencil-import] unsupported node type:", node.type,
        node.type === "ref" ? `(unresolved instance of ${node.ref})` : "",
        node.name ? `— "${node.name}"` : ""
      );
      return figma.createFrame();
  }
}

// Font, content and every text style property. Shared by fresh text nodes and by
// text layers inside a component instance, where an override hands us the whole
// effective node (component value + override) — so this must set, not merge.
async function applyTextProps(txt: TextNode, node: N): Promise<void> {
  const family = node.fontFamily || "Inter";
  let style = weightToStyle(node.fontWeight);
  // Italic lives in the Figma font STYLE name, not a separate property.
  if (/^italic$/i.test(String(node.fontStyle || ""))) {
    style = style === "Regular" ? "Italic" : `${style} Italic`;
  }
  const f = await ensureFont(family, style);
  try { txt.fontName = (f.variationSettings ? f : { family: f.family, style: f.style }) as FontName; }
  catch { txt.fontName = { family: "Inter", style: "Regular" }; }
  if (node.fontSize != null) txt.fontSize = node.fontSize;
  txt.characters = String(node.content != null ? node.content : "");

  if (node.letterSpacing != null) {
    txt.letterSpacing = { value: node.letterSpacing, unit: "PIXELS" };
  }
  if (typeof node._lineHeightPx === "number" && node._lineHeightPx > 0) {
    // Pencil's line in whole px, as the bridge computed it (round(size × lineHeight),
    // or the font's own ratio when unset) — see annotateLineHeights. Neither a
    // percentage nor Figma's Auto reproduces Pencil's rounding.
    txt.lineHeight = { value: node._lineHeightPx, unit: "PIXELS" };
  } else if (node.lineHeight != null) {
    // Pencil uses unitless multiplier (e.g. 1.05). Figma needs PERCENT (105) or PIXELS.
    const lh = node.lineHeight;
    if (lh > 0 && lh < 5) {
      txt.lineHeight = { value: lh * 100, unit: "PERCENT" };
    } else {
      txt.lineHeight = { value: lh, unit: "PIXELS" };
    }
  }
  const ta: Record<string, "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED"> = {
    left: "LEFT", center: "CENTER", right: "RIGHT", justified: "JUSTIFIED", justify: "JUSTIFIED",
  };
  if (node.textAlign && ta[node.textAlign]) txt.textAlignHorizontal = ta[node.textAlign];
  const tav: Record<string, "TOP" | "CENTER" | "BOTTOM"> = {
    top: "TOP", center: "CENTER", middle: "CENTER", bottom: "BOTTOM",
  };
  if (node.textAlignVertical && tav[node.textAlignVertical]) txt.textAlignVertical = tav[node.textAlignVertical];
  const tc: Record<string, "ORIGINAL" | "UPPER" | "LOWER" | "TITLE"> = {
    none: "ORIGINAL", original: "ORIGINAL", upper: "UPPER", uppercase: "UPPER",
    lower: "LOWER", lowercase: "LOWER", title: "TITLE",
  };
  if (node.textCase && tc[node.textCase]) txt.textCase = tc[node.textCase];
  // Pencil expresses decoration as two booleans (`underline`, `strikethrough`),
  // not a single textDecoration string — reading only the string left every
  // underlined link and struck-through price rendering as plain text.
  const td: Record<string, "NONE" | "UNDERLINE" | "STRIKETHROUGH"> = {
    none: "NONE", underline: "UNDERLINE", strikethrough: "STRIKETHROUGH", "line-through": "STRIKETHROUGH",
  };
  if (node.underline === true) txt.textDecoration = "UNDERLINE";
  else if (node.strikethrough === true) txt.textDecoration = "STRIKETHROUGH";
  else if (node.textDecoration && td[node.textDecoration]) txt.textDecoration = td[node.textDecoration];

  const paints = await toPaints(node.fill);
  if (paints.length) txt.fills = paints;
}


// ─── Build (recursive) ────────────────────────────────────────────────────────

// Subtrees the bridge shipped unexpanded, collected so the import can report the
// loss instead of quietly rendering a partial design.
let truncatedNodes: string[] = [];

// Size a container to exactly cover its children. Used for `group`, which carries
// no width/height of its own — without this it stays at Figma's default 100x100.
function fitFrameToChildren(frame: FrameNode): void {
  const kids = frame.children;
  if (!kids.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of kids) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + c.width);
    maxY = Math.max(maxY, c.y + c.height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return;
  // Children are positioned relative to the frame's origin, so the box must start
  // at 0 unless a child actually sits at a negative offset.
  const shiftX = Math.min(minX, 0);
  const shiftY = Math.min(minY, 0);
  const w = Math.max(maxX, 0) - shiftX;
  const h = Math.max(maxY, 0) - shiftY;
  if (!(w > 0) || !(h > 0)) return;
  try {
    frame.resize(w, h);
    if (shiftX !== 0 || shiftY !== 0) {
      for (const c of kids) { c.x -= shiftX; c.y -= shiftY; }
      frame.x += shiftX;
      frame.y += shiftY;
    }
  } catch (e: any) {
    console.error("[pencil-import] group fit failed:", e?.message || e);
  }
}

// Mirror a node in place. Figma has no flip property — it's a negative scale in the
// node's relativeTransform — and that transform is ignored for a child in an
// auto-layout flow, which is why icons and paths bake the flip into their SVG
// instead (see flipSvg). This covers the remaining node types.
function applyFlip(n: SceneNode, fx: boolean, fy: boolean): void {
  if (!("relativeTransform" in n)) return;
  try {
    const t = (n as any).relativeTransform as number[][];
    const a = t[0][0], b = t[0][1], c = t[1][0], d = t[1][1];
    const w = n.width, h = n.height;
    // Negate the mirrored axis of the linear part, then translate by the mirrored
    // extent so the node's bounding box stays exactly where it was.
    const tx = t[0][2] + (fx ? a * w : 0) + (fy ? b * h : 0);
    const ty = t[1][2] + (fx ? c * w : 0) + (fy ? d * h : 0);
    (n as any).relativeTransform = [
      [fx ? -a : a, fy ? -b : b, tx],
      [fx ? -c : c, fy ? -d : d, ty],
    ];
  } catch (e: any) {
    console.warn("[pencil-import] could not flip", n.name, "-", e?.message || e);
  }
}

async function build(
  node: N,
  parent: BaseNode & ChildrenMixin
): Promise<SceneNode> {
  if (node.type === "ref") return buildInstance(node, parent);
  if (node.reusable === true && nestedPending.has(String(node.id))) return placeNestedDefinition(node, parent);

  const n = await createNode(node);
  parent.appendChild(n);
  builtPairs.push({ node, fig: n });

  if (node.name) n.name = String(node.name);
  // Pencil's visibility flag is `enabled` (Entity.enabled). It is also how an
  // instance override "deletes" a node from a component's subtree, so reading only
  // the Figma-style `visible` left hidden nodes — and every element a variant was
  // meant to remove — rendering on top of the design.
  if (node.enabled === false || node.visible === false) n.visible = false;

  // Pencil's `layoutPosition: "absolute"` takes the child out of the parent's
  // flex flow — Figma's equivalent is `layoutPositioning: "ABSOLUTE"`. This
  // MUST be set before x/y/resize: once Figma's auto-layout parent has flowed
  // a child in AUTO mode, the x/y we try to set afterwards are silently
  // ignored. Flip to ABSOLUTE first so the geometry below sticks.
  if (node.layoutPosition === "absolute" && "layoutPositioning" in n) {
    try { (n as any).layoutPositioning = "ABSOLUTE"; } catch {}
  }

  // Geometry. ONLY numeric width/height set fixed dimensions. String values like
  // "fill_container" / "fit_content" are deferred to applyChildSizing where they
  // become Figma layoutSizingHorizontal/Vertical (FILL/HUG). Calling resize() with
  // a fallback value here would force the text/frame into a tiny box and produce
  // the dreaded vertical-column-of-characters rendering bug.
  const wNum = sizingMode(node.width) === "FIXED" ? sizingPx(node.width) : null;
  const hNum = sizingMode(node.height) === "FIXED" ? sizingPx(node.height) : null;
  if ("resize" in n && (wNum !== null || hNum !== null)) {
    const targetW = wNum !== null ? wNum : n.width;
    const targetH = hNum !== null ? hNum : n.height;
    if (targetW > 0 && targetH > 0) {
      try { (n as FrameNode).resize(targetW, targetH); } catch {}
    }
  }
  if (node.x != null) n.x = node.x;
  if (node.y != null) n.y = node.y;
  if (node.rotation != null && "rotation" in n) {
    (n as RectangleNode).rotation = node.rotation;
  }
  // icon / path / vector already have the flip baked into their SVG geometry.
  const flipsInSvg = node.type === "path" || node.type === "vector" ||
                     node.type === "icon" || node.type === "icon_font";
  if ((node.flipX === true || node.flipY === true) && !flipsInSvg) {
    applyFlip(n, node.flipX === true, node.flipY === true);
  }

  // Fills (skip text — text fill is handled inside createNode;
  // skip icon_font — its fill is the icon tint, the actual paint is a
  // pre-tinted PNG image set inside createNode();
  // skip path/vector — createNode builds the real vector (or raster fallback) and
  // applies the node's own fill/stroke to the geometry itself; re-applying here
  // would paint the fill onto the wrapper/box instead of the shape.)
  const isPathVector = node.type === "path" || node.type === "vector";
  // Node types whose `fill` is NOT a background and must not be painted onto the box:
  //   text/note/prompt/context — the glyph colour, set on the TextNode in createNode
  //   icon / icon_font         — the glyph TINT, applied to the imported vectors.
  //                              Painting it here is what turned every icon into a
  //                              solid coloured square (white on the active menu
  //                              row, lavender on the rest).
  //   path / vector            — belongs to the geometry, applied in vectorFromPath
  //   group                    — has no fill in the schema at all
  const fillIsNotBackground =
    node.type === "text" || node.type === "note" || node.type === "prompt" ||
    node.type === "context" || node.type === "icon" || node.type === "icon_font" ||
    node.type === "group" || isPathVector;
  if (!fillIsNotBackground && "fills" in n) {
    const paints = await toPaints(node.fill);
    if (paints.length) {
      (n as RectangleNode).fills = paints;
    } else if (node._fillRaster) {
      // A fill Figma has no equivalent for (shader / mesh_gradient). The bridge asked
      // Pencil to render the node, so use that instead of dropping the artwork.
      try {
        const bytes = base64ToBytes(node._fillRaster);
        const img = figma.createImage(bytes);
        (n as RectangleNode).fills = [
          { type: "IMAGE", imageHash: img.hash, scaleMode: "FILL" } as ImagePaint,
        ];
      } catch (e: any) {
        console.error("[pencil-import] rasterized fill failed:", e?.message || e);
        (n as RectangleNode).fills = [];
      }
    } else {
      // No paints resolved. Two cases, both want a transparent node:
      //   • Pencil didn't specify a fill — make it transparent so the parent's
      //     color shows through. Otherwise figma.createFrame()/createRectangle()'s
      //     default fill would obscure the parent (e.g. white text inside an
      //     unfilled column over a dark purple Footer becomes invisible).
      //   • A fill WAS specified but produced nothing — an image fill that
      //     arrived without data (unfetchable/unembedded URL), a disabled fill,
      //     or an empty gradient. Leaving Figma's default light-gray rectangle
      //     fill in place would render a confusing gray placeholder box.
      (n as RectangleNode).fills = [];
    }
  }

  // Strokes — skip for path/vector nodes (isPathVector defined above). Their stroke
  // IS the geometry's outline (a wavy line, a curve) and is applied to the vector
  // itself inside createNode/vectorFromPath. Applying node.stroke here would draw it
  // on the node's bounding RECTANGLE instead — turning decorative hero lines into
  // hard box borders (purple→orange gradient frames).
  if (!isPathVector) await applyStrokes(n, node);

  if (node.cornerRadius != null) applyCornerRadius(n, node.cornerRadius);
  if (node.opacity != null && "opacity" in n) {
    // Icon frames already carry opacity × tint alpha (see tintIconVectors).
    (n as RectangleNode).opacity = isIconType(node) && n.type === "FRAME" ? iconOpacity(node) : node.opacity;
  }
  if (node.blendMode && blendMap[node.blendMode] && "blendMode" in n) {
    (n as RectangleNode).blendMode = blendMap[node.blendMode];
  }
  // Pencil's property is `effect` (singular, CanHaveEffects.effect); `effects` is
  // only accepted for older exported JSON.
  if (node.effect != null) applyEffects(n, node.effect);
  else if (node.effects != null) applyEffects(n, node.effects);
  // Pencil casts a path's shadow from its FILL. The neon lines and lightning bolts of
  // the VR Арена roll-up are stroke-only paths (fill #00000000) carrying a glow, and
  // Pencil draws them crisp, with no halo; Figma shadows the strokes too and wrapped
  // every line in a glow. An unfilled path casts no drop shadow, as in Pencil.
  if (isPathVector && "effects" in n && (n as FrameNode).effects.some((e) => e.type === "DROP_SHADOW")) {
    const fillPaints = await toPaints(node.fill);
    const filled = fillPaints.some((p) => p.visible !== false && (p.opacity == null || p.opacity > 0.001));
    if (!filled) (n as FrameNode).effects = (n as FrameNode).effects.filter((e) => e.type !== "DROP_SHADOW");
  }

  if (n.type === "FRAME") {
    // A `group` is a pure container: never clip it, and never give it a layout —
    // its children carry their own offsets.
    (n as FrameNode).clipsContent = node.type === "group" ? false : node.clip === true;
    if (node.type !== "group") applyAutoLayout(n as FrameNode, node);
  }

  // A truncated subtree. The bridge expands every "..." placeholder before it ships
  // the tree, so this should be unreachable — but silently treating it as "no
  // children" is exactly how large imports used to lose whole sections without a
  // single warning, so make it loud instead.
  if (node.children === "...") {
    console.error(
      `[pencil-import] TRUNCATED subtree at "${node.name || node.id}" — children were ` +
      `not expanded by the bridge; this part of the design is missing`
    );
    truncatedNodes.push(String(node.name || node.id));
  }

  // Children — recurse before sizing so child sizing context is valid
  if (Array.isArray(node.children) && "appendChild" in n) {
    for (const child of node.children) {
      await build(child, n as BaseNode & ChildrenMixin);
    }
  }

  // A Pencil group has no box of its own — fit the frame to its children so it
  // doesn't sit at Figma's default 100x100 and clip or mis-anchor them.
  if (node.type === "group" && n.type === "FRAME") fitFrameToChildren(n as FrameNode);

  // After everything is created and parented, apply auto-layout sizing rules
  // (must be after parent.layoutMode is set, and after this node has children)
  applyChildSizing(n, node);

  // x/y/rotation were set while this node still had Figma's default 100×100 box; a
  // hugging frame only reaches its real size now that its children exist. Figma
  // resizes a ROTATED node so that its axis-aligned bounding box keeps its top-left,
  // which drags the rotation pivot along — the 12° logo on "11 Недопустимо" (100×100
  // → 320×70) slid ~45px down and out of its clipped tile. Pencil pins x/y to the
  // pivot, i.e. the node's own top-left, so put it back now that the size is final.
  if (node.rotation && "rotation" in n) {
    if (node.x != null) n.x = node.x;
    if (node.y != null) n.y = node.y;
  }
  alignToPencilBox(n, node, parent);
  hideShadowUnderFill(n);
  emulateBoxShadow(n, node);

  return n;
}

// ─── Components ───────────────────────────────────────────────────────────────
//
// Components mode (bridge `components=1`, CLI `--components`): pages keep Pencil
// instances as `ref` nodes — `{type: "ref", ref: <component id>, descendants:
// {<layer id>: {…overridden props}}}` — and the reusable definitions arrive in a
// separate list. Definitions become Figma components first, then every ref becomes
// an instance with its overrides applied.
//
// Every ref also carries `_resolved`: the same instance as Pencil expands it. An
// override is partial (`{fontSize: 37}`) but Figma setters need the whole effective
// node, which `_resolved` holds under the id `<refId>/<layerId>`. Its tree mirrors
// the Figma instance layer for layer — build() makes exactly one Figma node per
// Pencil node, children in order — so an override's layer is found by index path.
//
// Figma doesn't take every Pencil override: it may refuse to move or resize a layer
// inside an instance. Geometry overrides are read back after applying; when Figma
// refuses one (throws, or silently keeps its value), that instance is removed and
// rebuilt detached from `_resolved` — exactly what the non-component import would
// produce — and the reason is counted for the report.

type ComponentEntry = { component: ComponentNode; wrapped: boolean };

// Pencil definition id → Figma component.
let components = new Map<string, ComponentEntry>();
// Figma ids of components whose Pencil root isn't frame-like (text, rectangle…):
// createComponentFromNode wraps such a node, so the Pencil node is the component's
// only child rather than the component itself.
let wrappedMains = new Set<string>();
// Definitions that sit INSIDE a frame in Pencil. They're built up front at the top
// level (instances need them before any page exists) and moved into place when the
// page's build reaches them.
let nestedPending = new Set<string>();
let buildingComponents = false;
let instanceStats = { linked: 0, scaled: 0, detached: 0, reasons: new Map<string, number>() };

// Override keys by how they're applied. Anything not listed can't be expressed as a
// Figma instance override (a swapped icon glyph, replaced children, new geometry)
// and sends the instance straight to the detached path.
const OV_IGNORE = new Set(["id", "name", "context", "metadata"]);
const OV_TEXT = new Set([
  "content", "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing",
  "lineHeight", "textAlign", "textAlignVertical", "textCase", "underline",
  "strikethrough", "textDecoration", "textGrowth",
]);
const OV_STROKE = new Set(["stroke", "strokeWidth", "strokeAlignment", "strokeLinecap", "strokeLinejoin"]);
const OV_LAYOUT = new Set(["layout", "gap", "padding", "justifyContent", "alignItems"]);
const OV_GEOMETRY = new Set(["x", "y", "width", "height", "rotation", "layoutPosition"]);
const OV_PAINT = new Set(["enabled", "visible", "opacity", "blendMode", "fill", "cornerRadius", "effect", "effects", "clip"]);
// Keys of the ref node itself that are handled outside applyOverride.
const REF_OWN_SKIP = new Set(["id", "type", "ref", "name", "descendants", "_resolved"]);

function overrideProblem(ov: N): string | null {
  if (!ov || typeof ov !== "object") return "malformed override";
  for (const k of Object.keys(ov)) {
    // `_box`, `_lineHeightPx`, `_iconSvg`… are the bridge's annotations, not overrides.
    if (k.startsWith("_")) continue;
    if (OV_IGNORE.has(k) || OV_TEXT.has(k) || OV_STROKE.has(k) || OV_LAYOUT.has(k) ||
        OV_GEOMETRY.has(k) || OV_PAINT.has(k)) continue;
    if (k === "descendants") {
      for (const v of Object.values(ov.descendants || {})) {
        const p = overrideProblem(v);
        if (p) return p;
      }
      continue;
    }
    if (k === "type" || k === "children") return "a layer is replaced inside the instance";
    return `"${k}" is overridden (no Figma instance equivalent)`;
  }
  return null;
}

function instanceProblem(node: N): string | null {
  const own: N = {};
  for (const k of Object.keys(node)) if (!REF_OWN_SKIP.has(k) && !k.startsWith("_")) own[k] = node[k];
  return overrideProblem(own) || overrideProblem({ descendants: node.descendants || {} });
}

function noteDetached(node: N, reason: string): void {
  instanceStats.detached++;
  instanceStats.reasons.set(reason, (instanceStats.reasons.get(reason) || 0) + 1);
  console.warn(`[pencil-import] "${node.name || node.id}" (instance of ${node.ref}) built detached: ${reason}`);
}

// Pencil id → {effective node, index path from the instance root}.
function indexResolved(root: N): Map<string, { node: N; path: number[] }> {
  const map = new Map<string, { node: N; path: number[] }>();
  (function walk(n: N, path: number[]) {
    if (!n || typeof n !== "object") return;
    if (n.id != null) map.set(String(n.id), { node: n, path });
    if (Array.isArray(n.children)) n.children.forEach((c: N, i: number) => walk(c, [...path, i]));
  })(root, []);
  return map;
}

async function unwrapLayer(n: SceneNode): Promise<SceneNode> {
  if (n.type !== "INSTANCE" || !wrappedMains.size) return n;
  const main = await (n as InstanceNode).getMainComponentAsync();
  const inst = n as InstanceNode;
  return main && wrappedMains.has(main.id) && inst.children.length ? inst.children[0] : n;
}

async function layerAt(root: SceneNode, path: number[]): Promise<SceneNode | null> {
  let t: SceneNode = root;
  for (const i of path) {
    if (!("children" in t)) return null;
    const kids = (t as FrameNode).children;
    if (i < 0 || i >= kids.length) return null;
    t = await unwrapLayer(kids[i]);
  }
  return t;
}

class OverrideRefused extends Error {}

function expectNear(what: string, prop: string, actual: number, want: any): void {
  if (typeof want !== "number" || !Number.isFinite(want)) return;
  if (Math.abs(actual - want) > 0.5) {
    console.warn(`[pencil-import] Figma kept ${prop}=${Math.round(actual * 100) / 100} on ${what}, Pencil has ${want}`);
    throw new OverrideRefused(`Figma won't override "${prop}" of a layer inside an instance`);
  }
}

async function applyFillOverride(target: SceneNode, merged: N): Promise<void> {
  const t = merged.type;
  if (t === "icon" || t === "icon_font") {
    tintIconVectors(target as any, iconTint(merged.fill));
    if ("opacity" in target) (target as FrameNode).opacity = iconOpacity(merged);
    return;
  }
  const paints = await toPaints(merged.fill);
  if (t === "path" || t === "vector") {
    eachSvgDescendant(target as any, (c) => { if (c.type === "VECTOR") (c as VectorNode).fills = paints; });
    return;
  }
  if ("fills" in target) (target as RectangleNode).fills = paints;
}

// Paths carry their stroke on the vectors inside the wrapper (see vectorFromPath),
// at the node's px width.
async function applyPathStrokeOverride(target: SceneNode, merged: N): Promise<void> {
  const th = strokeWeights(merged).max;
  const paints = th > 0 ? await toPaints(merged.stroke) : [];
  eachSvgDescendant(target as any, (c) => {
    if (c.type !== "VECTOR") return;
    const v = c as VectorNode;
    v.strokes = paints;
    if (th > 0) v.strokeWeight = th;
  });
}

// Only the layout properties that were overridden — re-running applyAutoLayout
// would also reassign layoutMode and sizing modes, which Figma may not accept on a
// layer inside an instance.
function applyLayoutOverride(f: FrameNode, merged: N, keys: string[], what: string): void {
  if (keys.includes("layout")) {
    const want = merged.layout === "vertical" ? "VERTICAL" : merged.layout === "none" ? "NONE" : "HORIZONTAL";
    if (f.layoutMode !== want) {
      f.layoutMode = want;
      if (f.layoutMode !== want) throw new OverrideRefused(`Figma won't change auto-layout direction inside an instance`);
    }
  }
  if (keys.includes("gap") && typeof merged.gap === "number") {
    f.itemSpacing = merged.gap;
    expectNear(what, "gap", f.itemSpacing, merged.gap);
  }
  if (keys.includes("padding")) {
    const p = expandPadding(merged.padding);
    f.paddingTop = p.top; f.paddingRight = p.right; f.paddingBottom = p.bottom; f.paddingLeft = p.left;
    expectNear(what, "padding", f.paddingTop, p.top);
    expectNear(what, "padding", f.paddingLeft, p.left);
  }
  if (keys.includes("justifyContent") && alignMap[merged.justifyContent]) {
    f.primaryAxisAlignItems = alignMap[merged.justifyContent];
  }
  if (keys.includes("alignItems") && alignMap[merged.alignItems] && alignMap[merged.alignItems] !== "SPACE_BETWEEN") {
    f.counterAxisAlignItems = alignMap[merged.alignItems] as "MIN" | "CENTER" | "MAX";
  }
}

// Everything except geometry, which waits until all of the instance's overrides are
// in (hug sizes depend on content). `merged` is the effective node, `ov` names what
// changed.
async function applyOverride(target: SceneNode, merged: N, ov: N, what: string): Promise<void> {
  const keys = Object.keys(ov).filter((k) => !OV_IGNORE.has(k) && k !== "descendants" && !k.startsWith("_"));
  const has = (set: Set<string>) => keys.some((k) => set.has(k));
  const t = merged.type;
  const isText = t === "text" || t === "note" || t === "prompt" || t === "context";

  if (keys.includes("enabled") || keys.includes("visible")) {
    target.visible = !(merged.enabled === false || merged.visible === false);
  }
  if (keys.includes("opacity") && "opacity" in target) {
    (target as FrameNode).opacity = isIconType(merged) ? iconOpacity(merged) : merged.opacity != null ? merged.opacity : 1;
  }
  if (keys.includes("blendMode") && merged.blendMode && blendMap[merged.blendMode] && "blendMode" in target) {
    (target as FrameNode).blendMode = blendMap[merged.blendMode];
  }
  if (isText && (has(OV_TEXT) || keys.includes("fill"))) {
    if (target.type !== "TEXT") throw new Error(`text override landed on a ${target.type}`);
    await applyTextProps(target as TextNode, merged);
  } else if (keys.includes("fill")) {
    await applyFillOverride(target, merged);
  }
  if (has(OV_STROKE)) {
    if (t === "path" || t === "vector") await applyPathStrokeOverride(target, merged);
    else await applyStrokes(target, merged);
  }
  if (keys.includes("cornerRadius")) applyCornerRadius(target, merged.cornerRadius);
  if (keys.includes("effect") || keys.includes("effects")) {
    applyEffects(target, merged.effect != null ? merged.effect : merged.effects != null ? merged.effects : []);
  }
  if (keys.includes("clip") && "clipsContent" in target) (target as FrameNode).clipsContent = merged.clip === true;
  if (has(OV_LAYOUT)) {
    if (!("itemSpacing" in target)) throw new Error(`layout override landed on a ${target.type}`);
    applyLayoutOverride(target as FrameNode, merged, keys, what);
  }
}

// `scaled`: the instance was scaled as a whole (buildScaledInstance), so sizes and
// positions can't be set — only checked.
async function applyGeometryOverride(target: SceneNode, merged: N, keys: string[], what: string, scaled = false): Promise<void> {
  if (scaled) {
    checkLayerGeometry(target, merged, what, keys.includes("x") || keys.includes("y"));
    return;
  }
  if (keys.includes("layoutPosition") && "layoutPositioning" in target) {
    (target as FrameNode).layoutPositioning = merged.layoutPosition === "absolute" ? "ABSOLUTE" : "AUTO";
  }
  if (keys.includes("width") || keys.includes("height")) {
    const t = merged.type;
    const wNum = sizingMode(merged.width) === "FIXED" ? sizingPx(merged.width) : null;
    const hNum = sizingMode(merged.height) === "FIXED" ? sizingPx(merged.height) : null;
    if ((t === "icon" || t === "icon_font") && wNum && hNum && "rescale" in target) {
      // Same reason as vectorFromSvg: only the Scale tool scales icon strokes.
      const k = Math.min(wNum / target.width, hNum / target.height);
      if (Number.isFinite(k) && k >= 0.01 && Math.abs(k - 1) > 1e-3) (target as FrameNode).rescale(k);
    } else {
      applyChildSizing(target, merged);
    }
    const isText = target.type === "TEXT";
    const growth = isText ? textAutoResizeFor(merged) : null;
    if (!isText || growth !== "WIDTH_AND_HEIGHT") expectNear(what, "width", target.width, wNum);
    if (!isText || growth === "NONE") expectNear(what, "height", target.height, hNum);
  }
  if (keys.includes("x") && typeof merged.x === "number") {
    target.x = merged.x;
    expectNear(what, "x", target.x, merged.x);
  }
  if (keys.includes("y") && typeof merged.y === "number") {
    target.y = merged.y;
    expectNear(what, "y", target.y, merged.y);
  }
  if (keys.includes("rotation") && typeof merged.rotation === "number" && "rotation" in target) {
    (target as FrameNode).rotation = merged.rotation;
  }
}

async function applyDescendantOverrides(
  root: SceneNode, index: Map<string, { node: N; path: number[] }>, refId: string,
  descendants: N, prefix: string, later: Array<() => Promise<void>>, scaled = false
): Promise<void> {
  for (const [key, ov] of Object.entries(descendants || {})) {
    const full = prefix + key;
    const hit = index.get(`${refId}/${full}`);
    if (!hit) throw new Error(`override target "${full}" is not in the resolved instance`);
    const layer = await layerAt(root, hit.path);
    if (!layer) throw new Error(`no Figma layer at the path of "${full}"`);
    const what = `"${hit.node.name || full}"`;
    await applyOverride(layer, hit.node, ov as N, what);
    const g = Object.keys(ov as N).filter((k) => OV_GEOMETRY.has(k));
    if (g.length) later.push(() => applyGeometryOverride(layer, hit.node, g, what, scaled));
    if ((ov as N).descendants) {
      await applyDescendantOverrides(root, index, refId, (ov as N).descendants, full + "/", later, scaled);
    }
  }
}

async function applyInstance(inst: InstanceNode, entry: ComponentEntry, node: N, scaled = false): Promise<void> {
  const resolved = node._resolved;
  if (!resolved || typeof resolved !== "object") throw new Error("the bridge sent no resolved copy of this instance");
  const index = indexResolved(resolved);
  const root: SceneNode = entry.wrapped && inst.children.length ? inst.children[0] : inst;

  if (node.name) inst.name = String(node.name);
  if (node.layoutPosition === "absolute") {
    try { inst.layoutPositioning = "ABSOLUTE"; } catch {}
  }

  const later: Array<() => Promise<void>> = [];
  await applyDescendantOverrides(root, index, String(node.id), node.descendants, "", later, scaled);

  const own: N = {};
  for (const k of Object.keys(node)) {
    if (!REF_OWN_SKIP.has(k) && !OV_GEOMETRY.has(k) && !k.startsWith("_")) own[k] = node[k];
  }
  await applyOverride(root, resolved, own, `"${node.name || node.id}"`);
  for (const g of later) await g();

  // The instance's own box, in build()'s order: size, then position and rotation.
  applyChildSizing(inst, resolved);
  if (node.rotation) inst.rotation = node.rotation;
  if (node.x != null) inst.x = node.x;
  if (node.y != null) inst.y = node.y;
  if (inst.parent) alignToPencilBox(inst, resolved, inst.parent as BaseNode & ChildrenMixin);
}

async function buildDetached(node: N, parent: BaseNode & ChildrenMixin, reason: string): Promise<SceneNode> {
  noteDetached(node, reason);
  if (node._resolved && typeof node._resolved === "object") return build(node._resolved, parent);
  const f = figma.createFrame();
  parent.appendChild(f);
  f.name = String(node.name || node.id || "instance");
  f.fills = [];
  return f;
}

async function buildInstance(node: N, parent: BaseNode & ChildrenMixin): Promise<SceneNode> {
  const entry = components.get(String(node.ref));
  if (!entry) return buildDetached(node, parent, "its component was not exported");
  const problem = instanceProblem(node);
  if (problem) return buildDetached(node, parent, problem);

  const inst = entry.component.createInstance();
  parent.appendChild(inst);
  try {
    await applyInstance(inst, entry, node);
    instanceStats.linked++;
    await recordInstancePairs(inst, entry, node._resolved);
    return inst;
  } catch (e: any) {
    try { inst.remove(); } catch {}
    if (e instanceof OverrideRefused) {
      const scaled = await buildScaledInstance(entry, node, parent);
      if (scaled) {
        instanceStats.linked++;
        instanceStats.scaled++;
        await recordInstancePairs(scaled, entry, node._resolved);
        return scaled;
      }
    }
    const reason = e instanceof OverrideRefused ? e.message : `override failed (${e?.message || e})`;
    return buildDetached(node, parent, reason);
  }
}

// ─── Scaled instances ─────────────────────────────────────────────────────────
// Figma refuses to resize or move a layer inside an instance, but it does scale a
// whole instance (the Scale tool). Most Pencil instances with resized layers are
// exactly that — a logo set at 0.92×: mark 69×70 instead of 74.9×76, type 37 instead
// of 40. So scale the instance by the one ratio its resized layers agree on (within
// 1%), put back everything the Scale tool changed that Pencil didn't — font sizes,
// letter spacing, gaps, paddings, stroke weights, radii, effects, all overridable —
// and keep it only if every fixed size and absolute position then matches Pencil.

async function buildScaledInstance(entry: ComponentEntry, node: N, parent: BaseNode & ChildrenMixin): Promise<InstanceNode | null> {
  const resolved = node._resolved;
  if (!resolved || typeof resolved !== "object") return null;
  const index = indexResolved(resolved);
  const refId = String(node.id);
  const inst = entry.component.createInstance();
  parent.appendChild(inst);
  const root: SceneNode = entry.wrapped && inst.children.length ? inst.children[0] : inst;
  try {
    const ratios: number[] = [];
    const collect = async (desc: N, prefix: string): Promise<void> => {
      for (const [key, ov] of Object.entries(desc || {})) {
        const o = ov as N;
        const full = prefix + key;
        const hit = index.get(`${refId}/${full}`);
        if (hit && (o.width !== undefined || o.height !== undefined)) {
          const layer = await layerAt(root, hit.path);
          const w = sizingMode(hit.node.width) === "FIXED" ? sizingPx(hit.node.width) : null;
          const h = sizingMode(hit.node.height) === "FIXED" ? sizingPx(hit.node.height) : null;
          if (layer && w && layer.width > 0) ratios.push(w / layer.width);
          if (layer && h && layer.height > 0) ratios.push(h / layer.height);
        }
        if (o.descendants) await collect(o.descendants, full + "/");
      }
    };
    await collect(node.descendants, "");
    if (!ratios.length) throw new Error("no resized layer to infer a scale from");
    ratios.sort((a, b) => a - b);
    const k = ratios[Math.floor(ratios.length / 2)];
    if (!(k >= 0.01) || ratios.some((r) => Math.abs(r / k - 1) > 0.01)) {
      throw new Error("the resized layers don't share one scale");
    }
    inst.rescale(k);
    await restoreAfterScale(root, resolved);
    await applyInstance(inst, entry, node, true);
    await verifyScaledGeometry(root, resolved, null);
    return inst;
  } catch (e: any) {
    console.warn(`[pencil-import] "${node.name || node.id}": scaling the instance didn't reproduce Pencil (${e?.message || e})`);
    try { inst.remove(); } catch {}
    return null;
  }
}

// Undo what the Scale tool did to everything Pencil kept at its own value.
async function restoreAfterScale(layer: SceneNode, n: N): Promise<void> {
  const t = n.type;
  if (t === "text" || t === "note" || t === "prompt" || t === "context") {
    if (layer.type === "TEXT") await applyTextProps(layer as TextNode, n);
  } else if (t === "path" || t === "vector") {
    if (n.stroke != null) await applyPathStrokeOverride(layer, n);
  } else if (!isIconType(n)) {
    if ("itemSpacing" in layer && (layer as FrameNode).layoutMode !== "NONE") {
      const f = layer as FrameNode;
      f.itemSpacing = typeof n.gap === "number" ? n.gap : 0;
      const p = expandPadding(n.padding);
      f.paddingTop = p.top; f.paddingRight = p.right; f.paddingBottom = p.bottom; f.paddingLeft = p.left;
    }
    if (n.stroke != null) await applyStrokes(layer, n);
    if ("cornerRadius" in layer) applyCornerRadius(layer, n.cornerRadius != null ? n.cornerRadius : 0);
    const fx = n.effect != null ? n.effect : n.effects;
    if ("effects" in layer && (fx != null || (layer as FrameNode).effects.length)) applyEffects(layer, fx != null ? fx : []);
  }
  if (Array.isArray(n.children) && "children" in layer) {
    const kids = (layer as FrameNode).children;
    for (let i = 0; i < n.children.length && i < kids.length; i++) {
      await restoreAfterScale(await unwrapLayer(kids[i]), n.children[i]);
    }
  }
}

function checkLayerGeometry(layer: SceneNode, n: N, what: string, position: boolean): void {
  const isText = layer.type === "TEXT";
  const growth = isText ? textAutoResizeFor(n) : null;
  const w = sizingMode(n.width) === "FIXED" ? sizingPx(n.width) : null;
  const h = sizingMode(n.height) === "FIXED" ? sizingPx(n.height) : null;
  if (w != null && (!isText || growth !== "WIDTH_AND_HEIGHT")) expectNear(what, "width", layer.width, w);
  if (h != null && (!isText || growth === "NONE")) expectNear(what, "height", layer.height, h);
  if (position) {
    if (typeof n.x === "number") expectNear(what, "x", layer.x, n.x);
    if (typeof n.y === "number") expectNear(what, "y", layer.y, n.y);
  }
}

// Every fixed size, and the position of every absolutely placed layer, must match.
async function verifyScaledGeometry(layer: SceneNode, n: N, parentLayout: string | null): Promise<void> {
  const absolute = parentLayout !== null && (n.layoutPosition === "absolute" || parentLayout === "none");
  checkLayerGeometry(layer, n, `"${n.name || n.id}"`, absolute);
  if (Array.isArray(n.children) && "children" in layer) {
    const kids = (layer as FrameNode).children;
    const lay = n.layout === "vertical" || n.layout === "horizontal" || n.layout === "none" ? n.layout : "horizontal";
    for (let i = 0; i < n.children.length && i < kids.length; i++) {
      await verifyScaledGeometry(await unwrapLayer(kids[i]), n.children[i], lay);
    }
  }
}

// ─── Layout check against Pencil ──────────────────────────────────────────────
// The bridge ships Pencil's own layout result with every node (`_box`: x, y, w, h in
// the parent's space). After each frame is built, every Figma layer is held against
// it. Two engines lay out text slightly differently (glyph advances differ by up to
// ~0.5%), which is invisible — until a line sits within a few px of its box and one
// engine wraps a word the other doesn't. That changes the line count, the text's
// height and everything laid out below it. When it happens, letter spacing is
// nudged by hundredths of a px until the line count matches Pencil's again. Any
// other size mismatch is reported, never papered over.

type Pair = { node: N; fig: SceneNode };
let builtPairs: Pair[] = [];
let pencilOf = new Map<string, N>(); // Figma node id → its Pencil node, during checkLayout
let layoutIssues: { frame: string; node: string; kind: string; detail: string }[] = [];
let textFixes = 0;
let trackingShifts = 0;
const MAX_ISSUES = 300;

function noteIssue(frame: string, node: N, kind: string, detail: string): void {
  if (layoutIssues.length >= MAX_ISSUES) return;
  layoutIssues.push({ frame, node: String(node.name || node.id), kind, detail });
}

async function recordInstancePairs(inst: InstanceNode, entry: ComponentEntry, resolved: N): Promise<void> {
  if (!resolved || typeof resolved !== "object") return;
  const root: SceneNode = entry.wrapped && inst.children.length ? inst.children[0] : inst;
  const walk = async (n: N, f: SceneNode): Promise<void> => {
    builtPairs.push({ node: n, fig: f });
    if (!Array.isArray(n.children) || !("children" in f)) return;
    const kids = (f as FrameNode).children;
    for (let i = 0; i < n.children.length && i < kids.length; i++) await walk(n.children[i], await unwrapLayer(kids[i]));
  };
  await walk(resolved, root);
}

// Figma takes a hidden layer out of its auto-layout flow, Pencil keeps laying it out:
// the ЭЦП tab of the login screen is switched off on that frame, and its text measured
// 64px wide in Figma against Pencil's 364. Nothing of it is on screen either way, so
// the layout checks skip anything with a hidden ancestor.
function isRendered(n: SceneNode): boolean {
  let cur: BaseNode | null = n;
  while (cur && cur.type !== "PAGE") {
    if ("visible" in cur && !(cur as SceneNode).visible) return false;
    cur = cur.parent;
  }
  return true;
}

function textLineHeightPx(t: TextNode): number {
  const fs = typeof t.fontSize === "number" ? t.fontSize : 16;
  const lh = t.lineHeight;
  if (lh === figma.mixed || !lh) return fs * 1.2;
  if (lh.unit === "PIXELS") return lh.value;
  if (lh.unit === "PERCENT") return (lh.value / 100) * fs;
  return fs * 1.2;
}

function letterSpacingPx(t: TextNode): number | null {
  const ls = t.letterSpacing;
  if (ls === figma.mixed) return null;
  const fs = typeof t.fontSize === "number" ? t.fontSize : 16;
  return ls.unit === "PIXELS" ? ls.value : (ls.value / 100) * fs;
}

// Auto-width text: the engines' glyph advances differ by up to ~0.5% (more for some
// fonts), so a label comes out a few px wider or narrower than in Pencil — and so
// does the button or table row that hugs it, shifting whatever sits next to it.
// Pencil's box width is exact, so spread the difference over the characters as
// letter spacing (typically a few hundredths of a px). Anything over 3% is not
// drift but a different font, and is reported instead.
function matchAutoWidth(frame: string, node: N, t: TextNode): void {
  const box = node._box;
  if (!Array.isArray(box) || !isRendered(t)) return;
  const pw = box[2];
  const n = t.characters.length;
  const base = letterSpacingPx(t);
  if (base == null || n < 1 || !(pw > 0)) return;
  const w0 = t.width;
  const diff = pw - w0;
  // Small, but not negligible: a row of three hug cards whose values each came out
  // 0.67px wider ("Параметры" on the master-class slides) ended 2px wider than Pencil.
  if (Math.abs(diff) <= 0.15) return;
  // Pencil counts the letter spacing after the LAST character into the text's width;
  // Figma doesn't. With tracking −4 every letter of the big "Kidlavie" (one text per
  // letter) came out 4px wider than in Pencil, 32px over the word. The glyphs are
  // identical — only the box differs by exactly the spacing — so give the text
  // Pencil's box and leave the letter alone. Single characters only: a fixed box that
  // is narrower than its content makes Figma WRAP, and "30 мин" / "4 000 ₸" lost
  // their last word to a second line when this ran on them.
  if (n === 1 && Math.abs(base) > 0.01 && Math.abs(diff - base) <= 0.6) {
    try {
      const h = t.height;
      t.textAutoResize = "NONE";
      t.resize(pw, h);
    } catch { /* leave it — compareBox reports the difference */ }
    return;
  }
  if (Math.abs(diff) > pw * 0.03 && Math.abs(diff) > 1.5) {
    noteIssue(frame, node, "text-width",
      `${Math.round(w0)}px wide in Figma, ${Math.round(pw)}px in Pencil — more than glyph drift, check the font`);
    return;
  }
  if (n < 2) return; // nothing to spread a drift over
  // Figma rounds an auto-width text box UP to a whole pixel: "30 мин" at 171.07px
  // reads 172, and a change of spacing that stays inside that pixel shows no effect
  // at all. So step until the box lands on Pencil's, each step worth the remaining
  // difference over the n−1 gaps the spacing applies to.
  let ls = base + diff / n;
  const limit = Math.abs(base) + pw * 0.03 / n;
  for (let i = 0; i < 6; i++) {
    t.letterSpacing = { value: +ls.toFixed(3), unit: "PIXELS" };
    const rest = pw - t.width;
    // A whole-pixel box can't get closer than half a pixel to a fractional one.
    if (Math.abs(rest) <= (Number.isInteger(t.width) ? 0.51 : 0.3)) return;
    const next = ls + rest / Math.max(1, n - 1);
    if (Math.abs(next) > limit) break;
    ls = next;
  }
  if (Math.abs(pw - t.width) > Math.abs(diff)) t.letterSpacing = { value: base, unit: "PIXELS" };
}

// Centred text with letter spacing: Figma draws every line `letterSpacing` px to
// the side of where Pencil draws it — the roll-up's "VR" (−10) sat 10px left, its
// "АРЕНА" (−6) 6px left, whatever the number of letters. Left-aligned text is not
// affected (the master-class cover title, −5, lands on the same pixel). The box is
// right, only the glyphs inside it move, so move the box by the opposite amount
// along its own x axis. Inside an auto-layout flow the position isn't ours to set.
function matchCenteredTracking(node: N, t: TextNode): void {
  if (t.textAlignHorizontal !== "CENTER" || t.textAutoResize === "WIDTH_AND_HEIGHT") return;
  const ls = Number(node.letterSpacing) || 0;
  if (Math.abs(ls) < 0.25 || t.letterSpacing === figma.mixed) return;
  const parent = t.parent;
  const inFlow = !!parent && "layoutMode" in parent && (parent as FrameNode).layoutMode !== "NONE" &&
    t.layoutPositioning !== "ABSOLUTE";
  if (inFlow) return;
  const m = t.relativeTransform;
  t.relativeTransform = [
    [m[0][0], m[0][1], m[0][2] - ls * m[0][0]],
    [m[1][0], m[1][1], m[1][2] - ls * m[1][0]],
  ];
  trackingShifts++;
}

// Wrapped text: Pencil breaks lines like a browser — a line fits when its words fit;
// the space after the last word doesn't count. Figma counts that trailing space, so a
// line within a space's width of the edge wraps one word earlier in Figma ("…объекта:
// люди," on the AI BAQYLAU mission slide: 793px of text in an 800px box, plus a 9px
// space). Re-run Pencil's rule with Figma's own measurements and, at each break where
// Figma would need the trailing space to fit, give that space zero advance. A space
// at the end of a line is invisible, so nothing on screen moves — the line just
// breaks where Pencil breaks it.
async function matchLineBreaks(frame: string, node: N, t: TextNode): Promise<void> {
  const box = node._box;
  if (!Array.isArray(box) || !isRendered(t)) return;
  const text = t.characters;
  if (!/\S\s+\S/.test(text)) return;
  const [, , pw, ph] = box;
  const lh = textLineHeightPx(t);
  if (ph < lh * 1.5 && t.height < lh * 1.5) return; // one line in both
  const W = t.width;
  if (Math.abs(W - pw) > 1) return; // the box itself differs — compareBox reports it
  const base = letterSpacingPx(t);
  if (base == null) return;

  let probe: TextNode | null = null;
  try {
    probe = t.clone();
    probe.x = -100000;
    probe.y = -100000;
    probe.textAutoResize = "WIDTH_AND_HEIGHT";
    const p = probe;
    const measure = (str: string): number => { p.characters = str; return p.width; };
    const spaceAdvance = measure("x x") - measure("xx");

    const breaks: Array<[number, number]> = [];
    let offset = 0;
    for (const para of text.split("\n")) {
      const words: Array<{ s: number; e: number }> = [];
      const re = /\S+/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(para))) words.push({ s: m.index, e: m.index + m[0].length });
      let i = 0;
      while (i < words.length) {
        let j = i;
        while (j + 1 < words.length && measure(para.slice(words[i].s, words[j + 1].e)) <= W + 0.01) j++;
        if (j + 1 < words.length && measure(para.slice(words[i].s, words[j + 1].s)) > W + 0.01) {
          breaks.push([offset + words[j].e, offset + words[j + 1].s]);
        }
        i = j + 1;
      }
      offset += para.length + 1;
    }
    if (!breaks.length) return;
    const zero = { value: +(base - spaceAdvance).toFixed(3), unit: "PIXELS" as const };
    for (const [a, b] of breaks) t.setRangeLetterSpacing(a, b, zero);
    textFixes++;
  } catch (e: any) {
    console.warn(`[pencil-import] line-break check failed for "${node.name || node.id}":`, e?.message || e);
  } finally {
    try { probe?.remove(); } catch {}
  }
}

async function fixTextLines(frame: string, node: N, t: TextNode): Promise<void> {
  const box = node._box;
  if (!Array.isArray(box) || t.removed || !isRendered(t)) return;
  const [, , pw, ph] = box;
  const lh = textLineHeightPx(t);
  if (Math.abs(t.height - ph) < lh * 0.5) return; // same number of lines
  if (t.textAutoResize !== "HEIGHT") {
    noteIssue(frame, node, "text-height", `Figma ${Math.round(t.height)}px tall, Pencil ${Math.round(ph)}px`);
    return;
  }
  if (Math.abs(t.width - pw) > 1) {
    noteIssue(frame, node, "text-box", `text box ${Math.round(t.width)}px wide in Figma, ${Math.round(pw)}px in Pencil`);
    return;
  }
  const fs = typeof t.fontSize === "number" ? t.fontSize : 16;
  const ls = t.letterSpacing;
  if (ls === figma.mixed) {
    // matchLineBreaks already re-broke this text; a uniform nudge would undo that.
    noteIssue(frame, node, "text-lines",
      `${Math.round(t.height / lh)} line(s) in Figma, ${Math.round(ph / lh)} in Pencil after matching Pencil's line breaks`);
    return;
  }
  const base = ls.unit === "PIXELS" ? ls.value : (ls.value / 100) * fs;
  const dir = t.height > ph ? -1 : 1;
  const step = fs * 0.004;
  for (let i = 1; i <= 8; i++) {
    t.letterSpacing = { value: +(base + dir * step * i).toFixed(3), unit: "PIXELS" };
    if (Math.abs(t.height - ph) < lh * 0.5) {
      textFixes++;
      return;
    }
  }
  t.letterSpacing = ls;
  noteIssue(frame, node, "text-lines",
    `${Math.round(t.height / lh)} line(s) in Figma, ${Math.round(ph / lh)} in Pencil — letter spacing within ±3% didn't fix it`);
}

// Figma and Pencil divide a row's space between "fill" children differently: Pencil
// splits it evenly — two 170px buttons in a 350px row — while Figma grows each child
// from its own content, so the same row came out 190 + 150. Where a fill child ends up
// a different size than Pencil gave it, pin that child to Pencil's size; the sibling
// that is still filling then lands on Pencil's size by itself.
let pinnedSizes = 0;

function pinFillToPencil(node: N, f: SceneNode): void {
  const box = node._box;
  if (!Array.isArray(box) || f.removed || f.type === "TEXT" || node.rotation || !isRendered(f)) return;
  if (!("layoutSizingHorizontal" in f) || !("resize" in f)) return;
  for (const axis of ["Horizontal", "Vertical"] as const) {
    const horizontal = axis === "Horizontal";
    const want = horizontal ? box[2] : box[3];
    const have = horizontal ? f.width : f.height;
    if (!(want > 0) || Math.abs(have - want) <= 1) continue;
    // Only the fill case: a hug that came out a different size means its CONTENT
    // differs, and forcing the box would hide that instead of reporting it.
    if (sizingMode(horizontal ? node.width : node.height) !== "FILL") continue;
    try {
      (f as any)["layoutSizing" + axis] = "FIXED";
      (f as FrameNode).resize(horizontal ? want : f.width, horizontal ? f.height : want);
      pinnedSizes++;
    } catch { /* not in an auto-layout parent after all */ }
  }
}

// A space_between row with more content than room: Pencil keeps the last child inside
// the row, so it overlaps the first — on the "112" app header the location pill and
// avatar sit over the end of the subtitle. Figma lets the row overflow instead, and
// the avatar was pushed off the screen and clipped. Same picture in Figma: pack the
// children from the start with Pencil's own (negative) spacing between them.
let negativeGaps = 0;

function fixOverflowingSpaceBetween(node: N, f: SceneNode): void {
  if (f.removed || !("primaryAxisAlignItems" in f) || !Array.isArray(node.children)) return;
  const fr = f as FrameNode;
  if (fr.layoutMode === "NONE" || fr.primaryAxisAlignItems !== "SPACE_BETWEEN" || !isRendered(fr)) return;
  const horizontal = fr.layoutMode === "HORIZONTAL";
  const kids = node.children
    .map((c: N, i: number) => ({ c, fig: fr.children[i] as SceneNode | undefined }))
    .filter((k: { c: N; fig?: SceneNode }) =>
      k.fig && k.fig.visible && k.c && Array.isArray(k.c._box) &&
      k.c.enabled !== false && k.c.visible !== false && k.c.layoutPosition !== "absolute");
  if (kids.length < 2) return;
  const gaps: number[] = [];
  for (let i = 1; i < kids.length; i++) {
    const a = kids[i - 1].c._box, b = kids[i].c._box;
    gaps.push(horizontal ? b[0] - (a[0] + a[2]) : b[1] - (a[1] + a[3]));
  }
  const g = gaps[0];
  // Only the overflow case, and only when Pencil spaced every child the same way.
  if (!(g < -0.5) || gaps.some((x) => Math.abs(x - g) > 0.5)) return;
  try {
    fr.primaryAxisAlignItems = "MIN";
    fr.itemSpacing = g;
    negativeGaps++;
  } catch { /* an instance layer that won't take it — compareBox reports what's left */ }
}

function compareBox(frame: string, node: N, f: SceneNode): void {
  const box = node._box;
  if (!Array.isArray(box) || f.removed || !isRendered(f) || node.rotation) return;
  const [, , pw, ph] = box;
  if (f.type === "TEXT") {
    const t = f as TextNode;
    const lh = textLineHeightPx(t);
    // Glyph advances differ by up to ~0.5% between the engines: not a layout error.
    if (Math.abs(t.width - pw) > Math.max(2, pw * 0.012)) {
      noteIssue(frame, node, "size", `width ${Math.round(t.width)} vs Pencil ${Math.round(pw)}`);
    } else if (Math.abs(t.height - ph) > 1 && Math.abs(t.height - ph) < lh * 0.5) {
      // Same number of lines, different box: Pencil grows the first line to the
      // font's own metrics when the line height is tighter than them, or when the
      // font has no glyph for the text and it falls back to another one.
      noteIssue(frame, node, "text-height", `${Math.round(t.height)}px tall in Figma, ${Math.round(ph)}px in Pencil`);
    }
    return;
  }
  if (Math.abs(f.width - pw) > 1 || Math.abs(f.height - ph) > 1) {
    noteIssue(frame, node, "size",
      `${Math.round(f.width * 10) / 10}×${Math.round(f.height * 10) / 10} vs Pencil ${Math.round(pw * 10) / 10}×${Math.round(ph * 10) / 10}` +
      childDrift(f));
  }
}

// Which children of a mis-sized box are off, and by how much — so a report says
// where a few px came from instead of only that they exist.
function childDrift(f: SceneNode, depth = 0): string {
  if (!("children" in f)) return "";
  const parts: string[] = [];
  const r = (v: number) => Math.round(v * 100) / 100;
  for (const c of (f as FrameNode).children) {
    const n = pencilOf.get(c.id);
    const b = n && n._box;
    if (!Array.isArray(b)) continue;
    const dw = c.width - b[2], dh = c.height - b[3];
    if (Math.abs(dw) < 0.05 && Math.abs(dh) < 0.05) continue;
    let what = `${n!.name || n!.id} ${dw >= 0 ? "+" : ""}${r(dw)}×${dh >= 0 ? "+" : ""}${r(dh)}`;
    if (c.type === "TEXT") {
      const t = c as TextNode;
      const ls = t.letterSpacing === figma.mixed ? "mixed" : r(letterSpacingPx(t) || 0);
      what += ` (text ${t.textAutoResize}, ls ${ls})`;
    }
    if (c.type !== "TEXT" && depth < 2) {
      const inner = childDrift(c, depth + 1);
      if (inner) what += ` [${inner.slice(2)}]`;
    }
    parts.push(what);
    if (parts.length >= 4) break;
  }
  return parts.length ? `: ${parts.join("; ")}` : "";
}

async function checkLayout(frame: string): Promise<void> {
  const pairs = builtPairs;
  builtPairs = [];
  pencilOf = new Map(pairs.map((p) => [p.fig.id, p.node] as [string, N]));
  // Text first: a line that wraps differently resizes everything around it.
  const texts = pairs.filter((p) => p.fig.type === "TEXT" && !p.fig.removed && Array.isArray(p.node._box));
  for (const { node, fig } of texts) {
    const t = fig as TextNode;
    try {
      if (t.textAutoResize === "WIDTH_AND_HEIGHT") matchAutoWidth(frame, node, t);
      else if (t.textAutoResize === "HEIGHT") await matchLineBreaks(frame, node, t);
      await fixTextLines(frame, node, t);
      matchCenteredTracking(node, t);
    } catch (e: any) {
      console.warn("[pencil-import] text check failed:", e?.message || e);
    }
  }
  // Parents before children (build order), so a row is the right size before its
  // children are measured against Pencil.
  for (const { node, fig } of pairs) {
    try { pinFillToPencil(node, fig); } catch {}
  }
  for (const { node, fig } of pairs) {
    try { fixOverflowingSpaceBetween(node, fig); } catch {}
  }
  for (const { node, fig } of pairs) {
    try { compareBox(frame, node, fig); } catch {}
  }
}

// Text layers of a frame in its own coordinate space — the 1:1 check gives these
// regions extra horizontal slack for the engines' glyph-advance drift.
function textBoxesOf(frame: SceneNode): number[][] {
  const fb = frame.absoluteBoundingBox;
  if (!fb || !("findAllWithCriteria" in frame)) return [];
  const out: number[][] = [];
  for (const t of (frame as FrameNode).findAllWithCriteria({ types: ["TEXT"] })) {
    const b = t.absoluteBoundingBox;
    if (!b || !t.visible) continue;
    out.push([Math.round(b.x - fb.x), Math.round(b.y - fb.y), Math.round(b.width), Math.round(b.height)]);
  }
  return out;
}

// Reached a definition that lives inside a frame: move its component here.
function placeNestedDefinition(node: N, parent: BaseNode & ChildrenMixin): SceneNode {
  const entry = components.get(String(node.id))!;
  // A main component can't sit inside another main component — while definitions
  // are being built, use an instance and leave the definition at the top level.
  const n: ComponentNode | InstanceNode = buildingComponents ? entry.component.createInstance() : entry.component;
  parent.appendChild(n);
  if (!buildingComponents) nestedPending.delete(String(node.id));
  if (node.layoutPosition === "absolute") {
    try { n.layoutPositioning = "ABSOLUTE"; } catch {}
  }
  applyChildSizing(n, node);
  if (node.rotation) n.rotation = node.rotation;
  if (node.x != null) n.x = node.x;
  if (node.y != null) n.y = node.y;
  return n;
}

// Dependencies first: a definition that contains an instance of (or the definition
// of) another component needs that component to exist.
function orderDefinitions(defs: N[]): N[] {
  const byId = new Map<string, N>(defs.map((d) => [String(d.id), d]));
  const deps = (d: N): Set<string> => {
    const out = new Set<string>();
    (function walk(n: N, isRoot: boolean) {
      if (!n || typeof n !== "object") return;
      if (!isRoot && n.reusable === true && n.id != null) out.add(String(n.id));
      if (n.type === "ref" && n.ref != null) out.add(String(n.ref));
      if (Array.isArray(n.children)) n.children.forEach((c: N) => walk(c, false));
    })(d, true);
    return out;
  };
  const done = new Set<string>();
  const visiting = new Set<string>();
  const order: N[] = [];
  const visit = (id: string) => {
    if (done.has(id) || visiting.has(id)) return;
    const d = byId.get(id);
    if (!d) return;
    visiting.add(id);
    for (const dep of deps(d)) visit(dep);
    visiting.delete(id);
    done.add(id);
    order.push(d);
  };
  for (const d of defs) visit(String(d.id));
  return order;
}

async function buildComponent(def: N, parent: BaseNode & ChildrenMixin): Promise<ComponentNode> {
  const built = await build(def, parent);
  const comp = figma.createComponentFromNode(built);
  const wrapped = !built.removed && built.parent != null && built.parent.id === comp.id;
  if (wrapped && "constraints" in built) {
    // The component box IS the node's box; let the node follow when an instance is resized.
    try { (built as any).constraints = { horizontal: "STRETCH", vertical: "STRETCH" }; } catch {}
  }
  if (def.name) comp.name = String(def.name);
  components.set(String(def.id), { component: comp, wrapped });
  if (wrapped) wrappedMains.add(comp.id);
  return comp;
}

// A filled box's shadow in Pencil is a CSS box-shadow: nothing of it is drawn under
// the box. Figma, left to itself, shows it through a translucent fill — the roll-up's
// 90%-opaque "Билеты" card came out tinted red by its own glow. Only for filled
// shapes: on an unfilled frame "behind the node" means the whole transparent box,
// and the glow its content casts (see emulateBoxShadow) would vanish.
const BOX_SHADOW_TYPES = new Set(["FRAME", "COMPONENT", "RECTANGLE", "ELLIPSE", "POLYGON", "STAR"]);

function hasVisibleFill(n: SceneNode): boolean {
  if (!("fills" in n)) return false;
  const fills = (n as GeometryMixin).fills;
  if (fills === figma.mixed) return true;
  return (fills as readonly Paint[]).some((p) => p.visible !== false && (p.opacity == null || p.opacity > 0.001));
}

function hideShadowUnderFill(n: SceneNode): void {
  if (!BOX_SHADOW_TYPES.has(n.type) || !("effects" in n)) return;
  const f = n as FrameNode;
  if (!f.effects.some((e) => e.type === "DROP_SHADOW") || !hasVisibleFill(n)) return;
  try {
    f.effects = f.effects.map((e) =>
      e.type === "DROP_SHADOW" ? ({ ...e, showShadowBehindNode: false } as Effect) : e);
  } catch {}
}

// An UNFILLED frame's outer shadow in Pencil is two things at once: a box-shadow
// around the frame's box, and a glow cast by its content. The VR Арена roll-up wraps
// its neon lettering in transparent 850×760 frames with blue and pink glows: Pencil
// draws a glowing band under each frame's bottom edge AND a wide halo around every
// letter (its fall-off fits the frame's own blur 22 + blur 60 on top of the letters'
// shadows). Figma derives a frame's shadow from its content only — the halo is
// there, the band isn't. So the frame keeps its shadows, and the band comes from a
// box-shaped caster masked to the outside of the box, placed right beneath the frame
// in its parent (inside the frame its band would cast the frame's shadow again).
function emulateBoxShadow(n: SceneNode, node: N): void {
  if (n.type !== "FRAME" || node.type !== "frame") return;
  const f = n as FrameNode;
  const shadows = f.effects.filter((e) => e.type === "DROP_SHADOW" && e.visible !== false) as DropShadowEffect[];
  if (!shadows.length || f.clipsContent) return; // a clipping frame would cut its own shadow off
  if (hasVisibleFill(f)) return; // a filled frame already casts a box-shaped shadow in Figma
  const parent = f.parent;
  if (!parent || !("insertChild" in parent) || parent.type === "INSTANCE") return;
  const w = f.width, h = f.height;
  if (!(w > 0 && h > 0)) return;
  const margin = Math.ceil(Math.max(...shadows.map((e) =>
    e.radius * 2 + Math.max(Math.abs(e.offset.x), Math.abs(e.offset.y)) + Math.abs(e.spread || 0)))) + 2;
  const radius = typeof f.cornerRadius === "number" ? f.cornerRadius : 0;
  const made: SceneNode[] = [];
  try {
    // Built inside the frame (its coordinate space, nothing else there moves when
    // layoutMode is NONE — absolute otherwise), then moved out as one group.
    const auto = f.layoutMode !== "NONE";
    const place = (r: SceneNode, x: number, y: number) => {
      if (auto) { try { (r as any).layoutPositioning = "ABSOLUTE"; } catch {} }
      r.x = x;
      r.y = y;
    };
    const outer = figma.createRectangle(); f.appendChild(outer); made.push(outer);
    place(outer, -margin, -margin);
    outer.resize(w + 2 * margin, h + 2 * margin);
    const hole = figma.createRectangle(); f.appendChild(hole); made.push(hole);
    place(hole, 0, 0);
    hole.resize(w, h);
    hole.cornerRadius = radius;
    const ring = figma.subtract([outer, hole], f);
    made.length = 0; made.push(ring);
    ring.isMask = true;
    const caster = figma.createRectangle(); f.appendChild(caster); made.push(caster);
    place(caster, 0, 0);
    caster.resize(w, h);
    caster.cornerRadius = radius;
    caster.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
    caster.effects = shadows;
    const group = figma.group([ring, caster], f);
    made.length = 0; made.push(group);
    group.name = "Тень по рамке";
    const p = parent as BaseNode & ChildrenMixin;
    p.insertChild(p.children.indexOf(f), group);
    if ("layoutMode" in p && (p as FrameNode).layoutMode !== "NONE") {
      try { (group as any).layoutPositioning = "ABSOLUTE"; } catch {}
    }
    // Frame-local (−margin, −margin), whatever the frame's rotation.
    const m = f.relativeTransform;
    group.relativeTransform = [
      [m[0][0], m[0][1], m[0][2] - margin * (m[0][0] + m[0][1])],
      [m[1][0], m[1][1], m[1][2] - margin * (m[1][0] + m[1][1])],
    ];
  } catch (e: any) {
    for (const m of made) { try { m.remove(); } catch {} }
    console.warn(`[pencil-import] box shadow for "${node.name || node.id}" left as a content shadow:`, e?.message || e);
  }
}

// Put the node exactly where Pencil put it, using Pencil's own layout result.
//
// Flips are why this exists: Pencil mirrors a node about its left/top edge, so a
// flipped node occupies [x−w, x], while Figma's mirror leaves the box where it was.
// The "Планета со звездой" on the K-POP booking slide (x 1290, flipX) landed 643px to
// the right of where Pencil draws it — outside the clipped 1080px frame, invisible.
// Rotated nodes are skipped: Pencil reports their axis-aligned bounds, which is not
// what Figma's x/y mean.
function alignToPencilBox(n: SceneNode, node: N, parent: BaseNode & ChildrenMixin): void {
  const box = node._box;
  if (!Array.isArray(box) || node.rotation || !("absoluteBoundingBox" in n)) return;
  if (!("absoluteBoundingBox" in parent)) return;
  const pb = (parent as FrameNode).absoluteBoundingBox;
  const nb = (n as FrameNode).absoluteBoundingBox;
  if (!pb || !nb) return;
  const dx = box[0] - (nb.x - pb.x);
  const dy = box[1] - (nb.y - pb.y);
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;
  try {
    n.x += dx;
    n.y += dy;
  } catch { /* a child of an auto-layout frame is placed by the parent */ }
}

// ─── Counting / progress ──────────────────────────────────────────────────────

function countNodes(t: N): number {
  let c = 1;
  if (Array.isArray(t.children)) for (const ch of t.children) c += countNodes(ch);
  return c;
}

// ─── Diagnostics ──────────────────────────────────────────────────────────────
// Everything the import warns about also goes into the 1:1 report the bridge saves,
// so a problem can be traced without anyone opening the plugin console.
let pluginLog: string[] = [];
const MAX_LOG = 600;
for (const level of ["warn", "error"] as const) {
  const orig = console[level].bind(console);
  try {
    console[level] = (...args: any[]) => {
      if (pluginLog.length < MAX_LOG) {
        pluginLog.push(`${level}: ` + args.map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" "));
      }
      orig(...args);
    };
  } catch { /* console not writable — the report just has no log */ }
}

// ─── UI bridge ────────────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg: any) => {
  if (msg.type !== "import") return;
  let tree = msg.tree;
  let defs: N[] = Array.isArray(msg.components) ? msg.components : [];
  // A design.json exported with --components wraps both lists: { tree, components }.
  if (tree && !Array.isArray(tree) && tree.type == null && tree.tree != null) {
    if (Array.isArray(tree.components)) defs = tree.components;
    tree = tree.tree;
  }
  const opts = msg.opts || {};

  try {
    truncatedNodes = [];
    fontFallbacks = new Map();
    components = new Map();
    wrappedMains = new Set();
    nestedPending = new Set();
    buildingComponents = false;
    instanceStats = { linked: 0, scaled: 0, detached: 0, reasons: new Map() };
    pinnedSizes = 0;
    negativeGaps = 0;
    builtPairs = [];
    layoutIssues = [];
    textFixes = 0;
    trackingShifts = 0;
    pluginLog = [];
    const roots: N[] = Array.isArray(tree) ? tree : [tree];
    const count = roots.reduce((s: number, r: N) => s + countNodes(r), 0) +
                  defs.reduce((s: number, r: N) => s + countNodes(r), 0);
    figma.ui.postMessage({ type: "progress", text: `Creating ${count} nodes…` });

    let parent: BaseNode & ChildrenMixin = figma.currentPage;
    let wrapper: FrameNode | null = null;

    if (opts.frameWrap) {
      const w = figma.createFrame();
      w.name = "Pencil Import";
      w.clipsContent = false;
      w.fills = [];
      // Plain frame (no auto-layout) — children keep their absolute (x, y) from
      // Pencil's canvas, preserving the original 2D arrangement of pages.
      figma.currentPage.appendChild(w);
      wrapper = w;
      parent = w;
    }

    // Components before pages: every instance needs its main component to exist.
    const topComponents: SceneNode[] = [];
    if (defs.length) {
      figma.ui.postMessage({ type: "progress", text: `Creating ${defs.length} components…` });
      buildingComponents = true;
      try {
        for (const def of orderDefinitions(defs)) {
          try {
            const comp = await buildComponent(def, parent);
            await checkLayout(String(def.name || def.id));
            if (def._topLevel === false) nestedPending.add(String(def.id));
            else topComponents.push(comp);
          } catch (e: any) {
            console.error(`[pencil-import] component "${def.name || def.id}" failed:`, e?.message || e);
          }
        }
      } finally {
        buildingComponents = false;
      }
      figma.ui.postMessage({ type: "progress", text: `Creating ${count} nodes…` });
    }

    const created: SceneNode[] = [];
    const pages: Array<{ root: N; fig: SceneNode }> = [];
    for (const root of roots) {
      builtPairs = [];
      const node = await build(root, parent);
      created.push(node);
      pages.push({ root, fig: node });
      await checkLayout(String(root.name || root.id));
    }
    // Nested definitions the pages never reached stay where they were built.
    for (const id of nestedPending) {
      const e = components.get(id);
      if (e) topComponents.push(e.component);
    }
    created.push(...topComponents);

    // Shift the imported pages so they don't sit at Pencil's arbitrary canvas
    // coordinates (some pages start at y=10116, which would leave a huge empty
    // gap in the Figma file). In both modes — with or without a wrapper — we
    // want the imported pages to start near (0, 0) and be clustered together.
    const minX = Math.min(...created.map((c) => c.x));
    const minY = Math.min(...created.map((c) => c.y));
    const maxX = Math.max(...created.map((c) => c.x + c.width));
    const maxY = Math.max(...created.map((c) => c.y + c.height));

    if (wrapper) {
      wrapper.x = 0;
      wrapper.y = 0;
      wrapper.resize(Math.max(1, maxX - minX), Math.max(1, maxY - minY));
      for (const c of created) {
        c.x -= minX;
        c.y -= minY;
      }
    } else {
      // No wrapper — find empty space on the page (right of existing content)
      // and shift the imported cluster there.
      let baseX = 0, baseY = 0;
      const existing = figma.currentPage.children.filter((n) => !created.includes(n));
      if (existing.length) {
        baseX = Math.max(...existing.map((n) => n.x + n.width)) + 100;
        baseY = 0;
      }
      for (const c of created) {
        c.x = c.x - minX + baseX;
        c.y = c.y - minY + baseY;
      }
    }

    if (opts.centerView !== false) {
      figma.viewport.scrollAndZoomIntoView(wrapper ? [wrapper] : created);
    }
    figma.currentPage.selection = wrapper ? [wrapper] : created;

    const fontIssues: string[] = [];
    fontFallbacks.forEach((used, asked) => fontIssues.push(`${asked} → ${used}`));
    if (fontIssues.length) {
      console.warn(
        `[pencil-import] ${fontIssues.length} font(s) were substituted — install them in Figma ` +
        `for a 1:1 result:\n  ` + fontIssues.join("\n  ")
      );
    }

    if (layoutIssues.length || textFixes || pinnedSizes) {
      console.log(
        `[pencil-import] layout vs Pencil: ${textFixes} text wrap(s) corrected, ${pinnedSizes} fill size(s) pinned, ${layoutIssues.length} mismatch(es)` +
        (layoutIssues.length ? ":\n  " + layoutIssues.slice(0, 40).map((i) => `${i.frame} › ${i.node}: ${i.kind} — ${i.detail}`).join("\n  ") : "")
      );
    }

    const detachReasons: string[] = [];
    instanceStats.reasons.forEach((n, why) => detachReasons.push(`${n}× ${why}`));
    const componentSummary = components.size
      ? { components: components.size, linked: instanceStats.linked, scaled: instanceStats.scaled, detached: instanceStats.detached, reasons: detachReasons }
      : null;
    if (componentSummary) {
      console.log(
        `[pencil-import] ${components.size} component(s), ${instanceStats.linked} linked instance(s), ` +
        `${instanceStats.detached} detached` + (detachReasons.length ? `:\n  ` + detachReasons.join("\n  ") : "")
      );
    }

    figma.ui.postMessage({
      type: "done",
      count,
      truncated: truncatedNodes.length,
      fontFallbacks: fontIssues,
      components: componentSummary,
      textFixes,
      layoutIssues: layoutIssues.length,
      verifying: !!(msg.session && opts.verify !== false),
    });

    // 1:1 check: render every imported frame and hand the PNGs to the UI, which posts
    // them to the bridge together with Pencil's renders of the same frames.
    if (msg.session && opts.verify !== false) {
      figma.ui.postMessage({ type: "progress", text: `Checking ${pages.length} frame(s) against Pencil…` });
      for (const { root, fig } of pages) {
        if (fig.removed || !("exportAsync" in fig)) continue;
        try {
          const bytes = await (fig as FrameNode).exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
          figma.ui.postMessage({ type: "render", id: String(root.id), name: String(root.name || root.id), bytes, texts: textBoxesOf(fig) });
        } catch (e: any) {
          console.warn(`[pencil-import] could not render "${root.name}" for the 1:1 check:`, e?.message || e);
        }
      }
      figma.ui.postMessage({
        type: "renders-done",
        issues: layoutIssues,
        diagnostics: {
          nodes: count,
          components: componentSummary,
          textFixes,
          trackingShifts,
          pinnedSizes,
          negativeGaps,
          fontFallbacks: fontIssues,
          truncated: truncatedNodes,
          log: pluginLog,
        },
      });
    }
    if (truncatedNodes.length) {
      // Never let an incomplete import look like a clean one.
      const names = truncatedNodes.slice(0, 3).join(", ");
      figma.notify(
        `Imported ${count} nodes, but ${truncatedNodes.length} subtree(s) were incomplete (${names}${truncatedNodes.length > 3 ? "…" : ""}). Check the bridge log.`,
        { error: true, timeout: 8000 }
      );
    } else if (fontIssues.length) {
      figma.notify(
        `Imported ${count} nodes. ${fontIssues.length} font(s) substituted: ${fontIssues.slice(0, 2).join(", ")}${fontIssues.length > 2 ? "…" : ""} — see console.`,
        { timeout: 8000 }
      );
    } else if (componentSummary) {
      figma.notify(
        `Imported ${count} nodes: ${componentSummary.components} components, ${componentSummary.linked} instances` +
        (componentSummary.detached ? `, ${componentSummary.detached} detached — see console` : ""),
        { timeout: 8000 }
      );
    } else {
      figma.notify(`Pencil → Figma: imported ${count} nodes`);
    }
  } catch (e: any) {
    console.error(e);
    figma.ui.postMessage({ type: "error", error: e?.message || String(e) });
    figma.notify("Import failed: " + (e?.message || e), { error: true });
  }
};
