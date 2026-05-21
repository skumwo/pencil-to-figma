---
description: Export a .pen file to JSON ready for the pencil-to-figma plugin
---

You are exporting a pencil.dev `.pen` design to a JSON file that the
`pencil-to-figma` Figma plugin can import directly. The user invoked this slash
command with a path argument: $ARGUMENTS

## Steps

1. **Resolve the input path.**
   - If `$ARGUMENTS` is empty, ask the user for the absolute path to a `.pen` file and stop.
   - If the path doesn't end in `.pen`, warn the user but proceed.
   - The output JSON path is the same as the input with `.json` extension, unless the user passes `--out <path>`.

2. **Open the document via Pencil MCP.**
   - Call `mcp__pencil__open_document` with the resolved absolute path.
   - Then `mcp__pencil__get_editor_state` to confirm it loaded and list top-level frames.

3. **Snapshot the full tree.**
   - Call `mcp__pencil__snapshot_layout` with `maxDepth: 20` (or higher if needed). Do NOT pass a `nodeId` unless the user explicitly asked for a single frame.
   - Save the result — this is the structural tree.

4. **Fetch design tokens / variables.**
   - Call `mcp__pencil__get_variables` (no args). The result is a flat map of token-name → `{ type, value }`.

5. **Resolve all `$token` references in the tree to concrete values.**
   - Walk every string in the tree. If a string starts with `$`, look up its name in the variables map and replace it with the variable's `value`. Recurse if the resolved value is itself a `$token` (cycle-guard with a Set).

6. **Embed images as base64.**
   - For every image fill `{ type: "image", url: "..." }` in the tree:
     - The `url` is a URL-encoded relative filename (e.g. `WhatsApp%20Image%20…png`). Decode it.
     - Resolve it against the **directory of the .pen file** — that's where the image bytes actually live.
     - Read the file with Bash (`cat` is fine, then base64 it) or with the Node `fs` API. Cache per filename so duplicates aren't re-read.
     - Replace the fill object: set `data` to the base64 string, delete `url`.
     - If a referenced file is missing, leave the fill as-is and warn the user.

7. **Write the JSON file.**
   - Output path defaults to `<input>.json` next to the .pen file.
   - Use Write tool with `JSON.stringify(tree, null, 2)`.

8. **Summarize to the user.**
   - Report: total nodes, image count (embedded + missing), variables resolved, output file path.
   - End with the next-step instruction:
     `Open Figma → Plugins → Development → Pencil Import → drop ${outPath}`.

## Notes

- The exporter project lives at `~/PyCharmProjects/pencil-to-figma/` — for reference, but you do NOT need to run any code from that project; this slash command does the work directly via Pencil MCP.
- The `pencil-to-figma` plugin expects this JSON schema (subset): `{ type, x, y, width, height, fill?, stroke?, text?, layout?, children? }` with image fills as `{ type: "image", data: "<base64>", mode }` and color fills as `{ type: "color", color: "#rrggbb" }`. The snapshot from Pencil MCP already matches this shape after token + image processing — no further transform is needed.
- Do not call `mcp__pencil__get_screenshot`. The plugin recreates the design from structural data, not rasterized snapshots.
