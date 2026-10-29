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
| `info` | read | the sprite's truth via a bundled read-only Lua probe: size, colour mode, frame count and per-frame durations, the layer tree with groups and visibility, animation tags (0-based, matching `frameRange`), slices, palette size |
| `export` | mutate | the CLI's export surface: plain `--save-as` (PNG/GIF/WebP/… by extension) or sprite sheets (`sheetType` layouts, fixed columns/rows, paddings, JSON metadata beside the image), with scaling, layer/tag selection, frame ranges, split-by-layer/tag, and trim. The result verifies the bytes landed and lists the produced files (a run that produced nothing says so) |
| `create` | mutate | creates a new sprite at the named size and colour mode (`rgb`, `indexed`, `gray`), in native `.aseprite` or any exportable format by extension |
| `draw` | mutate | draws an ordered `ops` batch on named layers and 0-based frames of an existing sprite: pixels, lines, rectangles, ellipses, circles and flood fills, with palette indices or RGBA colours; returns a PNG render by default |
| `render` | read | returns the sprite as a PNG image block and a clickable file path; choose a `frame` or `tag`, or view all frames side by side; optional integer `scale` uses nearest-neighbour pixels without resizing the sprite |
| `parts` | mutate | creates named layers or groups, shows or hides them, reorders siblings and duplicates independent cels across frames; one ordered `ops` batch and a PNG render by default |
| `describe` | read | returns compact structure: part paths and kinds, visibility, locks, opacity, stacking order, cel frames and bounds, frame durations, tags and palette size |
| `palette-check` | read | reports colours outside the sprite's per-frame palette, a named `.gpl`/`.hex` file or a supplied colour list, with counts and position summaries; never changes colours |
| `run-script` | exec | runs Lua against the app's scripting API, optionally opening a sprite first and passing `app.params` key/values (for palettes, cel edits, tilesets, and batch renames) |

Reads are permission-free; `export` and `create` ask naming source and
destination(s). `draw` and `parts` ask once per batch, naming the sprite and
listing the ordered operations. `run-script` always asks, carrying the code's
byte count and first line.

## Drawing and parts

`draw` and `parts` update an existing native `.aseprite` or `.ase` file.
The batch is saved only when every operation and its requested render succeed.
A failed operation leaves the original file unchanged. All coordinates and
frame numbers are 0-based. Layer paths include their groups, such as `Hero/Head`;
ambiguous paths refuse rather than selecting a part arbitrarily.

Each `draw` operation names `layer`, `frame` and `colour`: either `{index: 1}`
or `{r: 255, g: 128, b: 0, a: 255}` (alpha defaults to 255).
RGBA colours on indexed sprites must match a palette entry exactly.

| kind | inputs beyond layer, frame and colour | action |
| --- | --- | --- |
| `pixel` | `x`, `y` | sets one pixel |
| `line` | `x`, `y`, `x2`, `y2` | draws a one-pixel line, including both ends |
| `rect` | `x`, `y`, `x2`, `y2`, `fill?` | draws a rectangle with inclusive corners; `fill: true` fills it |
| `ellipse` | `x`, `y`, `x2`, `y2`, `fill?` | draws an ellipse inside inclusive corners; `fill: true` fills it |
| `circle` | `x`, `y`, `radius`, `fill?` | draws a circle centred at `x,y`; `fill: true` fills it |
| `flood-fill` | `x`, `y` | fills the four-connected region of exactly matching pixels on the named layer |

Strokes replace pixels with the supplied colour, including alpha. They use a
one-pixel brush and do not inherit personal brush, symmetry or tiled settings.
Points must lie inside the canvas. Drawing and part duplication use image
layers; tilemaps need `run-script`.

Each `parts` operation has a `kind` and the following inputs.

| kind | inputs | action |
| --- | --- | --- |
| `create` | `name`, `parent?`, `group?` | creates a layer, or a group with `group: true`; `parent` is a group path; names cannot contain `/` or duplicate a sibling |
| `show` / `hide` | `part` | changes the named layer or group's visibility |
| `reorder` | `part`, `index` | sets its 0-based position among siblings, bottom first |
| `duplicate` | `part`, `fromFrame`, `toFrames` | copies independent cels, including group descendants; replaces target cels, clears them when the source is empty, and extends the timeline with empty frames when needed |

`draw` and `parts` return render-back in the same batch. Set `preview: false`
to omit it. `frame` or `tag` selects the render, not the operations' targets;
`scale` is a positive integer and affects only the PNG. With neither selector,
all frames appear side by side in timeline order. Render files live in the
session scratchpad; use `export` for a permanent project image. Call `render`
to view sprites saved by `create`, `export` or `run-script`.

## Palette checking

`palette-check` inspects every image cel, including hidden layers and linked
cels in each frame. With no `palette`, it uses the sprite palette at that frame
and reports invalid indices in indexed sprites. `palette` can instead name a
`.gpl` or `.hex` file, parsed by Aseprite, or a list of hex colours
(`RRGGBB`, `#RRGGBB`, `RRGGBBAA`, `#RRGGBBAA`) and `{r,g,b,a?}` values.
Aseprite's `.gpl` alpha extension (`Channels: RGBA`) is supported.

The report gives `outsidePixels`, `scannedPixels`, `transparentPixels` and
`colours`. Each outside colour or invalid index has a count and per-layer/frame
`positions`: a first pixel, a count and a bounding rectangle in canvas
coordinates. Fully transparent pixels are counted separately and excluded
from outside colours. Tilemaps refuse rather than producing a partial audit.
No palette check quantises, replaces or otherwise repairs colours.

## Paths and the fence

`file`/`output`/`dataOutput` resolve against the working directory and are
fenced inside it for all fixed verbs; palette files are fenced too. A path
outside the working tree is refused with the remedy. Split and multi-frame exports may use `{layer}`, `{tag}`
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

Bundled Lua for the fixed verbs is written to private temporary files per run
and removed afterwards; `run-script` is the only path that runs custom Lua.

## Bounds and honesty

Every spawn has a deadline (`status`/`info` 15s · `create` 30s ·
`export` and the art verbs 60s · `run-script` 60s default) with output capped
and any truncation counted. Export and creation results carry file
sizes and the binary's version. Art results carry the sprite path, operation
report and, when requested, the PNG. Aseprite's own errors are reported.
Mercury never installs, launches, or updates Aseprite for you.
