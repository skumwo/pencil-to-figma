// Fetching a COMPLETE Pencil design tree over MCP, shared by the bridge (mode A)
// and the standalone exporter (mode B) so the two can't drift apart.
//
// Why this is not a one-liner:
//   • `snapshot_layout` returns geometry ONLY — id/x/y/width/height. No type, no
//     fill, no text content, no icon reference. A tree built from it is a pile of
//     untyped boxes, so it is useless for reproducing a design.
//   • `batch_get` returns everything, but truncates below `readDepth`, replacing
//     deeper children with the string "...". A real board nests 10+ levels, so the
//     placeholders have to be expanded iteratively until none are left.
//     (The execute-era `Get` returns whole subtrees, so there the loop is a no-op.)
//
// All Pencil access goes through `api` from ./pencil-api.mjs, which speaks both
// the old granular tools and the newer `execute` tool.

import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { resolveIconSvg, iconRef, isIconNode } from "./icon-svg.mjs";

// Nodes to request per read. Pencil handles a few dozen ids comfortably;
// larger batches risk the per-call response limit.
const EXPAND_CHUNK = 40;
// Runaway guard only — NOT a coverage limit. Sized so even a very large board
// finishes well inside it.
const MAX_EXPAND_PASSES = 5000;

// Find the dropped file's REAL location on disk by name, confirmed byte-for-byte.
//
// This matters because Pencil reads a .pen by path, but only from a location it is
// permitted to touch: the bridge's own upload staging dir (~/.pencil-to-figma/inbox)
// is rejected ("you are probably referencing the wrong .pen file"), while the user's
// actual working copy reads fine — even when a *different* document is the active
// editor. So locating the original is what lets us name the document explicitly
// instead of falling back to "whatever is open", which is how file A once imported
// as file B.
const SEARCH_SKIP = new Set([
  "node_modules", ".git", "Library", ".Trash", ".cache", "venv", ".venv",
  "dist", "build", ".pencil-to-figma", "Applications",
]);

export async function findOriginalOnDisk(name, bytes, log = () => {}, budgetMs = 5000) {
  if (!name || !bytes) return null;
  const home = homedir();
  const roots = [
    process.env.PEN_SOURCE_DIR,
    join(home, "Desktop"),
    join(home, "Documents"),
    join(home, "Downloads"),
    join(home, "Projects"),
    join(home, "PycharmProjects"),
    home,
  ].filter((r) => r && existsSync(r));

  const deadline = Date.now() + budgetMs;
  const seen = new Set();

  async function scan(dir, depth) {
    if (Date.now() > deadline || depth > 5) return null;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null; // unreadable / permission-denied — skip quietly
    }
    const subdirs = [];
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".pen") {
        if (SEARCH_SKIP.has(e.name)) continue;
      }
      if (e.isDirectory()) {
        if (!SEARCH_SKIP.has(e.name)) subdirs.push(join(dir, e.name));
        continue;
      }
      if (e.name !== name) continue;
      const p = join(dir, e.name);
      try {
        const candidate = await readFile(p);
        if (candidate.length === bytes.length && candidate.equals(bytes)) return p;
      } catch { /* unreadable — keep looking */ }
    }
    for (const sd of subdirs) {
      if (seen.has(sd)) continue;
      seen.add(sd);
      const hit = await scan(sd, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    const hit = await scan(root, 0);
    if (hit) return hit;
    if (Date.now() > deadline) {
      log(`[mcp] on-disk search for ${name} hit its ${budgetMs}ms budget`);
      break;
    }
  }
  return null;
}

/**
 * Establish WHICH document is going to be exported, and don't let a different one be
 * substituted silently.
 *
 * Order matters, because the two ways of asking have different failure modes:
 *   1. Locate the caller's file on disk and name it explicitly. Byte-identical match
 *      = definitive identity, and it needs no cooperation from the desktop app.
 *   2. Otherwise ask Pencil which document is active. Best-effort ONLY:
 *      this call hangs when a second MCP client is attached to Pencil (e.g. Claude
 *      Code), and a hang is NOT evidence that nothing is open — an earlier version
 *      treated it as exactly that and reported "Pencil has no .pen document open"
 *      to users who had the file right there on screen.
 *   3. Otherwise proceed against the active editor, but flag the result as
 *      unverified so the caller can say so out loud.
 *
 * @param {{activeDocument: () => Promise<string|null>}} api  from connectPencil()
 * @param {object} expected
 * @param {string} expected.name      filename the caller asked for
 * @param {Buffer} [expected.bytes]   its contents (bridge upload)
 * @param {string} [expected.path]    its path on disk (CLI)
 * @param {boolean} [allowMismatch]   proceed even on a proven mismatch
 * @param {Function} [log]
 * @returns {Promise<{workingPath: string|null, verified: boolean, how: string}>}
 */
