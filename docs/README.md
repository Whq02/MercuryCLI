# Mercury documentation

Mercury is a terminal harness for software development. This catalogue lists
the guides by task; each page describes the installed product.

## Getting started

- [The README](../README.md): the one-page overview, install one-liners, capabilities and slash-command table.
- [INSTALL.md](INSTALL.md): installation methods and paths, `mercury update`, release verification, requirements and building from source.
- [AGENTS.md](../AGENTS.md): build, run and check a source checkout.
- [INSTALL-WINDOWS-FROM-SOURCE.md](INSTALL-WINDOWS-FROM-SOURCE.md): the release route on Windows is one line in PowerShell 7 (`irm … | iex` in the README's Install section) and needs Git and nothing else; this guide builds Mercury from source on Windows with a check after each step.
- [WINDOWS-GLYPH-FIELD-CHECK.md](WINDOWS-GLYPH-FIELD-CHECK.md): what to look at on Windows after updating, and what to report if a mark looks wrong.
- [SESSIONS.md](SESSIONS.md): a session owns its conversation, model, permission mode, workspace and running work, hosted by the background daemon across the home screen, chat and Session Concourse.
- [SETTINGS.md](SETTINGS.md): Mercury stores settings in JSON files, edited in `/config` or through `/model`, `/effort`, `/permissions`, `/memory` and the MCPs & Skills menu.
- [TRUST.md](TRUST.md): workspace trust gates project hooks, credential helpers and project MCP servers until you trust the folder, alongside permission modes, built-in command safety rules and the safety floors.
- [AUTOMATION.md](AUTOMATION.md): drive Mercury from a program through the `mercury run --format rows` one-shot stream or the `mercury runner` JSON-RPC session protocol over standard input and output.

Keyboard interaction lives in the product: `/keys` shows the effective key
map and `/keybindings` opens your keybindings file.

## Working in a session

- [CHANGE-TRANSACTIONS.md](CHANGE-TRANSACTIONS.md): read anchors, atomic file edits, change receipts and recovery.
- [STRUCTURAL-PATTERNS.md](STRUCTURAL-PATTERNS.md): AstSearch and AstEdit patterns across the packaged language grammars.
- [LANGUAGE-SERVICE.md](LANGUAGE-SERVICE.md): compiler-backed navigation, diagnostics and previewed refactors through LSP.
- [EVAL.md](EVAL.md): the `Eval` tool runs one Python (`python3`) or JavaScript (Node ES module) code cell per call in a retained runtime per agent and working directory.
- [SAMPLES.md](SAMPLES.md): a sample is a versioned page the model keeps from an Eval cell (`sample({ name, title?, doc, ask? })`) when you ask to see a design, report or comparison, rendered by Mercury and served locally to your browser for pinned comments.
- [DEBUGGER.md](DEBUGGER.md): launch, attach, breakpoints and test debugging through Debug Adapter Protocol adapters.
- [APOLLO-MODE.md](APOLLO-MODE.md): the specification interview and review that lead into a prototype build.
- [MNEME.md](MNEME.md): Mneme is Mercury's project memory, on by default, storing facts in plain markdown topic pages under the config home, managed through four tools and the `/memory` centre.
- [MEMORY-FINDINGS.md](MEMORY-FINDINGS.md): what the handoff note does and what it costs, measured on 1.0.0-beta.32 over 250 sessions in chains of five, with a control.
- [VOICE.md](VOICE.md): on-device Whisper dictation with `/voice on` and `/voice off`, hold-to-talk capture, model selection and microphone setup.
- [COMPUTER-USE.md](COMPUTER-USE.md): screen and input tools, application consent, desktop ownership and platform requirements.

## Loading, extending and delegating

- [KIT.md](KIT.md): the MCPs & Skills menu, per-repository choices, presets and a running session's toggles.
- [EXTENSIONS.md](EXTENSIONS.md): extension manifests, sources, contributions, approval and the author's commands.
- [CREW.md](CREW.md): every Mercury session can delegate work to its crew of crewmates through the `Crewmate` tool, tracked live in `/crewmates` and `/runs` and reachable by id or name.
- [SATURN.md](SATURN.md): schedules that send a prompt or start a session, the scheduler board and held or late fires.
- [HOOKS.md](HOOKS.md): the three hook kinds (a shell command, a model question, a crewmate), event inputs, answers and policy controls.

## Providers and models

- [ENGINES.md](ENGINES.md): Mercury runs models across 22 sign-in provider families plus local servers and custom endpoints, with per-family credentials, model lists, usage meters and web tools.
- [LOCAL-SETUP.md](LOCAL-SETUP.md): `/localsetup` pulls a GGUF from Hugging Face into the Bank or starts one from the Bank on `llama-server`, or finds or installs Ollama, picks a model that fits your memory, sets its context window and checks a reply.
- [LLM-HOST.md](LLM-HOST.md): `/llmhost` and `mercury host` search Hugging Face or pick a shipped recipe, open the Bank to store weights locally and mirror Runpod fast-load volumes, rent a GPU (Runpod, Vast.ai, Lambda, Hugging Face, Hyperstack, Verda or DigitalOcean), run a model on your own computer, or connect an existing server and add it to `/model`.
- [ADVISOR.md](ADVISOR.md): a second model's notes for the working chat, the per-chat switch, model choice, interval and spend.

## Health and the runtime

- [HEALTH-CERTIFICATE.md](HEALTH-CERTIFICATE.md): `/health` certifies the install: runtime, settings, and channel checked live, rolled into one verdict, and runs headless as `mercury health`.
- [DURABILITY.md](DURABILITY.md): atomic publication, operation journals, recovery, watchdogs and loop-stop outcomes.
- [TERMINAL-RUNTIME.md](TERMINAL-RUNTIME.md): how the built product boots, where deployed copies live, how updates land, and how a broken boot recovers.
- [TERMINAL-PROFILE.md](TERMINAL-PROFILE.md): terminal requirements, capability detection, input decoding, ping and motion controls.
- [COMPATIBILITY.md](COMPATIBILITY.md): Mercury keeps configuration in its `.mercury` homes, reads `MERCURY_*` switches from `src/substrate/flagRegistry.ts`, and ships six platform archives.

## Creative tools

- [MEDIA.md](MEDIA.md): local image and video generation, `/imagesetup`, model defaults, download sizes, memory and licences.
- [VULCAN-GODOT-TOOLS.md](VULCAN-GODOT-TOOLS.md): Godot editor operations, frozen engine jobs, captures, profiling and file leases.
- [UNITY-BRIDGE.md](UNITY-BRIDGE.md): the Unity editor package, play and scene operations, tests and reconnects after a reload.
- [BLENDER-BRIDGE.md](BLENDER-BRIDGE.md): the Blender add-on, scene and render operations, and Python execution inside Blender.
- [ASEPRITE-BRIDGE.md](ASEPRITE-BRIDGE.md): Aseprite batch operations, sprite exports, sheets and Lua scripts.
- [VIDEO.md](VIDEO.md): the `Video` tool and `videoProvider` settings for generating MP4 clips and preview frames with MiniMax.

## Reference

- [BUILD-NOTES.md](../BUILD-NOTES.md): building and packaging the artifact, its vendored payloads and launchers.
- [CONTRIBUTING.md](../CONTRIBUTING.md): issues, pull-request policy, checks and generated-file conventions.
- [templates/extension-source-README.md](templates/extension-source-README.md): the source README template written by `mercury extensions scaffold --source`.
- Releases: [releases/README.md](releases/README.md) lists the release pages,
  each naming what was added and fixed. [1.0.0-beta.44](releases/1.0.0-beta.44.md)
  is the newest tag; [1.0.0-beta.45](releases/1.0.0-beta.45.md) is queued.
  `/update-notes` shows the running release's notes in the chat, with earlier
  releases behind the transcript key. `mercury run /update-notes` prints the
  full release history.

The capability switches and their defaults live in
`src/substrate/flagRegistry.ts`. Inventories render on demand to untracked
paths; generated sections are refreshed by their generators.
