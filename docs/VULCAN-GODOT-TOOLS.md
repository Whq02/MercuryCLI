# The Godot tool and the engine job service

Mercury's `Godot` tool has two halves. The editor bridge drives the one
open Godot editor over a token-authed loopback connection served by the
`mercury_vulcan` addon (scenes, nodes, scripts, play-testing, runtime
inspection). The engine job service runs headless Godot itself: Mercury's
own workers, in parallel, each on a frozen copy of the project, with a
compile gate that answers in seconds and every result as data. This page
is about the second half; the first is summarised so the two are not
confused.

## Arming

One switch, `MERCURY_GODOT_TOOLS=1` (the boot menu's Godot row). Off is
byte-identical to a build without the tool. On, the tool joins the
catalog when a Godot executable is on this machine — on `PATH`, under a
well-known install root, seen running, or pinned with
`MERCURY_GODOT_EXECUTABLE` (a pin that names no executable file counts as
none); without one the tool is withheld and the `Tools withheld` row of
`mercury doctor` says so. Inside a project — a `project.godot` at or
above the working directory — the ops work; without one every op answers
with a teaching line.

The bridge half needs the addon installed (`op:"vulcan_install"`) and the
editor open with it loaded; `op:"vulcan_status"` names the state (no
editor running · editor running but unbridged · bridge up) and where the
Godot executable lives. The engine half needs neither an editor nor the
addon: a Godot 4 executable is enough (the running editor's own binary,
`godot` on `PATH`, a well-known install root, or the manifest's
`executable`).

## What the engine job service is for

A team of agents working one Godot project cannot share the operator's
editor, and a single hand-rolled runner with a machine-wide lock queues
every check behind every other one while any half-finished edit in the
live tree breaks everyone else's gate. The service replaces the lock with
a queue, the shared tree with a frozen copy per job, and the log-reading
by hand with a record.

- **A queue with priorities** — `verifier` > `fold-gate` > `lane-gate`
  (the default) > `profile`. A verifier's run starts before a lane's gate
  queued earlier.
- **N headless workers** — `min(3, max(1, floor(cores / 2)))` by default,
  `MERCURY_GODOT_WORKERS` (1..16) overrides it, and `mercury doctor`'s
  Godot control row names the effective count. Explicit display jobs
  run one at a time whatever the count, and never while the
  operator's own editor holds the display unless the job says
  `displayShared: true`.
- **A frozen copy per job** under `<project>/.mercury/engine/trees/<id>`
  — a git ref (`HEAD`, a branch, a commit), `HEAD` plus a list of files
  (the fold's shape: `HEAD+src/a.gd,src/b.gd`), or `working` (HEAD plus
  every local change, frozen at the moment the job is submitted). An
  edit written into the live tree after that moment is never seen. The
  operator's editor never shares a `.godot` with a worker: the directory
  carries a `.gdignore`, and each copy has its own `.godot`.
- **An empty user directory per job**, so a run never touches the
  operator's saves: `APPDATA` on Windows (the runner's own way), `HOME` on
  macOS, the `XDG_*_HOME` trio on Linux. A suite that needs state across
  runs says `"userDir": "keep"` in the manifest and gets one directory of
  its own under `.mercury/engine/users/`.
- **One import cache** under `.mercury/engine/cache`, keyed by two hashes
  of the copy's inputs: the assets (every imported file and its `.import`
  sidecar, by git blob id, plus `project.godot` and the uid header of
  every scene and resource) and the scripts (each `.gd` file's
  `class_name` / `extends` / `@tool` / `@icon` / `@abstract` head, which
  is all the class cache is made of). When both hold, the job copies the
  cached `.godot` and runs no import; when either moves, the copy is
  seeded from the newest entry and the import pass runs incrementally,
  then the result is stored under the new key. A function-body edit costs
  no import; a renamed class or a new texture costs one. Naming `import`
  among the suites forces the pass.
- **Owner liveness** — every engine is Mercury's as a process tree: the
  process group on POSIX, `taskkill /PID <wrapper> /T /F` on Windows (the
  console wrapper, the engine and its `conhost` together). A timeout, a
  budget or a cancel ends the whole tree; engines found running under the
  project's `.mercury/engine/` at the service's start are swept; a normal
  exit of Mercury ends every live engine. A job's owner record distinguishes
  a dead owner from another session's live worker; unknown ownership is
  preserved rather than guessed dead. There is no engine exclusion lock
  file to leave behind.

## The manifest

The suites come from one file in the game repository,
`.mercury/engine-suites.json`:

