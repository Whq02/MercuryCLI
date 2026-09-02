# Mercury

Mercury is a terminal harness for software development. You open it in a
repository, sign in to a model provider, and work with an agent that reads,
edits, runs and verifies real code in that repository from a full-screen
terminal interface. Every piece of work is a session: it keeps its own
conversation, model, permissions and workspace, it keeps running while you
look at another screen, and it comes back when you ask for it.

It is for developers who live in a terminal and want the agent beside the
code rather than in a browser tab: one chat for solo work, several sessions
side by side on one board, sessions born on a schedule, and a headless mode
for scripts and editors. You bring a provider sign-in or an API key.

## Requirements

A release install needs git only: every archive carries its own Node 24 LTS
runtime beside the bundle, and the launcher, `mercury install` and
`mercury update` run on it. Building from source needs:

- Node 24 LTS: the supported range is `>=24.20.0 <25`, and `.node-version`
  pins the exact patch used for builds and vendored into release archives.
- bun 1.3.x, the build runtime (never vendored).
- git. On Windows, Windows Terminal or PowerShell 7; the step-by-step guide
  is [docs/INSTALL-WINDOWS-FROM-SOURCE.md](docs/INSTALL-WINDOWS-FROM-SOURCE.md).

The floor is 24.20.0 because it carries the fix for nodejs/node#56645. Below
it, a headless `-p` run that dispatched any tool aborts at exit on Windows.
Every launcher picks its Node in one order: `MERCURY_NODE` (an explicit
binary), the vendored runtime beside the bundle, then a PATH node inside the
range; a missing rung is named, never skipped silently.

## Build from source

Mercury builds with bun and runs on Node 24 LTS:

```sh
bun run setup                      # once; bun install + the five vendored packs
bun run build.ts                   # writes dist/mercury.mjs + dist/manifest.json
node dist/mercury.mjs --version
node dist/mercury.mjs              # the cockpit needs a real TTY, 100+ columns
node dist/mercury.mjs doctor --json
```

