// One interface over both generations of the Pencil MCP surface.
//
// Pen desktop 1.2.x replaced the granular tools (batch_get, get_variables,
// get_editor_state, export_nodes) with a single `execute` tool that runs a JS
// snippet against the document (Get / GetVariables / Export …), plus
// `get_app_state`. Calling batch_get on such a build fails with
// "tool 'batch_get' not found", so the pipeline talks to this module instead and
// never cares which build is installed.
//
// Two quirks of the execute-era app, both observed on host 1.2.10:
//   • The FIRST tool call of a fresh MCP session often hangs for ~62s and then fails
//     with "you are probably referencing the wrong .pen file" — for any tool and any
//     file. Calls after it answer in ~0.4s, and an abandoned hung call does not block
//     them. So we spend that first call on a cheap get_app_state with a short timeout.
//   • `execute` requires a filePath; there is no "whatever is open" default.

import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

// Print() emits strings raw, one line per call. JSON.stringify never produces a raw
// newline, so a marker prefix is enough to pick our payload lines out of the
// response (which also carries "OK", section headers and warnings).
const MARK = "@@P2F@@";

const GET_OPTS = "{resolveVariables:true,resolveInstances:true,includePathGeometry:true}";

const WARMUP_TIMEOUT_MS = 5000;
const EXECUTE_TIMEOUT_MS = 90000;

function toolText(res) {
  if (!res || !Array.isArray(res.content)) return typeof res === "string" ? res : "";
  return res.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

function parseMarked(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const i = line.indexOf(MARK);
    if (i < 0) continue;
    out.push(JSON.parse(line.slice(i + MARK.length).trim()));
  }
  return out;
}

function activePathFrom(text) {
  // get_app_state:    - Currently active canvas editor: `/Users/me/My designs/x.pen`
  // get_editor_state: ## Currently active editor\n- `/Users/me/design.pen`
  // Backticks first: real paths contain spaces ("ai qurylys"), which a bare
  // non-whitespace match cuts in half.
  const m = text.match(/`([^`]+\.pen)`/) || text.match(/([\/~][^\s`'"]*\.pen)/);
  return m ? m[1].replace(/^~/, homedir()) : null;
}

const isFlakyFailure = (e) => /wrong \.pen file|MCP call timeout/i.test(e?.message || "");

/**
 * @param {import("./mcp-client.mjs").McpClient} mcp  a started client
 * @param {(msg: string) => void} [log]
 */
export async function connectPencil(mcp, log = () => {}) {
  const listed = await mcp.call("tools/list", {});
  const names = new Set((listed?.tools || []).map((t) => t.name));
  if (names.has("batch_get")) return legacyApi(mcp);
  if (!names.has("execute")) {
    throw new Error(
      `This Pencil build exposes neither batch_get nor execute (tools: ${[...names].join(", ") || "none"}). ` +
      `pencil-to-figma needs an update for it.`
    );
  }
  log(`[mcp] Pencil execute API`);
  return executeApi(mcp, log);
}

// macOS stores paths in either Unicode normalization and Pencil hands back whichever
// one it has, so compare them normalized — every one of these paths has Cyrillic in it.
export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    let v = String(p);
    try { v = realpathSync(v); } catch { /* not on disk — compare as given */ }
    return v.normalize("NFC");
  };
  return norm(a) === norm(b);
}

/**
 * Make `filePath` the document Pencil has open, and confirm it.
 *
 * Pencil does NOT fail when asked to read a file it doesn't have open: it answers with
 * whatever document IS open. Dropping a closed `katalog-tort.pen` imported the open
 * `ai-qurylys.pen` instead — 65 frames of a different project, reported as a success.
 * So the file is opened first (macOS hands a .pen to Pencil) and the editor is polled
 * until it reports that very file; anything else throws rather than importing.
 */
