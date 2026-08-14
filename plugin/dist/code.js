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
    try {
      await figma.loadFontAsync({ family, style: "Regular" });
      fontCache.add(`${family}|Regular`);
      fontFallbacks.set(`${family} ${style}`, `${family} Regular`);
      return { family, style: "Regular" };
    } catch (e) {
      await figma.loadFontAsync({ family: "Inter", style: "Regular" });
      fontCache.add("Inter|Regular");
      fontFallbacks.set(`${family} ${style}`, "Inter Regular");
      return { family: "Inter", style: "Regular" };
    }
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
        list.push({
          type: inner ? "INNER_SHADOW" : "DROP_SHADOW",
          color: __spreadProps(__spreadValues({}, rgb), { a: e.opacity != null ? e.opacity : a }),
          offset: { x: offX, y: offY },
          radius: blurRadius,
          spread: e.spread || 0,
          visible: true,
          blendMode: "NORMAL"
        });
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
    const paint = { type: "SOLID", color: rgb, opacity: tint.alpha };
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
      try {
        frame.resize(wNum, hNum);
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
        const family = node.fontFamily || "Inter";
        let style = weightToStyle(node.fontWeight);
        if (/^italic$/i.test(String(node.fontStyle || ""))) {
          style = style === "Regular" ? "Italic" : `${style} Italic`;
        }
        const f = await ensureFont(family, style);
        const txt = figma.createText();
        try {
          txt.fontName = { family: f.family, style: f.style };
        } catch (e) {
          txt.fontName = { family: "Inter", style: "Regular" };
        }
        if (node.fontSize != null) txt.fontSize = node.fontSize;
        txt.characters = String(node.content != null ? node.content : "");
        if (node.letterSpacing != null) {
          txt.letterSpacing = { value: node.letterSpacing, unit: "PIXELS" };
        }
        if (node.lineHeight != null) {
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
    const n = await createNode(node);
    parent.appendChild(n);
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
    if ("strokes" in n && node.stroke != null && !isPathVector) {
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
    if (node.cornerRadius != null) applyCornerRadius(n, node.cornerRadius);
    if (node.opacity != null && "opacity" in n) n.opacity = node.opacity;
    if (node.blendMode && blendMap[node.blendMode] && "blendMode" in n) {
      n.blendMode = blendMap[node.blendMode];
    }
    if (node.effect != null) applyEffects(n, node.effect);
    else if (node.effects != null) applyEffects(n, node.effects);
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
    return n;
  }
  function countNodes(t) {
    let c = 1;
    if (Array.isArray(t.children)) for (const ch of t.children) c += countNodes(ch);
    return c;
  }
  figma.ui.onmessage = async (msg) => {
    if (msg.type !== "import") return;
    const tree = msg.tree;
    const opts = msg.opts || {};
    try {
      truncatedNodes = [];
      fontFallbacks = /* @__PURE__ */ new Map();
      const roots = Array.isArray(tree) ? tree : [tree];
      const count = roots.reduce((s, r) => s + countNodes(r), 0);
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
      const created = [];
      for (const root of roots) {
        const node = await build(root, parent);
        created.push(node);
      }
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
      figma.ui.postMessage({
        type: "done",
        count,
        truncated: truncatedNodes.length,
        fontFallbacks: fontIssues
      });
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
