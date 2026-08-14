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

async function ensureFont(family: string, style: string): Promise<{ family: string; style: string }> {
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
  // Right family, wrong weight — the typeface survives, the weight doesn't.
  try {
    await figma.loadFontAsync({ family, style: "Regular" });
    fontCache.add(`${family}|Regular`);
    fontFallbacks.set(`${family} ${style}`, `${family} Regular`);
    return { family, style: "Regular" };
  } catch {
    // Family missing entirely.
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    fontCache.add("Inter|Regular");
    fontFallbacks.set(`${family} ${style}`, "Inter Regular");
    return { family: "Inter", style: "Regular" };
  }
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
      list.push({
        type: inner ? "INNER_SHADOW" : "DROP_SHADOW",
        color: { ...rgb, a: e.opacity != null ? e.opacity : a },
        offset: { x: offX, y: offY },
        radius: blurRadius,
        spread: e.spread || 0,
        visible: true,
        blendMode: "NORMAL",
      });
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
function tintIconVectors(frame: FrameNode, tint: { hex: string; alpha: number }): void {
  const { rgb } = parseColor(tint.hex);
  const paint: SolidPaint = { type: "SOLID", color: rgb, opacity: tint.alpha };
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

// Build a real vector node from an SVG string and scale it to the Pencil node's
// box. figma.createNodeFromSvg() returns a FRAME wrapping the imported vectors;
// setting each child's constraints to SCALE means resizing the frame scales the
// geometry (and stroke weights) instead of clipping or anchoring it.
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
    try { frame.resize(wNum, hNum); } catch {}
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
      const family = node.fontFamily || "Inter";
      let style = weightToStyle(node.fontWeight);
      // Italic lives in the Figma font STYLE name, not a separate property.
      if (/^italic$/i.test(String(node.fontStyle || ""))) {
        style = style === "Regular" ? "Italic" : `${style} Italic`;
      }
      const f = await ensureFont(family, style);
      const txt = figma.createText();
      try { txt.fontName = { family: f.family, style: f.style }; }
      catch { txt.fontName = { family: "Inter", style: "Regular" }; }
      if (node.fontSize != null) txt.fontSize = node.fontSize;
      txt.characters = String(node.content != null ? node.content : "");

      if (node.letterSpacing != null) {
        txt.letterSpacing = { value: node.letterSpacing, unit: "PIXELS" };
      }
      if (node.lineHeight != null) {
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
      // text fonts will get their textGrowth in applyChildSizing via layoutSizing
      return txt;
    }
    default:
      // Unknown type, or a `ref` the exporter failed to expand (the bridge asks for
      // resolveInstances, so a surviving `ref` means the instance didn't resolve).
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
  const n = await createNode(node);
  parent.appendChild(n);

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
  if ("strokes" in n && node.stroke != null && !isPathVector) {
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

  if (node.cornerRadius != null) applyCornerRadius(n, node.cornerRadius);
  if (node.opacity != null && "opacity" in n) (n as RectangleNode).opacity = node.opacity;
  if (node.blendMode && blendMap[node.blendMode] && "blendMode" in n) {
    (n as RectangleNode).blendMode = blendMap[node.blendMode];
  }
  // Pencil's property is `effect` (singular, CanHaveEffects.effect); `effects` is
  // only accepted for older exported JSON.
  if (node.effect != null) applyEffects(n, node.effect);
  else if (node.effects != null) applyEffects(n, node.effects);

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

  return n;
}

// ─── Counting / progress ──────────────────────────────────────────────────────

function countNodes(t: N): number {
  let c = 1;
  if (Array.isArray(t.children)) for (const ch of t.children) c += countNodes(ch);
  return c;
}

// ─── UI bridge ────────────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg: any) => {
  if (msg.type !== "import") return;
  const tree = msg.tree;
  const opts = msg.opts || {};

  try {
    truncatedNodes = [];
    fontFallbacks = new Map();
    const roots: N[] = Array.isArray(tree) ? tree : [tree];
    const count = roots.reduce((s: number, r: N) => s + countNodes(r), 0);
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

    const created: SceneNode[] = [];
    for (const root of roots) {
      const node = await build(root, parent);
      created.push(node);
    }

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

    figma.ui.postMessage({
      type: "done",
      count,
      truncated: truncatedNodes.length,
      fontFallbacks: fontIssues,
    });
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
    } else {
      figma.notify(`Pencil → Figma: imported ${count} nodes`);
    }
  } catch (e: any) {
    console.error(e);
    figma.ui.postMessage({ type: "error", error: e?.message || String(e) });
    figma.notify("Import failed: " + (e?.message || e), { error: true });
  }
};
