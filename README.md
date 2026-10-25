<h1 align="center">
  <a href="https://mercury-cli.ai">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/media/wordmark-cli-dark.png">
      <img src="docs/media/wordmark-cli-light.png" alt="Mercury CLI" width="420">
    </picture>
  </a>
</h1>

<p align="center">
  A terminal-native environment for AI coding agents, inside your own git repositories on macOS, Linux and Windows.
</p>

<p align="center">
  <a href="https://mercury-cli.ai"><img alt="website mercury-cli.ai" src="https://img.shields.io/badge/website-mercury--cli.ai-4d7ae2?style=flat"></a>
  <a href="https://www.npmjs.com/package/mercury-tech-cli"><img alt="npm version" src="https://img.shields.io/npm/v/mercury-tech-cli?style=flat"></a>
  <a href="https://github.com/Whq02/MercuryCLI/actions/workflows/private-release.yml"><img alt="release workflow status" src="https://img.shields.io/github/actions/workflow/status/Whq02/MercuryCLI/private-release.yml?style=flat&label=release"></a>
  <a href="LICENSE.md"><img alt="licence Apache-2.0" src="https://img.shields.io/badge/licence-Apache--2.0-blue?style=flat"></a>
  <a href="https://github.com/Whq02/MercuryCLI"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Whq02/MercuryCLI?style=flat"></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="docs/translations/README.zh-CN.md">简体中文</a> |
  <a href="docs/translations/README.zh-TW.md">繁體中文</a> |
  <a href="docs/translations/README.ko.md">한국어</a> |
  <a href="docs/translations/README.de.md">Deutsch</a> |
  <a href="docs/translations/README.es.md">Español</a> |
  <a href="docs/translations/README.fr.md">Français</a> |
  <a href="docs/translations/README.it.md">Italiano</a> |
  <a href="docs/translations/README.da.md">Dansk</a> |
  <a href="docs/translations/README.ja.md">日本語</a> |
  <a href="docs/translations/README.pl.md">Polski</a> |
  <a href="docs/translations/README.ru.md">Русский</a> |
  <a href="docs/translations/README.bs.md">Bosanski</a> |
  <a href="docs/translations/README.ar.md">العربية</a> |
  <a href="docs/translations/README.no.md">Norsk</a> |
  <a href="docs/translations/README.pt-BR.md">Português (Brasil)</a> |
  <a href="docs/translations/README.th.md">ไทย</a> |
  <a href="docs/translations/README.tr.md">Türkçe</a> |
  <a href="docs/translations/README.uk.md">Українська</a> |
  <a href="docs/translations/README.bn.md">বাংলা</a> |
  <a href="docs/translations/README.el.md">Ελληνικά</a> |
  <a href="docs/translations/README.vi.md">Tiếng Việt</a>
</p>

An agent reads and edits files, runs shell commands, steps through tests and debuggers, and checks the results while you choose the model provider, the model, and what the agent is allowed to do. Mercury is used to build Mercury across parallel sessions and models: each session writes a handoff note when it finishes, and the next session reads that note once at startup alongside your pinned rules, stopping context poisoning between sessions.

![The session board with three sessions on one project, each on its own model and effort: one ready to review, two working; opening the review session, then the finished documentation session](docs/media/session-board-stream.gif)

Mercury is open source under the Apache License 2.0, as are the SDKs in [sdk/](sdk/) and [sdk-py/](sdk-py/).

## Install

Release archives for Apple silicon and Intel Macs, Linux x64 and arm64, and Windows x64 and arm64 include Node and ripgrep (`git` is the only separate requirement):

```sh
curl -fsSL https://mercury-cli.ai/install | sh     # macOS and Linux (x64 and arm64)
irm https://mercury-cli.ai/install.ps1 | iex        # Windows (x64 and arm64), in PowerShell 7
brew install Whq02/mercury/mercury                 # Homebrew: macOS and Linux x64
npm install -g mercury-tech-cli                    # npm; `bun install -g mercury-tech-cli` is the same package
mise use -g npm:mercury-tech-cli                   # mise, through the npm package
```

