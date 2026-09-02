# The Blender bridge

Mercury's `Blender` tool drives a running Blender the way the `Unity` tool
drives a running Unity editor: over a token-authed, loopback-only NDJSON/TCP
connection served by a Python add-on Mercury ships as source and installs
on ask. Protocol version 1; the Python half ships under
`assets/blender/bridge/` as the classic add-on `mercury_blender_bridge` (a
`bl_info` add-on, which both current Blender LTS lines load; it is not
packaged as a Blender extension).

## Arming

One switch: the **"Blender dev lanes"** boot-menu row (`MERCURY_BLENDER=1`)
— the same flag that arms `.blend` awareness, the headless launch profiles,
and the debugpy attach recipe. Off is byte-identical to a build without any
of it: no tool, no client, no token file, no readiness row, no line in the
harness map the model reads. The tool joins the catalog only in a `.blend`
context (the bounded
walk finds at least one `.blend` — Blender has no project-root marker; the
file is the unit of work).

Three value knobs: `MERCURY_BLENDER_BRIDGE_PORT` (default 6012; the
loopback dev-lane family is Godot LSP 6005 · Godot DAP 6006 · VULCAN 6010 ·
Unity 6011 · this bridge 6012), `MERCURY_BLENDER_BRIDGE_TOKEN` (a
proof/embedder override), and `MERCURY_BLENDER_BRIDGE_ADDON_DIR` (an
authoritative install-home pin for nonstandard layouts).

## Install — and the enable step that stays yours

`op:"blender_bridge_install"` (a permissioned mutate) resolves the user
addon home down a ladder with every arm named — the `ADDON_DIR` pin, then
Blender's own `BLENDER_USER_SCRIPTS`/`BLENDER_USER_RESOURCES`, then the
per-OS default for the probed Blender version (on a Mac:
`~/Library/Application Support/Blender/<X.Y>/scripts/addons`) — and writes
everything INSIDE one directory, `mercury_blender_bridge/`:

1. the add-on source files;
2. the session token (`token`, mode 0600, 64-hex, per-install — the add-on
   finds it beside itself, Mercury knows it because it put it there);
3. `config.json` — only when Mercury's port differs from the default, so
   both halves agree; removed when the default returns.

No Blender located and no pin? Install **refuses** with the reason naming
every road, and writes nothing.

**Enabling is never automated.** Blender keeps add-on enablement in the
binary `userpref.blend` — there is no honest text edit — so the install
receipt teaches both roads and stops: Edit > Preferences > Add-ons, search
"Mercury"; or run the printed
`--python-expr "…addon_enable(module='mercury_blender_bridge'); …save_userpref()"`
one-liner yourself. `op:"blender_status"` reports enablement as unknowable
from disk; an **answering** bridge is the proof of installed + enabled +
open. `op:"blender_bridge_uninstall"` removes the directory whole — token
and config ride along.

## The verbs

| verb | class | what it does |
| --- | --- | --- |
| `scene_info` | read | blend filepath / saved / dirty · Blender version · scenes · frame range · engine · context mode · active object |
| `objects_list` | read | the outliner truth: collection trees + objects, bounded, truncation counted |
| `blend_open` | mutate | open a `.blend` (path fenced inside the working tree, Mercury-side) — unsaved work refuses `BLEND_DIRTY` (save first; nothing is ever discarded) |
| `render_state` | read | per-job running truth (RENDER / RENDER_PREVIEW / COMPOSITE / OBJECT_BAKE) + engine/resolution/output/frames — readable DURING a render by design |
| `render_still` | exec | render a frame as an editor JOB to a fenced `outputPath`; answers `{started:true}` at once; **the image file is the durable result**, `render_finished` reports the end |
| `report_tail` | read | the add-on's honest ring (Python logging + bridge notes + lifecycle events; C-level terminal prints are out of Python's reach and the tool says so) |
| `python_run` | exec | execute Python inside Blender — the executor verb; see below |

Reads are permission-free; `blend_open` asks (and its message says what
really happens — a file switch is not an undo step); renders and
`python_run` always ask.

## python_run — the two sentences that are contract

- python_run claims NO sandbox: the code runs inside Blender with full bpy
  authority — it can modify or delete scene data and write files as you;
  the permission ask is the fence.
- python_run has NO preemption: bpy cannot abort a running script — a
  runaway script blocks Blender until it finishes (the client times out;
  the server cannot cancel).

Every call asks permission carrying the code's byte count and first line.
Source is capped at 64 KiB; stdout/stderr are captured and capped at 32 KiB
each with truncation counted; a raise answers `PYTHON_EXCEPTION` with the
type, message, and a bounded traceback tail; a variable named `result` is
consumed by the answer as its `repr`. The namespace persists between runs.

## The no-reload law (the deliberate inverse of Unity)

Blender never reloads the add-on's Python state on file opens, mode
changes, or renders, so **the connection holds across `blend_open`** and
render jobs. A mid-flight drop means Blender quit or the add-on was
disabled — never a by-design transition. Opening a file by hand is reported
as `blend_changed`.

While a RENDER job runs, mutate/exec verbs refuse `RENDER_ACTIVE`; reads
stay free — `render_state` during a render is the point. RENDER_PREVIEW
(viewport preview shading) never refuses anything.

## Refusals worth knowing

`AUTH_FAILED` (token wrong or missing — reinstall writes it),
`VERSION_SKEW`/`BRIDGE_VERSION_SKEW` (the halves disagree on the protocol —
reinstall re-aligns; no op ever crosses a version gap), `BLEND_DIRTY`
(unsaved work is never discarded), `BLEND_NOT_FOUND`, `RENDER_ACTIVE`
(mutate/exec during a render), `PYTHON_EXCEPTION` (your code raised —
carried honestly), `EDITOR_UNREACHABLE` (Blender closed, the add-on missing
or **not enabled**, or the port wrong — `blender_status` explains which).

## Routing

Python **breakpoint** debugging inside Blender stays with the Debug tool's
debugpy recipe (the Launch tool's blender-debug row prints the listener
line). **Headless** batch renders/scripts stay with the Launch tool's
operator-run profiles (the exact command is printed, arguments in
documented order). In-Blender scene/object/render truth, file opens, still
renders, reports, and `python_run` live here. There is no test-run road:
Blender has no test framework, and a rendered image is not a test run.

