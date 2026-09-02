# The Unity editor bridge

Mercury's `Unity` tool drives a running Unity editor the way the `Godot`
tool drives a running Godot editor: over a token-authed, loopback-only
NDJSON/TCP connection served by an editor-side package Mercury ships as
source and installs on ask. Protocol version 1; the C# half ships under
`assets/unity/bridge/` as the embedded package `com.mercury.unity-bridge`.

## Arming

One switch: the **"Unity dev lanes"** boot-menu row (`MERCURY_UNITY=1`) —
the same flag that arms the C# language lane, the `unity` attach-to-editor
debug adapter, and the headless launch profiles. Off is byte-identical to a
build without any of it: no tool, no client, no token file, no readiness
row, no line in the harness map the model reads. The tool joins the catalog
only inside a Unity project (`Assets/` + `ProjectSettings/` at the root).

Two value knobs: `MERCURY_UNITY_BRIDGE_PORT` (default 6011; the loopback
dev-lane family is Godot LSP 6005 · Godot DAP 6006 · VULCAN 6010 · this
bridge 6011) and `MERCURY_UNITY_BRIDGE_TOKEN` (a proof/embedder override —
normally the token is a per-project 64-hex file).

## Install

`op:"unity_bridge_install"` (a permissioned mutate) writes exactly three
artifacts:

1. the package files under `Packages/com.mercury.unity-bridge/` — an
   *embedded package*, so no `manifest.json` entry is needed; the editor
   imports and compiles it on its next focus/refresh;
2. the session token at `Library/mercury-unity-bridge-token` (mode 0600,
   project-private, machine-local — `Library/` is gitignored by every
   standard Unity template);
3. `ProjectSettings/MercuryUnityBridge.json` — only when Mercury's port
   differs from the default, so both halves agree; removed when the default
   returns.

`op:"unity_bridge_uninstall"` removes all three. `op:"unity_status"` probes
everything: flag, package presence and drift, token, reachability, client
state, and any port mismatch between the halves.

## The verbs

| verb | class | what it does |
| --- | --- | --- |
| `play_state` | read | isPlaying / isPaused / isPlayingOrWillChangePlaymode / willReloadOnPlay |
| `play_enter` | exec | enter play mode — answers `{willReload}` **before** the transition |
| `play_exit` | exec | exit play mode, same ack-then-transition law |
| `play_pause` | exec | pause/resume (`{paused: bool}`) |
| `scene_list` | read | open scenes (dirty/loaded/active) + build-settings scenes |
| `scene_open` | mutate | open a scene by `Assets/…` path — edit mode only; a dirty scene refuses `SCENE_DIRTY` (save first; nothing is ever discarded) |
| `hierarchy_read` | read | loaded scenes' GameObject trees, bounded, truncation counted |
| `console_tail` | read | the package's severity-classed log ring (cap 1000, evictions counted) |
| `tests_run` | exec | trigger a Test Runner run; results land as NUnit XML at `.mercury/unity-test-results/<mode>.xml`, where the results parser reads them |

Reads are permission-free; `scene_open` asks (and its message says what
really happens — a scene switch is not an editor undo step); play and test
verbs always ask.

## The reload law

Entering or leaving play mode (and any script recompile) reloads the
editor's script domain, which kills the editor-side listener — so those
transitions **drop the bridge connection by design**. The package answers
first (`willReload` tells you it is coming), re-arms itself after every
reload from `[InitializeOnLoad]`, and Mercury's client reconnects on the
next call through its backoff window. A `play_state` after the reconnect
confirms the transition. Test runs survive reloads editor-side
(`SessionState` carries the pending results path), and the results file —
not the connection — is the durable handoff.

## Refusals worth knowing

`AUTH_FAILED` (token wrong or missing — reinstall writes it),
`VERSION_SKEW`/`BRIDGE_VERSION_SKEW` (the halves disagree on the protocol —
reinstall re-aligns; no op ever crosses a version gap), `SCENE_DIRTY`
(unsaved work is never discarded), `PLAY_MODE_ACTIVE` (edit-mode-only verb,
or a redundant transition), `RUN_IN_FLIGHT` (one test run at a time),
`EDITOR_UNREACHABLE` (the editor is closed, the package missing, or the
port wrong — `unity_status` explains which).

## Routing

C# **symbol** work stays with the LSP tool's `mercury-csharp` lane.
**Breakpoint** debugging stays with the Debug tool's `unity` adapter
(attach to the running editor). **Headless** batch-mode test/build commands
stay with the Launch tool's operator-run profiles. In-editor play, scenes,
hierarchy, console, and Test Runner runs live here.

