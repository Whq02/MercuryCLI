# Mercury documentation

Mercury is a terminal harness for software development. This catalogue lists
the guides by task; each page describes the installed product.

## Getting started

- [The README](../README.md): installation, daily work, providers, headless rows and the runner session protocol.
- [AGENTS.md](../AGENTS.md): build, run and check a source checkout.
- [INSTALL-WINDOWS-FROM-SOURCE.md](INSTALL-WINDOWS-FROM-SOURCE.md): build and run Mercury from a source checkout on Windows 10 or 11 using PowerShell 7, Git, Node 24 LTS and bun 1.3, with a verification check after each step.
- [WINDOWS-GLYPH-FIELD-CHECK.md](WINDOWS-GLYPH-FIELD-CHECK.md): what to look at on Windows after updating, and what to report if a mark looks wrong.
- [SESSIONS.md](SESSIONS.md): a session owns its conversation, model, permission mode, workspace and running work, hosted by the background daemon across the Boot face, chat and Session Concourse.
- [SETTINGS.md](SETTINGS.md): Mercury stores settings in JSON files, edited in `/config` or through `/model`, `/effort`, `/permissions`, `/memory` and the MCPs & Skills menu.
- [TRUST.md](TRUST.md): workspace trust gates project hooks, helpers and MCP servers until you grant trust for the directory, alongside permission modes and built-in command wards.

Keyboard interaction lives in the product: `/keys` shows the effective key
map and `/keybindings` opens your keybindings file.

## Working in a session

- [CHANGE-TRANSACTIONS.md](CHANGE-TRANSACTIONS.md): read anchors, atomic file edits, change receipts and recovery.
- [STRUCTURAL-PATTERNS.md](STRUCTURAL-PATTERNS.md): AstSearch and AstEdit patterns across the packaged language grammars.
- [LANGUAGE-SERVICE.md](LANGUAGE-SERVICE.md): compiler-backed navigation, diagnostics and previewed refactors through LSP.
- [EVAL.md](EVAL.md): the `Eval` tool runs one Python (`python3`) or JavaScript (Node ES module) code cell per call in a retained runtime per agent and working directory.
- [SAMPLES.md](SAMPLES.md): a sample is a versioned HTML page the model draws in an Eval cell when you ask to see a design, report or comparison, served locally to your browser for pinned comments.
- [DEBUGGER.md](DEBUGGER.md): launch, attach, breakpoints and test debugging through Debug Adapter Protocol adapters.
- [APOLLO-MODE.md](APOLLO-MODE.md): the specification interview and review that lead into a prototype build.
- [MNEME.md](MNEME.md): Mneme is Mercury's project memory, on by default, storing facts in plain markdown topic pages under the config home, managed through four tools and the `/memory` centre.
- [MEMORY-FINDINGS.md](MEMORY-FINDINGS.md): what the handoff note does and what it costs, measured on 1.0.0-beta.32 over 250 sessions in chains of five, with a control.
- [VOICE.md](VOICE.md): hold-to-talk dictation, capture backends, transcriber selection and audio privacy.
- [COMPUTER-USE.md](COMPUTER-USE.md): screen and input tools, application consent, desktop ownership and platform requirements.

## Loading, extending and delegating

- [KIT.md](KIT.md): the MCPs & Skills menu, per-repository choices, presets and a running session's dials.
- [EXTENSIONS.md](EXTENSIONS.md): extension manifests, sources, contributions, approval and the maker's commands.
- [CREW.md](CREW.md): every Mercury session can delegate work to its crew of crewmates through the `Crewmate` tool, tracked live in `/crewmates` and `/runs` and reachable by id or name.
- [SATURN.md](SATURN.md): schedules that send a prompt or start a session, the scheduler board and held or late fires.
- [HOOKS.md](HOOKS.md): the four hook kinds, event inputs, command and HTTP answers, model verdicts and policy controls.

## Providers and models

- [ENGINES.md](ENGINES.md): Mercury runs models across 13 sign-in provider families plus local servers and custom endpoints, with per-family credentials, model lists, usage meters and web tools.
- [LOCAL-SETUP.md](LOCAL-SETUP.md): `/localsetup` finds or installs Ollama, asks which model, sets its window and checks a reply.
- [ADVISOR.md](ADVISOR.md): a second model's notes for the working chat, the per-chat switch, model choice, interval and spend.

## Health and the runtime

- [HEALTH-CERTIFICATE.md](HEALTH-CERTIFICATE.md): `/health` (and headless `mercury health`) checks the installation, runtime, settings and release channel live and rolls them into one verdict (`certified`, `caution` or `fault`).
- [DURABILITY.md](DURABILITY.md): atomic publication, operation journals, recovery, watchdogs and loop-stop outcomes.
- [TERMINAL-RUNTIME.md](TERMINAL-RUNTIME.md): how the built product boots, where deployed and release copies live, how `mercury update` and the background daemon work, and how the shell engine runs.
- [TERMINAL-PROFILE.md](TERMINAL-PROFILE.md): terminal requirements, capability detection, input decoding, ping and motion controls.
- [COMPATIBILITY.md](COMPATIBILITY.md): Mercury stores configuration in `.mercury` directories, reads `MERCURY_*` environment switches from `src/substrate/flagRegistry.ts`, and ships four platform archives.

## Creative tools

- [VULCAN-GODOT-TOOLS.md](VULCAN-GODOT-TOOLS.md): Godot editor operations, frozen engine jobs, captures, profiling and file leases.
- [UNITY-BRIDGE.md](UNITY-BRIDGE.md): the Unity editor package, play and scene operations, tests and reconnects after a reload.
- [BLENDER-BRIDGE.md](BLENDER-BRIDGE.md): the Blender add-on, scene and render operations, and Python execution inside Blender.
- [ASEPRITE-BRIDGE.md](ASEPRITE-BRIDGE.md): Aseprite batch operations, sprite exports, sheets and Lua scripts.

## Reference

- [BUILD-NOTES.md](../BUILD-NOTES.md): building and packaging the artifact, its vendored payloads and launchers.
- [CONTRIBUTING.md](../CONTRIBUTING.md): issues, pull-request policy, checks and generated-file conventions.
- [templates/extension-source-README.md](templates/extension-source-README.md): the source README template written by `mercury extensions scaffold --source`.
- Releases: [releases/README.md](releases/README.md) lists the release pages,
  each naming what was added and fixed. [1.0.0-beta.34](releases/1.0.0-beta.34.md)
  is the newest tag; [1.0.0-beta.35](releases/1.0.0-beta.35.md) is queued.
  `/update-notes` shows the running release's notes in the chat, with earlier
  releases behind the transcript key. `mercury run /update-notes` prints the
  full release history.

The capability switches and their defaults live in
`src/substrate/flagRegistry.ts`. Inventories render on demand to untracked
paths; generated sections are refreshed by their generators.
