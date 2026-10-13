#!/usr/bin/env node
// pencil-to-figma standalone exporter (mode B)
//
// Usage:
//   node exporter/cli.mjs <path-to-design.pen> [--out design.json] [--node <rootId>]
//
// What it does:
//   1. Spawns the Pencil MCP server (auto-discovered, or env PENCIL_MCP_CMD)
//   2. Opens the document
//   3. Fetches the COMPLETE design tree (batch_get or execute, whichever this Pencil
//      build has — see exporter/lib/pencil-api.mjs), expanding any truncated subtree
//   4. Fetches design variables and resolves all $token refs to concrete values
//   5. Resolves `icon` nodes to real SVG vectors (PNG fallback via Pencil)
//   6. Embeds image fills as base64 (reads files from the .pen file's directory)
//   7. Writes a single design.json ready to drop into the Figma plugin
//
// This produces the SAME payload the bridge serves in mode A — it shares the same
// pipeline module, so the two modes can't drift apart.
//
// NOTE: an earlier version built the tree from `snapshot_layout`, which returns
// geometry ONLY (id/x/y/width/height). The JSON had no types, no fills, no text and
// no icons, so the plugin could only ever draw a stack of blank boxes from it.

import { writeFile } from "node:fs/promises";
import { resolve, dirname, basename, extname } from "node:path";
import { existsSync } from "node:fs";
import { McpClient, findPencilMcp } from "./lib/mcp-client.mjs";
import { connectPencil, ensureDocumentActive } from "./lib/pencil-api.mjs";
import { resolveTokens, normalizeVariables } from "./lib/resolve-tokens.mjs";
import { embedImages } from "./lib/embed-images.mjs";
import {
  annotateLineHeights, attachBoxes, fetchComponentTrees, fetchFullTree, countTreeNodes, resolveIcons, resolveOpenDocument,
} from "./lib/fetch-tree.mjs";
import { availableLibraries } from "./lib/icon-svg.mjs";

function parseArgs(argv) {
  const args = { _: [], out: null, node: null, components: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" || a === "-o") args.out = argv[++i];
    else if (a === "--node" || a === "-n") args.node = argv[++i];
    else if (a === "--components" || a === "-c") args.components = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else args._.push(a);
  }
  return args;
}

function usage() {
  console.log(`pencil-to-figma exporter

Usage:
  node exporter/cli.mjs <design.pen> [options]

Options:
  -o, --out <file>     output path (default: <design>.json next to .pen)
  -n, --node <id>      export only this top-level frame (default: all of them)
  -c, --components     keep Pencil components: definitions + instances with their
                       overrides, so the plugin builds real Figma components
  -h, --help

Environment:
  PENCIL_MCP_CMD       override the MCP binary path (default: auto-discover
                       Pen.app / Pencil.app under /Applications)
  PENCIL_MCP_ARGS      override MCP args (default: "--app desktop")

Note: the Pencil desktop app must be running with the .pen file open.
`);
}

