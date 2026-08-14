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

import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { resolveIconSvg, iconRef, isIconNode } from "./icon-svg.mjs";

// includePathGeometry: send full SVG `geometry` for path nodes (batch_get abbreviates
// it to "..." by default). The plugin needs it to build REAL editable vectors — thin
// and gradient decorative lines vanish when rasterized to PNG.
export const RESOLVE_OPTS = {
  resolveVariables: true,
  resolveInstances: true,
  includePathGeometry: true,
};

// Nodes to request per batch_get. Pencil handles a few dozen ids comfortably;
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
 *   2. Otherwise ask `get_editor_state` which document is active. Best-effort ONLY:
 *      this call hangs when a second MCP client is attached to Pencil (e.g. Claude
 *      Code), and a hang is NOT evidence that nothing is open — an earlier version
 *      treated it as exactly that and reported "Pencil has no .pen document open"
 *      to users who had the file right there on screen.
 *   3. Otherwise proceed against the active editor, but flag the result as
 *      unverified so the caller can say so out loud.
 *
 * @param {{tool: Function}} mcp
 * @param {object} expected
 * @param {string} expected.name      filename the caller asked for
 * @param {Buffer} [expected.bytes]   its contents (bridge upload)
 * @param {string} [expected.path]    its path on disk (CLI)
 * @param {boolean} [allowMismatch]   proceed even on a proven mismatch
 * @param {Function} [log]
 * @returns {Promise<{workingPath: string|null, verified: boolean, how: string}>}
 */
export async function resolveOpenDocument(mcp, expected, allowMismatch = false, log = () => {}) {
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
  let openPath = null;
  try {
    const state = await mcp.tool("get_editor_state", { include_schema: false }, 8000);
    const text = typeof state === "string" ? state : JSON.stringify(state);
    // Reported as a path, e.g.  ## Currently active editor\n- `/Users/me/design.pen`
    const m = text.match(/([\/~][^\s`'"]*\.pen)/);
    if (m) openPath = m[1].replace(/^~/, homedir());
  } catch (e) {
    log(`[mcp] get_editor_state unavailable (${e.message}) — cannot confirm which document is open`);
  }

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

  // 4. Nothing could be confirmed. Import the active editor's document, but make sure
  //    nobody mistakes this for a verified match.
  log(
    `[mcp] WARNING importing whatever document Pencil has open — could not confirm it is "${wantName}".\n` +
    `[mcp]          If the result looks like a different design, open "${wantName}" in Pencil, or set\n` +
    `[mcp]          PEN_SOURCE_DIR=/folder/containing/it so the bridge can locate the original.`
  );
  return { workingPath: null, verified: false, how: "unverified active editor" };
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

export function collectNodes(tree, predicate) {
  const out = [];
  function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.id && predicate(n)) out.push(n);
    if (Array.isArray(n.children)) for (const c of n.children) walk(c);
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
 * @param {{tool: (name: string, args: object) => Promise<any>}} mcp
 * @param {string} rootId
 * @param {string|null} penPath  filePath to target, or null for the open document
 * @param {(msg: string) => void} [log]
 */
export async function fetchFullTree(mcp, rootId, penPath, log = () => {}) {
  const baseArgs = { ...RESOLVE_OPTS, readDepth: 4 };
  if (penPath) baseArgs.filePath = penPath;

  let tree = await mcp.tool("batch_get", { ...baseArgs, nodeIds: [rootId] });
  if (Array.isArray(tree)) tree = tree[0];
  if (!tree) throw new Error(`batch_get returned nothing for ${rootId}`);

  let passes = 0;
  let expanded = 0;
  for (; passes < MAX_EXPAND_PASSES; passes++) {
    const truncated = collectTruncated(tree);
    if (truncated.length === 0) break;
    const chunk = truncated.slice(0, EXPAND_CHUNK);
    let fetched;
    try {
      fetched = await mcp.tool("batch_get", { ...baseArgs, nodeIds: chunk.map((t) => t.id) });
    } catch (e) {
      // Don't let one bad chunk abort the import, but don't pretend the subtree was
      // empty either — clear the placeholders so the plugin gets valid JSON, and let
      // the leftover check below report the loss.
      log(`[mcp] expand chunk failed (${chunk.length} ids): ${e.message}`);
      for (const t of chunk) t.node.children = [];
      continue;
    }
    const byId = new Map();
    for (const item of (Array.isArray(fetched) ? fetched : [fetched])) {
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
 * Rasterize every node matching `predicate` to PNG via Pencil's export_nodes and
 * attach the base64 bytes under `field`. This is the fallback for glyphs we can't
 * supply a vector for.
 */
export async function rasterizeNodes(mcp, trees, workingPath, predicate, field, label, log = () => {}) {
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
    const args = { nodeIds: chunk.map((n) => n.id), outputDir: outDir, format: "png", scale: 2 };
    if (workingPath) args.filePath = workingPath;
    try {
      await mcp.tool("export_nodes", args);
    } catch (e) {
      log(`[${label}] export_nodes failed for chunk ${i}/${unique.length}: ${e.message}`);
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
export async function resolveUnsupportedFills(mcp, trees, workingPath, log = () => {}) {
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
    mcp, trees, workingPath, hasUnsupportedFill, "_fillRaster", "fills", log
  );
  log(`[fills] rasterized ${r.exported}/${r.total}`);
  return { total: r.total, rasterized: r.exported, kinds: [...kinds] };
}

/**
 * Resolve icons for a set of trees: vectors where possible, PNG fallback otherwise.
 * Returns a summary suitable for logging and for the plugin's stats payload.
 */
export async function resolveIcons(mcp, trees, workingPath, log = () => {}) {
  const svgStats = await attachIconSvgs(trees);
  const perLib = [...svgStats.byLib.entries()].map(([lib, s]) => `${lib} ${s.ok}/${s.total}`).join(", ");
  log(`[icons] resolved ${svgStats.attached}/${svgStats.total} icons as vectors${perLib ? ` — ${perLib}` : ""}`);
  if (svgStats.unresolved.length) {
    log(`[icons] no SVG for: ${svgStats.unresolved.slice(0, 20).join(", ")}` +
        (svgStats.unresolved.length > 20 ? ` (+${svgStats.unresolved.length - 20} more)` : ""));
  }
  const raster = await rasterizeNodes(
    mcp, trees, workingPath, (n) => isIconNode(n) && !n._iconSvg, "_iconImage", "icons", log
  );
  if (raster.total) log(`[icons] rasterized ${raster.exported}/${raster.total} fallback icon nodes`);
  return {
    total: svgStats.total,
    vectors: svgStats.attached,
    rasterized: raster.exported,
    unresolved: svgStats.unresolved,
  };
}