```json
{
  "version": 1,
  "suites": [
    { "name": "shield_checks", "marker": "SHIELD PASS" },
    { "name": "faran_mercenaries_checks", "marker": "FARANS PASS", "script": true },
    { "name": "castle_checks", "marker": "/^CASTLE PASS: \\d+ checks, 0 failures$/",
      "quitAfter": 120000, "timeoutMs": 720000, "nativeOnly": true },
    { "name": "fold_tour", "scene": "../.mercury/scratch/fold_tour", "marker": "TOUR DONE",
      "nativeOnly": true, "quitAfter": 120000, "timeoutMs": 720000 },
    { "name": "warship_checks", "marker": "WARSHIP PASS", "userArgs": ["--warship-checks"] },
    { "name": "dragon_voice_checks", "marker": "VOICE PASS", "local": true }
  ]
}
```

A suite is `tests/<name>.tscn`, or `--script res://tests/<name>.gd` with
`"script": true`. `marker` is a whole line the log must contain, or a
`/pattern/flags` tested against each trimmed line. `quitAfter` is the
engine's frame cap (`--quit-after`, default 15000), `timeoutMs` the
wall-clock kill (default 240000 ms; the import pass has 1200000 ms).
`scene` names a scene under `tests/` without its extension; `userArgs`
ride after `--`; a `local` suite whose file is absent is skipped and
never counts as passed; `nativeOnly` refuses a headless run. Optional at
the top: `defaults` (`quitAfter`, `timeoutMs`, `importTimeoutMs`,
`suiteDir`), `unclean` (the regular expression for unclean log lines —
the default is the runner's, `SCRIPT ERROR|SHADER ERROR|Parse
Error|^ERROR:|^FAIL:|leaked|resources still in use`, flags `im`, and a
`WARNING:` line never counts), and `executable`. A repository without the
file gets the runner's defaults and a teaching error that names it.

## Running suites

```json
{ "op": "engine_run", "args": { "suites": ["shield_checks", "humanoid_checks"], "tree": "HEAD+src/player/shield.gd", "priority": "lane-gate" } }
```

The answer is the run's record: the runner's own fields — `root`,
`executable`, `results[]` with `name ok exitCode signal timedOut
spawnError clean marker seconds log`, `complete`, `allPass` — and, per
suite, the marker line found, the `FAIL:` lines, the `SCRIPT ERROR` and
`SHADER ERROR` lines, every error's file and line and who last changed
that file in the frozen copy (the commit and author from git, or
`uncommitted`), the exact argument vector, and the log tail of every
failed suite. A suite is `ok` only when the exit code is 0, no signal, no
timeout, no spawn error, the log is clean and the marker line is present
— the triple that catches a check skipped by a `SCRIPT ERROR` while the
suite still printed its marker. The record is also written to
`.mercury/engine/runs/<id>/result.json` beside one `<name>.log` per
suite, and `engine_result {id}` reads it later, from any session.

Options: `native` (a display run), `capture` (appends `-- --capture`;
needs `native`), `budgetMs` (a whole-job cap; each suite keeps its own
timeout), `displayShared`, `keepTree`, `wait: false` (answer the job id
at once), `label`.

## The compile gate

```json
{ "op": "engine_check", "args": {} }
```

Parses and type-checks every changed `.gd` file (`godot --headless
--check-only --script res://…`, one process per file, up to the worker
count at once, no lock) and compiles every changed `.gdshader` file
headlessly through a generated probe, in seconds. Changed means changed
against `HEAD`; `files` names files instead, `all: true` checks every
script and shader, and `tree` checks a frozen copy. Diagnostics come as
data: `{ file, line, message, class, lastChange }` with the classes
`parse-error`, `compile-error`, `shader-error`, `preload-reaches-autoload`
and `engine-error`.

Two rules from the field. Check-only mode loads no autoloads, so a script
that names one prints `Identifier not found: <autoload>`; the gate reads
the project's `[autoload]` section and ignores exactly those lines for
exactly those names, listing each under `ignored`, and nothing else. And a
`--script` suite compiles its `preload` graph before autoloads exist, so
the gate walks that graph (scripts and scenes) for every script-mode suite
and flags the chain that reaches a script naming an autoload — the whole
suite would fail with that identifier the moment it ran. The gate
enforces nothing by itself; a turn-end hook, if wanted, would call it
where the file tools settle a batch of edits.

## The queue, cancel and results