export async function resolveOpenDocument(api, expected, allowMismatch = false, log = () => {}) {
  const wantName = basename(expected.name || expected.path || "");
  let wantBytes = expected.bytes || null;
  if (!wantBytes && expected.path && existsSync(expected.path)) {
    try { wantBytes = await readFile(expected.path); } catch { /* fall through */ }
  }

  // 1. The caller already knows the path (CLI) — nothing to search for.
  if (expected.path && existsSync(expected.path)) {
    log(`[mcp] using ${expected.path}`);
    return { workingPath: expected.path, verified: true, how: "caller-supplied path" };
  }

  // 2. Find the original on disk and address it by name.
  if (wantBytes) {
    const found = await findOriginalOnDisk(wantName, wantBytes, log);
    if (found) {
      log(`[mcp] verified: "${wantName}" is byte-identical to ${found}`);
      return { workingPath: found, verified: true, how: "byte-identical file on disk" };
    }
    log(`[mcp] could not find "${wantName}" on disk (or it differs from what was dropped)`);
  }

  // 3. Best-effort: ask which document is active. Short timeout — this call is the
  //    one that hangs under MCP client contention, and it is only a nicety here.
  const openPath = await api.activeDocument();
  if (!openPath) log(`[mcp] Pencil did not report an active document — cannot confirm which one is open`);

  if (openPath) {
    log(`[mcp] Pencil reports the active document as ${openPath}`);
    if (basename(openPath) !== wantName) {
      const msg =
        `Pencil has a different document open than the one requested.\n` +
        `  requested : ${wantName}\n` +
        `  open      : ${openPath}\n` +
        `Open "${wantName}" in Pencil and retry.`;
      if (!allowMismatch) throw new Error(msg);
      log(`[mcp] WARNING ${msg.replace(/\n/g, " ")} — continuing (mismatch explicitly allowed)`);
    }
    return {
      workingPath: existsSync(openPath) ? openPath : null,
      verified: basename(openPath) === wantName,
      how: "active editor reported by Pencil",
    };
  }

  // 4. Nothing could be confirmed. Importing "whatever is open" is exactly how a
  //    dropped file turns into a different project on the canvas, so stop here.
  throw new Error(
    `Could not find "${wantName}" on disk, and Pencil doesn't say which document it has open.\n` +
    `Pencil can only read a document it has open, so the import would have brought in whatever else is.\n` +
    `Open "${wantName}" in Pencil and import again, or start the bridge with ` +
    `PEN_SOURCE_DIR=/folder/containing/it so it can locate the file.`
  );
}

export function collectTruncated(node) {
  const out = [];
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.children === "...") { out.push({ id: n.id, node: n }); return; }
    if (Array.isArray(n.children)) for (const c of n.children) walk(c);
  })(node);
  return out;
}

export function countTreeNodes(n) {
  if (!n || typeof n !== "object") return 0;
  let c = 1;
  if (Array.isArray(n.children)) for (const ch of n.children) c += countTreeNodes(ch);
  return c;
}

/**
 * Everything below a node that can carry design data. Besides `children` that is,
 * in components mode, an instance's Pencil-resolved expansion (`_resolved`) and its
 * per-descendant overrides (`descendants`) — an override can swap in an icon or an
 * image fill, and those need their SVG / bytes attached like any other node.
 */
export function linkedNodes(n) {
  const out = [];
  if (Array.isArray(n.children)) out.push(...n.children);
  if (n._resolved && typeof n._resolved === "object") out.push(n._resolved);
  if (n.descendants && typeof n.descendants === "object") out.push(...Object.values(n.descendants));
  return out;
}

export function collectNodes(tree, predicate) {
  const out = [];
  function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.id && predicate(n)) out.push(n);
    for (const c of linkedNodes(n)) walk(c);
  }
  if (Array.isArray(tree)) tree.forEach(walk); else walk(tree);
  return out;
}

