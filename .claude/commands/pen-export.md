---
description: Export a .pen file to JSON ready for the pencil-to-figma plugin
---

You are exporting a pencil.dev `.pen` design to a JSON file that the
`pencil-to-figma` Figma plugin can import directly. The user invoked this slash
command with a path argument: $ARGUMENTS

Project root: `~/PycharmProjects/pencil-to-figma/` (referred to below as `$PROJ`).

**Why this command exists instead of just running `node exporter/cli.mjs`:** the CLI
spawns its own Pencil MCP client, and Pencil serves exactly ONE client at a time. You
already hold that connection, so the CLI would fail with *"you are probably
referencing the wrong .pen file"*. So: **you** fetch the tree over MCP, then hand it
to `exporter/process.mjs` for the steps that need no MCP.

## Steps

1. **Resolve the input path.**
   - If `$ARGUMENTS` is empty, ask the user for the absolute path to a `.pen` file and stop.
   - If the path doesn't end in `.pen`, warn the user but proceed.
   - Output JSON path is the input with a `.json` extension, unless `--out <path>` is given.

2. **Open the document.**
   - `mcp__pencil__open_document` with the absolute path.
   - `mcp__pencil__get_editor_state` to confirm it loaded and list top-level nodes.

3. **Pick the roots.**
   - `mcp__pencil__batch_get` with `readDepth: 1`, `resolveVariables: true`,
     `resolveInstances: true`, and the `filePath`.
   - Take every top-level node with `type: "frame"` and `reusable !== true`.
     Reusable components are inlined into their instances by `resolveInstances`, so
     exporting them separately would duplicate them.
   - If the user named a single frame, use just that one.

4. **Fetch the COMPLETE tree for each root.** This is the step that matters most.
   - Use `mcp__pencil__batch_get` with **`resolveVariables: true`,
     `resolveInstances: true`, `includePathGeometry: true`, `readDepth: 4`**.
   - **Do NOT use `snapshot_layout`.** It returns geometry only — `id`, `x`, `y`,
     `width`, `height`. No `type`, no `fill`, no `content`, no `icon`. A tree built
     from it imports as a stack of blank boxes.
   - `batch_get` truncates anything below `readDepth`, replacing deeper children with
     the **string** `"..."`. You must expand these iteratively: collect every node
     whose `children === "..."`, re-fetch those ids in batches (~40 at a time), splice
     the returned `children` arrays in, and repeat **until no `"..."` remains**.
     A real board is 10+ levels deep and needs dozens of rounds — do not stop early,
     and do not cap the number of rounds. Every placeholder you leave behind is a
     section of the design that silently disappears from the import.
   - Sanity-check before moving on: search the assembled JSON for `"..."`. Zero hits.

5. **Fetch design tokens.** `mcp__pencil__get_variables` (no args) → a flat map of
   token-name → `{ type, value }`. Write it to a temp file, e.g. `/tmp/pen-vars.json`.

6. **Write the raw tree** to a temp file, e.g. `/tmp/pen-tree.json`, with the Write tool.

7. **Post-process** — run the project's processor, which resolves `$token` refs,
   attaches real SVG vectors to every `icon` node, embeds image fills as base64, and
   re-verifies that no truncated subtree slipped through:

   ```bash
   cd $PROJ && node exporter/process.mjs /tmp/pen-tree.json /tmp/pen-vars.json <dir-of-the-.pen-file> --out <outPath>
   ```

   - `<dir-of-the-.pen-file>` is where image filenames resolve against.
   - Exit code 3 means the tree was still truncated — go back to step 4.
   - Read its output: it reports node count, images embedded, and icons resolved.
     If it lists `[icons] NO SVG`, tell the user which glyphs will import blank.

8. **Summarize.** Report node count, images (embedded/missing), variables resolved,
   icons resolved as vectors, and the output path. Then:
   `Figma → Plugins → Development → Pencil Import → tab "Drop design.json" → drop <outPath>`

## Notes

- Do **not** call `mcp__pencil__get_screenshot`. The plugin recreates the design from
  structural data, not rasterized snapshots.
- Icon nodes look like
  `{ "type": "icon", "library": "Material Symbols Rounded", "icon": "space_dashboard", "fill": "#FFF" }`
  — just pass them through untouched; `process.mjs` resolves the glyph.
- Unlike the bridge (mode A), this path has no PNG raster fallback for icons — that
  needs an MCP round-trip through `export_nodes`. Unresolved glyphs import as empty
  slots, which `process.mjs` warns about.
