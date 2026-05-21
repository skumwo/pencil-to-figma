#!/usr/bin/env node
// pencil-to-figma bridge — local HTTP server that turns .pen + images into design JSON.
//
// Usage:
//   node bridge/server.mjs                    # default port 7777
//   PEN_BRIDGE_PORT=8080 node bridge/server.mjs
//
// Endpoints:
//   GET  /                    health check (returns "pencil-to-figma bridge ok")
//   POST /import              multipart form-data: file `pen` + multiple `image` files
//                             returns processed design JSON ready for the plugin
//
// The bridge spawns the bundled Pencil MCP binary
// (default: /Applications/Pencil.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64)
// — override with PENCIL_MCP_CMD env var if your install path differs.

import http from "node:http";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Busboy from "busboy";

import { McpClient } from "../exporter/lib/mcp-client.mjs";
import { resolveTokens, normalizeVariables } from "../exporter/lib/resolve-tokens.mjs";

const PORT = parseInt(process.env.PEN_BRIDGE_PORT || "7777", 10);
const PENCIL_CMD = process.env.PENCIL_MCP_CMD ||
  "/Applications/Pencil.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64";
const PENCIL_ARGS = (process.env.PENCIL_MCP_ARGS || "--app desktop").split(/\s+/).filter(Boolean);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function setCors(res) {
  // Figma's plugin iframe origin is null after redirect — allow all so plugin can hit us.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, body) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

// ─── Multipart parsing ────────────────────────────────────────────────────────

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 50 * 1024 * 1024 } });
    /** @type {{name: string, filename: string, mimeType: string, data: Buffer[], size: number}[]} */
    const files = [];
    const fields = {};

    bb.on("file", (name, stream, info) => {
      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => {
        chunks.push(chunk);
        size += chunk.length;
      });
      stream.on("limit", () => reject(new Error(`file ${info.filename} exceeds size limit`)));
      stream.on("end", () => {
        files.push({
          name,
          filename: info.filename,
          mimeType: info.mimeType,
          data: Buffer.concat(chunks),
          size,
        });
      });
    });

    bb.on("field", (name, value) => { fields[name] = value; });
    bb.on("close", () => resolve({ files, fields }));
    bb.on("error", reject);
    req.pipe(bb);
  });
}

// ─── Image embedding ──────────────────────────────────────────────────────────
// Walks the design tree, replaces image fill `url` with embedded base64 `data`,
// matching by relative filename against the uploaded images.

/**
 * Build a lookup from {baseName, fullPath, normalizedPath} → base64 data
 */
function buildImageIndex(files) {
  const index = new Map();
  for (const f of files) {
    if (f.name === "pen") continue;
    const b64 = f.data.toString("base64");
    // The relative path the user dragged from — busboy gives us either "filename" or
    // the original path via webkitRelativePath which the client puts in `field` part.
    // Try multiple keys for robustness.
    const fullPath = (f.filename || "").replace(/\\/g, "/");
    index.set(fullPath, b64);
    // Base name lookup (case-insensitive)
    const base = fullPath.split("/").pop();
    if (base) index.set(base, b64);
    // Common subpath variants: with/without leading folder name
    const parts = fullPath.split("/");
    for (let i = 1; i < parts.length; i++) {
      index.set(parts.slice(i).join("/"), b64);
    }
  }
  return index;
}

function embedImages(tree, index) {
  let total = 0, embedded = 0, missing = [];

  function findData(url) {
    if (!url) return null;
    const decoded = decodeURIComponent(url).replace(/\\/g, "/");
    // Try full path, base name, and progressively shorter sub-paths
    if (index.has(decoded)) return index.get(decoded);
    const parts = decoded.split("/");
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(i).join("/");
      if (index.has(key)) return index.get(key);
    }
    return null;
  }

  function embedFill(fill) {
    if (!fill || typeof fill !== "object") return;
    if (fill.type === "image" && fill.url) {
      total++;
      const data = findData(fill.url);
      if (data) {
        fill.data = data;
        delete fill.url;
        embedded++;
      } else {
        missing.push(fill.url);
      }
    }
  }

  function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.fill != null) {
      if (Array.isArray(n.fill)) for (const f of n.fill) embedFill(f);
      else embedFill(n.fill);
    }
    if (Array.isArray(n.fills)) for (const f of n.fills) embedFill(f);
    if (n.stroke && n.stroke.fill) embedFill(n.stroke.fill);
    if (Array.isArray(n.children)) for (const c of n.children) walk(c);
  }

  if (Array.isArray(tree)) tree.forEach(walk); else walk(tree);
  return { total, embedded, missing };
}

// ─── Deep-snapshot via Pencil MCP ─────────────────────────────────────────────
// snapshot_layout only returns geometry. batch_get returns full data but truncates
// children below readDepth (replacing them with "..."). To get the full tree we
// recursively expand "..." subtrees, batched.