`setup` fetches the vendored capability packs (pyright · debugpy · js-debug ·
extra grammars · this machine's Node runtime); a failed fetch skips its pack,
and the build and the affected features say so (`bun install` alone ships
that degraded build). With a Rust toolchain on the machine, `setup` also
builds the voice capture addon from `native/voice` (the one pack that is
built, not fetched; without cargo it is skipped and the doctor says so).
The build writes only under `dist/`. Configuration and sessions live in the
config home, `~/.mercury` or whatever `MERCURY_CONFIG_DIR` names; the first
run creates it. Windows runs `node dist\mercury.mjs` directly.

To run Mercury as a command, `scripts/ops/deploy-runtime.sh` publishes a
clean-tree build to `<config home>/runtime/dist` and
`scripts/ops/deploy-launcher.sh` installs the `mercury` launcher at
`<config home>/bin/mercury`; put that directory on your `PATH` (for zsh,
`echo 'export PATH="$HOME/.mercury/bin:$PATH"' >> ~/.zshrc`). A missing
runtime is a loud launcher failure, never a silent fallback. Release archives
install with `mercury install` and stay current with `mercury update` on the
private release channel (`--check`, `--status`, `--rollback`). Both paths run
the artifact on the vendored Node 24 LTS runtime the build carries, else on
`MERCURY_NODE` or a PATH node inside the range. [AGENTS.md](AGENTS.md) is the one-screen
build-and-run guide; [BUILD-NOTES.md](BUILD-NOTES.md) covers the build itself.

## The first run

The first interactive run is a short walk: pick a theme (the screen re-tints
as you move), then sign in to a provider or choose "sign in later" and look
around logged-out. After the walk, Mercury asks whether you trust the folder
you started in. Nothing a workspace config asks for runs before you trust
the folder, a grant covers the whole repository, and declining exits
([docs/TRUST.md](docs/TRUST.md)).

Every interactive boot with no explicit journey then lands on the Boot face,
the ten-row card:

- **New Session in \<folder\>**: a fresh session here, born on Enter.
- **Continue Last Session**: one keystroke back into the newest chat. It
  appears once session history exists; a first boot has none yet.
- **Boot Menu**: boot settings.
- **MCPs & Skills**: what the next session loads ([docs/KIT.md](docs/KIT.md)).
- **Agents**: create and edit agents.
- **Doctor / Health Check**: the install's health certificate.
- **Saturn Scheduler**: sessions born on the clock ([docs/SATURN.md](docs/SATURN.md)).
- **Logins**: sign in to providers.
- **Session Concourse**: the board of the project you are in.
- **Sessions · Projects**: pick a session or a repository, one screen.

Every row but Session Concourse opens in place as a layer of the face, and
esc lands back on the row; the concourse is the screen one shift+→ away. A
prompt argument, `--continue` or `--resume` goes straight to the chat.

## The daily loop

**New Session.** ↵ on New Session creates a real session for the current
folder on the model the chip shows, and enters it. The session, the chat and
its board row come into being together, and a warm runner already stands
behind the menu, so Enter is instant. Every further ↵ opens another session
while whatever the last chat held keeps running.

**The chat.** You type; the agent reads, edits, runs and verifies code under
the permission mode you chose, and each tool call shows in the chat as it
runs. `/model` and `/effort` tune the session, `/permissions` shapes what
runs free and what asks first, `/policy` is the governance posture, `/diff`
reviews the changes by source, file and hunk, `/tasks` is the board of
running shells and agents, and `/help` browses every command. `/clear` parks
the chat and `/title` names it.

**The strip.** shift+← and shift+→ walk only the screens that exist. A fresh
boot has the Boot face and the concourse; the chat joins the strip when a
session is focused and leaves it when the last chat closes, and the dim
key-map row names only the moves that exist. Closing every chat returns you
to the Boot face. `--chat` is the plain world (the face and a chat, no
concourse); `--concourse-off` saves that choice for every later boot, and
`--concourse-on` or `/config` turns it back.

**The Session Concourse.** `/concourse`, or shift+→ from the face, is the
board of the project you are in: its running sessions and, beneath them, its
parked chats, newest first. Each live row is a tile whose NOW cell streams
what the session is doing; ↵ brings a row back in place while every other
session keeps working; a session that crashed stays on the board as NEEDS
YOU with its reason until you release it; and a session taps the terminal
bell once when it needs you or finishes a run. The whole lifecycle is
[docs/SESSIONS.md](docs/SESSIONS.md).

## Providers and models

`/logins` opens the sign-in catalogue, the same card the first run shows,
and `/accounts` manages the provider slots afterwards. The doors:

- Claude subscription account
- OpenAI: ChatGPT subscription or API key
- Usage-based billing: Anthropic Console sign-in or API key
- OpenRouter: one credential, the whole catalogue (OAuth or key)
- Google Gemini: API key or Google OAuth
- Hugging Face: device-code sign-in or a Hub token
- Kimi (Moonshot): device-code sign-in or API key
- GLM (Z.AI): API key
- DeepSeek: API key

Local model servers and a custom OpenAI-compatible endpoint need no sign-in;
they become ready by discovery or configuration. Each family owns its own
wire, credentials and refusals, and nothing ever falls through from one
provider to another ([docs/ENGINES.md](docs/ENGINES.md)).

A fresh session starts on the provider of your most recent sign-in, on the
newest model that sign-in can use. A gated row is never chosen, a provider
with no usable row falls through to the next most recent sign-in, and
`/model` says which model was picked and why. With no sign-in yet, the face
and `/model` say so and point at `/logins`. `/defaultprovider` makes a
provider the most recent sign-in by your word.

## The headless CLI

The same artifact is a command-line tool; `node dist/mercury.mjs --help`
lists every flag. `-p "<prompt>"` runs one non-interactive turn (with
`--output-format text|json|stream-json`), `-c` continues the most recent
conversation, `-r` resumes by id, title or picker, `-w` runs the session
inside a managed worktree, and `--bare` is the minimal mode. The verbs:

- `mercury health` (alias `doctor`): the health certificate; `--json` prints
  it whole, `--deep` runs the deep inventory, `--fix` runs the guided fixes.
- `mercury auth login|status|logout`: sign in, show the status, sign out.
- `mercury mcp`: manage MCP servers (list, get, add-json, remove, serve).
- `mercury extensions`: install extensions and manage their sources (list,
  sources, add, remove, check, install, approve, enable, disable, update,
  uninstall, block, unblock, validate, init).
- `mercury agents`: print the agent inventory.
- `mercury daemon`: the background daemon that hosts sessions.
- `mercury acp --stdio`: the editor bridge over the Agent Client Protocol;
  `mercury editor <action>` manages the IDE side.
- `mercury themis`: THEMIS integrity tooling.
- `mercury show <image>`: render an image to the terminal.
- `mercury setup-token`: create a long-lived authentication token.
- `mercury install` and `mercury update`: release archives only.

## What is inside

- **The coding loop**: anchored reads and atomic multi-file edits
  ([docs/CHANGE-TRANSACTIONS.md](docs/CHANGE-TRANSACTIONS.md)), search and
  rewrite by syntax shape across 23 grammars
  ([docs/STRUCTURAL-PATTERNS.md](docs/STRUCTURAL-PATTERNS.md)), persistent
  code cells ([docs/WORKSHOP.md](docs/WORKSHOP.md)), and a debugger that
  speaks the Debug Adapter Protocol ([docs/DEBUGGER.md](docs/DEBUGGER.md)).
- **Extensions**: one manifest per extension, sources you add (a git URL, a
  folder, an archive), approval per contributions hash
  ([docs/EXTENSIONS.md](docs/EXTENSIONS.md)).
- **MCPs & Skills**: what a session loads, as a per-repository record with
  named presets and in-session dials ([docs/KIT.md](docs/KIT.md)).
- **Agents and teams**: named teammates, an agent studio, workflow runs and
  the boards that watch them ([docs/TEAMS.md](docs/TEAMS.md)).
- **Saturn**: wake a session with a prompt at a time or on a recurrence, or
  schedule a fresh session's birth ([docs/SATURN.md](docs/SATURN.md)).
- **The doctor and `/health`**: an evidence-backed certificate with a
  `certified` / `caution` / `fault` verdict and verified fixes
  ([docs/HEALTH-CERTIFICATE.md](docs/HEALTH-CERTIFICATE.md)).
- **Trust, permissions and THEMIS**: workspace trust, permission rules and
  modes, and the deterministic trust plane ([docs/TRUST.md](docs/TRUST.md),
  [docs/THEMIS-CONTROL-PLANE.md](docs/THEMIS-CONTROL-PLANE.md)).
- **Apollo Mode**: the pre-flight interview that writes the missing spec and
  builds a prototype from it ([docs/APOLLO-MODE.md](docs/APOLLO-MODE.md)).
- **Editor bridges**: `mercury acp` for any Agent Client Protocol editor,
  the VS Code extension (`mercury editor install`) that runs Mercury in
  the editor and attaches a terminal session to it (`/ide`: selection,
  diagnostics, native diffs), in-editor bridges into a running Unity,
  Blender or Godot editor, and a batch door into Aseprite, each behind its
  own opt-in switch
  ([docs/UNITY-BRIDGE.md](docs/UNITY-BRIDGE.md),
  [docs/BLENDER-BRIDGE.md](docs/BLENDER-BRIDGE.md),
  [docs/ASEPRITE-BRIDGE.md](docs/ASEPRITE-BRIDGE.md)).
- **Memory**: experience cards, a project notepad, and Minerva's room over
  your saved prompts ([docs/TABULA-NOTES.md](docs/TABULA-NOTES.md)).
- **Voice input**: `/speak on`, then `v` in an empty composer dictates
  into it through the family you signed into; audio leaves only after you
  stop, and Mercury never speaks aloud ([docs/VOICE.md](docs/VOICE.md)).
- **Durability**: atomic publication, journaled operations and a boot-time
  reconciliation pass ([docs/DURABILITY.md](docs/DURABILITY.md)).
- **Web search for every model**: the provider's own live search beside
  Mercury's vendored WebSearch (a Brave or Tavily key, else a keyless door),
  every result naming the door that answered ([docs/ENGINES.md](docs/ENGINES.md)).

Runtime behaviour is gated through the in-code flag registry
(`src/substrate/flagRegistry.ts`, rendered on demand) with `MERCURY_*`
spellings, and the interop surfaces are documented in
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md). The documentation index is
[docs/README.md](docs/README.md).

