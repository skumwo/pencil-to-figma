#!/usr/bin/env node
// Test/utility entrypoint — processes an already-saved Pencil snapshot + variables file.
// Useful when the raw snapshot was captured separately (e.g. via Claude Code's
// Pencil MCP tool output) and you just need the post-processing steps:
//   - resolve $token refs to concrete values
//   - embed image fills as base64
//
// Usage:
//   node exporter/process.mjs <snapshot.json> <variables.json> <images-dir> [--out design.json]

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, basename, extname } from "node:path";
import { resolveTokens, normalizeVariables } from "./lib/resolve-tokens.mjs";
import { embedImages } from "./lib/embed-images.mjs";

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

  console.error(`[step] resolving tokens…`);
  tree = resolveTokens(tree, vars);

  console.error(`[step] embedding images from ${imagesDir} …`);
  const stats = await embedImages(tree, imagesDir);
  console.error(`[step] images: ${stats.cachedBytes} unique, ${stats.total} refs, ${stats.missing} missing`);

  await writeFile(outPath, JSON.stringify(tree, null, 2), "utf8");
  console.error(`[ok] wrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(2); });
