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
  var fontCache = /* @__PURE__ */ new Set();
  async function ensureFont(family, style) {
    const key = `${family}|${style}`;
    if (fontCache.has(key)) return { family, style };
    try {
      await figma.loadFontAsync({ family, style });
      fontCache.add(key);
      return { family, style };
    } catch (e) {
      try {
        await figma.loadFontAsync({ family, style: "Regular" });
        fontCache.add(`${family}|Regular`);
        return { family, style: "Regular" };
      } catch (e2) {
        await figma.loadFontAsync({ family: "Inter", style: "Regular" });
        fontCache.add("Inter|Regular");
        return { family: "Inter", style: "Regular" };
      }
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
      return { type: "SOLID", color: rgb, opacity: fill.opacity != null ? fill.opacity : a };
    }
    if (fill.type === "image" && fill.data) {
      try {
        const bytes = base64ToBytes(fill.data);
        const img = figma.createImage(bytes);
        const modeMap = {
          fill: "FILL",
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
    if (fill.type === "gradient" && Array.isArray(fill.stops)) {
      const stops = fill.stops.map((s) => {
        const c = typeof s.color === "string" ? parseColor(s.color) : { rgb: { r: 0, g: 0, b: 0 }, a: 1 };
        return {
          position: s.position,
          color: __spreadProps(__spreadValues({}, c.rgb), { a: s.opacity != null ? s.opacity : c.a })
        };
      });
      const typeMap = {
        linear: "GRADIENT_LINEAR",
        radial: "GRADIENT_RADIAL",
        angular: "GRADIENT_ANGULAR",
        diamond: "GRADIENT_DIAMOND"
      };
      return {
        type: typeMap[fill.kind || "linear"] || "GRADIENT_LINEAR",
        gradientStops: stops,
        gradientTransform: fill.transform || [[1, 0, 0], [0, 1, 0]],
        opacity: fill.opacity
      };
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
    stretch: "MIN"
  };
  function applyAutoLayout(frame, node) {
    let mode = node.layout;
    if (mode !== "vertical" && mode !== "horizontal") {
      if (mode != null && mode !== "none") return;
      const kids = Array.isArray(node.children) ? node.children : [];
      const anyChildIsAbsolute = kids.some(
        (c) => c && typeof c === "object" && (typeof c.x === "number" && c.x !== 0 || typeof c.y === "number" && c.y !== 0)
      );
      if (anyChildIsAbsolute) return;
      if (kids.length === 0) return;
      mode = "horizontal";
    }
    frame.layoutMode = mode === "vertical" ? "VERTICAL" : "HORIZONTAL";
    const primaryDim = mode === "vertical" ? node.height : node.width;
    const counterDim = mode === "vertical" ? node.width : node.height;
    const setSizingMode = (which, dim) => {
      let val;
      if (typeof dim === "number") val = "FIXED";
      else if (dim === "fit_content" || dim == null) val = "AUTO";
      else val = "FIXED";
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
      frame.primaryAxisAlignItems = alignMap[node.justifyContent];
    }
    if (node.alignItems && alignMap[node.alignItems]) {
      const v = alignMap[node.alignItems];
      if (v !== "SPACE_BETWEEN") frame.counterAxisAlignItems = v;
    }
    if (node.alignItems === "stretch" && "layoutAlign" in frame) {
    }
  }
  function applyChildSizing(n, node) {
    if (!("layoutSizingHorizontal" in n)) return;
    if (n.type === "TEXT") {
      const txt = n;
      const wantsFillW = node.width === "fill_container";
      const wantsFixedW = typeof node.width === "number";
      if (wantsFillW || wantsFixedW) {
        try {
          txt.textAutoResize = "HEIGHT";
        } catch (e) {
        }
      } else {
        try {
          txt.textAutoResize = "WIDTH_AND_HEIGHT";
        } catch (e) {
        }
      }
    }
    const set = (axis, val) => {
      if (val === "fill_container") {
        n["layoutSizing" + axis] = "FILL";
      } else if (val === "fit_content") {
        n["layoutSizing" + axis] = "HUG";
      } else {
        n["layoutSizing" + axis] = "FIXED";
      }
    };
    if (node.width != null) {
      try {
        set("Horizontal", node.width);
      } catch (e) {
      }
    }
    if (node.height != null) {
      try {
        set("Vertical", node.height);
      } catch (e) {
      }
    }
    if ("resize" in n) {
      const wNum = typeof node.width === "number" ? node.width : null;
      const hNum = typeof node.height === "number" ? node.height : null;
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
  function applyEffects(n, effects) {
    if (!("effects" in n) || !Array.isArray(effects)) return;
    const list = [];
    for (const e of effects) {
      if (!e || e.enabled === false) continue;
      if (e.type === "drop_shadow" || e.type === "drop-shadow" || e.type === "shadow") {
        const { rgb, a } = parseColor(e.color || "#00000040");
        list.push({
          type: "DROP_SHADOW",
          color: __spreadProps(__spreadValues({}, rgb), { a: e.opacity != null ? e.opacity : a }),
          offset: { x: e.offsetX || 0, y: e.offsetY || 0 },
          radius: e.blur || 0,
          spread: e.spread || 0,
          visible: true,
          blendMode: "NORMAL"
        });
      } else if (e.type === "inner_shadow" || e.type === "inner-shadow") {
        const { rgb, a } = parseColor(e.color || "#00000040");
        list.push({
          type: "INNER_SHADOW",
          color: __spreadProps(__spreadValues({}, rgb), { a: e.opacity != null ? e.opacity : a }),
          offset: { x: e.offsetX || 0, y: e.offsetY || 0 },
          radius: e.blur || 0,
          spread: e.spread || 0,
          visible: true,
          blendMode: "NORMAL"
        });
      } else if (e.type === "blur" || e.type === "layer_blur") {
        list.push({ type: "LAYER_BLUR", radius: e.blur || 0, visible: true, blurType: "NORMAL" });
      } else if (e.type === "background_blur" || e.type === "background-blur") {
        list.push({ type: "BACKGROUND_BLUR", radius: e.blur || 0, visible: true, blurType: "NORMAL" });
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
  async function createNode(node) {
    switch (node.type) {
      case "frame":
        return figma.createFrame();
      case "rectangle":
        return figma.createRectangle();
      case "ellipse":
        return figma.createEllipse();
      case "line":
        return figma.createLine();
      case "polygon":
        return figma.createPolygon();
      case "path":
      case "vector":
        return figma.createVector();
      case "text": {
        const family = node.fontFamily || "Inter";
        const style = weightToStyle(node.fontWeight);
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
        if (node.textDecoration && td[node.textDecoration]) txt.textDecoration = td[node.textDecoration];
        const paints = await toPaints(node.fill);
        if (paints.length) txt.fills = paints;
        return txt;
      }
      default:
        return figma.createFrame();
    }
  }
  async function build(node, parent) {
    const n = await createNode(node);
    parent.appendChild(n);
    if (node.name) n.name = String(node.name);
    if (node.visible === false) n.visible = false;
    const wNum = typeof node.width === "number" ? node.width : null;
    const hNum = typeof node.height === "number" ? node.height : null;
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
    if (node.type !== "text" && "fills" in n) {
      const paints = await toPaints(node.fill);
      if (paints.length) {
        n.fills = paints;
      } else if (node.fill == null && node.fills == null) {
        n.fills = [];
      }
    }
    if ("strokes" in n && node.stroke) {
      const sp = await toPaint(node.stroke.fill || node.stroke);
      if (sp) n.strokes = [sp];
      if (node.stroke.thickness != null) n.strokeWeight = node.stroke.thickness;
      const sa = node.stroke.align;
      if (sa) {
        const m = {
          inside: "INSIDE",
          outside: "OUTSIDE",
          center: "CENTER"
        };
        if (m[sa] && "strokeAlign" in n) n.strokeAlign = m[sa];
      }
    }
    if (node.cornerRadius != null) applyCornerRadius(n, node.cornerRadius);
    if (node.opacity != null && "opacity" in n) n.opacity = node.opacity;
    if (node.blendMode && blendMap[node.blendMode] && "blendMode" in n) {
      n.blendMode = blendMap[node.blendMode];
    }
    if (node.effects) applyEffects(n, node.effects);
    if (n.type === "FRAME") {
      n.clipsContent = node.clip === true;
      applyAutoLayout(n, node);
    }
    if (Array.isArray(node.children) && "appendChild" in n) {
      for (const child of node.children) {
        await build(child, n);
      }
    }
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
      figma.ui.postMessage({ type: "done", count });
      figma.notify(`Pencil \u2192 Figma: imported ${count} nodes`);
    } catch (e) {
      console.error(e);
      figma.ui.postMessage({ type: "error", error: (e == null ? void 0 : e.message) || String(e) });
      figma.notify("Import failed: " + ((e == null ? void 0 : e.message) || e), { error: true });
    }
  };
})();