The install addresses keep approximate script-request counts by source and UTC day (completed installs are not counted); the counter stores no IP address, user-agent string or cookie. Open a new terminal (or run the `export PATH=…` line the shell installer prints), check `mercury --version`, and run `mercury` inside a repository. See [docs/INSTALL.md](docs/INSTALL.md), [docs/INSTALL-WINDOWS-FROM-SOURCE.md](docs/INSTALL-WINDOWS-FROM-SOURCE.md) and [AGENTS.md](AGENTS.md) for `mercury update`, release verification, requirements and building from source.

## What is inside

- **22 model providers, `/llmhost` and `/localsetup`:** keep all 22 providers signed in at once (OpenAI, Anthropic, Google, DeepSeek, Moonshot, Z.AI, OpenRouter, Hugging Face, xAI, Meta, Mistral, Nous Portal, OpenCode Zen, Qwen, MiniMax, Together AI, Cohere, Groq, Cerebras, Fireworks AI, Melious AI, OrcaRouter, or your own local/hosted weights) and switch models mid-chat; new sessions default to your most recently connected provider. Rent or host weights with `/llmhost` and `mercury host` ([docs/LLM-HOST.md](docs/LLM-HOST.md)), connect Ollama, LM Studio, vLLM or llama.cpp with `/localsetup` ([docs/LOCAL-SETUP.md](docs/LOCAL-SETUP.md)), and see [docs/ENGINES.md](docs/ENGINES.md) for sign-ins and routing.
- **The daily loop, Session Concourse and crewmates:** interactive launches open the home screen (New Session, Continue Last Session once session history exists, Boot Menu, MCPs & Skills, Agents, Health Check, Saturn Scheduler, Logins, Session Concourse, Sessions · Projects); run parallel sessions on `/concourse` and delegate to cross-provider crewmates (`Crewmate`) in isolated `git worktree` checkouts with project file leases ([docs/SESSIONS.md](docs/SESSIONS.md), [docs/CREW.md](docs/CREW.md)).
- **Headless CLI and JSON-RPC runner:** run one-shot prompts with `mercury run "<prompt>"` (`--format text|json|rows`, `--input rows`, `--partial`), or host multi-turn sessions over stdio with `mercury runner` and the TypeScript and Python SDKs ([docs/AUTOMATION.md](docs/AUTOMATION.md), [sdk/](sdk/), [sdk-py/](sdk-py/)).
- **Mneme hybrid RAG project memory:** on-device 118 MB BGE semantic embeddings (`bge-base-en-v1.5`, bundled in every release archive, built for its platform) fused with BM25 word ranking, citation tracking, verbatim pinned rules, contradiction checks, session handoff notes, and the `/memory page` browser graph ([docs/MNEME.md](docs/MNEME.md), [docs/MEMORY-FINDINGS.md](docs/MEMORY-FINDINGS.md)).
- **LSP, 23-language AST, DAP debugger and `Eval` cells:** anchored multi-file edits ([docs/CHANGE-TRANSACTIONS.md](docs/CHANGE-TRANSACTIONS.md)), LSP navigation and previewed refactors ([docs/LANGUAGE-SERVICE.md](docs/LANGUAGE-SERVICE.md)), 23-language tree-sitter search and rewrites ([docs/STRUCTURAL-PATTERNS.md](docs/STRUCTURAL-PATTERNS.md)), Debug Adapter Protocol stepping for failing Python, JS/TS, Go and Rust tests ([docs/DEBUGGER.md](docs/DEBUGGER.md)), and persistent Python and JavaScript code cells with browser samples ([docs/EVAL.md](docs/EVAL.md), [docs/SAMPLES.md](docs/SAMPLES.md)).
- **Keyless `WebSearch` and markdown `WebFetch`:** cascades through provider-native search, Brave or Tavily keys, official APIs (Stack Exchange, npm, PyPI, crates.io, GitHub, Hacker News, Wikipedia), SearXNG and keyless DuckDuckGo, and reads public pages as markdown within a 38,000-character call budget ([docs/ENGINES.md](docs/ENGINES.md)).
- **Computer use, Whisper voice, Saturn, video and editor bridges:** desktop control with `Computer` ([docs/COMPUTER-USE.md](docs/COMPUTER-USE.md)), on-device Whisper dictation with `/voice` ([docs/VOICE.md](docs/VOICE.md)), recurring or one-shot schedules with `/saturn` ([docs/SATURN.md](docs/SATURN.md)), MiniMax video generation ([docs/VIDEO.md](docs/VIDEO.md)), and bridges for VS Code (`mercury acp`), [Unity](docs/UNITY-BRIDGE.md), [Blender](docs/BLENDER-BRIDGE.md), [Godot](docs/VULCAN-GODOT-TOOLS.md) and [Aseprite](docs/ASEPRITE-BRIDGE.md).