`engine_jobs` shows the worker count and its source, the queued and
running jobs in priority order, the recent runs, the live engine
processes, the orphans swept at start and the manifest's suites.
`engine_cancel {id}` takes a queued job out of the queue or ends a running
job's whole engine tree; `engine_result {id}` reads one record by id.

The same service is available to scripts, on the project in the working
directory: `mercury godot run [suites…] [--tree <spec>] [--native]
[--capture] [--priority <p>] [--budget-ms <n>] [--label <s>]`, `mercury
godot check [files…] [--all] [--tree <spec>] [--no-shaders]`, `mercury
godot jobs`, `mercury godot cancel <id>`, `mercury godot result <id>`.
Each prints its record as JSON; `run` exits 0 on `allPass`, `check` on no
diagnostics. A fresh process owns no queue of its own: `jobs` lists the
runs on disk and the engines alive under the project, and `cancel` ends
the engine tree of a job id it finds running there.

## Capture jobs and named tours

```json
{ "op": "engine_capture", "args": { "tour": "fixture", "clock": { "simulationTime": 2, "shaderTime": 3, "seed": 1234, "fps": 60 }, "pair": { "switch": "feature", "a": false, "b": true } } }
```

A capture uses the service's queue, frozen project, import cache and process
ownership. It never attaches to the operator's editor or game. A pair boots
the same frozen tour twice, changing only the named switch value. Each boot
has a fresh user directory. `result.json` lists every frame under `frames`
with its `variant`, `stepIndex`, complete `step`, `frameIndex`, and absolute
`path`. `media.contactSheet.path` names the small contact sheet. There are
at most 64 frames, including both halves, so the sheet includes every frame.

Register tours in the top-level `tours` map of `.mercury/engine-suites.json`:

```json
{
  "version": 1,
  "tours": {
    "fixture": {
      "script": "res://tests/media_fixture.gd",
      "steps": [
        { "name": "front", "timeOfDay": 12,
          "camera": { "node": "Camera", "position": [0, 2, 4],
                      "target": [0, 0, 0], "fov": 70 } }
      ]
    }
  }
}
```

`tour` can instead carry that object inline. Supply exactly one `script`
(a GDScript extending `Node`) or `scene` (a `.tscn`). A step names its camera
relative to the tour root; position and target are world coordinates,
rotation is local degrees, and `fov` is the lens angle in degrees. `frames`
defaults to one. `timeOfDay` requires the project's step hook. Tour data is
copied at submission, alongside the frozen resource tree.

`route` defaults to `headless`. This uses the project's
`mercury_media_capture` Image hook because stock Godot's headless driver
has a dummy renderer. The result explicitly labels these as project Image
pixels, not rendered GPU viewport evidence. `route: "display"` (or
`display: true`) explicitly requests a real viewport window and takes the
native display slot. `route: "hidden"` refuses before spawning: stock
Godot shows its native bootstrap window before scripts can hide it. A
minimized or offscreen-positioned window is not substituted. There is no
automatic visible fallback.

### The capture hook contract

The tour root supplies:

- `mercury_media_configure(context) -> Dictionary`: applies the requested
  clock and RNG state, then returns `{simulationClock: true, shaderClock:
  true, seeded: true, notes: "how this project freezes those inputs"}`.
  Captures refuse absent or incomplete acknowledgement.
- `mercury_media_step(step, context)`: optional for project-specific state;
  required when a step names `timeOfDay`.
- `mercury_media_toggle(switch_name, value)`: required for a pair.
- `mercury_media_capture(context) -> Image`: required headlessly. With an
  explicitly requested display, omitting it captures the root viewport.

`context` contains `kind`, `clock`, `variant` (`single`, `a`, or `b`) and
`stepIndex`; capture calls also carry `frameIndex`. The driver seeds Godot's
global RNG before loading the tour resource, fixes frame deltas for capture,
and sets `Engine.time_scale = 0`. The requested simulation and shader time
must be applied by the project hook. Built-in shader `TIME`, wall clocks,
autoload initialization and independent RNGs are not intercepted. These
limitations and the hook's acknowledgement are retained in the result;
acknowledgement is not proof that arbitrary project code is deterministic.

`mercury godot capture fixture --request capture.json` runs the same op,
where `capture.json` is an object of operation arguments. Common CLI flags
include `--tree`, `--budget-ms`, `--priority`, `--display`,
`--display-shared`, `--keep-tree`, and `--label`. The CLI waits for completion
because its process owns the worker; `wait: false` is available through the
Godot tool for a session-owned queued job, not the short-lived CLI.

