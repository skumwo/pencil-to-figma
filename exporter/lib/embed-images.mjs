// Image embedder — finds image fills referencing relative file URLs,
// reads the file from disk, and replaces `url` with base64 `data`.

import { readFile } from "node:fs/promises";
import { join, isAbsolute, dirname } from "node:path";
import { existsSync } from "node:fs";

/**
 * Walk a node tree, replace image fill URLs with embedded base64 bytes.
 * Caches reads so repeated images aren't re-read.
 *
 * @param {any} tree
 * @param {string} baseDir  directory of the .pen file — where image filenames are resolved against
 * @param {string[]} [extraSearch]  fallback directories to try
 */
export async function embedImages(tree, baseDir, extraSearch = []) {
  const cache = new Map();
  let total = 0, missing = 0;

  async function findAndRead(name) {
    if (cache.has(name)) return cache.get(name);
    const decoded = decodeURIComponent(name);
    const candidates = [];
    if (isAbsolute(decoded)) candidates.push(decoded);
    candidates.push(join(baseDir, decoded));
    for (const d of extraSearch) candidates.push(join(d, decoded));
    for (const p of candidates) {
      if (existsSync(p)) {
        const bytes = await readFile(p);
        const b64 = bytes.toString("base64");
        cache.set(name, b64);
        return b64;
      }
    }
    cache.set(name, null);
    return null;
  }

  async function walk(node) {
    if (!node || typeof node !== "object") return;
    // Single fill
    if (node.fill) await embedFill(node.fill);
    // Array of fills
    if (Array.isArray(node.fills)) for (const f of node.fills) await embedFill(f);
    // Stroke fill
    if (node.stroke && node.stroke.fill) await embedFill(node.stroke.fill);
    // Text fills
    if (node.text) {
      if (node.text.fill) await embedFill(node.text.fill);
      if (Array.isArray(node.text.fills)) for (const f of node.text.fills) await embedFill(f);
    }
    if (Array.isArray(node.children)) for (const c of node.children) await walk(c);
  }

  async function embedFill(fill) {
    if (!fill || fill.type !== "image" || !fill.url) return;
    total++;
    const b64 = await findAndRead(fill.url);
    if (b64) {
      fill.data = b64;
      delete fill.url;
    } else {
      missing++;
      console.warn(`[warn] image not found: ${fill.url}`);
    }
  }

  await walk(tree);
  return { total, missing, cachedBytes: cache.size };
}