See [docs/README.md](docs/README.md) for the full documentation catalogue ([docs/TRUST.md](docs/TRUST.md), [docs/KIT.md](docs/KIT.md), [docs/EXTENSIONS.md](docs/EXTENSIONS.md), [docs/HEALTH-CERTIFICATE.md](docs/HEALTH-CERTIFICATE.md), [docs/APOLLO-MODE.md](docs/APOLLO-MODE.md), [docs/DURABILITY.md](docs/DURABILITY.md), [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)).

## Slash commands

`/help` lists the available interactive commands and `/palette` searches them (`MERCURY_SAMPLES=1` adds `/samples` under `current work`, `MERCURY_DEV_SURFACES=1` adds `/showcase`):

| Domain | Commands |
| --- | --- |
| current work | `/run` `/runs` `/workbench` `/diff` `/mission` |
| crew & delegation | `/agents` `/crewmates` `/crew` `/workflows` `/daemon` `/saturn` `/seats` `/kill` `/unkill` |
| session & context | `/clear` `/compact` `/context` `/rewind` `/sessions` `/concourse` `/rename` `/title` `/contract` `/export` `/copy` `/usage` `/realms` `/restart` |
| memory & goals | `/memory` `/console` |
| model & effort | `/model` `/effort` `/submodels` `/advise` `/caching` |
| git & review | `/review` `/audit` |
| health & introspection | `/health` `/verify` `/trace` `/capabilities` `/lsp` |
| config & setup | `/config` `/jev` `/localsetup` `/llmhost` `/permissions` `/hooks` `/mcp` `/extensions` `/skills` `/browser` `/orient` `/keybindings` `/keys` `/vim` `/mouse` `/keysetup` `/bootmenu` `/voice` |
| appearance & cockpit | `/appearance` `/critter` `/palette` `/zen` `/browse` |
| account & app | `/logins` `/logout` `/accounts` `/defaultprovider` `/update-notes` `/feedback` `/help` `/exit` |

| Command | What it does |
| --- | --- |
| `/llmhost` | Choose a model to rent on Runpod, Vast.ai, Lambda, Hugging Face Inference Endpoints, Hyperstack, Verda or DigitalOcean, run on your own computer, or connect an existing server. |
| `/restart` | Move this chat to the installed Mercury build; running watches and background shells stop. |
| `/mcp` | Inspect servers, sign in, browse each server’s tools and parameters, reconnect, or toggle a server for this chat. |

## Author

Mercury CLI is designed, built and maintained by **Waleed Al Qusous** as its sole developer: seven months from the first line to this release, 42 public releases, 717,000 lines of TypeScript and 3,900 proofs, built with the AI agents it now runs. [GitHub](https://github.com/Whq02) · [X](https://x.com/dubsthedev) · [mercury-cli.ai](https://mercury-cli.ai)

## Reporting a problem

For a short report (OS, what you tried, what broke; no health dump), use [the tester form](https://mercury-cli.ai/report) or `/bug --short <what you tried>` inside Mercury. Run `/bug <what happened>` to preview and file a full report through your signed-in GitHub CLI (`gh`), or open an issue with your `--version` output, OS, terminal, steps and `mercury health --json` (`node dist/mercury.mjs health --json` for a source build). Report security problems privately through the repository's Security tab ([SECURITY.md](SECURITY.md)); see [CONTRIBUTING.md](CONTRIBUTING.md) for pull requests and checks.

## Licence

The Mercury CLI is licensed under the Apache License 2.0 (`Apache-2.0`); see
[LICENSE.md](LICENSE.md). The TypeScript and Python SDKs use the same licence
([sdk/LICENSE](sdk/LICENSE) and [sdk-py/LICENSE](sdk-py/LICENSE)).

The [trademark policy](TRADEMARKS.md) covers use of the Mercury name and marks.
Bundled third-party licences are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
