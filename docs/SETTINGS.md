# Settings

Mercury stores settings in JSON files, edited in `/config` or through
`/model`, `/effort`, `/permissions`, `/memory` and the MCPs & Skills menu.

This page covers the grouped keys you can set in a file. The Boot Menu and
`/config` also keep machine and session choices of their own (such as
**DuckDuckGo page scraping**, on by default, and **Session concourse**); not
every screen row is a key in `settings.json`. In `/config`, typing any
printable character (including `j` and `k`) filters the rows immediately; arrow
keys and `PageUp`/`PageDown` move the selection. `/config`'s header counts
the rows you set: a settings file names the row's key, or a saved choice
differs from Mercury's default.

## Files and precedence

From lowest to highest priority:

1. `<config home>/settings.json`: your defaults, across projects. The home
   is `~/.mercury` unless `MERCURY_CONFIG_DIR` names another directory.
2. `<project>/.mercury/settings.json`: shared project settings.
3. `<project>/.mercury/settings.local.json`: your settings for this project.
4. `--config <file-or-json>`: settings supplied to this launch.
5. Managed policy: the administrator's settings, including
   `managed-settings.json` and platform-managed policy.

Objects merge by key and arrays combine, with repeated scalar entries kept
once. A scalar in a higher-priority source wins. A running session reads an
edit to any of these files as it lands, including a `.mercury/` folder created while
the session runs (a rule a permission card saves into it is
honoured on the next call). `--config-layers user,local` selects which
of the three user-owned sources load; flag settings and managed policy still
apply. Permission denies and managed locks remain binding.

Mercury writes an editor-schema pointer as `$schema` in your settings file.
The schema at `<config home>/schema/settings.schema.json` belongs to the
installed build and works offline. Use it for completion and validation.
A value Mercury cannot read, and a key it does not know, is named where
settings faults are reported: the health check's Settings row, the chat's
settings notice, one line in the chat at the start of the next turn (said
once, and again only if the fault goes away and comes back), and one
`settings:` line on stderr at the start of a headless run; the rest of the
file still applies. A file that does not parse at all is left out whole at
launch; a file that stops parsing while a session is open keeps its last good
settings in force (its hooks and rules keep working) and the line says so,
until the file reads again.

Settings that execute project commands still require workspace trust
([TRUST.md](TRUST.md)). Keep secrets in `/logins` or a credential helper,
not in a shared project file.

For example:

```json
{
  "engine": { "effort": "max", "reasoning": true },
  "guardrails": {
    "mode": "default",
    "allow": ["Bash(bun run typecheck)"],
    "ask": ["Bash(git push *)"],
    "deny": ["Read(~/.ssh/**)"]
  },
  "memory": { "pinnedLimit": 8000 },
  "view": { "ping": false },
  "patience": "patient"
}
```

## Model and reasoning

| Key | What it sets |
| --- | --- |
| `engine.model` | The model id or family word saved by `/model`. Choose from the live catalogue; `--model` and `MERCURY_MODEL` can override the saved default. When `<config home>/settings.json` cannot be written, `/model` names the file and the OS reason (`not saved as your default: ~/.mercury/settings.json …`). |
| `engine.effort` | `low`, `medium`, `high`, `xhigh` or `max`, also saved by `/effort` or `ctrl+e` in `/model`. Each model uses the levels its provider supports; a failed write to `settings.json` names the file and the OS reason in the picker footer or receipt. |
| `engine.reasoning` | Whether thinking is requested, on every provider that reads it (Anthropic, Z.AI where thinking-locked models keep it on, and the OpenAI-compatible chat roads; GPT models take the effort dial instead). A model that always reasons keeps its own rule. |
| `engine.agent` | The agent definition used for the session; `--agent` chooses one for a launch. |
| `engine.roster` | A list limiting which models can be selected. |
| `engine.disabledProviders` | A list of provider families to switch off. Their rows leave `/model` and `mercury://models`, their bare family words stop resolving, their stored keys remain untouched, and a session already running on a disabled family keeps running; `/health` records the disabled families and any unknown names as info. |
| `engine.backups` | The backup engines, in order. When the engine in use cannot answer a turn (its provider overloaded past the retry ladder, unreachable, refusing the sign-in after a refresh, or no longer serving the model), the turn hops to the first backup, then the next, each tried once per turn, and says so in one line. A `--backup-model` heads the list. With no list nothing changes. |
| `engine.pins` | An object mapping known canonical Anthropic model ids to the ids your endpoint serves. |
| `engine.sessionDefaults` | Whether the home screen and board show the model-default key; on unless set to `false`. |
| `engine.usageNotice` | Usage notice to the model: with it on, the model is told when the session's usage window or spending limit is near (80% and 90%); off, the model is told nothing and only you see the meters. |