export async function ensureDocumentActive(api, filePath, log = () => {}, timeoutMs = 30000) {
  const active = await api.activeDocument();
  if (samePath(active, filePath)) return { opened: false, active };

  log(`[mcp] Pencil has ${active || "no document"} open — opening ${filePath}`);
  try {
    spawn("open", [filePath], { stdio: "ignore", detached: true }).unref();
  } catch (e) {
    throw new Error(`Could not ask macOS to open ${filePath}: ${e.message}`);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 800));
    let now = null;
    try { now = await api.activeDocument(true); } catch { /* app still starting */ }
    if (samePath(now, filePath)) {
      log(`[mcp] Pencil now has ${now} open`);
      return { opened: true, active: now };
    }
  }
  throw new Error(
    `Pencil did not open "${filePath}". It reads only the document it has open, so the import would ` +
    `have brought in whatever else is open. Open the file in Pencil and import again.`
  );
}

function executeApi(mcp, log) {
  let activeCache;

  async function appState(timeoutMs) {
    return toolText(await mcp.call("tools/call", { name: "get_app_state", arguments: {} }, timeoutMs));
  }

  async function activeDocument(force = false) {
    if (!force && activeCache !== undefined) return activeCache;
    activeCache = undefined;
    let text = null;
    for (let attempt = 1; attempt <= 3 && text == null; attempt++) {
      try {
        text = await appState(WARMUP_TIMEOUT_MS);
      } catch (e) {
        log(`[mcp] get_app_state attempt ${attempt} failed (${e.message})`);
      }
    }
    activeCache = text ? activePathFrom(text) : null;
    return activeCache;
  }

  async function run(filePath, input) {
    const path = filePath || (await activeDocument());
    if (!path) {
      throw new Error("Pencil reports no open document — open the .pen file in Pencil and retry.");
    }
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await mcp.call(
          "tools/call", { name: "execute", arguments: { filePath: path, input } }, EXECUTE_TIMEOUT_MS
        );
        return toolText(res);
      } catch (e) {
        if (attempt >= 2 || !isFlakyFailure(e)) throw e;
        log(`[mcp] execute failed (${e.message}) — retrying once`);
      }
    }
  }

  return {
    kind: "execute",

    // Also the session warm-up: it absorbs the first-call hang described above.
    activeDocument,

    async topLevel(filePath) {
      const text = await run(filePath,
        `Get((n,c)=>{c.skipChildren();Print(${JSON.stringify(MARK)}+JSON.stringify({id:n.id,type:n.type,name:n.name,reusable:n.reusable===true}))})`
      );
      return parseMarked(text);
    },

    // Full subtrees: without `depth`, Get returns the whole subtree with no "..."
    // placeholders (a 43-frame / 2k-node deck is ~1 MB and comes back in ~1s).
    async getNodes(ids, filePath) {
      const text = await run(filePath,
        `for(const id of ${JSON.stringify(ids)})Print(${JSON.stringify(MARK)}+JSON.stringify(Get(id,${GET_OPTS})))`
      );
      return parseMarked(text);
    },

    // Every reusable definition in the document, top-level or nested inside a frame.
    async listReusable(filePath) {
      const text = await run(filePath,
        `Get((n,c)=>{if(n.reusable)Print(${JSON.stringify(MARK)}+JSON.stringify({id:n.id,name:n.name,top:c.depth===0}))})`
      );
      return parseMarked(text);
    },

    // Each node twice: as stored — instances stay `ref` nodes carrying only their
    // overrides — and with instances expanded. Components mode needs both.
    async getNodePairs(ids, filePath) {
      const raw = `{resolveVariables:true,includePathGeometry:true}`;
      const text = await run(filePath,
        `for(const id of ${JSON.stringify(ids)}){` +
          `Print(${JSON.stringify(MARK)}+JSON.stringify(Get(id,${raw})));` +
          `Print(${JSON.stringify(MARK)}+JSON.stringify(Get(id,${GET_OPTS})))}`
      );
      const flat = parseMarked(text);
      const pairs = [];
      for (let i = 0; i + 1 < flat.length; i += 2) pairs.push({ raw: flat[i], resolved: flat[i + 1] });
      return pairs;
    },

    // Pencil's own layout result for every node under `id` (instances expanded, so
    // ids match both the resolved tree and components-mode `_resolved` copies):
    // id → [x, y, width, height] in the parent's space. The plugin checks its
    // result against these — text that wrapped into a different number of lines,
    // a box that came out a different size.
    async getBoxes(ids, filePath) {
      const text = await run(filePath,
        `const r=[];for(const id of ${JSON.stringify(ids)})Get(id,(n,c)=>{const b=c.bounds;r.push([n.id,+b.x.toFixed(2),+b.y.toFixed(2),+b.width.toFixed(2),+b.height.toFixed(2)])},{resolveInstances:true});` +
        `Print(${JSON.stringify(MARK)}+JSON.stringify(r))`
      );
      const rows = parseMarked(text)[0] || [];
      const map = new Map();
      for (const [nid, x, y, w, h] of rows) map.set(String(nid), [x, y, w, h]);
      return map;
    },

    // PNG renders of whole frames, for the 1:1 check.
    async exportFrames(ids, outputDir, filePath) {
      await run(filePath, `Export(${JSON.stringify(ids)},"png",${JSON.stringify(outputDir)},{scale:1})`);
    },

    async getVariables(filePath) {
      const text = await run(filePath, `Print(${JSON.stringify(MARK)}+JSON.stringify(GetVariables()))`);
      return parseMarked(text)[0] || {};
    },

    // Files land as <rawId>.png, same naming as the old export_nodes.
    async exportPng(ids, outputDir, scale, filePath) {
      await run(filePath,
        `Export(${JSON.stringify(ids)},"png",${JSON.stringify(outputDir)},{scale:${Number(scale) || 2}})`
      );
    },
  };
}

