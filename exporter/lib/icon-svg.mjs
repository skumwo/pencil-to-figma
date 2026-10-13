// Pencil `icon` nodes → source SVG markup (for import as REAL editable Figma vectors).
//
// A Pencil icon node only *references* a glyph by library + name:
//
//   { type: "icon", library: "Material Symbols Rounded", icon: "space_dashboard",
//     width: 20, height: 20, fill: "#FFFFFF", weight?: 100..700 }
//
// There is no geometry on the node, so the only way to reproduce it in Figma is to
// look the glyph up in its upstream SVG set and hand that markup to the plugin,
// which runs figma.createNodeFromSvg(). Rasterizing to PNG also "works" but yields
// a flat, uneditable image — so raster is only the last-resort fallback.
//
// Libraries the .pen schema allows (Icon.library):
//   'lucide' | 'feather' | 'phosphor' |
//   'Material Symbols Outlined' | 'Material Symbols Rounded' | 'Material Symbols Sharp'

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NM = join(__dirname, "..", "..", "node_modules");

// Material Symbols ship one npm package per variable-weight axis stop
// (@material-symbols/svg-100 … svg-700), each with outlined/rounded/sharp dirs.
// We use whichever ones are actually installed and snap to the nearest.
const MATERIAL_WEIGHTS = [100, 200, 300, 400, 500, 600, 700];
const MATERIAL_STYLES = {
  "material symbols outlined": "outlined",
  "material symbols rounded": "rounded",
  "material symbols sharp": "sharp",
  // tolerate the shorthand spellings people use in designs
  "material symbols": "outlined",
  "material-symbols": "outlined",
  material: "outlined",
};

// Phosphor ships one directory per weight, and every weight except `regular`
// also suffixes the filename (assets/bold/house-bold.svg, but assets/regular/house.svg).
const PHOSPHOR_DIRS = [
  [150, "thin"],
  [300, "light"],
  [500, "regular"],
  [1000, "bold"],
];

function materialDir(style, weight) {
  const want = typeof weight === "number" && weight > 0 ? weight : 400;
  // Nearest installed weight, preferring the requested one.
  const ranked = MATERIAL_WEIGHTS.slice().sort(
    (a, b) => Math.abs(a - want) - Math.abs(b - want) || a - b
  );
  for (const w of ranked) {
    const dir = join(NM, "@material-symbols", `svg-${w}`, style);
    if (existsSync(dir)) return dir;
  }
  return null;
}

function phosphorDir(weight) {
  const want = typeof weight === "number" && weight > 0 ? weight : 400;
  const name = (PHOSPHOR_DIRS.find(([max]) => want <= max) || PHOSPHOR_DIRS[2])[1];
  const root = join(NM, "@phosphor-icons", "core", "assets");
  const dir = join(root, name);
  if (existsSync(dir)) return { dir, suffix: name === "regular" ? "" : `-${name}` };
  const fallback = join(root, "regular");
  return existsSync(fallback) ? { dir: fallback, suffix: "" } : null;
}

// Which directories could hold this library's glyphs (with any filename suffix the
// set requires), best match first. A weighted phosphor lookup falls back to the
// regular weight so an unusual `weight` never loses the icon entirely.
function iconDirs(library, weight) {
  const lib = String(library || "").trim().toLowerCase();
  if (lib === "lucide") return [{ dir: join(NM, "lucide-static", "icons"), suffix: "" }];
  if (lib === "feather") return [{ dir: join(NM, "feather-icons", "dist", "icons"), suffix: "" }];
  if (lib === "phosphor") {
    const out = [phosphorDir(weight)].filter(Boolean);
    const root = join(NM, "@phosphor-icons", "core", "assets");
    // Fall back across every weight dir: the design may name the glyph without a
    // matching `weight` ("house-bold"), or ask for a weight this install lacks.
    for (const name of ["regular", "bold", "light", "thin", "fill", "duotone"]) {
      const dir = join(root, name);
      if (existsSync(dir) && !out.some((c) => c.dir === dir)) {
        out.push({ dir, suffix: name === "regular" ? "" : `-${name}` });
      }
    }
    return out;
  }
  const style = MATERIAL_STYLES[lib];
  if (style) {
    const dir = materialDir(style, weight);
    // Material Symbols ship every glyph twice: `bolt.svg` (FILL axis 0, an outline)
    // and `bolt-fill.svg` (FILL 1, solid). Pencil renders the solid one — the
    // Superhero cover's lightning bolt imported as an outline until this matched —
    // and the schema has no per-icon fill flag, so the filled file comes first.
    return dir ? [{ dir, suffix: "-fill" }, { dir, suffix: "" }] : [];
  }
  return [];
}

