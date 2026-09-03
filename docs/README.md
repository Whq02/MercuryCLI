# Mercury documentation

Mercury is a terminal harness for software development: sessions, a chat, a
board and a headless CLI over one built artifact. This page is the index;
every page under `docs/` is listed here, by task.

## Getting started

1. [The README](../README.md): what Mercury is, who it is for, the
   requirements, the first run, the daily loop, providers and models, the
   headless verbs, and every slash command.
2. [AGENTS.md](../AGENTS.md): build, run and check a fresh checkout in one
   screen. [INSTALL-WINDOWS-FROM-SOURCE.md](INSTALL-WINDOWS-FROM-SOURCE.md)
   is the step-by-step Windows install, every step with its check;
   [WINDOWS-GLYPH-FIELD-CHECK.md](WINDOWS-GLYPH-FIELD-CHECK.md) is the
   ten-minute look over a Windows terminal after an update: the rows whose
   marks must read as text, and what to report when one draws as a picture.
3. The first run: [TRUST.md](TRUST.md) is the workspace-trust question the
   first boot asks, and [SESSIONS.md](SESSIONS.md) is the Boot face, the
   chat, the strip and the concourse board you land in.

Keyboard interaction lives in-product: `/keys` shows the effective key map
and `/keybindings` edits your keybindings file.

## Direction

The session is the unit; every screen is a view. A session owns its
conversation, model, posture, workspace and running work, and it survives
whatever screen is looking at it; the chat, the concourse board, a live tile
and the Boot face render sessions and never store their truth. The solo
journey stays sovereign: one Enter from the Boot face to a working chat, with
everything beneath invisible until summoned, and nothing reachable without
the concourse ever comes to require it.

## Operator guide, by task

### Working in a session

- [SESSIONS.md](SESSIONS.md): sessions, born on Enter, never lost, resumable
  from anywhere. The Boot face, the strip that walks only the screens that
  exist, the focused chat, the concourse board as the resume screen of the
  project you are in, the folder that becomes a project at its first chat,
  closing and bringing back, `--chat` and `--concourse-off`, and the
  commands that never reach the model.
- [CHANGE-TRANSACTIONS.md](CHANGE-TRANSACTIONS.md): the change-transaction
  layer over file edits, with read anchors and exactly-once records.
- [STRUCTURAL-PATTERNS.md](STRUCTURAL-PATTERNS.md): the structural pattern
  grammar and the AstSearch / AstEdit tools over the packaged grammars.
- [WORKSHOP.md](WORKSHOP.md): persistent code cells, JS/TS/Python state
  across calls, honest state-loss reporting, and the mercury.* bridge.
- [DEBUGGER.md](DEBUGGER.md): the debugger over the Debug Adapter Protocol,
  launch and attach, the adapter table, child-session trees, and
  one-gesture test-debug.
- [TABULA-NOTES.md](TABULA-NOTES.md): Minerva's room (`/tabula`, refining
  your saved prompts) and the project notepad file underneath (`/note`).
- [APOLLO-MODE.md](APOLLO-MODE.md): the Apollo permission mode, the
  pre-flight interview that writes the spec and builds a prototype from it.
- [VOICE.md](VOICE.md): voice input — `/speak on`, `v` in an empty composer
  to dictate, the capture backends, the transcribing sign-ins, and the
  privacy line (audio leaves only to the family you signed into, only after
  you stop).

### Loading, extending and delegating

- [KIT.md](KIT.md): MCPs & Skills, what the next session loads: the
  per-repository record and its menu, session kits, presets, and the
  in-session dials.
- [EXTENSIONS.md](EXTENSIONS.md): extensions, the manifest, sources,
  approval, health, the maker's loop and policy boundaries, liveness, and
  validation.
- [TEAMS.md](TEAMS.md): teammates and agent sessions, spawning, the mailbox,
  roles, boards, and the coordinator behind the concourse.
- [SATURN.md](SATURN.md): Saturn scheduling, schedules as session facts, the
  daemon fire engine, the `/saturn` board and the birth form, accounts and
  held fires, and the catch-up window.

### Providers and models

- [ENGINES.md](ENGINES.md): the provider families, the routing law, the
  main loop, the native in-process endpoints, and web search on every model.

### Trust, health and the runtime

- [TRUST.md](TRUST.md): workspace trust, what a grant is, when Mercury asks,
  what stays closed until trust, and what managed policy changes.
- [THEMIS-CONTROL-PLANE.md](THEMIS-CONTROL-PLANE.md): the deterministic
  trust machinery, the execution-gate blocklist, audit chains, the config
  lockfile, and missions.
- [HEALTH-CERTIFICATE.md](HEALTH-CERTIFICATE.md): `/health` and the doctor,
  evidence-backed checks, the verdict, the fix engine, the JSON certificate,
  and the on-disk artifacts.
- [DURABILITY.md](DURABILITY.md): the atomic-publish floor, the operation
  journal, boot reconciliation, store quarantine, and the deadline and
  watchdog ceilings.
- [TERMINAL-RUNTIME.md](TERMINAL-RUNTIME.md): how the built product boots,
  where deployed copies live, how updates land, and how a broken boot
  recovers.
- [TERMINAL-PROFILE.md](TERMINAL-PROFILE.md): terminal capability profiles,
  what a host must offer and what is reported when it does not.

### Editors and tools

- [UNITY-BRIDGE.md](UNITY-BRIDGE.md): the Unity editor bridge, the `Unity`
  tool, the in-repo C# package, the loopback protocol, the reload law.
- [BLENDER-BRIDGE.md](BLENDER-BRIDGE.md): the Blender bridge, the `Blender`
  tool, the in-repo Python add-on, the no-reload law, python_run's contract.
- [ASEPRITE-BRIDGE.md](ASEPRITE-BRIDGE.md): the Aseprite batch door, the
  `Aseprite` tool, the resolution law, exports and sprite sheets,
  run-script's contract.

## Reference and architecture

- [COMPATIBILITY.md](COMPATIBILITY.md): the live interop surfaces, honored
  external environment spellings, the User-Agent identity, MCP, claude.ai
  connectors, and credential migration.
- Capabilities: what the harness can do on this machine is what `mercury
  doctor` reports; every capability's switch and default lives in the flag
  registry (`src/substrate/flagRegistry.ts`).
- [BUILD-NOTES.md](../BUILD-NOTES.md): building and packaging the artifact,
  the vendored payloads, the manifest, and the launchers.
- [templates/extension-source-README.md](templates/extension-source-README.md):
  the README an extension source starts from (`mercury extensions init
  --source` writes it).
- Inventories render on demand to untracked paths, never into the tree: the
  flag table from `src/substrate/flagRegistry.ts`, the durable-operation
  matrix, the state-lifecycle manifest, and the reachability manifest.
- Releases: the notes ride each release itself and `/release-notes` prints
  the bundled history; the repository carries the product.
- Generated sections are regenerated from their sources, never hand-edited;
  each names its generator in its own header.
