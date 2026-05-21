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

const fontCache = new Set<string>();
async function ensureFont(family: string, style: string): Promise<{ family: string; style: string }> {
  const key = `${family}|${style}`;
  if (fontCache.has(key)) return { family, style };
  try {
    await figma.loadFontAsync({ family, style });
    fontCache.add(key);
    return { family, style };
  } catch {
    try {
      await figma.loadFontAsync({ family, style: "Regular" });
      fontCache.add(`${family}|Regular`);
      return { family, style: "Regular" };
    } catch {
      await figma.loadFontAsync({ family: "Inter", style: "Regular" });
      fontCache.add("Inter|Regular");
      return { family: "Inter", style: "Regular" };
    }
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
    return { type: "SOLID", color: rgb, opacity: fill.opacity != null ? fill.opacity : a };
  }

  if (fill.type === "image" && fill.data) {
    try {
      const bytes = base64ToBytes(fill.data);
      const img = figma.createImage(bytes);
      const modeMap: Record<string, ImagePaint["scaleMode"]> = {
        fill: "FILL", fit: "FIT", crop: "CROP", tile: "TILE",
      };
      const paint: ImagePaint = {
        type: "IMAGE",
        imageHash: img.hash,
        scaleMode: modeMap[fill.mode || "fill"] || "FILL",
      };
      if (fill.opacity != null) (paint as any).opacity = fill.opacity;
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

  if (fill.type === "gradient" && Array.isArray(fill.stops)) {
    const stops: ColorStop[] = fill.stops.map((s: any) => {
      const c = typeof s.color === "string" ? parseColor(s.color) : { rgb: { r: 0, g: 0, b: 0 }, a: 1 };
      return {
        position: s.position,
        color: { ...c.rgb, a: s.opacity != null ? s.opacity : c.a },
      };
    });
    const typeMap: Record<string, GradientPaint["type"]> = {
      linear: "GRADIENT_LINEAR",
      radial: "GRADIENT_RADIAL",
      angular: "GRADIENT_ANGULAR",
      diamond: "GRADIENT_DIAMOND",
    };
    return {
      type: typeMap[fill.kind || "linear"] || "GRADIENT_LINEAR",
      gradientStops: stops,
      gradientTransform: fill.transform || [[1, 0, 0], [0, 1, 0]],
      opacity: fill.opacity,
    } as GradientPaint;
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
  stretch: "MIN",
};

function applyAutoLayout(frame: FrameNode, node: N): void {
  // Pencil schema rules (empirically derived from real .pen exports):
  //   layout: "vertical"   → vertical auto-layout
  //   layout: "horizontal" → horizontal auto-layout
  //   layout: "none" or missing →
  //     • if any child has explicit numeric x/y → absolute positioning (e.g. Services Grid)
  //     • otherwise → horizontal auto-layout (Pencil's implicit default — split frames,
  //       single-child wrappers, button rows, etc. all rely on this)
  let mode = node.layout;
  if (mode !== "vertical" && mode !== "horizontal") {
    if (mode != null && mode !== "none") return; // unknown explicit layout — leave alone
    const kids = Array.isArray(node.children) ? node.children : [];
    const anyChildIsAbsolute = kids.some(
      (c: N) =>
        c && typeof c === "object" &&
        (typeof c.x === "number" && c.x !== 0 ||
         typeof c.y === "number" && c.y !== 0)
    );
    if (anyChildIsAbsolute) return; // genuine absolute layout
    if (kids.length === 0) return;  // no children, layout mode doesn't matter
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
    let val: "FIXED" | "AUTO";
    if (typeof dim === "number") val = "FIXED";
    else if (dim === "fit_content" || dim == null) val = "AUTO";
    else val = "FIXED"; // "fill_container" → FIXED, parent will resize via layoutSizing
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
    frame.primaryAxisAlignItems = alignMap[node.justifyContent];
  }
  if (node.alignItems && alignMap[node.alignItems]) {
    const v = alignMap[node.alignItems];
    if (v !== "SPACE_BETWEEN") frame.counterAxisAlignItems = v;
  }
  if (node.alignItems === "stretch" && "layoutAlign" in frame) {
    // alignment on children controlled by their own layoutAlign — handled in applyChildSizing
  }
}

function applyChildSizing(n: SceneNode, node: N): void {
  // Pencil uses "fill_container" / "fit_content" / number for width and height.
  // In Figma, this maps to layoutSizing… on the child, when the parent has auto-layout.
  if (!("layoutSizingHorizontal" in n)) return;

  // CRITICAL for text nodes: set textAutoResize BEFORE layoutSizing*, otherwise
  // setting FILL on a text node whose textAutoResize is the default WIDTH_AND_HEIGHT
  // can silently fail (Figma's plugin API quietly refuses to apply FILL to a
  // hug-content text), leaving the text invisible at zero width inside an
  // auto-layout column.
  if (n.type === "TEXT") {
    const txt = n as TextNode;
    const wantsFillW = node.width === "fill_container";
    const wantsFixedW = typeof node.width === "number";
    if (wantsFillW || wantsFixedW) {
      try { txt.textAutoResize = "HEIGHT"; } catch {}
    } else {
      try { txt.textAutoResize = "WIDTH_AND_HEIGHT"; } catch {}
    }
  }

  const set = (axis: "Horizontal" | "Vertical", val: any) => {
    if (val === "fill_container") {
      (n as any)["layoutSizing" + axis] = "FILL";
    } else if (val === "fit_content") {
      (n as any)["layoutSizing" + axis] = "HUG";
    } else {
      (n as any)["layoutSizing" + axis] = "FIXED";
    }
  };
  if (node.width != null) {
    try { set("Horizontal", node.width); } catch {}
  }
  if (node.height != null) {
    try { set("Vertical", node.height); } catch {}
  }

  // CRITICAL: Setting layoutSizing*=FIXED only LOCKS the current size — it does not
  // restore a numeric dimension that auto-layout has previously hugged away. So if
  // Pencil specified an explicit numeric width/height (e.g. card height: 340) and
  // applyAutoLayout reset the frame to HUG content, the actual size right now is
  // whatever the children needed (often much smaller). Re-call resize() with the
  // intended dimensions to force the frame back to spec.
  if ("resize" in n) {
    const wNum = typeof node.width === "number" ? node.width : null;
    const hNum = typeof node.height === "number" ? node.height : null;
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

function applyEffects(n: SceneNode, effects: any[]): void {
  if (!("effects" in n) || !Array.isArray(effects)) return;
  const list: Effect[] = [];
  for (const e of effects) {
    if (!e || e.enabled === false) continue;
    if (e.type === "drop_shadow" || e.type === "drop-shadow" || e.type === "shadow") {
      const { rgb, a } = parseColor(e.color || "#00000040");
      list.push({
        type: "DROP_SHADOW",
        color: { ...rgb, a: e.opacity != null ? e.opacity : a },
        offset: { x: e.offsetX || 0, y: e.offsetY || 0 },
        radius: e.blur || 0,
        spread: e.spread || 0,
        visible: true,
        blendMode: "NORMAL",
      });
    } else if (e.type === "inner_shadow" || e.type === "inner-shadow") {
      const { rgb, a } = parseColor(e.color || "#00000040");
      list.push({
        type: "INNER_SHADOW",
        color: { ...rgb, a: e.opacity != null ? e.opacity : a },
        offset: { x: e.offsetX || 0, y: e.offsetY || 0 },
        radius: e.blur || 0,
        spread: e.spread || 0,
        visible: true,
        blendMode: "NORMAL",
      });
    } else if (e.type === "blur" || e.type === "layer_blur") {
      list.push({ type: "LAYER_BLUR", radius: e.blur || 0, visible: true, blurType: "NORMAL" } as Effect);
    } else if (e.type === "background_blur" || e.type === "background-blur") {
      list.push({ type: "BACKGROUND_BLUR", radius: e.blur || 0, visible: true, blurType: "NORMAL" } as Effect);
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

// ─── Node factories ───────────────────────────────────────────────────────────

async function createNode(node: N): Promise<SceneNode> {
  switch (node.type) {
    case "frame": return figma.createFrame();
    case "rectangle": return figma.createRectangle();
    case "ellipse": return figma.createEllipse();
    case "line": return figma.createLine();
    case "polygon": return figma.createPolygon();
    case "path":
    case "vector": return figma.createVector();
    case "text": {
      const family = node.fontFamily || "Inter";
      const style = weightToStyle(node.fontWeight);
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
      const td: Record<string, "NONE" | "UNDERLINE" | "STRIKETHROUGH"> = {
        none: "NONE", underline: "UNDERLINE", strikethrough: "STRIKETHROUGH", "line-through": "STRIKETHROUGH",
      };
      if (node.textDecoration && td[node.textDecoration]) txt.textDecoration = td[node.textDecoration];

      const paints = await toPaints(node.fill);
      if (paints.length) txt.fills = paints;
      // text fonts will get their textGrowth in applyChildSizing via layoutSizing
      return txt;
    }
    default:
      // Unknown / `ref` that wasn't expanded — make a placeholder frame so the tree still nests
      return figma.createFrame();
  }
}

// ─── Build (recursive) ────────────────────────────────────────────────────────

async function build(
  node: N,
  parent: BaseNode & ChildrenMixin
): Promise<SceneNode> {
  const n = await createNode(node);
  parent.appendChild(n);

  if (node.name) n.name = String(node.name);
  if (node.visible === false) n.visible = false;

  // Geometry. ONLY numeric width/height set fixed dimensions. String values like
  // "fill_container" / "fit_content" are deferred to applyChildSizing where they
  // become Figma layoutSizingHorizontal/Vertical (FILL/HUG). Calling resize() with
  // a fallback value here would force the text/frame into a tiny box and produce
  // the dreaded vertical-column-of-characters rendering bug.
  const wNum = typeof node.width === "number" ? node.width : null;
  const hNum = typeof node.height === "number" ? node.height : null;
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

  // Fills (skip text — text fill is handled inside createNode)
  if (node.type !== "text" && "fills" in n) {
    const paints = await toPaints(node.fill);
    if (paints.length) {
      (n as RectangleNode).fills = paints;
    } else if (node.fill == null && node.fills == null) {
      // Pencil didn't specify a fill — make the frame transparent so the
      // parent's color shows through. Otherwise figma.createFrame()'s default
      // white fill would obscure the parent (e.g. white text inside an
      // unfilled column over a dark purple Footer becomes invisible).
      (n as RectangleNode).fills = [];
    }
  }

  // Strokes
  if ("strokes" in n && node.stroke) {
    const sp = await toPaint(node.stroke.fill || node.stroke);
    if (sp) (n as RectangleNode).strokes = [sp];
    if (node.stroke.thickness != null) (n as RectangleNode).strokeWeight = node.stroke.thickness;
    const sa = node.stroke.align;
    if (sa) {
      const m: Record<string, "INSIDE" | "OUTSIDE" | "CENTER"> = {
        inside: "INSIDE", outside: "OUTSIDE", center: "CENTER",
      };
      if (m[sa] && "strokeAlign" in n) (n as RectangleNode).strokeAlign = m[sa];
    }
  }

  if (node.cornerRadius != null) applyCornerRadius(n, node.cornerRadius);
  if (node.opacity != null && "opacity" in n) (n as RectangleNode).opacity = node.opacity;
  if (node.blendMode && blendMap[node.blendMode] && "blendMode" in n) {
    (n as RectangleNode).blendMode = blendMap[node.blendMode];
  }
  if (node.effects) applyEffects(n, node.effects);

  if (n.type === "FRAME") {
    (n as FrameNode).clipsContent = node.clip === true;
    applyAutoLayout(n as FrameNode, node);
  }

  // Children — recurse before sizing so child sizing context is valid
  if (Array.isArray(node.children) && "appendChild" in n) {
    for (const child of node.children) {
      await build(child, n as BaseNode & ChildrenMixin);
    }
  }

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

    figma.ui.postMessage({ type: "done", count });
    figma.notify(`Pencil → Figma: imported ${count} nodes`);
  } catch (e: any) {
    console.error(e);
    figma.ui.postMessage({ type: "error", error: e?.message || String(e) });
    figma.notify("Import failed: " + (e?.message || e), { error: true });
  }
};