A resumed chat keeps its model and effort unless the launch explicitly
chooses them. [ENGINES.md](ENGINES.md) describes provider routing;
[SESSIONS.md](SESSIONS.md) describes saved defaults and resumes.

### Model facts

`models` is keyed by the full model id, including its provider or
endpoint prefix. State only the facts you know; omitted fields keep the
provider's or model table's facts. These entries do not sign in a provider
or make an unavailable model selectable.

| Key under `models.<id>` | What it states |
| --- | --- |
| `contextWindow` | The context window in tokens, a positive integer. |
| `maxOutputTokens` | The output ceiling in tokens, a positive integer. |
| `prices.input`, `prices.output` | Input and output prices in USD per million tokens; zero is allowed. |
| `prices.cacheRead`, `prices.cacheWrite` | Cache-read and cache-write prices in USD per million tokens. |
| `efforts` | The supported words from `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`. |
| `images`, `reasoning` | Whether the model accepts images and supports reasoning. |
| `thinkingBudget` | The thinking-token cap, a positive integer, sent only on a wire that documents one (Qwen's `thinking_budget`); with it stated, the effort dial stays off that request. |

A lower window or output value, an omitted effort rung, or `false` cannot
remove a capability already recorded for that model. Other stated facts,
including prices, still apply. `models._default.<family>` accepts
the same fields for unknown model ids in that family and fills only facts
that have not been stated. An explicit model entry takes priority over the
family default.

## Custom endpoints

`compatProvider` names custom endpoints in user, launch or managed-policy
settings. Project settings cannot redirect their credentials. Each map key
is 1–32 lowercase letters, digits or hyphens; select a model as
`compat/<name>/<id>`. A single endpoint block names `default` and uses
`compat/<id>`.

| Key | What it sets |
| --- | --- |
| `compatProvider.<name>.baseUrl` | The HTTP(S) API base, without credentials, query or fragment. |
| `compatProvider.<name>.label` | The endpoint name shown in the model picker and Logins. |
| `compatProvider.<name>.keyCommand` | A shell command supplying the API key for this endpoint (10 s timeout, cached for the process, 30 s back-off after a failure, invalidated on HTTP 401). |
| `compatProvider.<name>.models` | Vendor model ids. Without a list, named endpoints read `/models` when catalogue traffic is on. |
| `compatProvider.<name>.headers` | Extra request headers; credential and transport headers are reserved. |
| `compatProvider.<name>.sessionAffinityHeader` | A header carrying the session id on model requests. |
| `compatProvider.<name>.dialect` | `chat-completions` (default), `responses`, `ollama`, `lmstudio`, `vllm` or `llamacpp`; server dialects use their Chat Completions profiles. |

`/logins compat/<name>` stores a key for that endpoint alone.
`MERCURY_COMPAT_<NAME>_API_KEY` takes precedence: uppercase the name and
replace hyphens with underscores. The default endpoint also honours
`MERCURY_COMPAT_API_KEY`, `MERCURY_COMPAT_BASE_URL`,
`MERCURY_COMPAT_LABEL` and `MERCURY_COMPAT_MODELS`.

## Permissions and the sandbox

| Key | What it sets |
| --- | --- |
| `guardrails.mode` | The saved posture: `default`, `dontAsk`, `implement`, `sovereign`, `flow` or `apollo`. Availability and consent still apply at entry. |
| `guardrails.allow` | Tool rules that allow a matching action without a question. |
| `guardrails.ask` | Tool rules that require confirmation in a posture that asks. |
| `guardrails.deny` | Tool rules that refuse a matching action. A deny wins over an ask or allow. |
| `guardrails.reasons` | An object keyed by a rule's exact spelling, with the explanation shown on its refusal or consent card. |
| `guardrails.managedOnly` | When set by managed policy, restricts permission rules to that policy. |
| `guardrails.disableSovereignMode` | Closes Sovereign mode. |
| `guardrails.disableFlowMode` | Closes Flow. |
| `guardrails.sovereignConsentSeen` | Records acceptance of the Sovereign consent card. Checked-in project settings cannot grant it. |

Rules use `Tool(pattern)`: `Bash(bun run typecheck)` is one exact command,
`Bash(bun run *)` covers that command prefix and its arguments,
`Read(~/docs/**)` covers a path, and `WebFetch(domain:example.com)` covers a
host. A bare tool name covers every use of that tool. `/permissions` shows
where each rule came from. Workspace trust and permission modes are separate
from the OS sandbox.

Sandbox settings live under `guardrails.sandbox`:

| Key | What it sets |
| --- | --- |
| `guardrails.sandbox.enabled` | Turns OS sandboxing on. |
| `guardrails.sandbox.enabledPlatforms` | The platforms it runs on: `macos`, `linux`, `wsl`; absent means every supported platform. |
| `guardrails.sandbox.failIfUnavailable` | Refuses a run when the sandbox cannot be established. |
| `guardrails.sandbox.autoAllowBashIfSandboxed` | Allows sandboxed shell commands without a separate permission question. |
| `guardrails.sandbox.allowUnsandboxedCommands` | Permits the consented unsandboxed execution path. |
| `guardrails.sandbox.excludedCommands` | Command patterns that run outside the sandbox. |
| `guardrails.sandbox.ignoreViolations` | Violation patterns grouped by command. |
| `guardrails.sandbox.enableWeakerNestedSandbox` | Allows the weaker nested-sandbox option. |
| `guardrails.sandbox.enableWeakerNetworkIsolation` | Allows the weaker network-isolation option. |
| `guardrails.sandbox.ripgrep.command`, `guardrails.sandbox.ripgrep.args` | The sandbox's search binary and its arguments. |
| `guardrails.sandbox.network.allowedDomains` | Hosts a sandboxed process may reach. |
| `guardrails.sandbox.network.allowManagedDomainsOnly` | Restricts the domain list to managed policy. |
| `guardrails.sandbox.network.allowUnixSockets` | Allowed Unix socket paths. |
| `guardrails.sandbox.network.allowAllUnixSockets` | Allows every Unix socket. |
| `guardrails.sandbox.network.allowLocalBinding` | Allows binding local ports. |
| `guardrails.sandbox.network.httpProxyPort`, `guardrails.sandbox.network.socksProxyPort` | Proxy ports for sandboxed traffic. |
| `guardrails.sandbox.filesystem.allowWrite`, `guardrails.sandbox.filesystem.denyWrite` | Writable and write-denied path patterns. |
| `guardrails.sandbox.filesystem.allowRead`, `guardrails.sandbox.filesystem.denyRead` | Readable and read-denied path patterns. |
| `guardrails.sandbox.filesystem.allowManagedReadPathsOnly` | Restricts allowed read paths to managed policy. |

Use `/sandbox` and `/health` to check what the platform can establish before
relying on these boundaries.

## Instructions, files and memory

| Key | What it sets |
| --- | --- |
| `briefs.profile` | `auto` loads a project's `AGENTS.md` when its instruction chain has no `MERCURY.md`; `native` loads Mercury instruction files only. A `MERCURY.local.md` is a personal layer; it does not stop `auto` loading `AGENTS.md`. |
| `briefs.exclude` | Instruction-file glob patterns or absolute paths to skip; managed instructions cannot be excluded. |
| `briefs.git` | Whether the model receives Mercury's git instructions. |
| `files.honourGitignore` | Whether file suggestions respect `.gitignore`. |
| `files.suggester` | A file-suggestion helper, shaped as `{ "type": "command", "command": "…" }`. |
| `records.retentionDays` | Retention for recordings and tool results, in days; 30 by default. Session transcripts are not aged out by this sweep. `0` turns transcript writing off: no new transcript is written and no lineage entry is written, and the ones already on disk stay. |
| `memory.enabled` | Mneme memory is on unless this is `false`. |
| `memory.directory` | A custom memory directory. Checked-in project settings cannot choose it. |
| `memory.pinnedLimit` | The pinned shelf's text limit in characters, at least 1000; 8000 by default. Every pinned rule still loads above the limit. |
| `memory.startLimit` | How much memory text rides at the start of a session (`# Memory at start`) beyond the pinned rules, in characters, at least 1000; 4000 by default (`/config` row **Memory at start, beyond the pins**). The pinned rules always ride whole and never count against it; the allowance takes the facts and earlier notes most relevant to the branch, the files touched lately and the last note. What is left out is a Recall away. |
| `memory.embeddingModel` | Which embedding model memory ranks recall by meaning with (`/config` row **Memory recall ranking`), beside the word match: a model name this install carries (`bge-base-en-v1.5`, the shipped default), or the path of a `.gguf` file. A name or path that resolves nowhere leaves memory on `word match only`, and the front page says so. |
| `memory.journal` | The session journal, off by default: when `true`, at session end the model writes a brief entry (where the project is, the queued backlog, the constraints you set) into `<config home>/projects/<project>/journal/journal.md` in the Mercury home beside the project's memory, never under the project tree, never pushed, synced or shared by Mercury. |
| `memory.journalOnEntryPage` | `true` hands the journal's last entry to the model at session start on its `# Lineage` entry page; off by default. What the model reads at entry travels to the engine's provider with the request ("never uploaded" means Mercury itself never pushes, syncs or shares the journal). |
| `memory.tellEngineSwitch` | `true` tells the model when its model is switched: one line reaches it at the switch naming the new model, the time with its time zone, and instructing it to include the zone when repeating the time. Off by default: a switch is invisible to the model (the `/model` rows stay your record, and if you ask which model is running, the model reads the live session record at `mercury://seat`). |
| `workspace.worktree.symlinkDirectories` | Additional directories linked into a managed worktree. |
| `workspace.worktree.sparsePaths` | Paths included in a managed sparse worktree. |
| `workspace.worktree.prepare` | A shell command run inside every new worktree after git makes it and before any seat uses it; a failure is named on the row. |

Project conventions belong in `MERCURY.md` or the project's `AGENTS.md`.
A personal `MERCURY.local.md` loads after the guide. Memory records what was
learned across sessions; [MNEME.md](MNEME.md) describes its tools and shelf.

## Credentials, environment and attribution

| Key | What it sets |
| --- | --- |
| `credentials.keyCommand` | A shell command supplying an Anthropic API key (10 s timeout, cached for the process, 30 s back-off after a failure, invalidated on HTTP 401). Project-scope helpers wait for workspace trust. |
| `credentials.keyCommands` | A map of provider family names (`openai`, `openrouter`, `gemini`, `moonshot`, `deepseek`, `xai`, `meta`, `mistral`, `nous`, `zen`, `minimax`, `together`, `cohere`, `huggingface`, `local`, `zai`, `anthropic`, or `compat/<name>`) to shell commands supplying their API keys, under the same timeout, cache, back-off, 401 invalidation and workspace-trust rules. |
| `credentials.signInRoute` | The required Anthropic sign-in route: `claudeai` or `console`. |
| `credentials.organisation` | The required organisation for Anthropic sign-in. |
| `environment.values` | Environment variable names and values for Mercury; string, number and boolean values become strings. |
| `credit.mercury` | Mercury's commit and pull-request attribution is on unless this is `false`. |
| `credit.lines.commit`, `credit.lines.pr` | Custom attribution text. An empty string omits that line; when `credit.lines` is present, an omitted member uses its default. This object takes precedence over `credit.mercury`. |

## MCP servers, hooks and extensions

MCP server definitions live in `.mercury/mcp.json` for the project;
`mercury mcp` manages them. The `kit` keys govern selection and policy, not
the server definitions themselves.

| Key | What it sets |
| --- | --- |
| `kit.trustProjectServers` | Approves project-defined MCP servers without an individual approval card. |
| `kit.projectOn`, `kit.projectOff` | Project MCP server names approved or disabled in this settings source. |
| `kit.permit`, `kit.deny` | Server policy entries. Each entry names exactly one of `serverName`, `serverCommand` (an argument array), or `serverUrl`. Denies take precedence. |
| `kit.managedOnly` | When set by managed policy, uses only that policy's server allowlist. |
| `events.hooks` | The hooks, by event: one entry per hook with its own match; [HOOKS.md](HOOKS.md) defines the events and the entry. |
| `events.disabled` | Turns off every hook that is not managed; in the managed layer, every hook. |
| `events.managedOnly` | In the managed layer, runs only the managed layer's hooks. |
| `extensions.enabled` | Extension ids and their enabled state. |
| `extensions.wanted` | Requested extensions, each with `name`, `source` and optional `ref`. |
| `extensions.blocked` | Extension ids or source labels on the blocklist. |
| `extensions.options` | Non-secret option values grouped by extension id and option name. |
| `extensions.exclusive` | A managed lock: `true` for every customization surface, or a list drawn from `skills`, `agents`, `hooks`, `mcp`. |
| `channels.enabled` | Enables messages from approved MCP channels. |

[KIT.md](KIT.md) explains the per-repository menu and the session's dials;
[EXTENSIONS.md](EXTENSIONS.md) explains manifests, sources and approval.

## Appearance and input

| Key | What it sets |
| --- | --- |
| `voice.language` | The language the model should use in its replies. This is not the speech transcriber's choice. |
| `activity.tips.enabled` | Whether activity tips are shown. |
| `activity.tips.words` | Custom tips: `tips` is a string list and `excludeDefault` chooses whether the built-in tips also appear. |
| `activity.verbs` | Custom activity verbs: `verbs` is a string list and `mode` is `append` or `replace`. |
| `activity.progress` | The ring in the terminal tab while a turn runs: `false` turns it off, `true` keeps it on where the terminal draws one; unset, the terminal's own capability decides. `/config`'s Terminal progress bar row reads it and names it when set. |
| `view.files` | Shows the FILES box in the sidebar. |
| `view.modelPicker.centred` | Centres the model picker; `false` places it at the left edge. |
| `view.syntaxOff` | Disables syntax colouring. |
| `view.reducedMotion` | Suppresses authored animation. |
| `view.backgroundKey` | Enables the key that backgrounds a running shell command. |
| `view.firstRunCards` | First-run card placement: `centred` or `top-left`. |
| `view.ping` | Pings the terminal when a chat finishes while you are away; on unless `false`. |
| `view.accountIdentity` | Shows the signed-in account on the screens; `false` takes every address, username and key tail off them (for a recording) and leaves the account word. The Logins screen, `/accounts` and the health report still name the account. On unless `false`. |
| `view.zen` | Zen mode: `true` hides the lanes and vitals rails and the chat takes the full width of the terminal. Off unless `true`; `/zen` flips it and the Zen mode row of `/config` shows it. |
| `context.wayBack` | Shows the way-back hint beside a notice. |
| `input.suggestions` | Enables prompt suggestions. |
| `apollo.preflightQuestions` | Apollo's interview budget, 1–20 questions, 7 by default. |

## Shell, patience and provider routing

| Key | What it sets |
| --- | --- |
| `shell.kind` | The default shell tool: `bash` or `powershell`. |
| `shell.engine` | `system` or the persistent `brush` engine. |
| `shell.sessions` | The live shell-engine session ceiling, 1–64, 8 by default; the main conversation owns one. |
| `shell.filterOutput` | Filters a command's output before the model reads it: progress-bar redraws collapse to their last line, package-manager install chatter is dropped, runs of identical lines fold to one with a count, and a footer names what was left out and the file holding the raw output. Off by default. |
| `turns.loopGuard` | Allows the loop guard to end a turn after a repeated cycle is detected twice; off by default. |
| `patience` | `normal`, `patient`, or the custom object below. |
| `routing.openrouter.dataCollection` | `deny` by default, or `allow`. |
| `routing.openrouter.requireParameters` | Requires support for every request parameter; `true` by default. |
| `routing.openrouter.allowFallbacks` | Permits OpenRouter provider fallback; `true` by default. |
| `routing.openrouter.zeroDataRetention` | Requires zero data retention; `false` by default. |
| `routing.openai.transport` | The OpenAI API-key road's transport: `http` by default, or `websocket` — one connection per conversation that sends only the new input against the previous response and falls back to `http` on any connect or stream fault before the response begins. |

Custom patience uses `patience.streamIdleSeconds`,
`patience.quietStreamIdleSeconds`, `patience.fallbackCeilingSeconds` and
`patience.recoveryBudgetMinutes`. Normal values are 360 seconds for an idle
stream whose keep-alives are visible, 900 for a quiet stream, 900 for the
non-streamed fallback and 20 minutes for recovery. Patient doubles those
values. A custom object inherits normal values for omitted fields; a recovery
budget of zero means no budget. `MERCURY_STREAM_IDLE_TIMEOUT_MS`,
`MERCURY_API_TIMEOUT_MS` and `MERCURY_RECOVERY_BUDGET_MINUTES` take precedence.
These limits govern connection silence and recovery only.

## The local server

The values under `local.server` stage changes to Ollama's launch configuration.
They do not alter a running server until you confirm the review and restart in
`/config`.

| Key | What it sets |
| --- | --- |
| `local.server.maxLoadedModels` | Models kept loaded, 1–64. |
| `local.server.parallelSlots` | Concurrent requests per loaded model, 1–64. |
| `local.server.keepAlive` | A duration such as `30m`; `-1` keeps a model loaded, `0` unloads it at once. |
| `local.server.contextLength` | The window used when a request names none, 512–10485760 tokens. |

[LOCAL-SETUP.md](LOCAL-SETUP.md) covers choosing and starting a local model;
[ENGINES.md](ENGINES.md) covers window sizing and server memory checks.