const log = (m) => console.error(m);

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args._.length === 0) { usage(); process.exit(args.help ? 0 : 1); }

  const penPath = resolve(args._[0]);
  if (!existsSync(penPath)) {
    console.error(`File not found: ${penPath}`);
    process.exit(1);
  }
  if (extname(penPath).toLowerCase() !== ".pen") {
    console.warn(`[warn] expected a .pen file, got ${extname(penPath)}`);
  }

  const outPath = args.out
    ? resolve(args.out)
    : resolve(dirname(penPath), basename(penPath, extname(penPath)) + ".json");

  const command = process.env.PENCIL_MCP_CMD || findPencilMcp();
  if (!command) {
    console.error(
      "Pencil/Pen desktop app not found in /Applications or ~/Applications.\n" +
      "Set PENCIL_MCP_CMD=/path/to/mcp-server-darwin-arm64 and retry."
    );
    process.exit(1);
  }
  const cmdArgs = (process.env.PENCIL_MCP_ARGS || "--app desktop").split(/\s+/).filter(Boolean);
  log(`[mcp] starting: ${command} ${cmdArgs.join(" ")}`);
  log(`[icons] vectors available for: ${availableLibraries().join(", ") || "(none — run npm install)"}`);
  const mcp = new McpClient(command, cmdArgs);

  try {
    await mcp.start();
    log(`[mcp] initialized`);
    const api = await connectPencil(mcp, log);

    // Pencil MCP only exports the document open in its editor, so confirm that's the
    // file we were asked for rather than silently exporting whatever happens to be open.
    const { workingPath } = await resolveOpenDocument(
      api, { name: basename(penPath), path: penPath }, process.env.PEN_ALLOW_MISMATCH === "1", log
    );

    if (workingPath) await ensureDocumentActive(api, workingPath, log);

    let topLevel = null;
    let lastErr = null;
    for (let retry = 0; retry < 3 && !topLevel; retry++) {
      try {
        const arr = await api.topLevel(workingPath);
        if (arr.length && arr[0]) {
          topLevel = arr;
          log(`[pen] read OK (${arr.length} top-level items)`);
        } else {
          // Pencil can race the doc-open against the first read.
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch (e) {
        lastErr = e;
        log(`[pen] read error: ${e.message}`);
        break;
      }
    }
    if (!topLevel) {
      throw lastErr || new Error(
        "Could not read the .pen file via Pencil MCP. Make sure the Pencil desktop app is " +
        "responsive and no other MCP client (e.g. Claude Code) is attached."
      );
    }

    // Import every top-level frame that isn't a reusable component — components are
    // inlined into their instances by resolveInstances.
    const rootIds = args.node
      ? [args.node]
      : topLevel.filter((n) => n && n.type === "frame" && n.reusable !== true).map((n) => n.id);
    if (!rootIds.length) throw new Error("No importable top-level frames found in the .pen file");
    log(`[pen] exporting ${rootIds.length} top-level frame(s): ${rootIds.join(", ")}`);

    log(`[pen] variables…`);
    const variables = normalizeVariables(await api.getVariables(workingPath));
    log(`[pen] ${Object.keys(variables).length} variables found`);

    // Full tree per root, sequentially (Pencil MCP doesn't love parallel calls).
    let trees = [];
    let defs = [];
    let incomplete = 0;
    if (args.components) {
      const r = await fetchComponentTrees(api, rootIds, workingPath, log);
      trees = r.trees;
      defs = r.components;
    } else {
      for (const id of rootIds) {
        const r = await fetchFullTree(api, id, workingPath, log);
        trees.push(r.tree);
        incomplete += r.incomplete;
      }
    }

    log(`[step] resolve tokens…`);
    const resolved = trees.map((t) => resolveTokens(t, variables));
    const components = defs.map((t) => resolveTokens(t, variables));
    const all = [...resolved, ...components];
    try { await attachBoxes(api, all, workingPath, log); } catch (e) { log(`[layout] failed: ${e.message}`); }
    annotateLineHeights(all, log);

    log(`[step] resolve icons…`);
    let icons = null;
    try {
      icons = await resolveIcons(api, all, workingPath, log);
    } catch (e) {
      log(`[icons] processing failed: ${e.message}`);
    }

    log(`[step] embed images (reading from ${dirname(penPath)})…`);
    let imgTotal = 0, imgMissing = 0;
    for (const t of all) {
      const s = await embedImages(t, dirname(penPath));
      imgTotal += s.total;
      imgMissing += s.missing;
    }
    log(`[step] embedded ${imgTotal - imgMissing}/${imgTotal} images (${imgMissing} missing)`);

    const nodes = resolved.reduce((s, t) => s + countTreeNodes(t), 0);
    // Single root → emit the object; several → emit the array. The plugin accepts both.
    // With components, wrap both lists: { tree, components }.
    const payload = args.components
      ? { tree: resolved, components }
      : resolved.length === 1 ? resolved[0] : resolved;
    await writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");

    log("");
    log(`[ok] wrote ${outPath}`);
    log(`     frames  : ${resolved.length}`);
    log(`     nodes   : ${nodes}`);
    if (args.components) log(`     components : ${components.length}`);
    log(`     images  : ${imgTotal - imgMissing}/${imgTotal} embedded`);
    if (icons) log(`     icons   : ${icons.vectors} vectors, ${icons.rasterized} rasterized, of ${icons.total}`);
    if (incomplete) log(`     WARNING : ${incomplete} subtree(s) could not be expanded — the export is incomplete`);
    log("");
    log(`Next: Figma → Plugins → Development → Pencil Import → tab "Drop design.json" → drop ${basename(outPath)}`);
    if (incomplete) process.exitCode = 3;
  } catch (err) {
    console.error(`[error] ${err?.stack || err?.message || err}`);
    process.exit(2);
  } finally {
    mcp.stop();
  }
}

main();