const RESOLVE_OPTS = { resolveVariables: true, resolveInstances: true };

async function fetchFullTree(mcp, rootId, penPath) {
  const baseArgs = { ...RESOLVE_OPTS, readDepth: 4 };
  if (penPath) baseArgs.filePath = penPath;

  // First, fetch the root with a sane depth. If we see "..." we expand iteratively.
  let tree = await mcp.tool("batch_get", { ...baseArgs, nodeIds: [rootId] });
  if (Array.isArray(tree)) tree = tree[0];

  // BFS for nodes whose children === "..." and replace with their fetched children.
  const MAX_PASSES = 20;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const truncated = collectTruncated(tree);
    if (truncated.length === 0) break;
    // Batch up to 20 ids per call
    const idsChunk = truncated.slice(0, 20).map((t) => t.id);
    const fetched = await mcp.tool("batch_get", { ...baseArgs, nodeIds: idsChunk });
    const fetchedById = new Map();
    for (const item of (Array.isArray(fetched) ? fetched : [fetched])) {
      if (item && item.id) fetchedById.set(item.id, item);
    }
    // Splice fetched children into the tree
    for (const t of truncated.slice(0, 20)) {
      const replacement = fetchedById.get(t.id);
      if (replacement && Array.isArray(replacement.children)) {
        t.node.children = replacement.children;
      } else {
        // No children at all, just clear the placeholder
        t.node.children = [];
      }
    }
  }
  return tree;
}

function collectTruncated(node) {
  const out = [];
  function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.children === "...") {
      out.push({ id: n.id, node: n });
      return;
    }
    if (Array.isArray(n.children)) for (const c of n.children) walk(c);
  }
  walk(node);
  return out;
}

// ─── Core handler ─────────────────────────────────────────────────────────────