## Every slash command

Every interactive surface is a slash command: `/help` browses them all,
`/palette` fuzzy-searches the live roster, and `/surfaces` is the index of
every discoverable surface. The table is the artifact's own effective
catalogue, grouped the way `/help` groups it:

| Domain | Commands |
| --- | --- |
| current work | `/run` `/tasks` `/workbench` `/diff` `/mission` `/themis` `/supervisor` |
| crew & delegation | `/agents` `/teammates` `/crew` `/team` `/workflows` `/fleet` `/monitor` `/router` `/daemon` `/saturn` `/live` `/halt` `/kill` `/unkill` `/surfaces` |
| session & context | `/clear` `/compact` `/context` `/auto-compact-window` `/resume` `/rewind` `/sessions` `/concourse` `/branches` `/rename` `/title` `/contract` `/export` `/copy` `/cost` `/usage` `/insights` `/debrief` `/add-dir` `/realms` |
| memory & goals | `/memory` `/cards` `/remember` `/tabula` `/note` `/minerva` `/console` `/orient` |
| model & effort | `/model` `/effort` `/plan` `/supercode` `/submodels` `/counsel` `/harness` `/caching` |
| git & review | `/branch` `/review` `/security-review` `/pr-comments` |
| health & introspection | `/health` `/verify` `/status` `/trace` `/substrate` `/capabilities` `/capabilities-detail` `/ledger` `/provenance` |
| config & setup | `/config` `/permissions` `/hooks` `/mcp` `/extensions` `/skills` `/policy` `/authority` `/sovereign` `/sandbox` `/ide` `/browser` `/init` `/keybindings` `/keys` `/vim` `/mouse` `/pings` `/terminal-setup` `/bootmenu` `/speak` `/voice` |
| appearance & cockpit | `/cockpit` `/home` `/appearance` `/accent` `/color` `/critter` `/companion` `/palette` `/fullscreen` |
| account & app | `/logins` `/logout` `/accounts` `/defaultprovider` `/release-notes` `/feedback` `/help` `/exit` |

## Reporting a problem

Open an issue on the repository through one of its templates: a bug, a
provider or model report, or a feature request. Every template asks for the
`--version` line, the OS and terminal, and the exact steps; the bug and
provider templates also ask for the output of `node dist/mercury.mjs doctor
--json` (`mercury doctor --json` for a release install). A pasted transcript
of the failing screen helps. Security problems go through the repository's
Security tab instead ([SECURITY.md](SECURITY.md)), and
[CONTRIBUTING.md](CONTRIBUTING.md) covers issues, pull requests and the
checks.

## Licence

The licence is [LICENSE.md](LICENSE.md). Bundled third-party licences are
inventoried in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