`mercury godot tour fixture --tree HEAD` runs the named tour on its own
frozen instance and returns the same record with `media.contactSheet.path`.
No operator editor or game is involved.

## Settled profile jobs

```json
{ "op": "engine_profile", "args": { "tour": "fixture", "settleFrames": 30, "sampleFrames": 60, "pair": { "switch": "feature", "a": false, "b": true }, "baseline": { "save": true } } }
```

`mercury godot profile fixture --request profile.json` prints the profile
record. A profile uses one boot for both A/B halves. Each variant visits
every tour step and settles for `settleFrames` (default 60), then measures
`sampleFrames` (default 120). `media.phases` retains each variant and step.
Every timing summary has `samples`, `median`, and nearest-rank `p95`.

`frameMs` measures real frame intervals with `Time.get_ticks_usec`;
`processMs`, `physicsMs`, and `navigationMs` are Godot Performance monitor
values converted to milliseconds. Positive engine-reported viewport CPU
and GPU times are retained when available. Headless GPU timings are `null`,
not a claim of zero rendering cost.

The root must supply `mercury_media_sample() -> Dictionary`, returning
`scripts: [{script, selfMs, totalMs, calls}]` and
`physics: {componentName: milliseconds}` for each sample. Tables must remain
consistent through a phase and contain at least one script and physics
component. These are explicitly project-instrumented measurements, not the
debugger's automatic engine-wide per-script profile. `mercury_media_toggle`
provides the in-boot A/B switch; the configure and step hooks are available
as for captures.

The quiet-machine guard checks active service jobs, the global live worker
registry, and the box's process census before import and measurement, during
the measurement boot, and afterward. Other Godot processes or an unavailable
census cause refusal by default. `quiet: "flag"` retains contaminated data
with explicit evidence; it never hides the contention. Short-lived workers
between census samples can escape detection, so a quiet report is sampled
evidence, not a machine-wide exclusion lock.

`baseline: {save: true}` writes an immutable
`.mercury/engine-baselines/<commit>.json` only for an uncontaminated committed
frozen tree. It never replaces an existing baseline. To compare, pass
`baseline: {compare: "<full commit SHA>"}` with the same tour, settings,
engine and machine. `media.baseline.metrics` lists each metric's `baseline`,
`current`, `delta`, and percentage; incompatible runs are explicitly not
comparable. Overlaid trees and contaminated measurements cannot establish a
per-commit baseline.

## Frame statistics without an engine

```json
{ "op": "engine_frames", "args": { "action": "diff", "a": "frames/off.png", "b": "frames/on.png" } }
```

`mercury godot frames diff frames/off.png frames/on.png` returns the changed
pixel count and fraction, connected-region bounding boxes in source pixel
coordinates, and a small mask PNG. `threshold` is the maximum channel
change ignored, from 0 through 255; the default is zero. Frame dimensions
must match. Inputs are PNG files; source images are never rewritten.

```json
{ "op": "engine_frames", "args": { "action": "stats", "frame": "frames/off.png", "grid": [4, 3], "maxLag": 32 } }
```

`mercury godot frames stats frames/off.png --grid 4x3 --max-lag 32` returns
row and column autocorrelation, anisotropy, high-frequency energy, mean
RGBA per grid cell, and a small preview PNG. Flat images have no defined
correlation, rather than an invented tile repeat.

```json
{ "op": "engine_frames", "args": { "action": "contact-sheet", "id": "<run id>" } }
```

`mercury godot frames contact-sheet <run id>` reads the frames listed in a
run's record and returns a small contact sheet and the placement of each
source frame. The op can also take `frames: ["a.png", "b.png"]`. Each call
writes new artifacts under the project's engine estate. The op is a
file-writing mutation, not an editor undo step. It uses Mercury's existing
TypeScript PNG decoder, encoder and downscaler; no native dependency is
needed.

## The Windows path

Written from the runner's facts on the operator's machine: the job's user
directory rides `APPDATA`, the engine is spawned as the `_console.exe`
wrapper beside a plain `_win64.exe` when one exists (the wrapper carries
the output), and a kill is `taskkill /PID <wrapper> /T /F`, which ends
the wrapper, the engine and its `conhost` together. The macOS and Linux
halves are proved on this repository's fixture project; the Windows half
is written to the facts and waits for a run on that box.

## What this is not

The service does not drive the operator's editor or game, lease files, or
answer live runtime queries through the editor bridge. It does not persist
a queue across a Mercury restart (the records on disk persist; a queued
job does not).
