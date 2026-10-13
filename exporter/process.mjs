#!/usr/bin/env node
// Post-processor for an already-captured Pencil tree + variables file.
//
// The fallback back half of mode B: when the tree was captured by an MCP client that
// already exists (Claude Code's Pencil MCP, via the /pen-export slash command) and
// the CLI can't spawn its own — older Pencil builds served one client at a time. The
// client fetches the tree and this script does everything that needs no MCP:
//   - resolve $token refs to concrete values
//   - attach real SVG vectors to `icon` nodes
//   - embed image fills as base64
//   - verify no truncated ("...") subtrees survived the capture
//
// Usage:
//   node exporter/process.mjs <tree.json> <variables.json> <images-dir> [--out design.json]

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, basename, extname } from "node:path";
import { resolveTokens, normalizeVariables } from "./lib/resolve-tokens.mjs";
import { embedImages } from "./lib/embed-images.mjs";
import { attachIconSvgs, collectTruncated, countTreeNodes } from "./lib/fetch-tree.mjs";
import { availableLibraries } from "./lib/icon-svg.mjs";

function parseArgs(argv) {
  const args = { _: [], out: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" || a === "-o") args.out = argv[++i];
    else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args._.length < 3) {
    console.error("Usage: node exporter/process.mjs <snapshot.json> <variables.json> <images-dir> [--out design.json]");
    process.exit(1);
  }
  const [snapshotPath, varsPath, imagesDir] = args._.map((p) => resolve(p));
  const outPath = args.out
    ? resolve(args.out)
    : resolve(dirname(snapshotPath), basename(snapshotPath, extname(snapshotPath)).replace(/-snapshot.*/, "") + "-design.json");

  console.error(`[read] ${snapshotPath}`);
  let tree = JSON.parse(await readFile(snapshotPath, "utf8"));

  console.error(`[read] ${varsPath}`);
  const vars = normalizeVariables(JSON.parse(await readFile(varsPath, "utf8")));
  console.error(`[vars] ${Object.keys(vars).length} variables`);

  // Pencil MCP returns an array of top-level nodes — find our root, or unwrap singleton
  if (Array.isArray(tree) && tree.length === 1) tree = tree[0];

  // A "..." placeholder means the capture stopped short of the full tree. The plugin
  // cannot recover those children, so fail loudly here rather than shipping a design
  // that is quietly missing whole sections.
  const truncated = collectTruncated(tree);
  if (truncated.length) {
    console.error(
      `[error] ${truncated.length} subtree(s) in ${basename(snapshotPath)} are still truncated ("children": "...").\n` +
      `        The capture is incomplete — re-fetch those ids with batch_get and splice them in.\n` +
      `        First few: ${truncated.slice(0, 8).map((t) => t.id).join(", ")}`
    );
    process.exit(3);
  }

  console.error(`[step] resolving tokens…`);
  tree = resolveTokens(tree, vars);

  console.error(`[step] resolving icons…`);
  console.error(`[icons] vectors available for: ${availableLibraries().join(", ") || "(none — run npm install)"}`);
  const icons = await attachIconSvgs([tree]);
  const perLib = [...icons.byLib.entries()].map(([lib, s]) => `${lib} ${s.ok}/${s.total}`).join(", ");
  console.error(`[icons] ${icons.attached}/${icons.total} resolved as vectors${perLib ? ` — ${perLib}` : ""}`);
  if (icons.unresolved.length) {
    // No MCP here, so no raster fallback — these will import as empty slots.
    console.error(`[icons] NO SVG (will import blank): ${icons.unresolved.slice(0, 20).join(", ")}` +
      (icons.unresolved.length > 20 ? ` (+${icons.unresolved.length - 20} more)` : ""));
  }

  console.error(`[step] embedding images from ${imagesDir} …`);
  const stats = await embedImages(tree, imagesDir);
  console.error(`[step] images: ${stats.cachedBytes} unique, ${stats.total} refs, ${stats.missing} missing`);

  await writeFile(outPath, JSON.stringify(tree, null, 2), "utf8");
  console.error("");
  console.error(`[ok] wrote ${outPath}`);
  console.error(`     nodes  : ${countTreeNodes(tree)}`);
  console.error(`     images : ${stats.total - stats.missing}/${stats.total} embedded`);
  console.error(`     icons  : ${icons.attached}/${icons.total} vectors`);
}

main().catch((e) => { console.error(e); process.exit(2); });