// Icon sets disagree on separators: Material uses snake_case (`keyboard_arrow_down`),
// lucide/feather/phosphor use kebab-case (`chevron-down`). Designs are not always
// consistent with their library, so try every plausible spelling.
function nameVariants(name) {
  const s = String(name || "").trim();
  if (!s) return [];
  const out = [
    s,
    s.toLowerCase(),
    s.replace(/-/g, "_"),
    s.replace(/_/g, "-"),
    s.toLowerCase().replace(/-/g, "_"),
    s.toLowerCase().replace(/_/g, "-"),
    // "ChevronDown" / "chevronDown" → chevron-down / chevron_down
    s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(),
    s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase(),
  ];
  return [...new Set(out)];
}

// Normalize upstream markup so the plugin can treat every library identically:
//   • drop XML comments (lucide ships a license header) and `class` attributes
//   • pin width/height to the viewBox so the imported frame's aspect ratio is
//     exactly the glyph's — Material declares width/height 48 against a
//     `0 -960 960 960` viewBox, and non-square glyphs would otherwise letterbox
//   • guarantee the paint is addressable as `currentColor`. lucide/feather/phosphor
//     already say `currentColor`; Material Symbols say nothing at all, which makes
//     SVG default to solid black — so we mark the root as a currentColor fill.
function normalizeSvg(svg) {
  let s = String(svg)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\sclass="[^"]*"/g, "")
    .trim();

  const open = s.match(/<svg\b[^>]*>/i);
  if (!open) return s;
  let tag = open[0];

  const vb = tag.match(/viewBox\s*=\s*"([^"]+)"/i);
  if (vb) {
    const parts = vb[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      tag = tag
        .replace(/\swidth\s*=\s*"[^"]*"/i, "")
        .replace(/\sheight\s*=\s*"[^"]*"/i, "")
        .replace(/<svg\b/i, `<svg width="${parts[2]}" height="${parts[3]}"`);
    }
  }

  // No paint declared anywhere on the root → Material-style solid glyph.
  if (!/\bfill\s*=/i.test(tag) && !/\bstroke\s*=/i.test(tag)) {
    tag = tag.replace(/<svg\b/i, '<svg fill="currentColor"');
  }

  return s.replace(open[0], tag);
}

const cache = new Map();

/**
 * Look up a Pencil icon node's source SVG.
 * @param {string} library  Icon.library, e.g. "Material Symbols Rounded"
 * @param {string} name     Icon.icon, e.g. "space_dashboard"
 * @param {number} [weight] Icon.weight (100..700)
 * @returns {Promise<string|null>} normalized SVG markup, or null when unavailable
 */
export async function resolveIconSvg(library, name, weight) {
  const key = `${library}|${name}|${weight ?? ""}`;
  if (cache.has(key)) return cache.get(key);

  let svg = null;
  for (const { dir, suffix } of iconDirs(library, weight)) {
    for (const variant of nameVariants(name)) {
      // Try the weighted filename first, then the bare one — designs sometimes
      // already carry the suffix in the icon name ("house-bold").
      for (const file of suffix ? [`${variant}${suffix}.svg`, `${variant}.svg`] : [`${variant}.svg`]) {
        const p = join(dir, file);
        if (!existsSync(p)) continue;
        try {
          svg = normalizeSvg(await readFile(p, "utf8"));
        } catch (e) {
          console.error(`[icons] read ${p} failed: ${e.message}`);
        }
        break;
      }
      if (svg) break;
    }
    if (svg) break;
  }

  cache.set(key, svg);
  return svg;
}

/** Read a Pencil icon node's library/name/weight, tolerating the older `icon_font` shape. */
export function iconRef(node) {
  return {
    library: node.library ?? node.iconFontFamily ?? null,
    name: node.icon ?? node.iconFontName ?? null,
    weight: typeof node.weight === "number" ? node.weight : undefined,
  };
}

/** True for any Pencil node that references a library glyph. */
export function isIconNode(node) {
  return !!node && (node.type === "icon" || node.type === "icon_font");
}

/** Which libraries this install can serve as vectors (for diagnostics / README). */
export function availableLibraries() {
  const out = [];
  if (existsSync(join(NM, "lucide-static", "icons"))) out.push("lucide");
  if (existsSync(join(NM, "feather-icons", "dist", "icons"))) out.push("feather");
  if (phosphorDir(400)) out.push("phosphor");
  for (const [lib, style] of Object.entries(MATERIAL_STYLES)) {
    if (lib.startsWith("material symbols ") && materialDir(style, 400)) {
      out.push(lib.replace(/\b\w/g, (c) => c.toUpperCase()));
    }
  }
  return out;
}