/**
 * Fetch a node's entire subtree, expanding every truncated "..." placeholder.
 *
 * The earlier version capped expansion at 20 passes of 20 ids — 400 subtrees TOTAL
 * — and then returned whatever it had. On a ~5,800-node board that silently dropped
 * thousands of nodes: the placeholders reached the plugin, which saw a string where
 * it expected an array and rendered nothing. Expansion now runs to completion and
 * anything genuinely unreachable is reported.
 *
 * @param {{getNodes: (ids: string[], filePath: string|null) => Promise<any[]>}} api
 * @param {string} rootId
 * @param {string|null} penPath  filePath to target, or null for the open document
 * @param {(msg: string) => void} [log]
 */
export async function fetchFullTree(api, rootId, penPath, log = () => {}) {
  const tree = (await api.getNodes([rootId], penPath))[0];
  if (!tree) throw new Error(`Pencil returned nothing for ${rootId}`);

  let passes = 0;
  let expanded = 0;
  for (; passes < MAX_EXPAND_PASSES; passes++) {
    const truncated = collectTruncated(tree);
    if (truncated.length === 0) break;
    const chunk = truncated.slice(0, EXPAND_CHUNK);
    let fetched;
    try {
      fetched = await api.getNodes(chunk.map((t) => t.id), penPath);
    } catch (e) {
      // Don't let one bad chunk abort the import, but don't pretend the subtree was
      // empty either — clear the placeholders so the plugin gets valid JSON, and let
      // the leftover check below report the loss.
      log(`[mcp] expand chunk failed (${chunk.length} ids): ${e.message}`);
      for (const t of chunk) t.node.children = [];
      continue;
    }
    const byId = new Map();
    for (const item of fetched) {
      if (item && item.id) byId.set(item.id, item);
    }
    for (const t of chunk) {
      const replacement = byId.get(t.id);
      t.node.children =
        replacement && Array.isArray(replacement.children) ? replacement.children : [];
      expanded++;
    }
    if (passes > 0 && passes % 25 === 0) {
      log(`[mcp]   …expanding ${rootId}: ${expanded} subtrees, ${countTreeNodes(tree)} nodes so far`);
    }
  }

  const leftover = collectTruncated(tree);
  if (leftover.length) {
    log(
      `[mcp] WARNING ${rootId}: gave up with ${leftover.length} unexpanded subtree(s) ` +
      `after ${passes} passes — the import will be incomplete`
    );
    for (const t of leftover) t.node.children = [];
  }
  log(`[mcp] ${rootId}: ${countTreeNodes(tree)} nodes (${expanded} subtrees expanded in ${passes} passes)`);
  return { tree, nodes: countTreeNodes(tree), expanded, passes, incomplete: leftover.length };
}

/**
 * Components mode: fetch pages AND every reusable definition without expanding
 * instances, so the plugin can rebuild them as real Figma components + instances.
 *
 * Each `ref` node keeps only what the instance overrides; the plugin also gets the
 * same instance as Pencil resolves it, attached as `_resolved`. That copy is what the
 * plugin reads effective values from (an override is partial — `{fontSize: 37}` —
 * but applying it needs the whole node), what maps override keys onto the Figma
 * instance's layers, and what it falls back to when Figma refuses an override.
 *
 * @param {{listReusable: Function, getNodePairs: Function}} api
 * @param {string[]} rootIds  the non-reusable top-level frames to import
 * @param {string|null} penPath
 */
export async function fetchComponentTrees(api, rootIds, penPath, log = () => {}) {
  const reusable = await api.listReusable(penPath);
  log(`[components] ${reusable.length} reusable definition(s): ${reusable.map((r) => r.name || r.id).join(", ")}`);

  let refs = 0;
  let unresolved = 0;
  async function fetchOne(id) {
    const [pair] = await api.getNodePairs([id], penPath);
    if (!pair || !pair.raw) throw new Error(`Pencil returned nothing for ${id}`);
    const r = attachResolved(pair.raw, pair.resolved);
    refs += r.refs;
    unresolved += r.missing;
    return pair.raw;
  }

  const components = [];
  for (const r of reusable) {
    try {
      const def = await fetchOne(r.id);
      def._topLevel = r.top === true;
      components.push(def);
    } catch (e) {
      log(`[components] failed to fetch definition ${r.id}: ${e.message}`);
    }
  }
  const trees = [];
  for (const id of rootIds) {
    try {
      const t = await fetchOne(id);
      trees.push(t);
      log(`[mcp] ${id}: ${countTreeNodes(t)} nodes`);
    } catch (e) {
      log(`[mcp] failed to fetch ${id}: ${e.message}`);
    }
  }
  log(`[components] ${refs} instance(s) across pages and definitions`);
  if (unresolved) {
    log(`[components] WARNING ${unresolved} instance(s) came without a resolved copy — they can't fall back if Figma refuses an override`);
  }
  return { trees, components, refs, unresolved };
}