async function handleImport(req, res) {
  let tmpDir;
  try {
    const { files, fields } = await parseMultipart(req);
    const penFile = files.find((f) => f.name === "pen" || /\.pen$/i.test(f.filename));
    if (!penFile) {
      return sendJson(res, 400, { error: "No .pen file received. Expected a multipart field 'pen' or a file with .pen extension." });
    }

    // Write .pen to a user-visible location — Pencil desktop (sandboxed) refuses
    // files served from /var/folders/.../tmp, but accepts paths under the user's
    // home directory. We use ~/.pencil-to-figma/inbox/<timestamp>/ and clean up after.
    const inboxRoot = join(homedir(), ".pencil-to-figma", "inbox");
    if (!existsSync(inboxRoot)) await mkdir(inboxRoot, { recursive: true });
    tmpDir = await mkdtemp(join(inboxRoot, "run-"));
    const penPath = join(tmpDir, penFile.filename || "design.pen");
    await writeFile(penPath, penFile.data);
    console.error(`[import] received ${penFile.filename} (${(penFile.size/1024).toFixed(1)} KB)`);
    console.error(`[import] received ${files.length - 1} image files`);
    console.error(`[import] tmp dir: ${tmpDir}`);

    // Spawn Pencil MCP
    const mcp = new McpClient(PENCIL_CMD, PENCIL_ARGS);
    try {
      await mcp.start();
      console.error(`[mcp] started`);

      // Open the document in Pencil desktop. Pencil needs the file to actually be
      // open in the editor — calling batch_get on a closed file always fails with
      // "A file needs to be open in the editor". 30s timeout because the desktop
      // app can take a while to load on first open.
      let documentOpened = false;
      try {
        await mcp.call("tools/call", {
          name: "open_document",
          arguments: { path: penPath },
        }, 30000);
        documentOpened = true;
        console.error(`[mcp] document opened via open_document`);
        // Give Pencil a moment to actually parse the file before we ask for its tree.
        // Without this pause, batch_get returns an empty array.
        await new Promise((r) => setTimeout(r, 1500));
      } catch (e) {
        console.error(`[mcp] open_document failed (${e.message}); falling back to filePath mode`);
      }

      // Discover the root frame(s). The first top-level frame is what we'll import.
      // For more advanced flows we'd offer a picker; for now grab the first frame.
      // Try the uploaded copy first. If Pencil desktop rejects it (sandboxing,
      // wrong-file errors), fall through to common locations on disk.
      let topLevel;
      const candidatePaths = [penPath];
      // Common alternate paths the file might exist at, for "use existing open file" fallback.
      for (const alt of [
        join(homedir(), "Downloads", penFile.filename),
        join(homedir(), "Desktop", penFile.filename),
      ]) {
        if (existsSync(alt) && alt !== penPath) candidatePaths.push(alt);
      }
      // Try batch_get against each candidate file path AND once without a path
      // (which targets the currently-open editor document). Retry with a tiny
      // backoff if the response is empty — Pencil can race the doc-open vs
      // first batch_get.
      let workingPath = null;
      let lastErr = null;
      const attempts = candidatePaths.map((p) => ({ filePath: p, label: p === penPath ? "uploaded copy" : p }));
      attempts.push({ filePath: null, label: "current open document (no filePath)" });

      for (const a of attempts) {
        for (let retry = 0; retry < 3; retry++) {
          try {
            const args = { readDepth: 1, ...RESOLVE_OPTS };
            if (a.filePath) args.filePath = a.filePath;
            const result = await mcp.tool("batch_get", args);
            const arr = Array.isArray(result) ? result : [result];
            if (arr.length > 0 && arr[0]) {
              topLevel = result;
              workingPath = a.filePath || null;
              console.error(`[mcp] batch_get OK (${a.label}, ${arr.length} top-level items)`);
              break;
            }
            console.error(`[mcp] batch_get empty for ${a.label}, retry ${retry + 1}/3 in 1500ms`);
            await new Promise((r) => setTimeout(r, 1500));
          } catch (e) {
            lastErr = e;
            console.error(`[mcp] batch_get error for ${a.label}: ${e.message}`);
            break;
          }
        }
        if (topLevel) break;
      }
      if (!topLevel) {
        throw lastErr || new Error(
          "Could not read .pen file via Pencil MCP. " +
          "Make sure Pencil desktop app is running and not stuck on another document."
        );
      }

      // Pick which top-level frames to import:
      //   - If `rootId` was passed explicitly via the form, import just that one.
      //   - Otherwise import every top-level frame that isn't a reusable component
      //     (components are inlined via resolveInstances on their instances).
      const topLevelArr = Array.isArray(topLevel) ? topLevel : [topLevel];
      let rootIds;
      if (fields.rootId) {
        rootIds = [fields.rootId];
      } else {
        rootIds = topLevelArr
          .filter((n) => n && n.type === "frame" && n.reusable !== true)
          .map((n) => n.id);
      }
      if (!rootIds.length) throw new Error("No importable top-level frames found in .pen file");
      console.error(`[mcp] importing ${rootIds.length} top-level frame(s): ${rootIds.join(", ")}`);

      // Variables
      const varsRaw = await mcp.tool("get_variables", {});
      const variables = normalizeVariables(varsRaw);
      console.error(`[mcp] ${Object.keys(variables).length} variables`);

      // Deep tree for each root, sequentially (Pencil MCP doesn't love parallel calls).
      console.error(`[mcp] fetching full trees from ${workingPath}…`);
      const trees = [];
      for (const id of rootIds) {
        try {
          const t = await fetchFullTree(mcp, id, workingPath);
          trees.push(t);
        } catch (e) {
          console.error(`[mcp] failed to fetch ${id}: ${e.message}`);
        }
      }
      if (!trees.length) throw new Error("Failed to fetch any frames");

      // Resolve any remaining $token strings (defensive pass)
      const resolved = trees.map((t) => resolveTokens(t, variables));

      // Embed images from uploaded files across all trees
      const imageIndex = buildImageIndex(files);
      let totalImages = 0, embeddedImages = 0;
      const missingAll = [];
      for (const t of resolved) {
        const s = embedImages(t, imageIndex);
        totalImages += s.total;
        embeddedImages += s.embedded;
        missingAll.push(...s.missing);
      }
      const stats = { total: totalImages, embedded: embeddedImages, missing: missingAll };
      console.error(`[import] embedded ${embeddedImages}/${totalImages} images across ${trees.length} frame(s), ${missingAll.length} missing`);

      // Persist a debug copy of the JSON we're shipping so we can inspect what
      // the plugin actually receives. Useful when image rendering looks wrong.
      if (process.env.MCP_DEBUG) {
        const debugDir = join(homedir(), ".pencil-to-figma", "debug");
        if (!existsSync(debugDir)) await mkdir(debugDir, { recursive: true });
        const debugFile = join(debugDir, `bridge-${Date.now()}.json`);
        await writeFile(debugFile, JSON.stringify({ tree: resolved, stats }, null, 2), "utf8");
        console.error(`[debug] full payload saved to ${debugFile}`);
      }

      return sendJson(res, 200, { tree: resolved, stats, rootIds, variables: Object.keys(variables).length });
    } finally {
      mcp.stop();
    }
  } catch (err) {
    console.error(`[error] ${err?.stack || err?.message || err}`);
    return sendJson(res, 500, { error: err?.message || String(err) });
  } finally {
    if (tmpDir) {
      rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    return sendText(res, 200, "pencil-to-figma bridge ok");
  }
  if (req.method === "POST" && req.url === "/import") {
    return handleImport(req, res);
  }
  sendText(res, 404, "Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[bridge] listening on http://localhost:${PORT}`);
  console.error(`[bridge] Pencil MCP cmd: ${PENCIL_CMD} ${PENCIL_ARGS.join(" ")}`);
  console.error(`[bridge] ready — open the Figma plugin and drop a .pen + images folder`);
});