function legacyApi(mcp) {
  const RESOLVE_OPTS = { resolveVariables: true, resolveInstances: true, includePathGeometry: true };
  const withPath = (args, filePath) => (filePath ? { ...args, filePath } : args);
  const asArray = (r) => (Array.isArray(r) ? r : r ? [r] : []);

  return {
    kind: "legacy",

    // get_editor_state hangs when a second MCP client is attached to Pencil, and a
    // hang is not evidence that nothing is open — so a short timeout, and null on
    // failure rather than an error.
    async activeDocument(_force = false) {
      try {
        const state = await mcp.tool("get_editor_state", { include_schema: false }, 8000);
        return activePathFrom(typeof state === "string" ? state : JSON.stringify(state));
      } catch {
        return null;
      }
    },

    async topLevel(filePath) {
      return asArray(await mcp.tool("batch_get", withPath({ readDepth: 1, ...RESOLVE_OPTS }, filePath)));
    },

    // batch_get truncates below readDepth with "..." — fetchFullTree expands those.
    async getNodes(ids, filePath) {
      return asArray(await mcp.tool("batch_get", withPath({ ...RESOLVE_OPTS, readDepth: 4, nodeIds: ids }, filePath)));
    },

    async listReusable() {
      throw new Error("Components mode needs Pen 1.2+ (the execute API). Update Pencil, or import without components.");
    },

    async getNodePairs() {
      throw new Error("Components mode needs Pen 1.2+ (the execute API). Update Pencil, or import without components.");
    },

    // No layout readout in the old API — the plugin simply skips the checks that need it.
    async getBoxes() {
      return new Map();
    },

    async exportFrames(ids, outputDir, filePath) {
      await mcp.tool("export_nodes", withPath({ nodeIds: ids, outputDir, format: "png", scale: 1 }, filePath));
    },

    async getVariables() {
      return mcp.tool("get_variables", {});
    },

    async exportPng(ids, outputDir, scale, filePath) {
      await mcp.tool("export_nodes", withPath({ nodeIds: ids, outputDir, format: "png", scale }, filePath));
    },
  };
}