// Attach to every `ref` in `raw` its expansion from `resolved` (same ids at the top
// of each expansion). Refs don't nest in the raw tree — an instance's content only
// exists in its resolved copy — so the walk stops at each ref.
function attachResolved(raw, resolved) {
  const byId = new Map();
  (function index(n) {
    if (!n || typeof n !== "object") return;
    if (n.id) byId.set(n.id, n);
    if (Array.isArray(n.children)) n.children.forEach(index);
  })(resolved);
  let refs = 0;
  let missing = 0;
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.type === "ref") {
      refs++;
      const r = byId.get(n.id);
      if (r) n._resolved = r; else missing++;
      return;
    }
    if (Array.isArray(n.children)) n.children.forEach(walk);
  })(raw);
  return { refs, missing };
}

/**
 * Attach Pencil's computed layout to every node as `_box: [x, y, w, h]` (parent
 * space). The plugin compares its own result against it — that's how a heading that
 * wraps into one more line in Figma gets caught and corrected instead of shipped.
 * Roots are read a few at a time to keep each response small.
 */
export async function attachBoxes(api, roots, penPath, log = () => {}) {
  let attached = 0;
  for (let i = 0; i < roots.length; i += 8) {
    const chunk = roots.slice(i, i + 8);
    let boxes;
    try {
      boxes = await api.getBoxes(chunk.map((r) => r.id), penPath);
    } catch (e) {
      log(`[layout] could not read Pencil's layout for ${chunk.length} root(s): ${e.message}`);
      continue;
    }
    for (const root of chunk) {
      (function walk(n) {
        if (!n || typeof n !== "object") return;
        if (n.id != null && boxes.has(String(n.id))) { n._box = boxes.get(String(n.id)); attached++; }
        if (Array.isArray(n.children)) n.children.forEach(walk);
        if (n._resolved) walk(n._resolved);
      })(root);
    }
  }
  log(`[layout] Pencil layout attached to ${attached} node(s)`);
  return attached;
}

/**
 * Pencil's line height, in px, on every text node as `_lineHeightPx`.
 *
 * Pencil rounds each line to whole pixels: a line is round(fontSize × lineHeight),
 * so 40px at 1.22 is 49px (four lines = 196px, exactly what it lays out), where
 * Figma's 122% gives 48.8. With no lineHeight set, Pencil uses the font's own
 * metrics — round(fontSize × 1.21) for Inter, × 1.366 for Manrope — while Figma's
 * "Auto" comes out ~2px taller per line (Inter 16px: 21 vs Pencil's 19). Either
 * difference stacks down a column of text, so the plugin sets this value in px.
 *
 * The per-family ratio for unset line heights is read off Pencil's own layout: every
 * single-line auto-width text pins it to [(h−½)/size, (h+½)/size); the intersection
 * across the document is the ratio Pencil uses.
 */
