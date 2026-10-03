# Settings

Mercury keeps settings in JSON files. `/config` opens the settings screen;
`/model`, `/effort`, `/permissions`, `/memory` and the MCPs & Skills menu
provide the focused controls. This page covers the grouped keys you can set
in a file. The Boot Menu also keeps machine and session choices of its own;
not every screen row is a key in `settings.json`.

## Files and precedence

From lowest to highest priority:

1. `<config home>/settings.json` — your defaults, across projects. The home
   is `~/.mercury` unless `MERCURY_CONFIG_DIR` names another directory.
2. `<project>/.mercury/settings.json` — shared project settings.
3. `<project>/.mercury/settings.local.json` — your settings for this project.
4. `--config <file-or-json>` — settings supplied to this launch.
5. Managed policy — the administrator's settings, including
   `managed-settings.json` and platform-managed policy.

Objects merge by key and arrays combine, with repeated scalar entries kept
once. A scalar in a higher-priority source wins. `--config-layers user,local` selects which
of the three user-owned sources load; flag settings and managed policy still
apply. Permission denies and managed locks remain binding.

Mercury writes an editor-schema pointer as `$schema` in your settings file.
The schema at `<config home>/schema/settings.schema.json` belongs to the
installed build and works offline. Use it for completion and validation.
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
| `engine.model` | The model id or family word saved by `/model`. Choose from the live catalogue; `--model` and `MERCURY_MODEL` can override the saved default. |
| `engine.effort` | `low`, `medium`, `high`, `xhigh` or `max`, also saved by `/effort`. Each model uses the levels its provider supports. |
| `engine.reasoning` | Whether thinking is requested. A model that always reasons keeps its own rule. |
| `engine.agent` | The agent definition used for the session; `--agent` chooses one for a launch. |
| `engine.roster` | A list limiting which models can be selected. |
| `engine.pins` | An object mapping known canonical Anthropic model ids to the ids your endpoint serves. |
| `engine.sessionDefaults` | Whether the Boot face and board offer the model-default key; on unless set to `false`. |

A resumed chat keeps its model and effort unless the launch explicitly
chooses them. [ENGINES.md](ENGINES.md) describes provider routing;
[SESSIONS.md](SESSIONS.md) describes saved defaults and resumes.

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
| `briefs.profile` | `auto` loads a project's `AGENTS.md` when its instruction chain has no `MERCURY.md`; `native` loads Mercury instruction files only. A `MERCURY.local.md` is a personal layer, not a guide. |
| `briefs.exclude` | Instruction-file glob patterns or absolute paths to skip; managed instructions cannot be excluded. |
| `briefs.git` | Whether the model receives Mercury's git instructions. |
| `files.honourGitignore` | Whether file suggestions respect `.gitignore`. |
| `files.suggester` | A file-suggestion helper, shaped as `{ "type": "command", "command": "…" }`. |
| `records.retentionDays` | Retention for recordings and tool results, in days; 30 by default. Session transcripts are not aged out by this sweep. |
| `memory.enabled` | Mneme memory is on unless this is `false`. |
| `memory.directory` | A custom memory directory. Checked-in project settings cannot choose it. |
| `memory.pinnedLimit` | The pinned shelf's text limit in characters, at least 1000; 8000 by default. Every pinned rule still loads above the limit. |
| `workspace.worktree.symlinkDirectories` | Additional directories linked into a managed worktree. |
| `workspace.worktree.sparsePaths` | Paths included in a managed sparse worktree. |

Project conventions belong in `MERCURY.md` or the project's `AGENTS.md`.
A personal `MERCURY.local.md` loads after the guide. Memory records what was
learned across sessions; [MNEME.md](MNEME.md) describes its tools and shelf.

## Credentials, environment and attribution

| Key | What it sets |
| --- | --- |
| `credentials.keyCommand` | A shell command supplying an Anthropic API key. Project-scope helpers wait for workspace trust. |
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
| `events.hooks` | Hook events and their matchers; [HOOKS.md](HOOKS.md) defines them. |
| `events.disabled` | Disables every hook, including managed hooks. |
| `events.managedOnly` | Restricts hooks to managed policy. |
| `events.httpDestinations` | HTTP hook destinations allowed by policy. |
| `events.httpEnvironment` | Environment variables policy permits HTTP hooks to interpolate. |
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
| `activity.progress` | Terminal progress reporting. |
| `view.files` | Shows the files menu and its command. |
| `view.modelPicker.centred` | Centres the model picker; `false` places it at the left edge. |
| `view.syntaxOff` | Disables syntax colouring. |
| `view.reducedMotion` | Suppresses authored animation. |
| `view.backgroundKey` | Enables the key that backgrounds a running shell command. |
| `view.sessionsBar` | Shows the bottom SESSIONS bar; off unless enabled. |
| `view.firstRunCards` | First-run card placement: `centred` or `top-left`. |
| `view.ping` | Pings the terminal when a chat finishes while you are away; on unless `false`. |
| `context.wayBack` | Shows the way-back hint beside a notice. |
| `input.suggestions` | Enables prompt suggestions. |
| `apollo.preflightQuestions` | Apollo's interview budget, 1–20 questions, 7 by default. |

## Shell, patience and provider routing

| Key | What it sets |
| --- | --- |
| `shell.kind` | The default shell tool: `bash` or `powershell`. |
| `shell.engine` | `system` or the persistent `brush` engine. |
| `shell.sessions` | The live shell-engine session ceiling, 1–64, 8 by default; the main conversation owns one. |
| `turns.loopGuard` | Allows the loop guard to end a turn after a repeated cycle is detected twice; off by default. |
| `patience` | `normal`, `patient`, or the custom object below. |
| `routing.openrouter.dataCollection` | `deny` by default, or `allow`. |
| `routing.openrouter.requireParameters` | Requires support for every request parameter; `true` by default. |
| `routing.openrouter.allowFallbacks` | Permits OpenRouter provider fallback; `true` by default. |
| `routing.openrouter.zeroDataRetention` | Requires zero data retention; `false` by default. |

Custom patience uses `patience.streamIdleSeconds`,
`patience.quietStreamIdleSeconds`, `patience.fallbackCeilingSeconds` and
`patience.recoveryBudgetMinutes`. Normal values are 360 seconds for an idle
stream whose keep-alives are visible, 900 for a quiet stream, 900 for the
non-streamed fallback and 20 minutes for recovery. Patient doubles those
values. A custom object inherits normal values for omitted fields; a recovery
budget of zero means no budget. `MERCURY_STREAM_IDLE_TIMEOUT_MS`,
`MERCURY_API_TIMEOUT_MS` and `MERCURY_RECOVERY_BUDGET_MINUTES` take precedence.
These are connection-silence and recovery limits, not a clock on thinking.

## The local server

The values under `local.server` are the changes Mercury offers to make to
Ollama's launch configuration. They do not alter a running server until you
confirm the review and restart in `/config`.

| Key | What it sets |
| --- | --- |
| `local.server.maxLoadedModels` | Models kept loaded, 1–64. |
| `local.server.parallelSlots` | Concurrent requests per loaded model, 1–64. |
| `local.server.keepAlive` | A duration such as `30m`; `-1` keeps a model loaded, `0` unloads it at once. |
| `local.server.contextLength` | The window used when a request names none, 512–10485760 tokens. |

[LOCAL-SETUP.md](LOCAL-SETUP.md) covers choosing and starting a local model;
[ENGINES.md](ENGINES.md) covers window sizing and server memory checks.
