# The Aseprite batch door

Mercury's `Aseprite` tool drives the local Aseprite pixel-art and
2D-sprite application through its built-in batch mode: every operation is one
bounded background run of `aseprite -b`, and the GUI is never launched.
Unlike the Unity and Blender bridges there is no persistent socket connection:
Aseprite ships a batch CLI (exports, sprite sheets, list flags, Lua
scripts), so the CLI handles every operation with no add-on, port, or token to
install.

## Arming

One switch: the **"Aseprite dev lanes"** Boot Menu row
(`MERCURY_ASEPRITE=1`). Off is byte-identical to a build without any of it:
no tool, no spawn, no line in the harness map the model reads. Armed, the
tool joins the catalog
beside sprite files (a bounded `.aseprite`/`.ase` walk where the sprite file
is the unit of work) **or**
wherever the application is installed, so creating a first sprite in an
empty repository works. Armed with neither, a repository without sprites or Aseprite stays clean.

## Finding the app

One resolution law, every rung a filesystem fact (the app is never executed
to be found, and never installed):

1. `MERCURY_ASEPRITE_BIN`: your explicit binary path (a broken path
   refuses by name, never falling back silently; use this for source
   builds outside standard install locations);
2. `aseprite` on `PATH`;
3. the macOS app bundles (`/Applications/Aseprite.app` and
   `~/Applications/Aseprite.app`);
4. the Steam library on all three platforms;
5. the Windows installer root (`Program Files\Aseprite`) and the itch.io
   app directory.

Nothing found ⇒ a precise unavailable naming every road probed and the
install remedy. The version comes from the binary's own `--version`
(release builds answer like `Aseprite 1.3.7-arm64`, source builds
`Aseprite 1.x-dev`), probed briefly and cached.

## The verbs

| verb | class | what it does |
| --- | --- | --- |
| `status` | read | the resolution verdict (which rung, or the roads probed), the version, and the working tree's sprite census |
| `info` | read | the sprite's truth via a bundled read-only Lua probe: size, color mode, frame count and per-frame durations, the layer tree with groups and visibility, animation tags (0-based, matching `frameRange`), slices, palette size |
| `export` | mutate | the CLI's export surface: plain `--save-as` (PNG/GIF/WebP/… by extension) or sprite sheets (`sheetType` layouts, fixed columns/rows, paddings, JSON metadata beside the image), with scaling, layer/tag selection, frame ranges, split-by-layer/tag, and trim. The result verifies the bytes landed and lists the produced files (a run that produced nothing says so) |
| `create` | mutate | creates a new sprite at the named size and color mode (`rgb`, `indexed`, `gray`), in native `.aseprite` or any exportable format by extension |
| `run-script` | exec | runs Lua against the app's scripting API, optionally opening a sprite first and passing `app.params` key/values (for palettes, cel edits, tilesets, and batch renames) |

Reads are permission-free; `export` and `create` ask naming source and
destination(s); `run-script` always asks, carrying the code's byte count
and first line.

## Paths and the fence

`file`/`output`/`dataOutput` resolve against the working directory and are
fenced inside it for `info`/`export`/`create`; a path outside the working tree is
refused with the remedy. Split and multi-frame exports may use `{layer}`, `{tag}`
and `{frame}` templates in the output name; a multi-frame sprite saved to a
still format gets the frame number inserted by the app itself, and the
result's file census understands both shapes. `run-script` is the one operation
that may touch files outside the working tree, gated by its permission prompt.

## `run-script` contract

- The script runs with the app's own script authority: it can modify
  sprites and write files as you. There is no sandbox beyond a bounded
  deadline; the permission ask is the fence.
- There is no preemption inside the app: a runaway script is killed at the
  deadline (default 60s, `timeoutMs` caps at 120s), and the kill is named
  in the result.

Bundled Lua (the `info` probe and the `create` program) is fixed at
build time, written to a private temporary file per run and removed afterwards;
`run-script` is the only path that runs custom Lua.

## Bounds and honesty

Every spawn has a deadline (`status`/`info` 15s · `create` 30s ·
`export` 60s · `run-script` 60s default) with output capped and any
truncation counted. Results carry provenance: the file acted on, the output
files with byte sizes verified on disk, the binary's version, and which
resolution step found it. Aseprite's own errors are reported verbatim.
Mercury never installs, launches, or updates Aseprite for you.
