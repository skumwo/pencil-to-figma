#!/usr/bin/env node
// pencil-to-figma standalone exporter
//
// Usage:
//   node exporter/cli.mjs <path-to-design.pen> [--out design.json] [--node <rootId>]
//
// What it does:
//   1. Spawns the Pencil MCP server (npx @pencil-dev/mcp or env PENCIL_MCP_CMD)
//   2. Opens the document
//   3. Snapshots the full layout tree
//   4. Fetches design variables (color tokens, etc.) and resolves all $token refs to concrete values
//   5. Embeds image fills as base64 (reads files from the .pen file's directory)
//   6. Writes a single design.json ready to drop into the Figma plugin
//
// If you don't have Pencil MCP installed: set PENCIL_MCP_CMD to its launch command.
//   PENCIL_MCP_CMD="node /path/to/pencil-mcp/server.js" node exporter/cli.mjs design.pen

import { writeFile } from "node:fs/promises";
import { resolve, dirname, basename, extname } from "node:path";
import { existsSync } from "node:fs";
import { McpClient } from "./lib/mcp-client.mjs";
import { resolveTokens, normalizeVariables } from "./lib/resolve-tokens.mjs";
import { embedImages } from "./lib/embed-images.mjs";

function parseArgs(argv) {
  const args = { _: [], out: null, node: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" || a === "-o") args.out = argv[++i];
    else if (a === "--node" || a === "-n") args.node = argv[++i];
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
  -n, --node <id>      export only this node (default: full document)
  -h, --help

Environment:
  PENCIL_MCP_CMD       override MCP launch command (default: "npx -y @pencil-dev/mcp")
`);
}

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

  // Resolve MCP launch command
  const cmd = process.env.PENCIL_MCP_CMD || "npx -y @pencil-dev/mcp";
  const [command, ...cmdArgs] = cmd.split(/\s+/);
  console.error(`[mcp] starting: ${cmd}`);
  const mcp = new McpClient(command, cmdArgs);

  try {
    await mcp.start();
    console.error(`[mcp] initialized`);

    console.error(`[pen] open ${penPath}`);
    await mcp.tool("open_document", { path: penPath });

    console.error(`[pen] snapshot_layout (maxDepth: 20)…`);
    const snapshot = await mcp.tool("snapshot_layout", {
      ...(args.node ? { nodeId: args.node } : {}),
      maxDepth: 20,
    });

    console.error(`[pen] get_variables…`);
    const variablesRaw = await mcp.tool("get_variables", {});
    const variables = normalizeVariables(variablesRaw);
    console.error(`[pen] ${Object.keys(variables).length} variables found`);

    // The snapshot can be an array (top-level nodes) or an object. Normalize.
    let tree = snapshot;
    if (Array.isArray(tree) && tree.length === 1) tree = tree[0];

    console.error(`[step] resolve tokens…`);
    tree = resolveTokens(tree, variables);

    console.error(`[step] embed images (this reads referenced files from ${dirname(penPath)})…`);
    const stats = await embedImages(tree, dirname(penPath));
    console.error(`[step] embedded ${stats.cachedBytes} unique images (${stats.total} refs, ${stats.missing} missing)`);

    await writeFile(outPath, JSON.stringify(tree, null, 2), "utf8");
    console.error(`[ok] wrote ${outPath}`);
  } catch (err) {
    console.error(`[error] ${err?.stack || err?.message || err}`);
    process.exit(2);
  } finally {
    mcp.stop();
  }
}

main();
