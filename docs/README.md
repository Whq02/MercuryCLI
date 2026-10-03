# Mercury documentation

Mercury is a terminal harness for software development. This catalogue lists
the guides by task; each page describes the installed product.

## Getting started

- [The README](../README.md): installation, daily work, providers, headless rows and the runner session protocol.
- [AGENTS.md](../AGENTS.md): build, run and check a source checkout.
- [INSTALL-WINDOWS-FROM-SOURCE.md](INSTALL-WINDOWS-FROM-SOURCE.md): build Mercury on Windows, with a check after each step.
- [WINDOWS-GLYPH-FIELD-CHECK.md](WINDOWS-GLYPH-FIELD-CHECK.md): check a Windows terminal's text marks and report a rendering problem.
- [SESSIONS.md](SESSIONS.md): the Boot face, chat, Session Concourse, saved conversations and the flags that shape a launch.
- [SETTINGS.md](SETTINGS.md): settings files, their precedence and the grouped keys for models, permissions, memory, tools and appearance.
- [TRUST.md](TRUST.md): workspace trust, permission rules, hosted and hostless asks, managed policy and release signatures.

Keyboard interaction lives in the product: `/keys` shows the effective key
map and `/keybindings` opens your keybindings file.

## Working in a session

- [CHANGE-TRANSACTIONS.md](CHANGE-TRANSACTIONS.md): read anchors, atomic file edits, change receipts and recovery.
- [STRUCTURAL-PATTERNS.md](STRUCTURAL-PATTERNS.md): AstSearch and AstEdit patterns across the packaged language grammars.
- [LANGUAGE-SERVICE.md](LANGUAGE-SERVICE.md): compiler-backed navigation, diagnostics and previewed refactors through LSP.
- [WORKSHOP.md](WORKSHOP.md): persistent JavaScript, TypeScript and Python cells with the `mercury.*` tool bridge.
- [EVAL.md](EVAL.md): retained Python and JavaScript runtimes, cell helpers and what survives a failed cell.
- [SAMPLES.md](SAMPLES.md): pages drawn on request, versioned per session and opened in your browser for comments.
- [DEBUGGER.md](DEBUGGER.md): launch, attach, breakpoints and test debugging through Debug Adapter Protocol adapters.
- [APOLLO-MODE.md](APOLLO-MODE.md): the specification interview and review that lead into a prototype build.
- [MNEME.md](MNEME.md): Mercury's project memory, topic pages, pinned rules and the memory centre.
- [VOICE.md](VOICE.md): hold-to-talk dictation, capture backends, transcriber selection and audio privacy.
- [COMPUTER-USE.md](COMPUTER-USE.md): screen and input tools, application consent, desktop ownership and platform requirements.

## Loading, extending and delegating

- [KIT.md](KIT.md): the MCPs & Skills menu, per-repository choices, presets and a running session's dials.
- [EXTENSIONS.md](EXTENSIONS.md): extension manifests, sources, contributions, approval and the maker's commands.
- [CREW.md](CREW.md): the two built-in agents, custom definitions, crewmates, messages, file claims and work boards.
- [SATURN.md](SATURN.md): schedules that send a prompt or start a session, the scheduler board and held or late fires.
- [HOOKS.md](HOOKS.md): the four hook kinds, event inputs, command and HTTP answers, model verdicts and policy controls.

## Providers and models

- [ENGINES.md](ENGINES.md): model routing, provider accounts, local servers, web search, usage and model switches.
- [LOCAL-SETUP.md](LOCAL-SETUP.md): `/localsetup` finds or installs Ollama, asks which model, sets its window and checks a reply.
- [ADVISOR.md](ADVISOR.md): a second model's notes for the working chat, the per-chat switch, model choice, interval and spend.

## Health and the runtime

- [HEALTH-CERTIFICATE.md](HEALTH-CERTIFICATE.md): `/health` and the doctor, evidence-backed checks, fixes and the JSON certificate.
- [DURABILITY.md](DURABILITY.md): atomic publication, operation journals, recovery, watchdogs and loop-stop outcomes.
- [TERMINAL-RUNTIME.md](TERMINAL-RUNTIME.md): launchers, session hosts, runtime locations, installs, updates and the shell engine.
- [TERMINAL-PROFILE.md](TERMINAL-PROFILE.md): terminal requirements, capability detection, input decoding, ping and motion controls.
- [COMPATIBILITY.md](COMPATIBILITY.md): instruction files, configuration, external service identifiers, MCP and release platforms.

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
  each naming what was added and fixed. [1.0.0-beta.26](releases/1.0.0-beta.26.md)
  is the newest tag; [1.0.0-beta.27](releases/1.0.0-beta.27.md) is queued.
  `/update-notes` shows the running release's notes in the chat, with earlier
  releases behind the transcript key. `mercury run /update-notes` prints the
  full release history.

The capability switches and their defaults live in
`src/substrate/flagRegistry.ts`. Inventories render on demand to untracked
paths; generated sections are refreshed by their generators.
