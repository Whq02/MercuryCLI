# The Godot tool and the engine job service

Mercury's `Godot` tool controls named Godot instances over token-authed
loopback connections served by the `mercury_vulcan` addon. Each editor,
headless worker and native worker has its own port and token. Editor
operations edit scenes, nodes, scripts and resources; runtime queries
read a running worker directly. The engine job service runs workers in
parallel, each on a frozen copy of the project, with a compile and
proof-drift gate and every result as data. Project file leases prevent a
run from consuming changed files held by another session or agent.

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
  Godot control row names the effective count. Native jobs (a display, a
  capture) run one at a time whatever the count, and never while the
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
  then the result is stored under the new key. The bundled addon digest
  also participates, so changed bridge code cannot reuse an older cache.
  A function-body edit costs no import; a renamed class or a new texture
  costs one. Naming `import`
  among the suites forces the pass.
- **Owner liveness** — every engine is Mercury's as a process tree: the
  process group on POSIX, `taskkill /PID <wrapper> /T /F` on Windows (the
  console wrapper, the engine and its `conhost` together). A timeout, a
  budget or a cancel ends the whole tree. At startup, owner sidecars
  protect another live session's workers and frozen trees; only orphaned
  engines are swept. A normal exit ends the session's own live engines.
  Worker ownership uses process liveness rather than a shared engine lock.

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

## Proof drift on every gate

Every `engine_check` compares changed test assertions against `HEAD`,
even when `files` narrows the compile checks. `tree` compares the selected
frozen content, not unrelated live edits. The result's `drift` array
names the file, line, kind, before/after assertion and any fallen count.
Removed assertions, weaker numeric bounds, fewer assertions and lower
check counts make `ok` false. Multiline `expect(...)` and `assert(...)`
calls are compared as logical statements, ignoring formatting and
comments. Obvious stronger numeric bounds are accepted; other changed
assertions are flagged for human review rather than pretending to prove
arbitrary semantic equivalence.

A suite that prints `PASS` and `SCRIPT ERROR` is a failure regardless of
its exit code or a custom clean-log expression. `engine_run` carries the
named drift rows in its record. `engine_check` also reads the newest
completed run whose source fingerprint matches the selected tree; pass
`run` to require a specific run. Mismatched or incomplete named evidence
is refused instead of being credited to another tree. A compile check
without matching suite evidence does not claim the suite was run.

```json
{ "op": "engine_check", "args": { "files": ["tests/drift_checks.gd"], "run": "run-id" } }
```

The script equivalent is `mercury godot check tests/drift_checks.gd
--run run-id`. Both carry the drift rows as JSON and the command exits 1
when drift is present. A source comparison is a review aid, not a proof
that unchanged tests provide sufficient coverage.

## Runtime queries on a named instance

`engine_jobs` lists discovered instances. Pass the returned id as
`args.instance`; never infer a port from the project. The roles are
`operator-editor`, `agent-editor`, `headless-worker` and `native-worker`.
An editor operation without an explicit selection can choose an agent
editor, but never the operator's editor. Ambiguous selections are refused.
Every bridge reply identifies the instance it actually reached.

The service supplies a fresh port and token to each worker. An instance
started outside the service chooses a free loopback port and creates its
own discovery and token files under its `.godot`, including in a worktree.
A standalone runtime needs the addon and its autoload installed first.
The bridge stays disabled in exported games.

Start a long-running scene with `engine_run` and `wait: false`, then read
its instance id from `engine_jobs`. These examples use `worker-id` in
place of that returned id:

```json
{ "op": "engine_scene_tree", "args": { "instance": "worker-id", "depth": 3 } }
```

Returns the live tree, not the scene file parsed from disk.

```json
{ "op": "engine_node_get", "args": { "instance": "worker-id", "node": "/root/RuntimeFixture", "properties": ["score"] } }
```

Returns named properties as JSON. The fixture's `score` is `42`.

```json
{ "op": "engine_node_call", "args": { "instance": "worker-id", "node": "/root/RuntimeFixture", "method": "describe", "args": [7] } }
```

Returns the method's JSON result. This operation runs code and has the
same ask-always permission class as editor method calls. Tree, property
and signal queries are read-only by default.

```json
{ "op": "engine_signal_wait", "args": { "instance": "worker-id", "node": "/root/RuntimeFixture", "signal": "never", "timeout_ms": 100 } }
```

Returns the signal name and wait duration when it fires, or a timeout
naming the signal and its wait. A timeout is not a successful observation.

## Project file leases without a team

A directly launched agent uses the same Godot tool. Its trusted session
and agent identity supply the holder; operation arguments cannot choose
another holder. The project keeps one lease record under `.mercury/`.

```json
{ "op": "lease_take", "args": { "paths": ["tests/runtime_checks.gd"] } }
```

A conflicting take is refused with the existing holder's session and
agent named. Paths must stay under the project, including through
symbolic links.

```json
{ "op": "lease_list", "args": {} }
```

Lists live holders and their paths; it needs no team membership.

```json
{ "op": "lease_release", "args": {} }
```

Releases this holder's leases, never another agent's. Session termination
releases its leases; a later reader prunes a holder whose process died.
An engine run refuses changed files held elsewhere before it starts the
engine on the frozen copy. A frozen `HEAD` run does not consume unrelated live edits.

## The queue, cancel and results

`engine_jobs` shows the worker count and its source, the queued and
running jobs in priority order, the recent runs, the live engine
processes, the orphans swept at start and the manifest's suites.
`engine_cancel {id}` takes a queued job out of the queue or ends a running
job's whole engine tree; `engine_result {id}` reads one record by id.

The same four verbs exist for scripts, on the project in the working
directory: `mercury godot run [suites…] [--tree <spec>] [--native]
[--capture] [--priority <p>] [--budget-ms <n>] [--label <s>]`, `mercury
godot check [files…] [--all] [--tree <spec>] [--no-shaders]`, `mercury
godot jobs`, `mercury godot cancel <id>`, `mercury godot result <id>`.
Each prints its record as JSON; `run` exits 0 on `allPass`, `check` only
when both diagnostics and proof drift are absent. A fresh process owns no queue of its own: `jobs` lists the
runs on disk and the engines alive under the project, and `cancel` ends
the engine tree of a job id it finds running there.

## The Windows path

Written from the runner's facts on the operator's machine: the job's user
directory rides `APPDATA`, the engine is spawned as the `_console.exe`
wrapper beside a plain `_win64.exe` when one exists (the wrapper carries
the output), and a kill is `taskkill /PID <wrapper> /T /F`, which ends
the wrapper, the engine and its `conhost` together. Live fixture checks
run on macOS. Linux and Windows environment and argument shapes are
checked without launching those platforms; their live behavior still
needs a run on the corresponding machine.

## What this is not

The service does not capture frames or profile. Native workers still use
a display; runtime queries do not make a native run offscreen. It does
not persist a queue across a Mercury restart (the records on disk
persist; a queued job does not).
