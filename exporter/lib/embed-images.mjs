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

  // A Pencil `fill` (and `stroke`) is `Fill | Fill[]` — a layer can stack an image
  // under a gradient scrim. Passing the array straight to embedFill silently did
  // nothing (an array has no `.type`), so stacked image fills were never embedded
  // and reached the plugin as a bare URL it had to drop.
  async function embedFills(value) {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const f of value) await embedFill(f);
    } else {
      await embedFill(value);
    }
  }

  async function walk(node) {
    if (!node || typeof node !== "object") return;
    await embedFills(node.fill);
    await embedFills(node.fills);
    // `stroke` is itself a Fills value; older exports nested it under `.fill`.
    await embedFills(node.stroke);
    if (node.stroke && !Array.isArray(node.stroke) && node.stroke.fill) {
      await embedFills(node.stroke.fill);
    }
    // Text fills
    if (node.text) {
      await embedFills(node.text.fill);
      await embedFills(node.text.fills);
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
