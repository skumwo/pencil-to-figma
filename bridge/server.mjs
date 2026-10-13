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
// The bridge spawns the bundled Pencil MCP binary, discovered from the installed
// app bundle — override with PENCIL_MCP_CMD env var if your install path differs.

import http from "node:http";
import { mkdtemp, writeFile, rm, mkdir, readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Busboy from "busboy";

import { McpClient, findPencilMcp } from "../exporter/lib/mcp-client.mjs";
import { connectPencil, ensureDocumentActive } from "../exporter/lib/pencil-api.mjs";
import { resolveTokens, normalizeVariables } from "../exporter/lib/resolve-tokens.mjs";
import { availableLibraries } from "../exporter/lib/icon-svg.mjs";
import { compareRenders } from "../exporter/lib/verify.mjs";
import { normalizeImageForFigma } from "../exporter/lib/image-normalize.mjs";
import {
  annotateLineHeights,
  attachBoxes,
  fetchComponentTrees,
  linkedNodes,
  fetchFullTree,
  countTreeNodes,
  resolveIcons,
  resolveOpenDocument,
  resolveUnsupportedFills,
} from "../exporter/lib/fetch-tree.mjs";

const PORT = parseInt(process.env.PEN_BRIDGE_PORT || "7777", 10);

const PENCIL_CMD = process.env.PENCIL_MCP_CMD || findPencilMcp();
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
    // defParamCharset MUST be utf8: busboy defaults to latin1, which turns a
    // Content-Disposition filename sent as UTF-8 bytes into mojibake — "пакет.png"
    // arrived as "Ð¿Ð°ÐºÐµÑ.png" and never matched its own url in the .pen, so every
    // non-ASCII image name silently failed to embed (22 of 44 fills on the pricelist).
    const bb = Busboy({
      headers: req.headers,
      defParamCharset: "utf8",
      limits: { fileSize: 50 * 1024 * 1024, fieldSize: 10 * 1024 * 1024 },
    });
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
 * Normalize a path into a lookup key. Both sides of the match go through this,
 * so a name can't miss over a difference the filesystem considers cosmetic:
 *   • NFC — macOS stores "й"/"ё"/accented Latin decomposed (NFD), while the .pen
 *     carries whatever Pencil wrote. The two are the same name, different bytes.
 *   • lower case — APFS is case-insensitive by default, so "Пакет.png" in the
 *     design and "пакет.png" on disk are one file to the user.
 * A silent near-miss here costs an image with no error anywhere, so match wide.
 */
function imageKey(path) {
  return String(path || "").replace(/\\/g, "/").normalize("NFC").toLowerCase();
}

/**
 * Build a lookup from {baseName, fullPath, normalizedPath} → { buf, name }. Bytes stay
 * raw here: only the images a design actually uses get normalised for Figma
 * (finalizeImages), not every file in a dropped folder.
 */
function buildImageIndex(files) {
  const index = new Map();
  for (const f of files) {
    if (f.name === "pen") continue;
    const b64 = { buf: f.data, name: f.filename || "" };
    // The relative path the user dragged from — busboy gives us either "filename" or
    // the original path via webkitRelativePath which the client puts in `field` part.
    // Try multiple keys for robustness.
    const fullPath = (f.filename || "").replace(/\\/g, "/");
    index.set(imageKey(fullPath), b64);
    // Base name lookup
    const base = fullPath.split("/").pop();
    if (base) index.set(imageKey(base), b64);
    // Common subpath variants: with/without leading folder name
    const parts = fullPath.split("/");
    for (let i = 1; i < parts.length; i++) {
      index.set(imageKey(parts.slice(i).join("/")), b64);
    }
  }
  return index;
}

function embedImages(tree, index) {
  let total = 0, embedded = 0, missing = [];

  function findData(url) {
    if (!url) return null;
    let decoded;
    try { decoded = decodeURIComponent(url); } catch { decoded = String(url); }
    decoded = decoded.replace(/\\/g, "/");
    // Try full path, base name, and progressively shorter sub-paths
    if (index.has(imageKey(decoded))) return index.get(imageKey(decoded));
    const parts = decoded.split("/");
    for (let i = 0; i < parts.length; i++) {
      const key = imageKey(parts.slice(i).join("/"));
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
        fill._buf = data.buf;
        fill._bufName = data.name;
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
    for (const c of linkedNodes(n)) walk(c);
  }

  if (Array.isArray(tree)) tree.forEach(walk); else walk(tree);
  return { total, embedded, missing };
}

// Turn the raw bytes the embed passes attached (`_buf`) into what the plugin gets:
// normalised for Figma (see image-normalize.mjs), then base64.
async function finalizeImages(trees) {
  const notes = [];
  const fills = [];
  for (const t of trees) fills.push(...collectImageFills(t));
  const pending = fills.filter((f) => f._buf);
  await Promise.all(pending.map(async (f) => {
    const r = await normalizeImageForFigma(f._buf, f._bufName || "");
    if (r.changed && r.note) notes.push(`${(f._bufName || "image").split("/").pop()}: ${r.note}`);
    if (r.error) notes.push(`${(f._bufName || "image").split("/").pop()}: left as is (${r.error})`);
    f.data = r.buf.toString("base64");
    delete f._buf;
    delete f._bufName;
  }));
  return [...new Set(notes)];
}

// ─── Remote image fetching ────────────────────────────────────────────────────
// Image fills can point at a remote URL (e.g. an Unsplash link) instead of a
// local file dropped into the images folder. Those never match an uploaded file,
// so without this pass they reach the plugin with only a `url` and no `data` —
// and the plugin renders them as an empty/gray placeholder box. Fetch each
// remote URL once and embed it as base64, exactly like the local-file path does.

function collectImageFills(tree) {
  const out = [];
  function pushFill(fill) {
    if (fill && typeof fill === "object" && fill.type === "image") out.push(fill);
  }
  function walk(n) {
    if (!n || typeof n !== "object") return;
    if (n.fill != null) {
      if (Array.isArray(n.fill)) n.fill.forEach(pushFill); else pushFill(n.fill);
    }
    if (Array.isArray(n.fills)) n.fills.forEach(pushFill);
    if (n.stroke && n.stroke.fill) {
      if (Array.isArray(n.stroke.fill)) n.stroke.fill.forEach(pushFill); else pushFill(n.stroke.fill);
    }
    for (const c of linkedNodes(n)) walk(c);
  }
  if (Array.isArray(tree)) tree.forEach(walk); else walk(tree);
  return out;
}

async function embedRemoteImages(trees) {
  const fills = [];
  for (const t of trees) fills.push(...collectImageFills(t));
  // Only fills that still need data and point at a fetchable http(s) URL.
  const remote = fills.filter(
    (f) => !f.data && !f._buf && typeof f.url === "string" && /^https?:\/\//i.test(f.url)
  );
  if (!remote.length) return { total: 0, fetched: 0, failed: [] };

  // De-duplicate by URL — the same image can be used in many places; fetch once
  // and fan the bytes back out to every fill that references it.
  const byUrl = new Map();
  for (const f of remote) {
    if (!byUrl.has(f.url)) byUrl.set(f.url, []);
    byUrl.get(f.url).push(f);
  }

  let fetched = 0;
  const failed = [];
  for (const [url, targets] of byUrl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      let resp;
      try {
        resp = await fetch(url, { signal: controller.signal, redirect: "follow" });
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      for (const f of targets) {
        f._buf = buf;
        f._bufName = url.split("?")[0];
        delete f.url;
      }
      fetched++;
    } catch (e) {
      failed.push(url);
      console.error(`[remote] fetch failed ${url}: ${e.message}`);
    }
  }
  return { total: byUrl.size, fetched, failed };
}

// ─── Design tree, icons and rasterization ────────────────────────────────────
// All of this lives in exporter/lib/fetch-tree.mjs so the bridge (mode A) and the
// standalone exporter (mode B) fetch designs through exactly the same pipeline.

// ─── 1:1 check ────────────────────────────────────────────────────────────────
// After an import the plugin renders every frame it built and posts the PNGs to
// /verify. The Pencil side of the comparison is rendered here, in the background,
// as soon as /import has answered — so it is usually ready by the time Figma is.
// Everything lands in ~/.pencil-to-figma/verify/<run>/: both renders of every frame,
// a diff overlay for each one that differs, and report.json.

const VERIFY_ROOT = join(homedir(), ".pencil-to-figma", "verify");
const KEEP_RUNS = 3;
const sessions = new Map();

function safeName(s) {
  return String(s || "frame").replace(/[\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80);
}

async function renderPencilFrames(workingPath, roots) {
  const dir = await mkdtemp(join(homedir(), ".pencil-to-figma", "pencil-render-"));
  const mcp = new McpClient(PENCIL_CMD, PENCIL_ARGS);
  const errors = [];
  try {
    await mcp.start();
    const api = await connectPencil(mcp, (m) => console.error(m));
    await api.activeDocument();
    for (let i = 0; i < roots.length; i += 4) {
      const ids = roots.slice(i, i + 4).map((r) => r.id);
      try {
        await api.exportFrames(ids, dir, workingPath);
      } catch (e) {
        errors.push(`${ids.join(", ")}: ${e.message}`);
      }
    }
  } finally {
    mcp.stop();
  }
  const files = new Map();
  for (const f of await readdir(dir)) {
    if (f.endsWith(".png")) files.set(f.replace(/\.png$/, ""), join(dir, f));
  }
  console.error(`[verify] Pencil rendered ${files.size}/${roots.length} frame(s)${errors.length ? `, ${errors.length} chunk(s) failed` : ""}`);
  return { dir, files, errors };
}

function startSession(workingPath, roots) {
  const id = randomUUID();
  const session = { id, workingPath, roots, created: Date.now(), pencil: null };
  if (workingPath && PENCIL_CMD) {
    session.pencil = renderPencilFrames(workingPath, roots).catch((e) => {
      console.error(`[verify] Pencil render failed: ${e.message}`);
      return { dir: null, files: new Map(), errors: [e.message] };
    });
  }
  sessions.set(id, session);
  // Only the latest few imports can still be verified.
  for (const [k, v] of sessions) {
    if (sessions.size <= 5) break;
    if (v !== session) {
      v.pencil?.then((r) => r.dir && rm(r.dir, { recursive: true, force: true })).catch(() => {});
      sessions.delete(k);
    }
  }
  return session;
}

async function pruneRuns() {
  try {
    const runs = (await readdir(VERIFY_ROOT)).filter((d) => /^\d{8}-\d{6}/.test(d)).sort();
    for (const d of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS))) {
      await rm(join(VERIFY_ROOT, d), { recursive: true, force: true });
    }
  } catch { /* nothing to prune */ }
}

async function handleVerify(req, res) {
  try {
    const { files, fields } = await parseMultipart(req);
    const session = sessions.get(fields.session || "");
    if (!session) {
      return sendJson(res, 404, { error: "This import can't be verified any more — re-import to run the 1:1 check." });
    }
    if (!session.pencil) {
      return sendJson(res, 503, { error: "Pencil renders are unavailable for this import." });
    }
    let textBoxes = {};
    try { textBoxes = JSON.parse(fields.texts || "{}"); } catch {}
    let issues = [];
    try { issues = JSON.parse(fields.issues || "[]"); } catch {}
    let diagnostics = {};
    try { diagnostics = JSON.parse(fields.diagnostics || "{}"); } catch {}

    const pencil = await session.pencil;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const runDir = join(VERIFY_ROOT, stamp);
    await mkdir(runDir, { recursive: true });

    const nameOf = new Map(session.roots.map((r) => [String(r.id), r.name]));
    const order = new Map(session.roots.map((r, i) => [String(r.id), i]));
    const frames = [];
    for (const f of files) {
      if (f.name !== "render") continue;
      const id = (f.filename || "").replace(/\.png$/i, "");
      const name = nameOf.get(id) || id;
      const base = join(runDir, `${String((order.get(id) ?? 99) + 1).padStart(2, "0")} ${safeName(name)}`);
      await writeFile(`${base} — figma.png`, f.data);
      const pencilPath = pencil.files.get(id);
      if (!pencilPath) {
        frames.push({ id, name, status: "no-pencil-render", regions: [] });
        continue;
      }
      const pencilBuf = await readFile(pencilPath);
      await writeFile(`${base} — pencil.png`, pencilBuf);
      let r;
      try {
        r = compareRenders(pencilBuf, f.data, textBoxes[id] || []);
      } catch (e) {
        frames.push({ id, name, status: "error", error: e.message, regions: [] });
        continue;
      }
      if (r.overlay) await writeFile(`${base} — diff.png`, r.overlay);
      frames.push({ id, name, status: r.status, px: r.px, regions: r.regions.slice(0, 12), size: r.size || undefined });
    }
    frames.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));

    const summary = {
      frames: frames.length,
      match: frames.filter((f) => f.status === "match").length,
      differs: frames.filter((f) => f.status === "differs").length,
      other: frames.filter((f) => !["match", "differs"].includes(f.status)).length,
      issues: issues.length,
    };
    const report = {
      created: new Date().toISOString(),
      document: session.workingPath,
      summary,
      frames,
      issues,
      plugin: diagnostics,
      pencilRenderErrors: pencil.errors,
    };
    await writeFile(join(runDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
    pruneRuns();
    console.error(
      `[verify] ${summary.match}/${summary.frames} frame(s) match` +
      (summary.differs ? `, ${summary.differs} differ` : "") +
      (summary.other ? `, ${summary.other} not compared` : "") +
      (issues.length ? `, ${issues.length} layout issue(s)` : "") +
      ` → ${runDir}`
    );
    return sendJson(res, 200, { dir: runDir, summary, frames, issues: issues.slice(0, 50) });
  } catch (err) {
    console.error(`[verify] ${err?.stack || err?.message || err}`);
    return sendJson(res, 500, { error: err?.message || String(err) });
  }
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

    if (!PENCIL_CMD) {
      return sendJson(res, 500, {
        error: "Pencil/Pen desktop app not found. Install it, or start the bridge with " +
               "PENCIL_MCP_CMD=/path/to/mcp-server-darwin-arm64.",
      });
    }

    // Spawn Pencil MCP
    const mcp = new McpClient(PENCIL_CMD, PENCIL_ARGS);
    try {
      await mcp.start();
      console.error(`[mcp] started`);
      const api = await connectPencil(mcp, (m) => console.error(m));

      // Pencil MCP can only read the document that is OPEN IN THE EDITOR. It is a
      // thin shim over the desktop app: a read with a `filePath` for a file the
      // app doesn't have open just times out ("you are probably referencing the wrong
      // .pen file"), and `open_document` doesn't exist in every build.
      //
      // That makes the identity of the document a correctness issue, not a detail: the
      // previous version tried the uploaded copy, timed out after 30s, then silently
      // fell back to "whatever is open" and reported success. Drop file A while file B
      // is open in Pencil and you got a faithful import — of B. So: ask Pencil which
      // document it actually has, and refuse to import a different one.
      // PEN_ALLOW_MISMATCH=1 is the deliberate escape hatch ("just import what's open").
      const droppedName = (penFile.filename || "design.pen").split("/").pop();
      const doc = await resolveOpenDocument(
        api,
        { name: droppedName, bytes: penFile.data },
        process.env.PEN_ALLOW_MISMATCH === "1",
        (m) => console.error(m)
      );
      const workingPath = doc.workingPath;

      // Pencil answers a read for a file it doesn't have open with whatever document
      // IS open, so make the requested one active before reading anything.
      if (workingPath) {
        await ensureDocumentActive(api, workingPath, (m) => console.error(m));
      }

      let topLevel;
      let lastErr = null;
      for (let retry = 0; retry < 3 && !topLevel; retry++) {
        try {
          const arr = await api.topLevel(workingPath);
          if (arr.length > 0 && arr[0]) {
            topLevel = arr;
            console.error(`[mcp] read OK (${arr.length} top-level items)`);
            break;
          }
          // Pencil can race the doc-open against the first read.
          console.error(`[mcp] read empty, retry ${retry + 1}/3 in 1500ms`);
          await new Promise((r) => setTimeout(r, 1500));
        } catch (e) {
          lastErr = e;
          console.error(`[mcp] read error: ${e.message}`);
          break;
        }
      }
      if (!topLevel) {
        throw lastErr || new Error(
          `Could not read ${workingPath || "the active Pencil document"} via Pencil MCP. Make sure ` +
          `the Pencil desktop app is responsive and no other MCP client (e.g. Claude Code) is attached.`
        );
      }

      // Pick which top-level frames to import:
      //   - If `rootId` was passed explicitly via the form, import just that one.
      //   - Otherwise import every top-level frame that isn't a reusable component
      //     (components are inlined via resolveInstances on their instances).
      let rootIds;
      if (fields.rootId) {
        rootIds = [fields.rootId];
      } else {
        rootIds = topLevel
          .filter((n) => n && n.type === "frame" && n.reusable !== true)
          .map((n) => n.id);
      }
      if (!rootIds.length) throw new Error("No importable top-level frames found in .pen file");
      console.error(`[mcp] importing ${rootIds.length} top-level frame(s): ${rootIds.join(", ")}`);

      // Variables
      const varsRaw = await api.getVariables(workingPath);
      const variables = normalizeVariables(varsRaw);
      console.error(`[mcp] ${Object.keys(variables).length} variables`);

      // Deep tree for each root, sequentially (Pencil MCP doesn't love parallel calls).
      // Components mode keeps instances as `ref` nodes and ships the reusable
      // definitions alongside, so the plugin can build real Figma components.
      const withComponents = fields.components === "1";
      console.error(`[mcp] fetching full trees from ${workingPath}${withComponents ? " (components mode)" : ""}…`);
      let trees = [];
      let componentDefs = [];
      let instanceCount = 0;
      let incompleteRoots = 0;
      if (withComponents) {
        const r = await fetchComponentTrees(api, rootIds, workingPath, (m) => console.error(m));
        trees = r.trees;
        componentDefs = r.components;
        instanceCount = r.refs;
      } else {
        for (const id of rootIds) {
          try {
            const r = await fetchFullTree(api, id, workingPath, (m) => console.error(m));
            trees.push(r.tree);
            if (r.incomplete) incompleteRoots += r.incomplete;
          } catch (e) {
            console.error(`[mcp] failed to fetch ${id}: ${e.message}`);
          }
        }
      }
      if (!trees.length) throw new Error("Failed to fetch any frames");
      if (trees.length < rootIds.length) {
        console.error(`[mcp] WARNING only ${trees.length}/${rootIds.length} top-level frames were fetched`);
      }

      // Resolve any remaining $token strings (defensive pass). Component definitions
      // go through every pass below with the pages — `all` is the list to walk.
      const resolved = trees.map((t) => resolveTokens(t, variables));
      const components = componentDefs.map((t) => resolveTokens(t, variables));
      const all = [...resolved, ...components];

      try {
        await attachBoxes(api, all, workingPath, (m) => console.error(m));
      } catch (e) {
        console.error(`[layout] failed: ${e.message}`);
      }
      annotateLineHeights(all, (m) => console.error(m));

      // `icon` nodes (lucide / phosphor / Material Symbols / feather) have no native
      // Figma equivalent, so we supply real vectors where we can and rasterize the
      // rest. path/vector nodes are NOT rasterized here — the plugin builds real
      // editable vectors from their `geometry` (fetched via includePathGeometry),
      // which reproduces thin/gradient lines exactly and avoids the export_nodes
      // round-trip (and its occasional hang on large batches).
      let fillSummary = null;
      try {
        fillSummary = await resolveUnsupportedFills(api, all, workingPath, (m) => console.error(m));
      } catch (e) {
        console.error(`[fills] processing failed: ${e.message}`);
      }

      let iconSummary = null;
      try {
        iconSummary = await resolveIcons(api, all, workingPath, (m) => console.error(m));
      } catch (e) {
        console.error(`[icons] processing failed: ${e.message}`);
      }

      // Fetch & embed remote image URLs (e.g. Unsplash links) that aren't among
      // the uploaded local files. Run before the local pass so these fills already
      // carry `data` (url deleted) and aren't double-counted as "missing" below.
      try {
        const remoteStats = await embedRemoteImages(all);
        if (remoteStats.total) {
          console.error(
            `[remote] embedded ${remoteStats.fetched}/${remoteStats.total} remote image(s)` +
            (remoteStats.failed.length ? `, ${remoteStats.failed.length} failed` : "")
          );
        }
      } catch (e) {
        console.error(`[remote] processing failed: ${e.message}`);
      }

      // Embed images from uploaded files across all trees
      const imageIndex = buildImageIndex(files);
      let totalImages = 0, embeddedImages = 0;
      const missingAll = [];
      for (const t of all) {
        const s = embedImages(t, imageIndex);
        totalImages += s.total;
        embeddedImages += s.embedded;
        missingAll.push(...s.missing);
      }
      // Every image that ended up in the design, made Figma-safe: ≤4096px, sRGB.
      const imageNotes = await finalizeImages(all);
      for (const n of imageNotes) console.error(`[images] ${n}`);

      const nodeCount = resolved.reduce((s, t) => s + countTreeNodes(t), 0);
      const stats = {
        total: totalImages,
        embedded: embeddedImages,
        missing: missingAll,
        nodes: nodeCount,
        icons: iconSummary,
        unsupportedFills: fillSummary,
        incompleteSubtrees: incompleteRoots,
        components: withComponents ? { definitions: components.length, instances: instanceCount } : null,
        // Which document this actually came from, so an unverifiable import can't
        // pass for a verified one in the UI.
        document: {
          requested: droppedName,
          source: workingPath || "active editor in Pencil",
          verified: doc.verified,
          how: doc.how,
        },
      };
      console.error(`[import] embedded ${embeddedImages}/${totalImages} images across ${trees.length} frame(s), ${missingAll.length} missing`);
      console.error(`[import] shipping ${nodeCount} nodes to the plugin`);

      // Persist a debug copy of the JSON we're shipping so we can inspect what
      // the plugin actually receives. Useful when image rendering looks wrong.
      if (process.env.MCP_DEBUG) {
        const debugDir = join(homedir(), ".pencil-to-figma", "debug");
        if (!existsSync(debugDir)) await mkdir(debugDir, { recursive: true });
        const debugFile = join(debugDir, `bridge-${Date.now()}.json`);
        await writeFile(debugFile, JSON.stringify({ tree: resolved, components, stats }, null, 2), "utf8");
        console.error(`[debug] full payload saved to ${debugFile}`);
      }

      // Start rendering the Pencil side of the 1:1 check right away.
      const nameById = new Map(topLevel.map((n) => [String(n.id), n.name]));
      const session = startSession(workingPath, rootIds.map((id) => ({ id, name: nameById.get(String(id)) || id })));

      return sendJson(res, 200, {
        session: session.id,
        tree: resolved,
        components: withComponents ? components : undefined,
        stats,
        rootIds,
        variables: Object.keys(variables).length,
      });
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
  if (req.method === "POST" && req.url === "/verify") {
    return handleVerify(req, res);
  }
  if (req.method === "POST" && req.url === "/import") {
    return handleImport(req, res);
  }
  sendText(res, 404, "Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[bridge] listening on http://localhost:${PORT}`);
  if (PENCIL_CMD) {
    console.error(`[bridge] Pencil MCP cmd: ${PENCIL_CMD} ${PENCIL_ARGS.join(" ")}`);
  } else {
    console.error(`[bridge] WARNING: Pencil/Pen desktop app not found in /Applications or ~/Applications.`);
    console.error(`[bridge]          Set PENCIL_MCP_CMD=/path/to/mcp-server-darwin-arm64 before importing.`);
  }
  console.error(`[bridge] icon vectors available for: ${availableLibraries().join(", ") || "(none — run npm install)"}`);
  console.error(`[bridge] ready — open the Figma plugin and drop a .pen + images folder`);
});
