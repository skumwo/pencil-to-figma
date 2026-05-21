// Minimal JSON-RPC 2.0 client for Pencil MCP server over stdio.
// Spawns a child process and exposes a `call(method, params)` Promise API.

import { spawn } from "node:child_process";

export class McpClient {
  /**
   * @param {string} command  e.g. "npx"
   * @param {string[]} args   e.g. ["-y", "@pencil-dev/mcp"]
   */
  constructor(command, args, env = {}) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.proc = null;
    this.buf = "";
    this.nextId = 1;
    this.pending = new Map();
    this.initialized = false;
  }

  async start() {
    this.proc = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...this.env },
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this._onData(chunk));
    this.proc.on("error", (e) => this._rejectAll(e));
    this.proc.on("exit", (code) => {
      if (code !== 0 && this.pending.size) {
        this._rejectAll(new Error(`MCP server exited with code ${code}`));
      }
    });

    // Per MCP spec, initialize handshake first.
    const init = await this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "pencil-to-figma-exporter", version: "0.1.0" },
    });
    // Send the required notification after initialize
    this._send({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.initialized = true;
    return init;
  }

  stop() {
    if (this.proc && !this.proc.killed) this.proc.kill();
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch {
        if (process.env.MCP_DEBUG) console.error("[mcp ← (non-json)]", line.slice(0, 200));
        continue;
      }
      if (process.env.MCP_DEBUG) console.error("[mcp ←]", JSON.stringify(msg).slice(0, 300));
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  }

  _rejectAll(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  _send(obj) {
    if (process.env.MCP_DEBUG) console.error("[mcp →]", JSON.stringify(obj).slice(0, 300));
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  call(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP call timeout: ${method} (${timeoutMs}ms)`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async tool(name, args = {}) {
    const res = await this.call("tools/call", { name, arguments: args });
    // The MCP tools/call result wraps tool output in `content`. Pencil tools
    // typically return JSON-as-text or plain text. We try to parse text content.
    if (res && Array.isArray(res.content)) {
      const text = res.content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n");
      try { return JSON.parse(text); }
      catch { return text; }
    }
    return res;
  }
}
