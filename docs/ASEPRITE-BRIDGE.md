# The Aseprite batch door

Mercury's `Aseprite` tool drives the local Aseprite — the pixel-art and
2D-sprite tool — through the app's own batch mode: every operation is one
bounded background run of `aseprite -b`, and the GUI is never launched.
Unlike the Unity and Blender bridges there is no live connection to keep:
Aseprite ships a real batch CLI (exports, sprite sheets, list flags, Lua
scripts), so the CLI is the whole door — no add-on, no port, no token,
nothing to install on either side.

## Arming

One switch: the **"Aseprite dev lanes"** boot-menu row
(`MERCURY_ASEPRITE=1`). Off is byte-identical to a build without any of it:
no tool, no spawn, no line in the harness map the model reads. Armed, the
tool joins the catalog
beside sprite files (a bounded `.aseprite`/`.ase` walk — like Blender,
the file is the unit of work; there is no project-root marker) **or**
wherever the app itself is located, so creating a first sprite into an
empty tree works. Armed with neither, a foreign repo stays clean: no tool.

## Finding the app

One resolution law, every rung a filesystem fact (the app is never executed
to be found, and never installed):

1. `MERCURY_ASEPRITE_BIN` — the operator's explicit pin (a broken pin
   refuses by name, never a silent fallback; this is the road for source
   builds living outside every standard install location);
2. a PATH `aseprite`;
3. the macOS app bundles — `/Applications/Aseprite.app` and its
   `~/Applications` sibling;
4. the Steam library on all three platforms (Aseprite's main store);
5. the Windows installer root (`Program Files\Aseprite`) and the itch.io
   app home.

Nothing found ⇒ a precise unavailable naming every road probed and the
install remedy. The version comes from the binary's own `--version`
(release builds answer like `Aseprite 1.3.7-arm64`, source builds
`Aseprite 1.x-dev`), probed briefly and cached.

## The verbs

| verb | class | what it does |
| --- | --- | --- |
| `status` | read | the resolution verdict (which rung, or the roads probed), the version, and the working tree's sprite census |
| `info` | read | the sprite's truth via a bundled read-only Lua probe: size, color mode, frame count and per-frame durations, the layer tree with groups and visibility, animation tags (0-based, matching `frameRange`), slices, palette size |
| `export` | mutate | the CLI's real export surface — plain `--save-as` (PNG/GIF/WebP/… by extension) or the sprite-sheet road (`sheetType` layouts, fixed columns/rows, paddings, JSON metadata beside the image); with scaling, layer/tag selection, frame ranges, split-by-layer/tag, trim. The result verifies the bytes landed and lists the produced files — a run that produced nothing says so |
| `create` | mutate | a new sprite born at the named size and color mode (rgb · indexed · gray), native `.aseprite` or any exportable format by extension |
| `run-script` | exec | your Lua against the app's full scripting API, optionally with a sprite opened first and `app.params` key/values — the road for everything the fixed verbs do not cover (palettes, cel edits, tilesets, batch renames) |

Reads are permission-free; `export` and `create` ask naming source and
destination(s); `run-script` always asks, carrying the code's byte count
and first line.

## Paths and the fence

`file`/`output`/`dataOutput` resolve against the working directory and are
fenced inside it for `info`/`export`/`create` — the refusal names the tree
and the remedy. Split and multi-frame exports may use `{layer}`, `{tag}`
and `{frame}` templates in the output name; a multi-frame sprite saved to a
still format gets the frame number inserted by the app itself, and the
result's file census understands both shapes. `run-script` is the one road
that may touch files outside the tree — its permission ask is the fence.

## run-script — the contract

- The script runs with the app's own script authority: it can modify
  sprites and write files as you. There is no sandbox beyond a bounded
  deadline; the permission ask is the fence.
- There is no preemption inside the app: a runaway script is killed at the
  deadline (default 60s, `timeoutMs` caps at 120s), and the kill is named
  in the result.

Bundled Lua (the `info` probe and the `create` program) is content-fixed at
build time, written to a private temporary file per run and removed after —
`run-script` is the only road for foreign Lua.

## Bounds and honesty

Every spawn is deadline-killed (`status`/`info` 15s · `create` 30s ·
`export` 60s · `run-script` 60s default) with output capped and the
truncation counted. Results carry provenance: the file acted on, the output
files with byte sizes verified on disk, the binary's version, and which
resolution rung found it. Aseprite's own errors are carried honestly —
never guessed at. Mercury never installs, launches, or updates Aseprite
for you.