export function annotateLineHeights(trees, log = () => {}) {
  const isText = (n) => n && (n.type === "text" || n.type === "note" || n.type === "prompt" || n.type === "context");
  const each = (fn) => {
    const walk = (n) => {
      if (!n || typeof n !== "object") return;
      fn(n);
      if (Array.isArray(n.children)) n.children.forEach(walk);
      if (n._resolved) walk(n._resolved);
    };
    trees.forEach(walk);
  };

  const bounds = new Map(); // family → {lo, hi, samples}
  each((n) => {
    if (!isText(n) || n.lineHeight != null || !Array.isArray(n._box)) return;
    if (n.textGrowth === "fixed-width" || n.textGrowth === "fixed-width-height") return;
    if (typeof n.fontSize !== "number" || !(n.fontSize > 0) || /\n/.test(String(n.content || ""))) return;
    const h = n._box[3];
    const fam = String(n.fontFamily || "Inter");
    const b = bounds.get(fam) || { lo: 0, hi: Infinity, samples: [] };
    b.lo = Math.max(b.lo, (h - 0.5) / n.fontSize);
    b.hi = Math.min(b.hi, (h + 0.5) / n.fontSize);
    b.samples.push(h / n.fontSize);
    bounds.set(fam, b);
  });
  const ratio = new Map();
  for (const [fam, b] of bounds) {
    if (b.lo < b.hi) {
      ratio.set(fam, (b.lo + b.hi) / 2);
    } else {
      const sorted = b.samples.sort((x, y) => x - y);
      ratio.set(fam, sorted[Math.floor(sorted.length / 2)]);
      log(`[text] ${fam}: single-line heights don't agree on one ratio — using the median ${ratio.get(fam).toFixed(4)}`);
    }
  }

  let set = 0, derived = 0, unknown = 0;
  each((n) => {
    if (!isText(n) || typeof n.fontSize !== "number" || !(n.fontSize > 0)) return;
    const lh = n.lineHeight;
    let want = null;
    if (typeof lh === "number" && lh > 0) want = lh < 5 ? Math.round(n.fontSize * lh) : Math.round(lh);
    else if (lh == null && ratio.has(String(n.fontFamily || "Inter"))) {
      want = Math.round(n.fontSize * ratio.get(String(n.fontFamily || "Inter")));
    }

    // Pencil's own layout is the better source: one line is the box height divided by
    // the number of lines, and the ratio above only has to get that count right. It is
    // what catches a string Pencil had to render in a fallback font — Onest has no
    // Kazakh ә/ғ/қ, and those lines come out 1px taller than the rest of the screen,
    // which no per-family ratio can express. Skipped when the height is the designer's
    // (textGrowth "fixed-width-height"), since then it isn't the text's own.
    const h = Array.isArray(n._box) ? n._box[3] : null;
    const ownHeight = n.textGrowth !== "fixed-width-height" && typeof n.height !== "number";
    if (h > 0 && ownHeight) {
      const seed = want > 0 ? want : Math.round(n.fontSize * 1.3);
      const lines = Math.max(1, Math.round(h / seed));
      const perLine = h / lines;
      if (Math.abs(perLine - Math.round(perLine)) <= 0.05) {
        n._lineHeightPx = Math.round(perLine);
        set++;
        derived++;
        return;
      }
    }
    if (want > 0) { n._lineHeightPx = want; set++; } else unknown++;
  });
  log(`[text] line heights: ${set} set to Pencil's px value (${derived} read off Pencil's own layout)` +
      (ratio.size ? ` (auto ratios: ${[...ratio].map(([f, r]) => `${f} ${r.toFixed(4)}`).join(", ")})` : "") +
      (unknown ? `, ${unknown} left on Figma's auto (no single-line sample of that font)` : ""));
  return { set, derived, unknown };
}

/**
 * Attach each icon node's source SVG as `_iconSvg` so the plugin can import it as
 * real vectors. Pencil `icon` nodes carry only `library` + `icon`.
 */
export async function attachIconSvgs(trees) {
  const icons = [];
  for (const t of trees) icons.push(...collectNodes(t, isIconNode));
  let attached = 0;
  const byLib = new Map();
  const unresolved = new Set();
  for (const n of icons) {
    const { library, name, weight } = iconRef(n);
    const key = library || "(no library)";
    const stat = byLib.get(key) || { total: 0, ok: 0 };
    stat.total++;
    if (name) {
      const svg = await resolveIconSvg(library, name, weight);
      if (svg) { n._iconSvg = svg; stat.ok++; attached++; }
      else unresolved.add(`${key}/${name}`);
    } else {
      unresolved.add(`${key}/(no name)`);
    }
    byLib.set(key, stat);
  }
  return { attached, total: icons.length, byLib, unresolved: [...unresolved] };
}

