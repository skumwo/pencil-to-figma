"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));

  // plugin/src/code.ts
  figma.showUI(__html__, { width: 360, height: 540, themeColors: true });
  function styleAlternates(style) {
    const out = [style];
    const spaced = style.replace(/([a-z])([A-Z])/g, "$1 $2");
    if (spaced !== style) out.push(spaced);
    const collapsed = style.replace(/\s+/g, "");
    if (collapsed !== style) out.push(collapsed);
    const lower = style.replace(/([a-z])([A-Z])/g, "$1$2").toLowerCase();
    const titled = lower.charAt(0).toUpperCase() + lower.slice(1);
    if (titled !== style && !out.includes(titled)) out.push(titled);
    return out;
  }
  var fontCache = /* @__PURE__ */ new Set();
  var fontFallbacks = /* @__PURE__ */ new Map();
  var STYLE_WEIGHTS = {
    thin: 100,
    hairline: 100,
    extralight: 200,
    ultralight: 200,
    light: 300,
    book: 350,
    regular: 400,
    normal: 400,
    medium: 500,
    semibold: 600,
    demibold: 600,
    bold: 700,
    extrabold: 800,
    ultrabold: 800,
    black: 900,
    heavy: 900,
    extrablack: 950,
    ultrablack: 950
  };
  function styleWeight(style) {
    const s = String(style).toLowerCase().replace(/italic|oblique/g, "").replace(/[\s_-]/g, "");
    return STYLE_WEIGHTS[s] != null ? STYLE_WEIGHTS[s] : 400;
  }
  var isItalicStyle = (s) => /italic|oblique/i.test(String(s));
  var fontIndex = null;
  async function stylesOf(family) {
    if (!fontIndex) {
      fontIndex = /* @__PURE__ */ new Map();
      try {
        for (const f of await figma.listAvailableFontsAsync()) {
          const list = fontIndex.get(f.fontName.family) || [];
          list.push(f.fontName.style);
          fontIndex.set(f.fontName.family, list);
        }
      } catch (e) {
        console.warn("[pencil-import] could not list fonts:", (e == null ? void 0 : e.message) || e);
      }
    }
    return fontIndex.get(family) || [];
  }
  var axisCache = /* @__PURE__ */ new Map();
  function variationAxes(family) {
    if (axisCache.has(family)) return axisCache.get(family);
    let axes = null;
    try {
      const fn = figma.getFontFamilyVariationAxes;
      if (typeof fn === "function") axes = fn.call(figma, family);
    } catch (e) {
      axes = null;
    }
    axisCache.set(family, axes);
    return axes;
  }
  async function ensureFont(family, style) {
    const key = `${family}|${style}`;
    if (fontCache.has(key)) return { family, style };
    for (const candidate of styleAlternates(style)) {
      try {
        await figma.loadFontAsync({ family, style: candidate });
        fontCache.add(`${family}|${candidate}`);
        return { family, style: candidate };
      } catch (e) {
      }
    }
    const want = styleWeight(style);
    const italic = isItalicStyle(style);
    const available = await stylesOf(family);
    const axes = available.length ? variationAxes(family) : null;
    if (axes && axes.indexOf("wght") >= 0) {
      const base = available.find((s) => isItalicStyle(s) === italic) || available[0];
      const fontName = { family, style: base, variationSettings: { wght: want } };
      try {
        await figma.loadFontAsync(fontName);
        fontCache.add(`${family}|${base}|${want}`);
        return fontName;
      } catch (e) {
      }
    }
    if (available.length) {
      const ranked = available.slice().sort((a, b) => {
        const ia = isItalicStyle(a) === italic ? 0 : 1e3;
        const ib = isItalicStyle(b) === italic ? 0 : 1e3;
        return ia + Math.abs(styleWeight(a) - want) - (ib + Math.abs(styleWeight(b) - want));
      });
      for (const candidate of ranked) {
        try {
          await figma.loadFontAsync({ family, style: candidate });
          fontCache.add(`${family}|${candidate}`);
          if (styleWeight(candidate) !== want || isItalicStyle(candidate) !== italic) {
            fontFallbacks.set(`${family} ${style}`, `${family} ${candidate} (has: ${available.join(", ")})`);
          }
          return { family, style: candidate };
        } catch (e) {
        }
      }
    }
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    fontCache.add("Inter|Regular");
    fontFallbacks.set(`${family} ${style}`, "Inter Regular");
    return { family: "Inter", style: "Regular" };
  }
  function weightToStyle(weight) {
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
    const map = {
      thin: "Thin",
      hairline: "Thin",
      extralight: "ExtraLight",
      ultralight: "ExtraLight",
      light: "Light",
      regular: "Regular",
      normal: "Regular",
      book: "Regular",
      medium: "Medium",
      semibold: "SemiBold",
      demibold: "SemiBold",
      bold: "Bold",
      extrabold: "ExtraBold",
      ultrabold: "ExtraBold",
      heavy: "ExtraBold",
      black: "Black"
    };
    return map[String(w)] || "Regular";
  }
  function hexToRgb(hex) {
    let h = hex.replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const num = parseInt(h.slice(0, 6), 16);
    return {
      r: (num >> 16 & 255) / 255,
      g: (num >> 8 & 255) / 255,
      b: (num & 255) / 255
    };
  }
  function parseColor(c) {
    if (typeof c !== "string") return { rgb: { r: 0, g: 0, b: 0 }, a: 1 };
    const h = c.replace("#", "");
    if (h.length === 8) {
      const a = parseInt(h.slice(6, 8), 16) / 255;
      return { rgb: hexToRgb("#" + h.slice(0, 6)), a };
    }
    return { rgb: hexToRgb(c), a: 1 };
  }
  function base64ToBytes(b64) {
    const data = b64.includes(",") ? b64.split(",")[1] : b64;
    const bin = atob(data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  var fillBlendMap = {
    normal: "NORMAL",
    darken: "DARKEN",
    multiply: "MULTIPLY",
    linearburn: "LINEAR_BURN",
    colorburn: "COLOR_BURN",
    light: "LIGHTEN",
    lighten: "LIGHTEN",
    screen: "SCREEN",
    lineardodge: "LINEAR_DODGE",
    colordodge: "COLOR_DODGE",
    overlay: "OVERLAY",
    softlight: "SOFT_LIGHT",
    hardlight: "HARD_LIGHT",
    difference: "DIFFERENCE",
    exclusion: "EXCLUSION",
    hue: "HUE",
    saturation: "SATURATION",
    color: "COLOR",
    luminosity: "LUMINOSITY"
  };
  function fillBlendMode(bm) {
    if (!bm || typeof bm !== "string") return null;
    return fillBlendMap[bm.toLowerCase()] || null;
  }
  function pencilGradientTransform(fill, kind) {
    const cx = fill.center && fill.center.x != null ? fill.center.x : 0.5;
    const cy = fill.center && fill.center.y != null ? fill.center.y : 0.5;
    if (kind === "radial" || kind === "angular") {
      const sw = fill.size && fill.size.width != null && fill.size.width > 0 ? fill.size.width : 1;
      const sh = fill.size && fill.size.height != null && fill.size.height > 0 ? fill.size.height : 1;
      const rot = (fill.rotation != null ? fill.rotation : 0) * Math.PI / 180;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      return [
        [cos / sw, -sin / sw, 0.5 - (cos * cx - sin * cy) / sw],
        [sin / sh, cos / sh, 0.5 - (sin * cx + cos * cy) / sh]
      ];
    }
    const rad = (fill.rotation != null ? fill.rotation : 0) * Math.PI / 180;
    const dx = -Math.sin(rad);
    const dy = -Math.cos(rad);
    const len = fill.size && fill.size.height != null && fill.size.height > 0 ? fill.size.height : 1;
    const ax = dx / len;
    const ay = dy / len;
    return [
      [ax, ay, 0.5 - (ax * cx + ay * cy)],
      [-ay, ax, 0.5 - (-ay * cx + ax * cy)]
    ];
  }
  async function toPaint(fill) {
    if (fill == null || fill === false) return null;
    if (typeof fill === "string") {
      const { rgb, a } = parseColor(fill);
      return { type: "SOLID", color: rgb, opacity: a };
    }
    if (typeof fill !== "object") return null;
    if (fill.enabled === false) return null;
    if (fill.type === "color") {
      const { rgb, a } = parseColor(fill.color);
      const paint = { type: "SOLID", color: rgb, opacity: fill.opacity != null ? fill.opacity : a };
      const bm = fillBlendMode(fill.blendMode);
      if (bm) paint.blendMode = bm;
      return paint;
    }
    if (fill.type === "image" && fill.data) {
      try {
        const bytes = base64ToBytes(fill.data);
        const img = figma.createImage(bytes);
        const modeMap = {
          fill: "FILL",
          stretch: "FILL",
          fit: "FIT",
          crop: "CROP",
          tile: "TILE"
        };
        const paint = {
          type: "IMAGE",
          imageHash: img.hash,
          scaleMode: modeMap[fill.mode || "fill"] || "FILL"
        };
        if (fill.opacity != null) paint.opacity = fill.opacity;
        const bm = fillBlendMode(fill.blendMode);
        if (bm) paint.blendMode = bm;
        return paint;
      } catch (e) {
        console.error("[pencil-import] image fill failed:", (e == null ? void 0 : e.message) || e, "data length:", (fill.data || "").length);
        return null;
      }
    }
    if (fill.type === "image" && !fill.data && fill.url) {
      console.warn("[pencil-import] image fill missing data, url:", fill.url);
      return null;
    }
    if (fill.type === "gradient") {
      const rawStops = Array.isArray(fill.colors) ? fill.colors : Array.isArray(fill.stops) ? fill.stops : null;
      if (!rawStops || !rawStops.length) return null;
      const stops = rawStops.map((s) => {
        const c = typeof s.color === "string" ? parseColor(s.color) : { rgb: { r: 0, g: 0, b: 0 }, a: 1 };
        return {
          position: s.position != null ? s.position : 0,
          color: __spreadProps(__spreadValues({}, c.rgb), { a: s.opacity != null ? s.opacity : c.a })
        };
      });
      const kind = fill.gradientType || fill.kind || "linear";
      const typeMap = {
        linear: "GRADIENT_LINEAR",
        radial: "GRADIENT_RADIAL",
        angular: "GRADIENT_ANGULAR",
        diamond: "GRADIENT_DIAMOND"
      };
      const paint = {
        type: typeMap[kind] || "GRADIENT_LINEAR",
        gradientStops: stops,
        gradientTransform: fill.transform || pencilGradientTransform(fill, kind)
      };
      if (fill.opacity != null) paint.opacity = fill.opacity;
      const bm = fillBlendMode(fill.blendMode);
      if (bm) paint.blendMode = bm;
      return paint;
    }
    return null;
  }
  async function toPaints(fill) {
    if (fill == null) return [];
    const arr = Array.isArray(fill) ? fill : [fill];
    const out = [];
    for (const f of arr) {
      const p = await toPaint(f);
      if (p) out.push(p);
    }
    return out;
  }
  function expandPadding(p) {
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
        left: p.left || 0
      };
    }
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
  var alignMap = {
    start: "MIN",
    min: "MIN",
    left: "MIN",
    top: "MIN",
    center: "CENTER",
    middle: "CENTER",
    end: "MAX",
    max: "MAX",
    right: "MAX",
    bottom: "MAX",
    space_between: "SPACE_BETWEEN",
    "space-between": "SPACE_BETWEEN",
    // Figma auto-layout has no space-around; SPACE_BETWEEN is the closest primary-axis
    // distribution it offers, and leaving it unset would collapse the row to `start`.
    space_around: "SPACE_BETWEEN",
    "space-around": "SPACE_BETWEEN",
    stretch: "MIN"
  };
  function sizingMode(dim) {
    if (dim == null) return null;
    if (typeof dim === "number") return Number.isFinite(dim) ? "FIXED" : null;
    if (typeof dim !== "string") return null;
    const s = dim.trim();
    if (/^fill_container\b/.test(s)) return "FILL";
    if (/^fit_content\b/.test(s)) return "HUG";
    const n = Number(s);
    return Number.isFinite(n) ? "FIXED" : null;
  }
  function sizingPx(dim) {
    if (typeof dim === "number") return Number.isFinite(dim) ? dim : null;
    if (typeof dim !== "string") return null;
    const paren = dim.match(/\(\s*(-?[\d.]+)\s*\)/);
    if (paren) {
      const n2 = Number(paren[1]);
      return Number.isFinite(n2) ? n2 : null;
    }
    const n = Number(dim.trim());
    return Number.isFinite(n) ? n : null;
  }
  function applyAutoLayout(frame, node) {
    let mode = node.layout;
    if (mode !== "vertical" && mode !== "horizontal") {
      if (mode != null && mode !== "none") return;
      if (mode === "none") return;
      const kids = Array.isArray(node.children) ? node.children : [];
      if (kids.length === 0) return;
      mode = "horizontal";
    }
    frame.layoutMode = mode === "vertical" ? "VERTICAL" : "HORIZONTAL";
    try {
      frame.strokesIncludedInLayout = false;
    } catch (e) {
    }
    const primaryDim = mode === "vertical" ? node.height : node.width;
    const counterDim = mode === "vertical" ? node.width : node.height;
    const setSizingMode = (which, dim) => {
      const m = sizingMode(dim);
      const val = m === "HUG" || m === null ? "AUTO" : "FIXED";
      try {
        frame[which] = val;
      } catch (e) {
      }
    };
    setSizingMode("primaryAxisSizingMode", primaryDim);
    setSizingMode("counterAxisSizingMode", counterDim);
    if (node.gap != null) frame.itemSpacing = node.gap;
    const pad = expandPadding(node.padding);
    frame.paddingTop = pad.top;
    frame.paddingRight = pad.right;
    frame.paddingBottom = pad.bottom;
    frame.paddingLeft = pad.left;
    if (node.justifyContent && alignMap[node.justifyContent]) {
      let primary = alignMap[node.justifyContent];
      if (primary === "SPACE_BETWEEN") {
        const kids = Array.isArray(node.children) ? node.children : [];
        const inFlow = kids.filter(
          (c) => c && typeof c === "object" && c.layoutPosition !== "absolute" && c.enabled !== false && c.visible !== false
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
    }
  }
  function textAutoResizeFor(node) {
    switch (node.textGrowth) {
      case "fixed-width":
        return "HEIGHT";
      case "fixed-width-height":
        return "NONE";
      default:
        return "WIDTH_AND_HEIGHT";
    }
  }
  function applyChildSizing(n, node) {
    if (!("layoutSizingHorizontal" in n)) return;
    const isText = n.type === "TEXT";
    const growth = isText ? textAutoResizeFor(node) : null;
    if (isText && growth) {
      try {
        n.textAutoResize = growth;
      } catch (e) {
      }
    }
    const useWidth = !isText || growth !== "WIDTH_AND_HEIGHT";
    const useHeight = !isText || growth === "NONE";
    const set = (axis, dim) => {
      const m = sizingMode(dim);
      if (m === null) return;
      n["layoutSizing" + axis] = m === "FILL" ? "FILL" : m === "HUG" ? "HUG" : "FIXED";
    };
    if (useWidth && node.width != null) {
      try {
        set("Horizontal", node.width);
      } catch (e) {
      }
    }
    if (useHeight && node.height != null) {
      try {
        set("Vertical", node.height);
      } catch (e) {
      }
    }
    if ("resize" in n) {
      const wNum = useWidth && sizingMode(node.width) === "FIXED" ? sizingPx(node.width) : null;
      const hNum = useHeight && sizingMode(node.height) === "FIXED" ? sizingPx(node.height) : null;
      if (wNum !== null || hNum !== null) {
        try {
          const w = wNum !== null ? wNum : n.width;
          const h = hNum !== null ? hNum : n.height;
          if (w > 0 && h > 0) n.resize(w, h);
        } catch (e) {
        }
      }
    }
  }
  function applyCornerRadius(n, r) {
    if (r == null) return;
    if (typeof r === "number" && "cornerRadius" in n) {
      n.cornerRadius = r;
      return;
    }
    if (Array.isArray(r) && r.length === 4 && "topLeftRadius" in n) {
      const rn = n;
      rn.topLeftRadius = r[0];
      rn.topRightRadius = r[1];
      rn.bottomRightRadius = r[2];
      rn.bottomLeftRadius = r[3];
      return;
    }
    if (typeof r === "object" && "topLeftRadius" in n) {
      const rn = n;
      if (r.topLeft != null) rn.topLeftRadius = r.topLeft;
      if (r.topRight != null) rn.topRightRadius = r.topRight;
      if (r.bottomLeft != null) rn.bottomLeftRadius = r.bottomLeft;
      if (r.bottomRight != null) rn.bottomRightRadius = r.bottomRight;
    }
  }
  function applyEffects(n, raw) {
    if (!("effects" in n) || raw == null) return;
    const effects = Array.isArray(raw) ? raw : [raw];
    const list = [];
    for (const e of effects) {
      if (!e || typeof e !== "object" || e.enabled === false) continue;
      const type = String(e.type || "");
      const offX = e.offset && e.offset.x != null ? e.offset.x : e.offsetX || 0;
      const offY = e.offset && e.offset.y != null ? e.offset.y : e.offsetY || 0;
      const blurRadius = e.radius != null ? e.radius : e.blur != null ? e.blur : 0;
      if (type === "shadow" || type === "drop_shadow" || type === "drop-shadow" || type === "inner_shadow" || type === "inner-shadow") {
        const inner = e.shadowType === "inner" || type === "inner_shadow" || type === "inner-shadow";
        const { rgb, a } = parseColor(e.color || "#00000040");
        const shadow = {
          type: inner ? "INNER_SHADOW" : "DROP_SHADOW",
          color: __spreadProps(__spreadValues({}, rgb), { a: e.opacity != null ? e.opacity : a }),
          offset: { x: offX, y: offY },
          radius: blurRadius,
          spread: e.spread || 0,
          visible: true,
          blendMode: "NORMAL"
        };
        list.push(shadow);
      } else if (type === "blur" || type === "layer_blur") {
        list.push({ type: "LAYER_BLUR", radius: blurRadius, visible: true, blurType: "NORMAL" });
      } else if (type === "background_blur" || type === "background-blur") {
        list.push({ type: "BACKGROUND_BLUR", radius: blurRadius, visible: true, blurType: "NORMAL" });
      }
    }
    n.effects = list;
  }
  var blendMap = {
    normal: "NORMAL",
    multiply: "MULTIPLY",
    screen: "SCREEN",
    overlay: "OVERLAY",
    darken: "DARKEN",
    lighten: "LIGHTEN",
    color_dodge: "COLOR_DODGE",
    "color-dodge": "COLOR_DODGE",
    color_burn: "COLOR_BURN",
    "color-burn": "COLOR_BURN",
    hard_light: "HARD_LIGHT",
    "hard-light": "HARD_LIGHT",
    soft_light: "SOFT_LIGHT",
    "soft-light": "SOFT_LIGHT",
    difference: "DIFFERENCE",
    exclusion: "EXCLUSION",
    hue: "HUE",
    saturation: "SATURATION",
    color: "COLOR",
    luminosity: "LUMINOSITY"
  };
  function strokeSideWeight(v) {
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  }
  function strokeWeights(node) {
    const none = { max: 0, top: 0, right: 0, bottom: 0, left: 0, perSide: false };
    const legacy = node.stroke && typeof node.stroke === "object" && !Array.isArray(node.stroke) ? node.stroke.thickness : void 0;
    const w = node.strokeWidth != null ? node.strokeWidth : legacy;
    if (typeof w === "number") {
      return Number.isFinite(w) ? { max: w, top: w, right: w, bottom: w, left: w, perSide: false } : none;
    }
    if (w && typeof w === "object") {
      const top = strokeSideWeight(w.top);
      const right = strokeSideWeight(w.right);
      const bottom = strokeSideWeight(w.bottom);
      const left = strokeSideWeight(w.left);
      return { max: Math.max(top, right, bottom, left), top, right, bottom, left, perSide: true };
    }
    if (w != null) return { max: 1, top: 1, right: 1, bottom: 1, left: 1, perSide: false };
    return none;
  }
  function strokeAlignOf(node) {
    const legacy = node.stroke && typeof node.stroke === "object" && !Array.isArray(node.stroke) ? node.stroke.align : void 0;
    const a = node.strokeAlignment != null ? node.strokeAlignment : legacy;
    const map = {
      inner: "INSIDE",
      inside: "INSIDE",
      outer: "OUTSIDE",
      outside: "OUTSIDE",
      center: "CENTER",
      middle: "CENTER"
    };
    return a && map[String(a)] || null;
  }
  function iconTint(fill) {
    const f = Array.isArray(fill) ? fill.find((x) => x != null && x !== false) : fill;
    let hex = null;
    let opacity = null;
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
  function eachSvgDescendant(root, visit) {
    const stack = root.children.slice();
    while (stack.length) {
      const n = stack.pop();
      visit(n);
      if ("children" in n) stack.push(...n.children);
    }
  }
  function tintIconVectors(frame, tint) {
    const { rgb } = parseColor(tint.hex);
    const paint = { type: "SOLID", color: rgb, opacity: 1 };
    eachSvgDescendant(frame, (c) => {
      const hasStroke = "strokes" in c && (c.strokes || []).length > 0;
      const hasFill = "fills" in c && Array.isArray(c.fills) && c.fills.length > 0;
      if (hasStroke) {
        try {
          c.strokes = [paint];
        } catch (e) {
        }
      }
      if (hasFill) {
        try {
          c.fills = [paint];
        } catch (e) {
        }
      }
      if (!hasStroke && !hasFill && "fills" in c) {
        try {
          c.fills = [paint];
        } catch (e) {
        }
      }
    });
  }
  function isIconType(node) {
    return !!node && (node.type === "icon" || node.type === "icon_font");
  }
  function iconOpacity(node) {
    const own = typeof node.opacity === "number" ? node.opacity : 1;
    return own * iconTint(node.fill).alpha;
  }
  function vectorFromSvg(svg, w, h) {
    const frame = figma.createNodeFromSvg(svg);
    eachSvgDescendant(frame, (c) => {
      if ("constraints" in c) {
        try {
          c.constraints = { horizontal: "SCALE", vertical: "SCALE" };
        } catch (e) {
        }
      }
    });
    const wNum = sizingPx(w);
    const hNum = sizingPx(h);
    if (wNum && hNum && wNum > 0 && hNum > 0) {
      const uniform = Math.min(wNum / frame.width, hNum / frame.height);
      if (Number.isFinite(uniform) && uniform >= 0.01 && Math.abs(uniform - 1) > 1e-3) {
        try {
          frame.rescale(uniform);
        } catch (e) {
        }
      }
      if (Math.abs(frame.width - wNum) > 0.01 || Math.abs(frame.height - hNum) > 0.01) {
        try {
          frame.resize(wNum, hNum);
        } catch (e) {
        }
      }
    }
    try {
      frame.fills = [];
    } catch (e) {
    }
    try {
      frame.clipsContent = false;
    } catch (e) {
    }
    return frame;
  }
  function flipSvg(svg, flipX, flipY) {
    if (!flipX && !flipY) return svg;
    const open = svg.match(/<svg\b[^>]*>/i);
    if (!open) return svg;
    const vb = open[0].match(/viewBox\s*=\s*"([^"]+)"/i);
    if (!vb) return svg;
    const p = vb[1].trim().split(/[\s,]+/).map(Number);
    if (p.length !== 4 || !(p[2] > 0) || !(p[3] > 0)) return svg;
    const sx = flipX ? -1 : 1;
    const sy = flipY ? -1 : 1;
    const tx = flipX ? -(2 * p[0] + p[2]) : 0;
    const ty = flipY ? -(2 * p[1] + p[3]) : 0;
    const body = svg.slice(open.index + open[0].length).replace(/<\/svg>\s*$/i, "");
    return `${open[0]}<g transform="scale(${sx} ${sy}) translate(${tx} ${ty})">${body}</g></svg>`;
  }
  async function vectorFromPath(node) {
    const vbRaw = Array.isArray(node.viewBox) && node.viewBox.length === 4 ? node.viewBox : [0, 0, sizingPx(node.width) || 100, sizingPx(node.height) || 100];
    const vx = Number(vbRaw[0]) || 0, vy = Number(vbRaw[1]) || 0;
    const vw = Number(vbRaw[2]) || 100, vh = Number(vbRaw[3]) || 100;
    const d = String(node.geometry || "").replace(/[<>&"]/g, " ");
    const sw = strokeWeights(node);
    const th = sw.max;
    const capSvg = { butt: "butt", round: "round", square: "square", none: "butt" }[node.strokeLinecap] || "butt";
    const joinSvg = { miter: "miter", bevel: "bevel", round: "round" }[node.strokeLinejoin] || "miter";
    const strokeSvg = th > 0 ? `stroke="#000000" stroke-width="${th}" stroke-linecap="${capSvg}" stroke-linejoin="${joinSvg}"` : "";
    const ruleSvg = node.fillRule === "evenodd" ? ' fill-rule="evenodd"' : "";
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}"><path d="${d}" fill="none"${ruleSvg} ${strokeSvg}/></svg>`;
    svg = flipSvg(svg, node.flipX === true, node.flipY === true);
    const frame = figma.createNodeFromSvg(svg);
    const strokePaints = th > 0 ? await toPaints(node.stroke) : [];
    const fillPaints = await toPaints(node.fill);
    const capFig = { butt: "NONE", none: "NONE", round: "ROUND", square: "SQUARE" }[node.strokeLinecap];
    const joinFig = { miter: "MITER", bevel: "BEVEL", round: "ROUND" }[node.strokeLinejoin];
    const alignFig = strokeAlignOf(node);
    eachSvgDescendant(frame, (c) => {
      if (c.type === "VECTOR") {
        const v = c;
        if (strokePaints.length) {
          try {
            v.strokes = strokePaints;
          } catch (e) {
          }
        }
        if (capFig && "strokeCap" in v) {
          try {
            v.strokeCap = capFig;
          } catch (e) {
          }
        }
        if (joinFig && "strokeJoin" in v) {
          try {
            v.strokeJoin = joinFig;
          } catch (e) {
          }
        }
        if (alignFig) {
          try {
            v.strokeAlign = alignFig;
          } catch (e) {
          }
        }
        try {
          v.fills = fillPaints;
        } catch (e) {
        }
      }
      if ("constraints" in c) {
        try {
          c.constraints = { horizontal: "SCALE", vertical: "SCALE" };
        } catch (e) {
        }
      }
    });
    const w = sizingPx(node.width) != null ? sizingPx(node.width) : vw;
    const h = sizingPx(node.height) != null ? sizingPx(node.height) : vh;
    if (w > 0 && h > 0) {
      try {
        frame.resize(w, h);
      } catch (e) {
      }
    }
    try {
      frame.fills = [];
    } catch (e) {
    }
    try {
      frame.clipsContent = false;
    } catch (e) {
    }
    return frame;
  }
  async function applyStrokes(n, node) {
    if (!("strokes" in n) || node.stroke == null) return;
    if (n.type === "TEXT") {
      try {
        n.strokes = [];
      } catch (e) {
      }
      return;
    }
    const sw = strokeWeights(node);
    if (sw.max <= 0) {
      try {
        n.strokes = [];
      } catch (e) {
      }
    } else {
      const sp = await toPaints(node.stroke);
      if (sp.length) n.strokes = sp;
      const align = strokeAlignOf(node);
      if (align && "strokeAlign" in n) {
        try {
          n.strokeAlign = align;
        } catch (e) {
        }
      }
      if (sw.perSide) {
        const rn = n;
        try {
          rn.strokeWeight = sw.max;
        } catch (e) {
        }
        try {
          if ("strokeTopWeight" in rn) rn.strokeTopWeight = sw.top;
        } catch (e) {
        }
        try {
          if ("strokeRightWeight" in rn) rn.strokeRightWeight = sw.right;
        } catch (e) {
        }
        try {
          if ("strokeBottomWeight" in rn) rn.strokeBottomWeight = sw.bottom;
        } catch (e) {
        }
        try {
          if ("strokeLeftWeight" in rn) rn.strokeLeftWeight = sw.left;
        } catch (e) {
        }
      } else {
        try {
          n.strokeWeight = sw.max;
        } catch (e) {
        }
      }
    }
    const capFig = { butt: "NONE", none: "NONE", round: "ROUND", square: "SQUARE" }[node.strokeLinecap];
    if (capFig && "strokeCap" in n) {
      try {
        n.strokeCap = capFig;
      } catch (e) {
      }
    }
    const joinFig = { miter: "MITER", bevel: "BEVEL", round: "ROUND" }[node.strokeLinejoin];
    if (joinFig && "strokeJoin" in n) {
      try {
        n.strokeJoin = joinFig;
      } catch (e) {
      }
    }
  }
  async function createNode(node) {
    switch (node.type) {
      case "frame":
        return figma.createFrame();
      case "group":
        return figma.createFrame();
      case "rectangle":
        return figma.createRectangle();
      case "ellipse": {
        const e = figma.createEllipse();
        const inner = typeof node.innerRadius === "number" ? node.innerRadius : 0;
        const startDeg = typeof node.startAngle === "number" ? node.startAngle : 0;
        const sweepDeg = typeof node.sweepAngle === "number" ? node.sweepAngle : 360;
        if (inner > 0 || startDeg !== 0 || Math.abs(sweepDeg) < 360) {
          const toRad = (d) => -d * Math.PI / 180;
          const a = toRad(startDeg);
          const b = toRad(startDeg + sweepDeg);
          try {
            e.arcData = {
              startingAngle: Math.min(a, b),
              endingAngle: Math.max(a, b),
              innerRadius: Math.max(0, Math.min(1, inner))
            };
          } catch (err) {
            console.error("[pencil-import] ellipse arcData failed:", (err == null ? void 0 : err.message) || err);
          }
        }
        return e;
      }
      case "line":
        return figma.createLine();
      case "polygon": {
        const p = figma.createPolygon();
        if (typeof node.polygonCount === "number" && node.polygonCount >= 3) {
          try {
            p.pointCount = Math.round(node.polygonCount);
          } catch (e) {
          }
        }
        return p;
      }
      case "image":
        return figma.createRectangle();
      case "script":
      case "connection":
        return figma.createFrame();
      case "path":
      case "vector": {
        const geom = node.geometry;
        if (typeof geom === "string" && geom.length > 0 && geom !== "...") {
          try {
            return await vectorFromPath(node);
          } catch (e) {
            console.error("[pencil-import] path vector build failed:", (e == null ? void 0 : e.message) || e);
          }
        }
        if (node._rasterImage) {
          const rect = figma.createRectangle();
          try {
            const bytes = base64ToBytes(node._rasterImage);
            const img = figma.createImage(bytes);
            rect.fills = [{ type: "IMAGE", imageHash: img.hash, scaleMode: "FIT" }];
          } catch (e) {
            console.error("[pencil-import] path raster fill failed:", (e == null ? void 0 : e.message) || e);
            rect.fills = [];
          }
          return rect;
        }
        return figma.createVector();
      }
      case "icon":
      case "icon_font": {
        const tint = iconTint(node.fill);
        if (node._iconSvg) {
          try {
            let svg = String(node._iconSvg).replace(/currentColor/g, tint.hex);
            svg = flipSvg(svg, node.flipX === true, node.flipY === true);
            const frame = vectorFromSvg(svg, node.width, node.height);
            tintIconVectors(frame, tint);
            frame.opacity = iconOpacity(node);
            return frame;
          } catch (e) {
            console.error(
              "[pencil-import] icon svg import failed:",
              (e == null ? void 0 : e.message) || e,
              "-",
              node.library,
              node.icon
            );
          }
        }
        const rect = figma.createRectangle();
        if (node._iconImage) {
          try {
            const bytes = base64ToBytes(node._iconImage);
            const img = figma.createImage(bytes);
            rect.fills = [{ type: "IMAGE", imageHash: img.hash, scaleMode: "FIT" }];
          } catch (e) {
            console.error("[pencil-import] icon raster fill failed:", (e == null ? void 0 : e.message) || e);
            rect.fills = [];
          }
        } else {
          console.warn("[pencil-import] unresolved icon:", node.library, node.icon);
          rect.fills = [];
        }
        return rect;
      }
      case "text":
      case "note":
      case "prompt":
      case "context": {
        const txt = figma.createText();
        await applyTextProps(txt, node);
        return txt;
      }
      default:
        console.warn(
          "[pencil-import] unsupported node type:",
          node.type,
          node.type === "ref" ? `(unresolved instance of ${node.ref})` : "",
          node.name ? `\u2014 "${node.name}"` : ""
        );
        return figma.createFrame();
    }
  }
  async function applyTextProps(txt, node) {
    const family = node.fontFamily || "Inter";
    let style = weightToStyle(node.fontWeight);
    if (/^italic$/i.test(String(node.fontStyle || ""))) {
      style = style === "Regular" ? "Italic" : `${style} Italic`;
    }
    const f = await ensureFont(family, style);
    try {
      txt.fontName = f.variationSettings ? f : { family: f.family, style: f.style };
    } catch (e) {
      txt.fontName = { family: "Inter", style: "Regular" };
    }
    if (node.fontSize != null) txt.fontSize = node.fontSize;
    txt.characters = String(node.content != null ? node.content : "");
    if (node.letterSpacing != null) {
      txt.letterSpacing = { value: node.letterSpacing, unit: "PIXELS" };
    }
    if (typeof node._lineHeightPx === "number" && node._lineHeightPx > 0) {
      txt.lineHeight = { value: node._lineHeightPx, unit: "PIXELS" };
    } else if (node.lineHeight != null) {
      const lh = node.lineHeight;
      if (lh > 0 && lh < 5) {
        txt.lineHeight = { value: lh * 100, unit: "PERCENT" };
      } else {
        txt.lineHeight = { value: lh, unit: "PIXELS" };
      }
    }
    const ta = {
      left: "LEFT",
      center: "CENTER",
      right: "RIGHT",
      justified: "JUSTIFIED",
      justify: "JUSTIFIED"
    };
    if (node.textAlign && ta[node.textAlign]) txt.textAlignHorizontal = ta[node.textAlign];
    const tav = {
      top: "TOP",
      center: "CENTER",
      middle: "CENTER",
      bottom: "BOTTOM"
    };
    if (node.textAlignVertical && tav[node.textAlignVertical]) txt.textAlignVertical = tav[node.textAlignVertical];
    const tc = {
      none: "ORIGINAL",
      original: "ORIGINAL",
      upper: "UPPER",
      uppercase: "UPPER",
      lower: "LOWER",
      lowercase: "LOWER",
      title: "TITLE"
    };
    if (node.textCase && tc[node.textCase]) txt.textCase = tc[node.textCase];
    const td = {
      none: "NONE",
      underline: "UNDERLINE",
      strikethrough: "STRIKETHROUGH",
      "line-through": "STRIKETHROUGH"
    };
    if (node.underline === true) txt.textDecoration = "UNDERLINE";
    else if (node.strikethrough === true) txt.textDecoration = "STRIKETHROUGH";
    else if (node.textDecoration && td[node.textDecoration]) txt.textDecoration = td[node.textDecoration];
    const paints = await toPaints(node.fill);
    if (paints.length) txt.fills = paints;
  }
  var truncatedNodes = [];
  function fitFrameToChildren(frame) {
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
    const shiftX = Math.min(minX, 0);
    const shiftY = Math.min(minY, 0);
    const w = Math.max(maxX, 0) - shiftX;
    const h = Math.max(maxY, 0) - shiftY;
    if (!(w > 0) || !(h > 0)) return;
    try {
      frame.resize(w, h);
      if (shiftX !== 0 || shiftY !== 0) {
        for (const c of kids) {
          c.x -= shiftX;
          c.y -= shiftY;
        }
        frame.x += shiftX;
        frame.y += shiftY;
      }
    } catch (e) {
      console.error("[pencil-import] group fit failed:", (e == null ? void 0 : e.message) || e);
    }
  }
  function applyFlip(n, fx, fy) {
    if (!("relativeTransform" in n)) return;
    try {
      const t = n.relativeTransform;
      const a = t[0][0], b = t[0][1], c = t[1][0], d = t[1][1];
      const w = n.width, h = n.height;
      const tx = t[0][2] + (fx ? a * w : 0) + (fy ? b * h : 0);
      const ty = t[1][2] + (fx ? c * w : 0) + (fy ? d * h : 0);
      n.relativeTransform = [
        [fx ? -a : a, fy ? -b : b, tx],
        [fx ? -c : c, fy ? -d : d, ty]
      ];
    } catch (e) {
      console.warn("[pencil-import] could not flip", n.name, "-", (e == null ? void 0 : e.message) || e);
    }
  }
  async function build(node, parent) {
    if (node.type === "ref") return buildInstance(node, parent);
    if (node.reusable === true && nestedPending.has(String(node.id))) return placeNestedDefinition(node, parent);
    const n = await createNode(node);
    parent.appendChild(n);
    builtPairs.push({ node, fig: n });
    if (node.name) n.name = String(node.name);
    if (node.enabled === false || node.visible === false) n.visible = false;
    if (node.layoutPosition === "absolute" && "layoutPositioning" in n) {
      try {
        n.layoutPositioning = "ABSOLUTE";
      } catch (e) {
      }
    }
    const wNum = sizingMode(node.width) === "FIXED" ? sizingPx(node.width) : null;
    const hNum = sizingMode(node.height) === "FIXED" ? sizingPx(node.height) : null;
    if ("resize" in n && (wNum !== null || hNum !== null)) {
      const targetW = wNum !== null ? wNum : n.width;
      const targetH = hNum !== null ? hNum : n.height;
      if (targetW > 0 && targetH > 0) {
        try {
          n.resize(targetW, targetH);
        } catch (e) {
        }
      }
    }
    if (node.x != null) n.x = node.x;
    if (node.y != null) n.y = node.y;
    if (node.rotation != null && "rotation" in n) {
      n.rotation = node.rotation;
    }
    const flipsInSvg = node.type === "path" || node.type === "vector" || node.type === "icon" || node.type === "icon_font";
    if ((node.flipX === true || node.flipY === true) && !flipsInSvg) {
      applyFlip(n, node.flipX === true, node.flipY === true);
    }
    const isPathVector = node.type === "path" || node.type === "vector";
    const fillIsNotBackground = node.type === "text" || node.type === "note" || node.type === "prompt" || node.type === "context" || node.type === "icon" || node.type === "icon_font" || node.type === "group" || isPathVector;
    if (!fillIsNotBackground && "fills" in n) {
      const paints = await toPaints(node.fill);
      if (paints.length) {
        n.fills = paints;
      } else if (node._fillRaster) {
        try {
          const bytes = base64ToBytes(node._fillRaster);
          const img = figma.createImage(bytes);
          n.fills = [
            { type: "IMAGE", imageHash: img.hash, scaleMode: "FILL" }
          ];
        } catch (e) {
          console.error("[pencil-import] rasterized fill failed:", (e == null ? void 0 : e.message) || e);
          n.fills = [];
        }
      } else {
        n.fills = [];
      }
    }
    if (!isPathVector) await applyStrokes(n, node);
    if (node.cornerRadius != null) applyCornerRadius(n, node.cornerRadius);
    if (node.opacity != null && "opacity" in n) {
      n.opacity = isIconType(node) && n.type === "FRAME" ? iconOpacity(node) : node.opacity;
    }
    if (node.blendMode && blendMap[node.blendMode] && "blendMode" in n) {
      n.blendMode = blendMap[node.blendMode];
    }
    if (node.effect != null) applyEffects(n, node.effect);
    else if (node.effects != null) applyEffects(n, node.effects);
    if (isPathVector && "effects" in n && n.effects.some((e) => e.type === "DROP_SHADOW")) {
      const fillPaints = await toPaints(node.fill);
      const filled = fillPaints.some((p) => p.visible !== false && (p.opacity == null || p.opacity > 1e-3));
      if (!filled) n.effects = n.effects.filter((e) => e.type !== "DROP_SHADOW");
    }
    if (n.type === "FRAME") {
      n.clipsContent = node.type === "group" ? false : node.clip === true;
      if (node.type !== "group") applyAutoLayout(n, node);
    }
    if (node.children === "...") {
      console.error(
        `[pencil-import] TRUNCATED subtree at "${node.name || node.id}" \u2014 children were not expanded by the bridge; this part of the design is missing`
      );
      truncatedNodes.push(String(node.name || node.id));
    }
    if (Array.isArray(node.children) && "appendChild" in n) {
      for (const child of node.children) {
        await build(child, n);
      }
    }
    if (node.type === "group" && n.type === "FRAME") fitFrameToChildren(n);
    applyChildSizing(n, node);
    if (node.rotation && "rotation" in n) {
      if (node.x != null) n.x = node.x;
      if (node.y != null) n.y = node.y;
    }
    alignToPencilBox(n, node, parent);
    hideShadowUnderFill(n);
    emulateBoxShadow(n, node);
    return n;
  }
  var components = /* @__PURE__ */ new Map();
  var wrappedMains = /* @__PURE__ */ new Set();
  var nestedPending = /* @__PURE__ */ new Set();
  var buildingComponents = false;
  var instanceStats = { linked: 0, scaled: 0, detached: 0, reasons: /* @__PURE__ */ new Map() };
  var OV_IGNORE = /* @__PURE__ */ new Set(["id", "name", "context", "metadata"]);
  var OV_TEXT = /* @__PURE__ */ new Set([
    "content",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "letterSpacing",
    "lineHeight",
    "textAlign",
    "textAlignVertical",
    "textCase",
    "underline",
    "strikethrough",
    "textDecoration",
    "textGrowth"
  ]);
  var OV_STROKE = /* @__PURE__ */ new Set(["stroke", "strokeWidth", "strokeAlignment", "strokeLinecap", "strokeLinejoin"]);
  var OV_LAYOUT = /* @__PURE__ */ new Set(["layout", "gap", "padding", "justifyContent", "alignItems"]);
  var OV_GEOMETRY = /* @__PURE__ */ new Set(["x", "y", "width", "height", "rotation", "layoutPosition"]);
  var OV_PAINT = /* @__PURE__ */ new Set(["enabled", "visible", "opacity", "blendMode", "fill", "cornerRadius", "effect", "effects", "clip"]);
  var REF_OWN_SKIP = /* @__PURE__ */ new Set(["id", "type", "ref", "name", "descendants", "_resolved"]);
  function overrideProblem(ov) {
    if (!ov || typeof ov !== "object") return "malformed override";
    for (const k of Object.keys(ov)) {
      if (k.startsWith("_")) continue;
      if (OV_IGNORE.has(k) || OV_TEXT.has(k) || OV_STROKE.has(k) || OV_LAYOUT.has(k) || OV_GEOMETRY.has(k) || OV_PAINT.has(k)) continue;
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
  function instanceProblem(node) {
    const own = {};
    for (const k of Object.keys(node)) if (!REF_OWN_SKIP.has(k) && !k.startsWith("_")) own[k] = node[k];
    return overrideProblem(own) || overrideProblem({ descendants: node.descendants || {} });
  }
  function noteDetached(node, reason) {
    instanceStats.detached++;
    instanceStats.reasons.set(reason, (instanceStats.reasons.get(reason) || 0) + 1);
    console.warn(`[pencil-import] "${node.name || node.id}" (instance of ${node.ref}) built detached: ${reason}`);
  }
  function indexResolved(root) {
    const map = /* @__PURE__ */ new Map();
    (function walk(n, path) {
      if (!n || typeof n !== "object") return;
      if (n.id != null) map.set(String(n.id), { node: n, path });
      if (Array.isArray(n.children)) n.children.forEach((c, i) => walk(c, [...path, i]));
    })(root, []);
    return map;
  }
  async function unwrapLayer(n) {
    if (n.type !== "INSTANCE" || !wrappedMains.size) return n;
    const main = await n.getMainComponentAsync();
    const inst = n;
    return main && wrappedMains.has(main.id) && inst.children.length ? inst.children[0] : n;
  }
  async function layerAt(root, path) {
    let t = root;
    for (const i of path) {
      if (!("children" in t)) return null;
      const kids = t.children;
      if (i < 0 || i >= kids.length) return null;
      t = await unwrapLayer(kids[i]);
    }
    return t;
  }
  var OverrideRefused = class extends Error {
  };
  function expectNear(what, prop, actual, want) {
    if (typeof want !== "number" || !Number.isFinite(want)) return;
    if (Math.abs(actual - want) > 0.5) {
      console.warn(`[pencil-import] Figma kept ${prop}=${Math.round(actual * 100) / 100} on ${what}, Pencil has ${want}`);
      throw new OverrideRefused(`Figma won't override "${prop}" of a layer inside an instance`);
    }
  }
  async function applyFillOverride(target, merged) {
    const t = merged.type;
    if (t === "icon" || t === "icon_font") {
      tintIconVectors(target, iconTint(merged.fill));
      if ("opacity" in target) target.opacity = iconOpacity(merged);
      return;
    }
    const paints = await toPaints(merged.fill);
    if (t === "path" || t === "vector") {
      eachSvgDescendant(target, (c) => {
        if (c.type === "VECTOR") c.fills = paints;
      });
      return;
    }
    if ("fills" in target) target.fills = paints;
  }
  async function applyPathStrokeOverride(target, merged) {
    const th = strokeWeights(merged).max;
    const paints = th > 0 ? await toPaints(merged.stroke) : [];
    eachSvgDescendant(target, (c) => {
      if (c.type !== "VECTOR") return;
      const v = c;
      v.strokes = paints;
      if (th > 0) v.strokeWeight = th;
    });
  }
  function applyLayoutOverride(f, merged, keys, what) {
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
      f.paddingTop = p.top;
      f.paddingRight = p.right;
      f.paddingBottom = p.bottom;
      f.paddingLeft = p.left;
      expectNear(what, "padding", f.paddingTop, p.top);
      expectNear(what, "padding", f.paddingLeft, p.left);
    }
    if (keys.includes("justifyContent") && alignMap[merged.justifyContent]) {
      f.primaryAxisAlignItems = alignMap[merged.justifyContent];
    }
    if (keys.includes("alignItems") && alignMap[merged.alignItems] && alignMap[merged.alignItems] !== "SPACE_BETWEEN") {
      f.counterAxisAlignItems = alignMap[merged.alignItems];
    }
  }
  async function applyOverride(target, merged, ov, what) {
    const keys = Object.keys(ov).filter((k) => !OV_IGNORE.has(k) && k !== "descendants" && !k.startsWith("_"));
    const has = (set) => keys.some((k) => set.has(k));
    const t = merged.type;
    const isText = t === "text" || t === "note" || t === "prompt" || t === "context";
    if (keys.includes("enabled") || keys.includes("visible")) {
      target.visible = !(merged.enabled === false || merged.visible === false);
    }
    if (keys.includes("opacity") && "opacity" in target) {
      target.opacity = isIconType(merged) ? iconOpacity(merged) : merged.opacity != null ? merged.opacity : 1;
    }
    if (keys.includes("blendMode") && merged.blendMode && blendMap[merged.blendMode] && "blendMode" in target) {
      target.blendMode = blendMap[merged.blendMode];
    }
    if (isText && (has(OV_TEXT) || keys.includes("fill"))) {
      if (target.type !== "TEXT") throw new Error(`text override landed on a ${target.type}`);
      await applyTextProps(target, merged);
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
    if (keys.includes("clip") && "clipsContent" in target) target.clipsContent = merged.clip === true;
    if (has(OV_LAYOUT)) {
      if (!("itemSpacing" in target)) throw new Error(`layout override landed on a ${target.type}`);
      applyLayoutOverride(target, merged, keys, what);
    }
  }
  async function applyGeometryOverride(target, merged, keys, what, scaled = false) {
    if (scaled) {
      checkLayerGeometry(target, merged, what, keys.includes("x") || keys.includes("y"));
      return;
    }
    if (keys.includes("layoutPosition") && "layoutPositioning" in target) {
      target.layoutPositioning = merged.layoutPosition === "absolute" ? "ABSOLUTE" : "AUTO";
    }
    if (keys.includes("width") || keys.includes("height")) {
      const t = merged.type;
      const wNum = sizingMode(merged.width) === "FIXED" ? sizingPx(merged.width) : null;
      const hNum = sizingMode(merged.height) === "FIXED" ? sizingPx(merged.height) : null;
      if ((t === "icon" || t === "icon_font") && wNum && hNum && "rescale" in target) {
        const k = Math.min(wNum / target.width, hNum / target.height);
        if (Number.isFinite(k) && k >= 0.01 && Math.abs(k - 1) > 1e-3) target.rescale(k);
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
      target.rotation = merged.rotation;
    }
  }
  async function applyDescendantOverrides(root, index, refId, descendants, prefix, later, scaled = false) {
    for (const [key, ov] of Object.entries(descendants || {})) {
      const full = prefix + key;
      const hit = index.get(`${refId}/${full}`);
      if (!hit) throw new Error(`override target "${full}" is not in the resolved instance`);
      const layer = await layerAt(root, hit.path);
      if (!layer) throw new Error(`no Figma layer at the path of "${full}"`);
      const what = `"${hit.node.name || full}"`;
      await applyOverride(layer, hit.node, ov, what);
      const g = Object.keys(ov).filter((k) => OV_GEOMETRY.has(k));
      if (g.length) later.push(() => applyGeometryOverride(layer, hit.node, g, what, scaled));
      if (ov.descendants) {
        await applyDescendantOverrides(root, index, refId, ov.descendants, full + "/", later, scaled);
      }
    }
  }
  async function applyInstance(inst, entry, node, scaled = false) {
    const resolved = node._resolved;
    if (!resolved || typeof resolved !== "object") throw new Error("the bridge sent no resolved copy of this instance");
    const index = indexResolved(resolved);
    const root = entry.wrapped && inst.children.length ? inst.children[0] : inst;
    if (node.name) inst.name = String(node.name);
    if (node.layoutPosition === "absolute") {
      try {
        inst.layoutPositioning = "ABSOLUTE";
      } catch (e) {
      }
    }
    const later = [];
    await applyDescendantOverrides(root, index, String(node.id), node.descendants, "", later, scaled);
    const own = {};
    for (const k of Object.keys(node)) {
      if (!REF_OWN_SKIP.has(k) && !OV_GEOMETRY.has(k) && !k.startsWith("_")) own[k] = node[k];
    }
    await applyOverride(root, resolved, own, `"${node.name || node.id}"`);
    for (const g of later) await g();
    applyChildSizing(inst, resolved);
    if (node.rotation) inst.rotation = node.rotation;
    if (node.x != null) inst.x = node.x;
    if (node.y != null) inst.y = node.y;
    if (inst.parent) alignToPencilBox(inst, resolved, inst.parent);
  }
  async function buildDetached(node, parent, reason) {
    noteDetached(node, reason);
    if (node._resolved && typeof node._resolved === "object") return build(node._resolved, parent);
    const f = figma.createFrame();
    parent.appendChild(f);
    f.name = String(node.name || node.id || "instance");
    f.fills = [];
    return f;
  }
  async function buildInstance(node, parent) {
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
    } catch (e) {
      try {
        inst.remove();
      } catch (e2) {
      }
      if (e instanceof OverrideRefused) {
        const scaled = await buildScaledInstance(entry, node, parent);
        if (scaled) {
          instanceStats.linked++;
          instanceStats.scaled++;
          await recordInstancePairs(scaled, entry, node._resolved);
          return scaled;
        }
      }
      const reason = e instanceof OverrideRefused ? e.message : `override failed (${(e == null ? void 0 : e.message) || e})`;
      return buildDetached(node, parent, reason);
    }
  }
  async function buildScaledInstance(entry, node, parent) {
    const resolved = node._resolved;
    if (!resolved || typeof resolved !== "object") return null;
    const index = indexResolved(resolved);
    const refId = String(node.id);
    const inst = entry.component.createInstance();
    parent.appendChild(inst);
    const root = entry.wrapped && inst.children.length ? inst.children[0] : inst;
    try {
      const ratios = [];
      const collect = async (desc, prefix) => {
        for (const [key, ov] of Object.entries(desc || {})) {
          const o = ov;
          const full = prefix + key;
          const hit = index.get(`${refId}/${full}`);
          if (hit && (o.width !== void 0 || o.height !== void 0)) {
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
    } catch (e) {
      console.warn(`[pencil-import] "${node.name || node.id}": scaling the instance didn't reproduce Pencil (${(e == null ? void 0 : e.message) || e})`);
      try {
        inst.remove();
      } catch (e2) {
      }
      return null;
    }
  }
  async function restoreAfterScale(layer, n) {
    const t = n.type;
    if (t === "text" || t === "note" || t === "prompt" || t === "context") {
      if (layer.type === "TEXT") await applyTextProps(layer, n);
    } else if (t === "path" || t === "vector") {
      if (n.stroke != null) await applyPathStrokeOverride(layer, n);
    } else if (!isIconType(n)) {
      if ("itemSpacing" in layer && layer.layoutMode !== "NONE") {
        const f = layer;
        f.itemSpacing = typeof n.gap === "number" ? n.gap : 0;
        const p = expandPadding(n.padding);
        f.paddingTop = p.top;
        f.paddingRight = p.right;
        f.paddingBottom = p.bottom;
        f.paddingLeft = p.left;
      }
      if (n.stroke != null) await applyStrokes(layer, n);
      if ("cornerRadius" in layer) applyCornerRadius(layer, n.cornerRadius != null ? n.cornerRadius : 0);
      const fx = n.effect != null ? n.effect : n.effects;
      if ("effects" in layer && (fx != null || layer.effects.length)) applyEffects(layer, fx != null ? fx : []);
    }
    if (Array.isArray(n.children) && "children" in layer) {
      const kids = layer.children;
      for (let i = 0; i < n.children.length && i < kids.length; i++) {
        await restoreAfterScale(await unwrapLayer(kids[i]), n.children[i]);
      }
    }
  }
  function checkLayerGeometry(layer, n, what, position) {
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
  async function verifyScaledGeometry(layer, n, parentLayout) {
    const absolute = parentLayout !== null && (n.layoutPosition === "absolute" || parentLayout === "none");
    checkLayerGeometry(layer, n, `"${n.name || n.id}"`, absolute);
    if (Array.isArray(n.children) && "children" in layer) {
      const kids = layer.children;
      const lay = n.layout === "vertical" || n.layout === "horizontal" || n.layout === "none" ? n.layout : "horizontal";
      for (let i = 0; i < n.children.length && i < kids.length; i++) {
        await verifyScaledGeometry(await unwrapLayer(kids[i]), n.children[i], lay);
      }
    }
  }
  var builtPairs = [];
  var pencilOf = /* @__PURE__ */ new Map();
  var layoutIssues = [];
  var textFixes = 0;
  var trackingShifts = 0;
  var MAX_ISSUES = 300;
  function noteIssue(frame, node, kind, detail) {
    if (layoutIssues.length >= MAX_ISSUES) return;
    layoutIssues.push({ frame, node: String(node.name || node.id), kind, detail });
  }
  async function recordInstancePairs(inst, entry, resolved) {
    if (!resolved || typeof resolved !== "object") return;
    const root = entry.wrapped && inst.children.length ? inst.children[0] : inst;
    const walk = async (n, f) => {
      builtPairs.push({ node: n, fig: f });
      if (!Array.isArray(n.children) || !("children" in f)) return;
      const kids = f.children;
      for (let i = 0; i < n.children.length && i < kids.length; i++) await walk(n.children[i], await unwrapLayer(kids[i]));
    };
    await walk(resolved, root);
  }
  function isRendered(n) {
    let cur = n;
    while (cur && cur.type !== "PAGE") {
      if ("visible" in cur && !cur.visible) return false;
      cur = cur.parent;
    }
    return true;
  }
  function textLineHeightPx(t) {
    const fs = typeof t.fontSize === "number" ? t.fontSize : 16;
    const lh = t.lineHeight;
    if (lh === figma.mixed || !lh) return fs * 1.2;
    if (lh.unit === "PIXELS") return lh.value;
    if (lh.unit === "PERCENT") return lh.value / 100 * fs;
    return fs * 1.2;
  }
  function letterSpacingPx(t) {
    const ls = t.letterSpacing;
    if (ls === figma.mixed) return null;
    const fs = typeof t.fontSize === "number" ? t.fontSize : 16;
    return ls.unit === "PIXELS" ? ls.value : ls.value / 100 * fs;
  }
  function matchAutoWidth(frame, node, t) {
    const box = node._box;
    if (!Array.isArray(box) || !isRendered(t)) return;
    const pw = box[2];
    const n = t.characters.length;
    const base = letterSpacingPx(t);
    if (base == null || n < 1 || !(pw > 0)) return;
    const w0 = t.width;
    const diff = pw - w0;
    if (Math.abs(diff) <= 0.15) return;
    if (n === 1 && Math.abs(base) > 0.01 && Math.abs(diff - base) <= 0.6) {
      try {
        const h = t.height;
        t.textAutoResize = "NONE";
        t.resize(pw, h);
      } catch (e) {
      }
      return;
    }
    if (Math.abs(diff) > pw * 0.03 && Math.abs(diff) > 1.5) {
      noteIssue(
        frame,
        node,
        "text-width",
        `${Math.round(w0)}px wide in Figma, ${Math.round(pw)}px in Pencil \u2014 more than glyph drift, check the font`
      );
      return;
    }
    if (n < 2) return;
    let ls = base + diff / n;
    const limit = Math.abs(base) + pw * 0.03 / n;
    for (let i = 0; i < 6; i++) {
      t.letterSpacing = { value: +ls.toFixed(3), unit: "PIXELS" };
      const rest = pw - t.width;
      if (Math.abs(rest) <= (Number.isInteger(t.width) ? 0.51 : 0.3)) return;
      const next = ls + rest / Math.max(1, n - 1);
      if (Math.abs(next) > limit) break;
      ls = next;
    }
    if (Math.abs(pw - t.width) > Math.abs(diff)) t.letterSpacing = { value: base, unit: "PIXELS" };
  }
  function matchCenteredTracking(node, t) {
    if (t.textAlignHorizontal !== "CENTER" || t.textAutoResize === "WIDTH_AND_HEIGHT") return;
    const ls = Number(node.letterSpacing) || 0;
    if (Math.abs(ls) < 0.25 || t.letterSpacing === figma.mixed) return;
    const parent = t.parent;
    const inFlow = !!parent && "layoutMode" in parent && parent.layoutMode !== "NONE" && t.layoutPositioning !== "ABSOLUTE";
    if (inFlow) return;
    const m = t.relativeTransform;
    t.relativeTransform = [
      [m[0][0], m[0][1], m[0][2] - ls * m[0][0]],
      [m[1][0], m[1][1], m[1][2] - ls * m[1][0]]
    ];
    trackingShifts++;
  }
  async function matchLineBreaks(frame, node, t) {
    const box = node._box;
    if (!Array.isArray(box) || !isRendered(t)) return;
    const text = t.characters;
    if (!/\S\s+\S/.test(text)) return;
    const [, , pw, ph] = box;
    const lh = textLineHeightPx(t);
    if (ph < lh * 1.5 && t.height < lh * 1.5) return;
    const W = t.width;
    if (Math.abs(W - pw) > 1) return;
    const base = letterSpacingPx(t);
    if (base == null) return;
    let probe = null;
    try {
      probe = t.clone();
      probe.x = -1e5;
      probe.y = -1e5;
      probe.textAutoResize = "WIDTH_AND_HEIGHT";
      const p = probe;
      const measure = (str) => {
        p.characters = str;
        return p.width;
      };
      const spaceAdvance = measure("x x") - measure("xx");
      const breaks = [];
      let offset = 0;
      for (const para of text.split("\n")) {
        const words = [];
        const re = /\S+/g;
        let m;
        while (m = re.exec(para)) words.push({ s: m.index, e: m.index + m[0].length });
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
      const zero = { value: +(base - spaceAdvance).toFixed(3), unit: "PIXELS" };
      for (const [a, b] of breaks) t.setRangeLetterSpacing(a, b, zero);
      textFixes++;
    } catch (e) {
      console.warn(`[pencil-import] line-break check failed for "${node.name || node.id}":`, (e == null ? void 0 : e.message) || e);
    } finally {
      try {
        probe == null ? void 0 : probe.remove();
      } catch (e) {
      }
    }
  }
  async function fixTextLines(frame, node, t) {
    const box = node._box;
    if (!Array.isArray(box) || t.removed || !isRendered(t)) return;
    const [, , pw, ph] = box;
    const lh = textLineHeightPx(t);
    if (Math.abs(t.height - ph) < lh * 0.5) return;
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
      noteIssue(
        frame,
        node,
        "text-lines",
        `${Math.round(t.height / lh)} line(s) in Figma, ${Math.round(ph / lh)} in Pencil after matching Pencil's line breaks`
      );
      return;
    }
    const base = ls.unit === "PIXELS" ? ls.value : ls.value / 100 * fs;
    const dir = t.height > ph ? -1 : 1;
    const step = fs * 4e-3;
    for (let i = 1; i <= 8; i++) {
      t.letterSpacing = { value: +(base + dir * step * i).toFixed(3), unit: "PIXELS" };
      if (Math.abs(t.height - ph) < lh * 0.5) {
        textFixes++;
        return;
      }
    }
    t.letterSpacing = ls;
    noteIssue(
      frame,
      node,
      "text-lines",
      `${Math.round(t.height / lh)} line(s) in Figma, ${Math.round(ph / lh)} in Pencil \u2014 letter spacing within \xB13% didn't fix it`
    );
  }
  var pinnedSizes = 0;
  function pinFillToPencil(node, f) {
    const box = node._box;
    if (!Array.isArray(box) || f.removed || f.type === "TEXT" || node.rotation || !isRendered(f)) return;
    if (!("layoutSizingHorizontal" in f) || !("resize" in f)) return;
    for (const axis of ["Horizontal", "Vertical"]) {
      const horizontal = axis === "Horizontal";
      const want = horizontal ? box[2] : box[3];
      const have = horizontal ? f.width : f.height;
      if (!(want > 0) || Math.abs(have - want) <= 1) continue;
      if (sizingMode(horizontal ? node.width : node.height) !== "FILL") continue;
      try {
        f["layoutSizing" + axis] = "FIXED";
        f.resize(horizontal ? want : f.width, horizontal ? f.height : want);
        pinnedSizes++;
      } catch (e) {
      }
    }
  }
  var negativeGaps = 0;
  function fixOverflowingSpaceBetween(node, f) {
    if (f.removed || !("primaryAxisAlignItems" in f) || !Array.isArray(node.children)) return;
    const fr = f;
    if (fr.layoutMode === "NONE" || fr.primaryAxisAlignItems !== "SPACE_BETWEEN" || !isRendered(fr)) return;
    const horizontal = fr.layoutMode === "HORIZONTAL";
    const kids = node.children.map((c, i) => ({ c, fig: fr.children[i] })).filter((k) => k.fig && k.fig.visible && k.c && Array.isArray(k.c._box) && k.c.enabled !== false && k.c.visible !== false && k.c.layoutPosition !== "absolute");
    if (kids.length < 2) return;
    const gaps = [];
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1].c._box, b = kids[i].c._box;
      gaps.push(horizontal ? b[0] - (a[0] + a[2]) : b[1] - (a[1] + a[3]));
    }
    const g = gaps[0];
    if (!(g < -0.5) || gaps.some((x) => Math.abs(x - g) > 0.5)) return;
    try {
      fr.primaryAxisAlignItems = "MIN";
      fr.itemSpacing = g;
      negativeGaps++;
    } catch (e) {
    }
  }
  function compareBox(frame, node, f) {
    const box = node._box;
    if (!Array.isArray(box) || f.removed || !isRendered(f) || node.rotation) return;
    const [, , pw, ph] = box;
    if (f.type === "TEXT") {
      const t = f;
      const lh = textLineHeightPx(t);
      if (Math.abs(t.width - pw) > Math.max(2, pw * 0.012)) {
        noteIssue(frame, node, "size", `width ${Math.round(t.width)} vs Pencil ${Math.round(pw)}`);
      } else if (Math.abs(t.height - ph) > 1 && Math.abs(t.height - ph) < lh * 0.5) {
        noteIssue(frame, node, "text-height", `${Math.round(t.height)}px tall in Figma, ${Math.round(ph)}px in Pencil`);
      }
      return;
    }
    if (Math.abs(f.width - pw) > 1 || Math.abs(f.height - ph) > 1) {
      noteIssue(
        frame,
        node,
        "size",
        `${Math.round(f.width * 10) / 10}\xD7${Math.round(f.height * 10) / 10} vs Pencil ${Math.round(pw * 10) / 10}\xD7${Math.round(ph * 10) / 10}` + childDrift(f)
      );
    }
  }
  function childDrift(f, depth = 0) {
    if (!("children" in f)) return "";
    const parts = [];
    const r = (v) => Math.round(v * 100) / 100;
    for (const c of f.children) {
      const n = pencilOf.get(c.id);
      const b = n && n._box;
      if (!Array.isArray(b)) continue;
      const dw = c.width - b[2], dh = c.height - b[3];
      if (Math.abs(dw) < 0.05 && Math.abs(dh) < 0.05) continue;
      let what = `${n.name || n.id} ${dw >= 0 ? "+" : ""}${r(dw)}\xD7${dh >= 0 ? "+" : ""}${r(dh)}`;
      if (c.type === "TEXT") {
        const t = c;
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
  async function checkLayout(frame) {
    const pairs = builtPairs;
    builtPairs = [];
    pencilOf = new Map(pairs.map((p) => [p.fig.id, p.node]));
    const texts = pairs.filter((p) => p.fig.type === "TEXT" && !p.fig.removed && Array.isArray(p.node._box));
    for (const { node, fig } of texts) {
      const t = fig;
      try {
        if (t.textAutoResize === "WIDTH_AND_HEIGHT") matchAutoWidth(frame, node, t);
        else if (t.textAutoResize === "HEIGHT") await matchLineBreaks(frame, node, t);
        await fixTextLines(frame, node, t);
        matchCenteredTracking(node, t);
      } catch (e) {
        console.warn("[pencil-import] text check failed:", (e == null ? void 0 : e.message) || e);
      }
    }
    for (const { node, fig } of pairs) {
      try {
        pinFillToPencil(node, fig);
      } catch (e) {
      }
    }
    for (const { node, fig } of pairs) {
      try {
        fixOverflowingSpaceBetween(node, fig);
      } catch (e) {
      }
    }
    for (const { node, fig } of pairs) {
      try {
        compareBox(frame, node, fig);
      } catch (e) {
      }
    }
  }
  function textBoxesOf(frame) {
    const fb = frame.absoluteBoundingBox;
    if (!fb || !("findAllWithCriteria" in frame)) return [];
    const out = [];
    for (const t of frame.findAllWithCriteria({ types: ["TEXT"] })) {
      const b = t.absoluteBoundingBox;
      if (!b || !t.visible) continue;
      out.push([Math.round(b.x - fb.x), Math.round(b.y - fb.y), Math.round(b.width), Math.round(b.height)]);
    }
    return out;
  }
  function placeNestedDefinition(node, parent) {
    const entry = components.get(String(node.id));
    const n = buildingComponents ? entry.component.createInstance() : entry.component;
    parent.appendChild(n);
    if (!buildingComponents) nestedPending.delete(String(node.id));
    if (node.layoutPosition === "absolute") {
      try {
        n.layoutPositioning = "ABSOLUTE";
      } catch (e) {
      }
    }
    applyChildSizing(n, node);
    if (node.rotation) n.rotation = node.rotation;
    if (node.x != null) n.x = node.x;
    if (node.y != null) n.y = node.y;
    return n;
  }
  function orderDefinitions(defs) {
    const byId = new Map(defs.map((d) => [String(d.id), d]));
    const deps = (d) => {
      const out = /* @__PURE__ */ new Set();
      (function walk(n, isRoot) {
        if (!n || typeof n !== "object") return;
        if (!isRoot && n.reusable === true && n.id != null) out.add(String(n.id));
        if (n.type === "ref" && n.ref != null) out.add(String(n.ref));
        if (Array.isArray(n.children)) n.children.forEach((c) => walk(c, false));
      })(d, true);
      return out;
    };
    const done = /* @__PURE__ */ new Set();
    const visiting = /* @__PURE__ */ new Set();
    const order = [];
    const visit = (id) => {
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
  async function buildComponent(def, parent) {
    const built = await build(def, parent);
    const comp = figma.createComponentFromNode(built);
    const wrapped = !built.removed && built.parent != null && built.parent.id === comp.id;
    if (wrapped && "constraints" in built) {
      try {
        built.constraints = { horizontal: "STRETCH", vertical: "STRETCH" };
      } catch (e) {
      }
    }
    if (def.name) comp.name = String(def.name);
    components.set(String(def.id), { component: comp, wrapped });
    if (wrapped) wrappedMains.add(comp.id);
    return comp;
  }
  var BOX_SHADOW_TYPES = /* @__PURE__ */ new Set(["FRAME", "COMPONENT", "RECTANGLE", "ELLIPSE", "POLYGON", "STAR"]);
  function hasVisibleFill(n) {
    if (!("fills" in n)) return false;
    const fills = n.fills;
    if (fills === figma.mixed) return true;
    return fills.some((p) => p.visible !== false && (p.opacity == null || p.opacity > 1e-3));
  }
  function hideShadowUnderFill(n) {
    if (!BOX_SHADOW_TYPES.has(n.type) || !("effects" in n)) return;
    const f = n;
    if (!f.effects.some((e) => e.type === "DROP_SHADOW") || !hasVisibleFill(n)) return;
    try {
      f.effects = f.effects.map((e) => e.type === "DROP_SHADOW" ? __spreadProps(__spreadValues({}, e), { showShadowBehindNode: false }) : e);
    } catch (e) {
    }
  }
  function emulateBoxShadow(n, node) {
    if (n.type !== "FRAME" || node.type !== "frame") return;
    const f = n;
    const shadows = f.effects.filter((e) => e.type === "DROP_SHADOW" && e.visible !== false);
    if (!shadows.length || f.clipsContent) return;
    if (hasVisibleFill(f)) return;
    const parent = f.parent;
    if (!parent || !("insertChild" in parent) || parent.type === "INSTANCE") return;
    const w = f.width, h = f.height;
    if (!(w > 0 && h > 0)) return;
    const margin = Math.ceil(Math.max(...shadows.map((e) => e.radius * 2 + Math.max(Math.abs(e.offset.x), Math.abs(e.offset.y)) + Math.abs(e.spread || 0)))) + 2;
    const radius = typeof f.cornerRadius === "number" ? f.cornerRadius : 0;
    const made = [];
    try {
      const auto = f.layoutMode !== "NONE";
      const place = (r, x, y) => {
        if (auto) {
          try {
            r.layoutPositioning = "ABSOLUTE";
          } catch (e) {
          }
        }
        r.x = x;
        r.y = y;
      };
      const outer = figma.createRectangle();
      f.appendChild(outer);
      made.push(outer);
      place(outer, -margin, -margin);
      outer.resize(w + 2 * margin, h + 2 * margin);
      const hole = figma.createRectangle();
      f.appendChild(hole);
      made.push(hole);
      place(hole, 0, 0);
      hole.resize(w, h);
      hole.cornerRadius = radius;
      const ring = figma.subtract([outer, hole], f);
      made.length = 0;
      made.push(ring);
      ring.isMask = true;
      const caster = figma.createRectangle();
      f.appendChild(caster);
      made.push(caster);
      place(caster, 0, 0);
      caster.resize(w, h);
      caster.cornerRadius = radius;
      caster.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
      caster.effects = shadows;
      const group = figma.group([ring, caster], f);
      made.length = 0;
      made.push(group);
      group.name = "\u0422\u0435\u043D\u044C \u043F\u043E \u0440\u0430\u043C\u043A\u0435";
      const p = parent;
      p.insertChild(p.children.indexOf(f), group);
      if ("layoutMode" in p && p.layoutMode !== "NONE") {
        try {
          group.layoutPositioning = "ABSOLUTE";
        } catch (e) {
        }
      }
      const m = f.relativeTransform;
      group.relativeTransform = [
        [m[0][0], m[0][1], m[0][2] - margin * (m[0][0] + m[0][1])],
        [m[1][0], m[1][1], m[1][2] - margin * (m[1][0] + m[1][1])]
      ];
    } catch (e) {
      for (const m of made) {
        try {
          m.remove();
        } catch (e2) {
        }
      }
      console.warn(`[pencil-import] box shadow for "${node.name || node.id}" left as a content shadow:`, (e == null ? void 0 : e.message) || e);
    }
  }
  function alignToPencilBox(n, node, parent) {
    const box = node._box;
    if (!Array.isArray(box) || node.rotation || !("absoluteBoundingBox" in n)) return;
    if (!("absoluteBoundingBox" in parent)) return;
    const pb = parent.absoluteBoundingBox;
    const nb = n.absoluteBoundingBox;
    if (!pb || !nb) return;
    const dx = box[0] - (nb.x - pb.x);
    const dy = box[1] - (nb.y - pb.y);
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;
    try {
      n.x += dx;
      n.y += dy;
    } catch (e) {
    }
  }
  function countNodes(t) {
    let c = 1;
    if (Array.isArray(t.children)) for (const ch of t.children) c += countNodes(ch);
    return c;
  }
  var pluginLog = [];
  var MAX_LOG = 600;
  for (const level of ["warn", "error"]) {
    const orig = console[level].bind(console);
    try {
      console[level] = (...args) => {
        if (pluginLog.length < MAX_LOG) {
          pluginLog.push(`${level}: ` + args.map((a) => typeof a === "string" ? a : (() => {
            try {
              return JSON.stringify(a);
            } catch (e) {
              return String(a);
            }
          })()).join(" "));
        }
        orig(...args);
      };
    } catch (e) {
    }
  }
  figma.ui.onmessage = async (msg) => {
    if (msg.type !== "import") return;
    let tree = msg.tree;
    let defs = Array.isArray(msg.components) ? msg.components : [];
    if (tree && !Array.isArray(tree) && tree.type == null && tree.tree != null) {
      if (Array.isArray(tree.components)) defs = tree.components;
      tree = tree.tree;
    }
    const opts = msg.opts || {};
    try {
      truncatedNodes = [];
      fontFallbacks = /* @__PURE__ */ new Map();
      components = /* @__PURE__ */ new Map();
      wrappedMains = /* @__PURE__ */ new Set();
      nestedPending = /* @__PURE__ */ new Set();
      buildingComponents = false;
      instanceStats = { linked: 0, scaled: 0, detached: 0, reasons: /* @__PURE__ */ new Map() };
      pinnedSizes = 0;
      negativeGaps = 0;
      builtPairs = [];
      layoutIssues = [];
      textFixes = 0;
      trackingShifts = 0;
      pluginLog = [];
      const roots = Array.isArray(tree) ? tree : [tree];
      const count = roots.reduce((s, r) => s + countNodes(r), 0) + defs.reduce((s, r) => s + countNodes(r), 0);
      figma.ui.postMessage({ type: "progress", text: `Creating ${count} nodes\u2026` });
      let parent = figma.currentPage;
      let wrapper = null;
      if (opts.frameWrap) {
        const w = figma.createFrame();
        w.name = "Pencil Import";
        w.clipsContent = false;
        w.fills = [];
        figma.currentPage.appendChild(w);
        wrapper = w;
        parent = w;
      }
      const topComponents = [];
      if (defs.length) {
        figma.ui.postMessage({ type: "progress", text: `Creating ${defs.length} components\u2026` });
        buildingComponents = true;
        try {
          for (const def of orderDefinitions(defs)) {
            try {
              const comp = await buildComponent(def, parent);
              await checkLayout(String(def.name || def.id));
              if (def._topLevel === false) nestedPending.add(String(def.id));
              else topComponents.push(comp);
            } catch (e) {
              console.error(`[pencil-import] component "${def.name || def.id}" failed:`, (e == null ? void 0 : e.message) || e);
            }
          }
        } finally {
          buildingComponents = false;
        }
        figma.ui.postMessage({ type: "progress", text: `Creating ${count} nodes\u2026` });
      }
      const created = [];
      const pages = [];
      for (const root of roots) {
        builtPairs = [];
        const node = await build(root, parent);
        created.push(node);
        pages.push({ root, fig: node });
        await checkLayout(String(root.name || root.id));
      }
      for (const id of nestedPending) {
        const e = components.get(id);
        if (e) topComponents.push(e.component);
      }
      created.push(...topComponents);
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
      const fontIssues = [];
      fontFallbacks.forEach((used, asked) => fontIssues.push(`${asked} \u2192 ${used}`));
      if (fontIssues.length) {
        console.warn(
          `[pencil-import] ${fontIssues.length} font(s) were substituted \u2014 install them in Figma for a 1:1 result:
  ` + fontIssues.join("\n  ")
        );
      }
      if (layoutIssues.length || textFixes || pinnedSizes) {
        console.log(
          `[pencil-import] layout vs Pencil: ${textFixes} text wrap(s) corrected, ${pinnedSizes} fill size(s) pinned, ${layoutIssues.length} mismatch(es)` + (layoutIssues.length ? ":\n  " + layoutIssues.slice(0, 40).map((i) => `${i.frame} \u203A ${i.node}: ${i.kind} \u2014 ${i.detail}`).join("\n  ") : "")
        );
      }
      const detachReasons = [];
      instanceStats.reasons.forEach((n, why) => detachReasons.push(`${n}\xD7 ${why}`));
      const componentSummary = components.size ? { components: components.size, linked: instanceStats.linked, scaled: instanceStats.scaled, detached: instanceStats.detached, reasons: detachReasons } : null;
      if (componentSummary) {
        console.log(
          `[pencil-import] ${components.size} component(s), ${instanceStats.linked} linked instance(s), ${instanceStats.detached} detached` + (detachReasons.length ? `:
  ` + detachReasons.join("\n  ") : "")
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
        verifying: !!(msg.session && opts.verify !== false)
      });
      if (msg.session && opts.verify !== false) {
        figma.ui.postMessage({ type: "progress", text: `Checking ${pages.length} frame(s) against Pencil\u2026` });
        for (const { root, fig } of pages) {
          if (fig.removed || !("exportAsync" in fig)) continue;
          try {
            const bytes = await fig.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
            figma.ui.postMessage({ type: "render", id: String(root.id), name: String(root.name || root.id), bytes, texts: textBoxesOf(fig) });
          } catch (e) {
            console.warn(`[pencil-import] could not render "${root.name}" for the 1:1 check:`, (e == null ? void 0 : e.message) || e);
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
            log: pluginLog
          }
        });
      }
      if (truncatedNodes.length) {
        const names = truncatedNodes.slice(0, 3).join(", ");
        figma.notify(
          `Imported ${count} nodes, but ${truncatedNodes.length} subtree(s) were incomplete (${names}${truncatedNodes.length > 3 ? "\u2026" : ""}). Check the bridge log.`,
          { error: true, timeout: 8e3 }
        );
      } else if (fontIssues.length) {
        figma.notify(
          `Imported ${count} nodes. ${fontIssues.length} font(s) substituted: ${fontIssues.slice(0, 2).join(", ")}${fontIssues.length > 2 ? "\u2026" : ""} \u2014 see console.`,
          { timeout: 8e3 }
        );
      } else if (componentSummary) {
        figma.notify(
          `Imported ${count} nodes: ${componentSummary.components} components, ${componentSummary.linked} instances` + (componentSummary.detached ? `, ${componentSummary.detached} detached \u2014 see console` : ""),
          { timeout: 8e3 }
        );
      } else {
        figma.notify(`Pencil \u2192 Figma: imported ${count} nodes`);
      }
    } catch (e) {
      console.error(e);
      figma.ui.postMessage({ type: "error", error: (e == null ? void 0 : e.message) || String(e) });
      figma.notify("Import failed: " + ((e == null ? void 0 : e.message) || e), { error: true });
    }
  };
})();
