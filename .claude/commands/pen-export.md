---
description: Export a .pen file to JSON ready for the pencil-to-figma plugin
---

You are exporting a pencil.dev `.pen` design to a JSON file that the
`pencil-to-figma` Figma plugin can import directly. The user invoked this slash
command with a path argument: $ARGUMENTS

Project root: `~/PycharmProjects/pencil-to-figma/` (referred to below as `$PROJ`).

**How this works now.** Pen desktop 1.2.x replaced the old granular MCP tools
(`batch_get`, `get_variables`, `get_editor_state`, `open_document`, `export_nodes`,
`snapshot_layout`, `get_screenshot`) with one `execute` tool plus `get_app_state`.
It also accepts several MCP clients at once, so the old reason for fetching the tree
yourself ("Pencil serves one client, and you already hold it") is gone. The CLI
exporter speaks both APIs (`exporter/lib/pencil-api.mjs`) — **run it; do not pull
the tree through your own context.** A real board is ~1 MB of JSON.

## Steps

1. **Resolve the input path.**
   - If `$ARGUMENTS` is empty, ask the user for the absolute path to a `.pen` file and stop.
   - If the path doesn't end in `.pen`, warn the user but proceed.
   - Output path is the input with a `.json` extension, unless `--out <path>` is given.
   - `--node <id>` exports a single top-level frame instead of all of them.
   - `--components` keeps Pencil components: the JSON becomes `{ tree, components }`,
     and the plugin builds real Figma components with linked instances. Pass it
     through if the user asks for components.

2. **Make sure Pencil has that document open.** Pencil only reads documents open in
   the app.
   - `mcp__pencil__get_app_state` → the line `Currently active canvas editor: \`<path>\``.
   - If it is a different file (or nothing is open), run `open "<abs path>.pen"` via
     Bash — macOS hands it to Pen — then call `get_app_state` again to confirm.
   - The very first Pencil call of a fresh MCP session can hang ~60s and fail with
     *"you are probably referencing the wrong .pen file"* even for the right file.
     That is a Pencil quirk, not a wrong path: just call it again.

3. **Run the exporter.**

   ```bash
   cd $PROJ && node exporter/cli.mjs "<abs path>.pen" --out "<outPath>" [--node <id>] [--components]
   ```

   It fetches every non-reusable top-level frame in full (components are inlined into
   their instances via `resolveInstances`; with `--components` they're exported as
   definitions and the instances keep their overrides), resolves `$token` refs, attaches real SVG
   vectors to `icon` nodes (PNG fallback through Pencil's Export for glyphs it can't
   resolve), and embeds image fills as base64 from the `.pen` file's directory
   (e.g. `assets/…`). Give it a generous Bash timeout (5 min) on big boards.

   - Exit 0 — done. Exit 3 — some subtrees could not be expanded, the JSON is
     incomplete; report which roots the log flags.
   - Exit 2 with *"wrong .pen file"* — the document isn't open in Pencil (step 2),
     or Pencil is stuck: ask the user to check the app, then retry once.

4. **Summarize** from the CLI's `[ok]` block: frames, nodes, images embedded/total,
   icons (vectors / rasterized / total), output path. If the log lists
   `[icons] no SVG for: …` or missing images, name them. Then:
   `Figma → Plugins → Development → Pencil Import → tab "Drop design.json" → drop <outPath>`

## If the CLI can't run

Only if spawning the CLI's own MCP client fails for a reason other than the ones
above (e.g. an old Pencil build that really does serve a single client), capture the
tree yourself and hand it to `exporter/process.mjs`:

- Root ids: `mcp__pencil__execute` with `filePath` and
  `Get((n,c)=>{c.skipChildren();return n.reusable?undefined:n.type==="frame"?n.id:undefined}).forEach(id=>Print(id))`
- Each root, one `execute` per root to keep responses small:
  `Print(JSON.stringify(Get("<id>",{resolveVariables:true,resolveInstances:true,includePathGeometry:true})))`
  — without `depth`, `Get` returns the whole subtree, no `"..."` placeholders.
- Variables: `Print(JSON.stringify(GetVariables()))`.
- Write the roots as a JSON array to `/tmp/pen-tree.json`, the variables to
  `/tmp/pen-vars.json`, then:

  ```bash
  cd $PROJ && node exporter/process.mjs /tmp/pen-tree.json /tmp/pen-vars.json "<dir-of-the-.pen-file>" --out "<outPath>"
  ```

  Exit 3 means a truncated subtree slipped through. This path has no PNG fallback
  for unresolved icons; they import as empty slots.

## Notes

- Never `Read`/`Grep` a `.pen` file — it is encrypted; only Pencil's MCP can read it.
- Don't screenshot anything: the plugin rebuilds the design from structural data.