// When `resolveInstances: true`, Pencil returns shadow-node IDs as full paths like
// "V99zP/DQAps" (instance/inner). export_nodes accepts these paths fine — but it
// writes the file using only the RAW id ("DQAps.png"), so strip the prefix when
// looking the resulting file up on disk.
export function rawId(id) {
  if (typeof id !== "string") return id;
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/**
 * Rasterize every node matching `predicate` to PNG via Pencil's export and attach
 * the base64 bytes under `field`. This is the fallback for glyphs we can't supply a
 * vector for.
 */
export async function rasterizeNodes(api, trees, workingPath, predicate, field, label, log = () => {}) {
  const all = [];
  for (const t of trees) all.push(...collectNodes(t, predicate));
  if (!all.length) return { exported: 0, total: 0 };

  // De-duplicate by raw id — the same glyph used in many places (and across many
  // instances of one reusable component) only needs one export.
  const seen = new Set();
  const unique = all.filter((n) => {
    const r = rawId(n.id);
    if (seen.has(r)) return false;
    seen.add(r);
    return true;
  });

  const outDir = await mkdtemp(join(homedir(), ".pencil-to-figma", `${label}-`));
  // export_nodes can hit a per-call limit and sometimes hangs on hundreds of ids.
  const CHUNK = 40;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    try {
      await api.exportPng(chunk.map((n) => n.id), outDir, 2, workingPath);
    } catch (e) {
      log(`[${label}] export failed for chunk ${i}/${unique.length}: ${e.message}`);
      continue;
    }
  }

  let files = [];
  try { files = await readdir(outDir); } catch {}
  const dataByRawId = new Map();
  for (const f of files) {
    const base = f.replace(/\.[^.]+$/, "");
    try {
      const bytes = await readFile(join(outDir, f));
      dataByRawId.set(base, bytes.toString("base64"));
    } catch (e) {
      log(`[${label}] could not read ${f}: ${e.message}`);
    }
  }
  rm(outDir, { recursive: true, force: true }).catch(() => {});

  let exported = 0;
  for (const n of all) {
    const data = dataByRawId.get(rawId(n.id));
    if (data) { n[field] = data; exported++; }
  }
  return { exported, total: all.length };
}

// Fill types Figma has no equivalent for at all. `shader` is a WebGL fragment
// program and `mesh_gradient` is a bezier-interpolated colour grid — neither can be
// expressed as a Figma Paint, and neither can be a vector. Left alone they resolve to
// nothing and the node turns transparent, silently deleting whatever the designer
// drew. Asking Pencil to render them to PNG is lossy (not editable) but visible,
// which is the right trade for an effect that has no Figma counterpart.
const UNSUPPORTED_FILLS = new Set(["shader", "mesh_gradient"]);

export function hasUnsupportedFill(node) {
  const fills = [];
  if (node.fill != null) {
    if (Array.isArray(node.fill)) fills.push(...node.fill);
    else fills.push(node.fill);
  }
  if (Array.isArray(node.fills)) fills.push(...node.fills);
  return fills.some(
    (f) => f && typeof f === "object" && UNSUPPORTED_FILLS.has(f.type) && f.enabled !== false
  );
}

/**
 * Rasterize nodes whose fill Figma cannot express, attaching the PNG as `_fillRaster`.
 */
export async function resolveUnsupportedFills(api, trees, workingPath, log = () => {}) {
  const found = [];
  for (const t of trees) found.push(...collectNodes(t, hasUnsupportedFill));
  if (!found.length) return { total: 0, rasterized: 0 };
  const kinds = new Set();
  for (const n of found) {
    const fills = Array.isArray(n.fill) ? n.fill : [n.fill];
    for (const f of fills) if (f && UNSUPPORTED_FILLS.has(f.type)) kinds.add(f.type);
  }
  log(`[fills] ${found.length} node(s) use fills Figma can't express (${[...kinds].join(", ")}) — rendering them to PNG`);
  const r = await rasterizeNodes(
    api, trees, workingPath, hasUnsupportedFill, "_fillRaster", "fills", log
  );
  log(`[fills] rasterized ${r.exported}/${r.total}`);
  return { total: r.total, rasterized: r.exported, kinds: [...kinds] };
}

/**
 * Resolve icons for a set of trees: vectors where possible, PNG fallback otherwise.
 * Returns a summary suitable for logging and for the plugin's stats payload.
 */
export async function resolveIcons(api, trees, workingPath, log = () => {}) {
  const svgStats = await attachIconSvgs(trees);
  const perLib = [...svgStats.byLib.entries()].map(([lib, s]) => `${lib} ${s.ok}/${s.total}`).join(", ");
  log(`[icons] resolved ${svgStats.attached}/${svgStats.total} icons as vectors${perLib ? ` — ${perLib}` : ""}`);
  if (svgStats.unresolved.length) {
    log(`[icons] no SVG for: ${svgStats.unresolved.slice(0, 20).join(", ")}` +
        (svgStats.unresolved.length > 20 ? ` (+${svgStats.unresolved.length - 20} more)` : ""));
  }
  const raster = await rasterizeNodes(
    api, trees, workingPath, (n) => isIconNode(n) && !n._iconSvg, "_iconImage", "icons", log
  );
  if (raster.total) log(`[icons] rasterized ${raster.exported}/${raster.total} fallback icon nodes`);
  return {
    total: svgStats.total,
    vectors: svgStats.attached,
    rasterized: raster.exported,
    unresolved: svgStats.unresolved,
  };
}
