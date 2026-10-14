# The health certificate

`/health` (and headless `mercury health`) checks the installation, runtime,
settings and release channel live and rolls them into one verdict (`certified`,
`caution` or `fault`). Configured MCP servers are validated without being
started.

Every check carries an `evidence` string naming the artifact, probe or value
consulted (missing evidence reads `unknown`), marks evidence older than current
`HEAD` or resume state as `stale`, and ranks available fixes worst-first. The
report is strictly read-only except for writing the `last-cert.json` summary.

## Checks and the verdict

Each check reports `ok`, `warn`, `fail`, `stale`, `unknown`, `off` or `info`,
with probe kind `functional` or `configuration` and depth `fast` or `deep`
(`--deep` includes payload digest checks and deep inventories). Any `fail`
makes the verdict `fault`; otherwise any `warn`, `stale` or `unknown` makes it
`caution`; otherwise `certified` (`off` and `info` are neutral).

A fast run checks these sections (`id` · `title`):

| id | title |
| --- | --- |
| `identity` | IDENTITY |
| `proofs` | PROOFS |
| `git` | GIT |
| `crew` | CREW & DAEMONS |
| `memory` | MEMORY & CONTEXT |
| `settings` | SETTINGS & FLAGS |
| `auth` | AUTH |
| `interface` | INTERFACE |
| `runtime` | RUNTIME |
| `durability` | DURABILITY |
| `native-ownership` | TERMINAL RUNTIME |
| `profile` | PROFILE |
| `coding-loop-fast` | CODING LOOP |
| `flux` | TERMINAL FLUIDITY |
| `tool-capability-fast` | TOOL CAPABILITY |
| `router-fast` | ROUTER |
| `architecture-fast` | ARCHITECTURE PRIMITIVES |

### Client contract and refused models

`IDENTITY`'s `Client contract` row (`client-contract`) shows the client version
Mercury presents on the Claude subscription sign-in (`cc_version`) and its
source: the built-in version, a newer version learned from the npm registry, or
`MERCURY_ANTHROPIC_CLIENT_CONTRACT=<version>` (`MERCURY_DISABLE_NONESSENTIAL_TRAFFIC`
disables registry reads).

`IDENTITY`'s `Refused models` row (`model-refusals`) lists models refused on any
credential door for a minimum client version, subscription tier or model
403/404, shared across the runner, picker and `/health` under the credential
home's `model-refusals` directory. Refusals for unserved models warn for one
hour and then become `info`; minimum-version and tier refusals warn until the
client version or plan changes, and `mercury health --fix --only model-refusals`
clears the records. `MEMORY & CONTEXT`'s `Preserved thinking` row
(`preserved-thinking`) follows the same one-hour warning rule.

### Interface, runtime and tool capability

- `INTERFACE`'s `Browser` row (`iface-browser`) reports the resolved Browser
  tool binary: managed Chrome for Testing (installed via `/browser install`,
  about 185 MB download) or an explicit executable pin, plus any discovered
  system browsers for information only.
- `RUNTIME`'s `Box lock` row (`box-lock`, also readable by agents at
  `mercury://health/box`) shows the `MERCURY_BOX_LOCK_DIR` coordination
  directory, held slots, waiting tickets and the latest memory sample (`vm_stat`,
  `meminfo`, or the Windows counter).
- `RUNTIME`'s `OS Bash sandbox` row (`sandbox`) reports `info` when off (the
  default), `warn` when enabled on an unsupported platform or missing a
  dependency, and `ok` when active (`seatbelt` on macOS; `bubblewrap` on Linux
  and WSL2, noting whether unix sockets are blocked by the `vendor/seccomp`
  helper or left open by `guardrails.sandbox.network.allowAllUnixSockets`).
- `TOOL CAPABILITY`'s `Tools withheld` row (`tools-withheld`) lists built-in
  tools withheld for a missing machine dependency (a debug adapter for `Debug`,
  Godot for `Godot`, the desktop driver for `Computer`, or `rg` for `Grep` and
  `Glob`), waiting for debug-adapter probes to settle first; withheld tools
  also appear in `readiness[]` as `tool:withheld:<name>`.
