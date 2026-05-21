// esbuild config — compiles plugin/src/code.ts to plugin/dist/code.js
// and copies ui.html alongside it. Run `node plugin/build.mjs` or with --watch.

import * as esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, "src");
const outDir = join(__dirname, "dist");

if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const baseOptions = {
  entryPoints: [join(srcDir, "code.ts")],
  outfile: join(outDir, "code.js"),
  bundle: true,
  platform: "browser",
  target: "es2017",
  format: "iife",
  // Figma sandbox has no DOM globals like document/window — but our plugin code
  // talks to figma.* and uses fetch-free atob (available in the sandbox).
  logLevel: "info",
};

async function copyUi() {
  await copyFile(join(srcDir, "ui.html"), join(outDir, "ui.html"));
  console.log("[copy] ui.html → dist/ui.html");
}

if (watch) {
  const ctx = await esbuild.context({
    ...baseOptions,
    plugins: [
      {
        name: "copy-ui-on-rebuild",
        setup(b) {
          b.onEnd(() => copyUi().catch((e) => console.error(e)));
        },
      },
    ],
  });
  await copyUi();
  await ctx.watch();
  console.log("[watch] esbuild watching… Ctrl+C to stop.");
  // hold the process open
  await new Promise(() => {});
} else {
  await esbuild.build(baseOptions);
  await copyUi();
  console.log("[done] plugin built in dist/");
}
