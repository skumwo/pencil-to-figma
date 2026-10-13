// Make an image something Figma will show exactly as Pencil does.
//
// Two ways the bytes that work in Pencil fail in Figma:
//   • Size. figma.createImage refuses anything over 4096px on a side ("Image is too
//     large"), so the 3434×8033 roll-up photo imported as an empty frame. It is scaled
//     down to 4096 on its long side — still 2× the density of the 850×2000 frame it
//     fills, so nothing visible is lost.
//   • Colour profile. Pencil renders through Chromium, which colour-manages a Display
//     P3 image; Figma (an sRGB document) shows the raw values, so the P3 Kidlavie logo
//     came out visibly duller. The pixels are converted to sRGB, which is what Pencil
//     ends up putting on screen anyway.
//
// macOS `sips` does both, in place, without extra dependencies. On other platforms the
// image is passed through unchanged.

import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";

export const FIGMA_MAX_IMAGE_SIDE = 4096;
const SRGB_PROFILE = "/System/Library/ColorSync/Profiles/sRGB Profile.icc";
const SIPS = "/usr/bin/sips";

const cache = new Map(); // sha1 → Promise<{ buf, changed, note }>

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

function isSrgb(profile) {
  return !profile || /^<nil>$/i.test(profile) || /sRGB/i.test(profile);
}

async function normalize(buf, name) {
  if (process.platform !== "darwin" || !existsSync(SIPS)) return { buf, changed: false };
  const ext = (extname(name || "") || ".png").toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp", ".heic", ".tif", ".tiff", ".gif"].includes(ext)) {
    return { buf, changed: false };
  }
  const dir = await mkdtemp(join(tmpdir(), "p2f-img-"));
  try {
    const src = join(dir, "in" + ext);
    await writeFile(src, buf);
    const info = await run(SIPS, ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "profile", src]);
    const w = Number((info.match(/pixelWidth:\s*(\d+)/) || [])[1] || 0);
    const h = Number((info.match(/pixelHeight:\s*(\d+)/) || [])[1] || 0);
    const profile = ((info.match(/profile:\s*(.+)/) || [])[1] || "").trim();

    const tooBig = Math.max(w, h) > FIGMA_MAX_IMAGE_SIDE;
    const convert = !isSrgb(profile) && existsSync(SRGB_PROFILE);
    if (!tooBig && !convert) return { buf, changed: false };

    // GIF/HEIC/WebP come back as PNG so Figma can take them.
    const outExt = [".jpg", ".jpeg"].includes(ext) ? ".jpg" : ".png";
    const out = join(dir, "out" + outExt);
    const args = [];
    if (tooBig) args.push("-Z", String(FIGMA_MAX_IMAGE_SIDE));
    if (convert) args.push("-m", SRGB_PROFILE);
    args.push("-s", "format", outExt === ".jpg" ? "jpeg" : "png");
    if (outExt === ".jpg") args.push("-s", "formatOptions", "92");
    args.push(src, "--out", out);
    await run(SIPS, args);
    const next = await readFile(out);
    const notes = [];
    if (tooBig) notes.push(`${w}×${h} → max ${FIGMA_MAX_IMAGE_SIDE}px`);
    if (convert) notes.push(`${profile} → sRGB`);
    return { buf: next, changed: true, note: notes.join(", ") };
  } catch (e) {
    return { buf, changed: false, error: e.message };
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {Buffer} buf   image bytes
 * @param {string} name  file name (for its extension)
 * @returns {Promise<{buf: Buffer, changed: boolean, note?: string, error?: string}>}
 */
export function normalizeImageForFigma(buf, name) {
  const key = createHash("sha1").update(buf).digest("hex");
  if (!cache.has(key)) cache.set(key, normalize(buf, name));
  return cache.get(key);
}