- `SETTINGS & FLAGS`'s `Env overrides` row (`flags`) lists active `MERCURY_*`
  environment switches set outside Mercury's own process stamps and saved boot
  defaults.

### Auth: model lists and web search

`AUTH`'s `Model lists` row (`model-lists`) compares Mercury's typed model ids
(Anthropic, OpenAI, Z.AI, Moonshot, DeepSeek, xAI, Meta, Gemini, Hugging Face)
against the live model lists already fetched in this process by `/model`,
`/logins` or a chat. It never makes network requests of its own: unread lists
report `no list read in this process` (`info`), and a read list missing a typed
id reports `warn`.

`AUTH`'s `Web search` row (`web-search-door`) reports the search cascade
available to the session's model: native provider search (`Anthropic web search
(native, session account)` or `OpenAI web search (native, session account)`),
stored Brave or Tavily keys, the official APIs, configured SearXNG instances
(joined only when `MERCURY_SEARCH_SEARXNG_INSTANCES` configures at least one
permitted instance; otherwise noted as `no metasearch instance configured`),
and keyless DuckDuckGo page scraping (on by default). When no search door opens
for the model (no native search, no Brave/Tavily key, no SearXNG instance, and
DuckDuckGo page scraping turned off in `/config` or with
`MERCURY_SEARCH_KEYLESS=0`), the row reports `info` (`no door opens for
<model>`) and names `/router key brave` (or `tavily`) and `/config` to turn
DuckDuckGo page scraping back on.

### Crew and daemons: store isolation and process sweep

`CREW & DAEMONS`'s `Store isolation` row (`isolation`) checks daemon-plane
records in the config home for Mercury's fingerprint; foreign records written
by other tools can be archived into a dated subfolder by the row's remedy.

`CREW & DAEMONS`'s `Mercury processes` row (`mercury-processes`, headless
`mercury health processes`) classifies every Mercury process (`node`, `bun` or
the launcher) into `running`, `stale`, `cannot end` or `not ours` using window
registrations (`<config home>/processes/`), live terminal ownership, daemon
records and runner seats (honouring `MERCURY_SESSION_PARK_DRAIN_MINUTES` and
`MERCURY_PROCESS_SWEEP_WAIT_MS`). Daemon and window boots record the census to
`<config home>/processes/census.json`; `/health` and `mercury health processes`
inspect live without writing. To end stale processes, use the row's remedy in
`/health`, `mercury health processes --end-stale`, or `mercury health --fix
--yes`.

## Fixes, JSON output, artifacts and gates

Checks with status `fail`, `warn` or `stale` can provide an executable
`{ plan, apply, verify }` remedy. Interactive `/health` prompts with a consent
card; headless `mercury health --fix` applies safe remedies and requires `--yes`
for destructive ones (`--only <id>` scopes any run to a single check). Each
applied fix appends an audit entry after `verify()` confirms the result.

`mercury health --json` outputs a `certSchema: 2` JSON document containing
`verdict`, `ranAt`, `version`, `durationMs`, `depth`, `head` (`{ sha, branch,
dirty }`), `nodeRuntime` (`{ observed, label, range, verdict }`), `sections[]`
and `readiness[]` (`tool`, `mcp`, `lane`, `engine`, `extension`, `skill`).

Under `<config home>/projects/<project>/` (`MERCURY_HEALTH_STATE_DIR` overrides
the project root):

- `health/last-cert.json`: summary of the latest certificate (keeping
  deep-only check readings across later fast runs).
- `health/last-preflight.json`: summary of the startup preflight check.
- `gate/verdict.json`: local verification pool verdict read by `PROOFS`.

Kill switches in `src/substrate/flagRegistry.ts`: `MERCURY_HEALTH_CERT=0`
restores plain diagnostics without artifact writes, `MERCURY_HEALTH_FIX=0`
disables remedies, and `MERCURY_BOOT_PREFLIGHT=0` skips the boot preflight.
