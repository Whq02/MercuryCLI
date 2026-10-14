# Settings

Mercury stores settings in JSON files, edited in `/config` or through
`/model`, `/effort`, `/permissions`, `/memory` and the MCPs & Skills menu.

This page lists the grouped keys you can set in `settings.json`. `/config`
also shows machine and session switches stored in the global config (such as
**DuckDuckGo page scraping**, on by default, and **Session concourse**). In
`/config`, typing any printable character (including `j` and `k`) filters the
rows immediately; arrow keys and `PageUp`/`PageDown` move the selection. The
header counts the rows whose saved value or file entry differs from Mercury's
default.

## Files and precedence

From lowest to highest priority:

1. `<config home>/settings.json`: your defaults across projects (`~/.mercury`
   unless `MERCURY_CONFIG_DIR` names another directory).
2. `<project>/.mercury/settings.json`: shared project settings.
3. `<project>/.mercury/settings.local.json`: your local settings for this project.
4. `--config <file-or-json>`: settings supplied to this launch.
5. Managed policy: administrator settings (`managed-settings.json` and
   platform-managed policy).

Objects merge by key and arrays combine with duplicate scalar entries kept
once; higher-priority scalars win. Running sessions reload edits to any of
these files (including a `.mercury/` folder created mid-session by a
permission card). `--config-layers user,local` selects which of the three
user-owned sources load while flag settings and managed policy remain active.

Mercury writes `$schema` pointing to `<config home>/schema/settings.schema.json`
for offline editor validation. Unknown keys or invalid values are reported in
`/health`'s Settings row, the chat settings notice, one chat line at the start
of the next turn (or `settings:` on `stderr` in `mercury run`), while valid
sibling keys still apply. An unparsable file is skipped at launch; if a file
becomes unparsable mid-session, the last valid settings stay in force until the
file parses again. Project-scoped commands require workspace trust
([TRUST.md](TRUST.md)); store credentials in `/logins` or a credential helper
instead of a shared project file.

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
| `engine.model` | The model id or family word saved by `/model`. Choose from the live catalogue; `--model` and `MERCURY_MODEL` override the saved default. When `<config home>/settings.json` cannot be written, `/model` names the file and the OS reason (`not saved as your default: ~/.mercury/settings.json …`). |
| `engine.effort` | `low`, `medium`, `high`, `xhigh` or `max`, saved by `/effort` or `ctrl+e` in `/model`. Each model uses the levels its provider supports; a failed write to `settings.json` names the file and the OS reason in the picker footer or receipt. |
| `engine.reasoning` | Whether thinking is requested on providers that read a toggle (Anthropic, Z.AI outside thinking-locked models, and OpenAI-compatible chat roads; GPT models use the effort dial). Models with always-on reasoning keep their own rule. |
| `engine.agent` | The agent definition used for the session (`--agent` selects one for a launch). |
| `engine.roster` | A list limiting which models can be selected. |
| `engine.pins` | An object mapping canonical Anthropic model ids to the ids your endpoint serves. |
| `engine.sessionDefaults` | Whether the Boot face and Session Concourse show the `m` model-default shortcut; on unless `false`. |
| `engine.usageNotice` | When `true`, sends a context notice to the model when the session's usage window or spending limit reaches 80% and 90%; off by default so only you see the meters. |

A resumed chat keeps its model and effort unless `--model` or `--effort` is
passed at launch. See [ENGINES.md](ENGINES.md) and [SESSIONS.md](SESSIONS.md).

## Permissions and the sandbox

| Key | What it sets |
| --- | --- |
| `guardrails.mode` | The saved posture: `default`, `dontAsk`, `implement`, `sovereign`, `flow` or `apollo`. Availability and consent still apply at entry. |
| `guardrails.allow` | Tool rules that allow a matching action without prompting. |
| `guardrails.ask` | Tool rules that require confirmation in a posture that asks. |
| `guardrails.deny` | Tool rules that refuse a matching action. A deny wins over an ask or allow. |
| `guardrails.reasons` | An object keyed by a rule's exact spelling, with the explanation shown on its refusal or consent card. |
| `guardrails.managedOnly` | When set by managed policy, restricts permission rules to that policy. |
| `guardrails.disableSovereignMode` | Closes Sovereign mode. |
| `guardrails.disableFlowMode` | Closes Flow. |
| `guardrails.sovereignConsentSeen` | Records acceptance of the Sovereign consent card (ignored in checked-in project settings). |

Rules use `Tool(pattern)`: `Bash(bun run typecheck)` matches one exact command,
`Bash(bun run *)` matches that prefix and its arguments, `Read(~/docs/**)`
matches a path glob, `WebFetch(domain:example.com)` matches a host, and a bare
tool name matches every call to that tool. `/permissions` lists active rules and
their sources.

Sandbox settings live under `guardrails.sandbox`:

| Key | What it sets |
| --- | --- |
| `guardrails.sandbox.enabled` | Turns OS sandboxing on. |
| `guardrails.sandbox.enabledPlatforms` | Platforms it runs on (`macos`, `linux`, `wsl`); absent means every supported platform. |
| `guardrails.sandbox.failIfUnavailable` | Refuses a run when the sandbox cannot be established. |
| `guardrails.sandbox.autoAllowBashIfSandboxed` | Allows sandboxed shell commands without a separate permission prompt. |
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

Use `/sandbox` and `/health` to verify platform sandbox support.

## Instructions, files and memory

| Key | What it sets |
| --- | --- |
| `briefs.profile` | `auto` loads a project's `AGENTS.md` when its instruction chain has no `MERCURY.md`; `native` loads Mercury instruction files only. A `MERCURY.local.md` is a personal layer loaded after the guide. |
| `briefs.exclude` | Instruction-file glob patterns or absolute paths to skip; managed instructions cannot be excluded. |
| `briefs.git` | Whether the model receives Mercury's git instructions. |
| `files.honourGitignore` | Whether file suggestions respect `.gitignore`. |
| `files.suggester` | A file-suggestion helper, shaped as `{ "type": "command", "command": "…" }`. |
| `records.retentionDays` | Retention for recordings and tool results, in days; 30 by default. Session transcripts are not aged out by this sweep. `0` turns transcript writing off: no new transcript is written and no lineage entry is written, and the ones already on disk stay. |
| `memory.enabled` | Mneme memory is on unless this is `false`. |
| `memory.directory` | A custom memory directory (ignored in checked-in project settings). |
| `memory.pinnedLimit` | The pinned shelf's text limit in characters, at least 1000; 8000 by default. Every pinned rule still loads above the limit. |
| `memory.startLimit` | Character allowance for `# Memory at start` beyond the pinned rules, at least 1000; 4000 by default (`/config` row **Memory at start, beyond the pins**). Pinned rules always load whole; this allowance packs the unpinned facts and earlier notes most relevant to the branch, recently touched files and last note. |
| `memory.embeddingModel` | Semantic embedding model for memory lookup and `# Memory at start` (`/config` row **Memory recall ranking**): a model name carried by this install (`bge-base-en-v1.5` by default) or the path to a `.gguf` file. If absent or unresolved, memory runs `word match only` and says so on the front page. |
| `memory.journal` | When `true` (off by default), enables the `Journal` tool so the model records a short session entry in `<config home>/projects/<project>/journal/journal.md`, outside the repository. |
| `memory.journalOnEntryPage` | When `true` (off by default), includes the last journal entry on the next session's `# Lineage` entry page (sent to the session's model provider with the prompt, never synced elsewhere by Mercury). |
| `memory.tellEngineSwitch` | When `true` (off by default), sends a meta line to the model on `/model` switches naming the new model id, the switch time with its time zone, and instructing it to include the zone when repeating the time. When `false`, the model learns its current model and switch history by reading `mercury://seat`. |
| `workspace.worktree.symlinkDirectories` | Additional directories linked into a managed worktree. |
| `workspace.worktree.sparsePaths` | Paths included in a managed sparse worktree. |
| `workspace.worktree.prepare` | A shell command run inside every new worktree after `git` creates it and before any agent uses it; failures are reported on the row. |

See [MNEME.md](MNEME.md) for memory tools and [COMPATIBILITY.md](COMPATIBILITY.md)
for instruction-file precedence.

## Credentials, environment and attribution

| Key | What it sets |
| --- | --- |
| `credentials.keyCommand` | A shell command supplying an Anthropic API key (project-scope helpers wait for workspace trust). |
| `credentials.signInRoute` | The required Anthropic sign-in route: `claudeai` or `console`. |
| `credentials.organisation` | The required organisation for Anthropic sign-in. |
| `environment.values` | Environment variable names and values for Mercury; string, number and boolean values become strings. |
| `credit.mercury` | Mercury's commit and pull-request attribution is on unless `false`. |
| `credit.lines.commit`, `credit.lines.pr` | Custom attribution text. An empty string omits that line; omitted members use their default and `credit.lines` takes precedence over `credit.mercury`. |

## MCP servers, hooks and extensions

MCP server definitions live in `.mercury/mcp.json` (`mercury mcp` manages them);
`kit` keys govern selection and policy.

| Key | What it sets |
| --- | --- |
| `kit.trustProjectServers` | Approves project-defined MCP servers without an individual approval card. |
| `kit.projectOn`, `kit.projectOff` | Project MCP server names approved or disabled in this settings source. |
| `kit.permit`, `kit.deny` | Server policy entries naming `serverName`, `serverCommand` (argument array) or `serverUrl`. Denies win. |
| `kit.managedOnly` | When set by managed policy, uses only that policy's server allowlist. |
| `events.hooks` | Hooks by event, one entry per hook with its own `match`; see [HOOKS.md](HOOKS.md). |
| `events.disabled` | Turns off every non-managed hook (or every hook when set in managed policy). |
| `events.managedOnly` | In managed policy, runs only managed hooks. |
| `extensions.enabled` | Extension ids and their enabled state. |
| `extensions.wanted` | Requested extensions, each with `name`, `source` and optional `ref`. |
| `extensions.blocked` | Extension ids or source labels on the blocklist. |
| `extensions.options` | Non-secret option values grouped by extension id and option name. |
| `extensions.exclusive` | A managed lock: `true` for every customization surface, or a list from `skills`, `agents`, `hooks`, `mcp`. |
| `channels.enabled` | Enables messages from approved MCP channels. |

See [KIT.md](KIT.md) and [EXTENSIONS.md](EXTENSIONS.md).

## Appearance and input

| Key | What it sets |
| --- | --- |
| `voice.language` | The language the model should use in its replies (distinct from the `/voice` transcriber model). |
| `activity.tips.enabled` | Whether activity tips are shown. |
| `activity.tips.words` | Custom tips (`tips` string list and `excludeDefault` boolean). |
| `activity.verbs` | Custom activity verbs (`verbs` string list and `mode` `append` or `replace`). |
| `activity.progress` | Terminal tab progress indicator while a turn runs (`true`, `false`, or unset for terminal auto-detection; `/config` row **Terminal progress bar**). |
| `view.files` | Shows the FILES box in the left rail. |
| `view.modelPicker.centred` | Centres the model picker; `false` places it at the left edge. |
| `view.syntaxOff` | Disables syntax colouring. |
| `view.reducedMotion` | Suppresses authored animation. |
| `view.backgroundKey` | Enables `⇧b` to background a running shell command. |
| `view.firstRunCards` | First-run card placement: `centred` or `top-left`. |
| `view.ping` | Pings the terminal when a chat finishes while you are away; on unless `false`. |
| `view.accountIdentity` | Shows signed-in account identifiers on screen; `false` hides e-mail addresses, usernames and key tails outside `/logins`, `/accounts` and `/health`. |
| `context.wayBack` | Shows the way-back hint beside a notice. |
| `input.suggestions` | Enables prompt suggestions. |
| `apollo.preflightQuestions` | Apollo's interview budget, 1–20 questions, 7 by default. |

## Shell, patience and provider routing

| Key | What it sets |
| --- | --- |
| `shell.kind` | The default shell tool: `bash` or `powershell`. |
| `shell.engine` | `system` or the persistent `brush` engine. |
| `shell.sessions` | Live shell-engine session ceiling, 1–64, 8 by default (the main conversation owns one). |
| `turns.loopGuard` | Allows the loop guard to end a turn after a repeated cycle is detected twice; off by default. |
| `patience` | `normal`, `patient`, or the custom object below. |
| `routing.openrouter.dataCollection` | `deny` by default, or `allow`. |
| `routing.openrouter.requireParameters` | Requires support for every request parameter; `true` by default. |
| `routing.openrouter.allowFallbacks` | Permits OpenRouter provider fallback; `true` by default. |
| `routing.openrouter.zeroDataRetention` | Requires zero data retention; `false` by default. |

Custom patience accepts `patience.streamIdleSeconds`,
`patience.quietStreamIdleSeconds`, `patience.fallbackCeilingSeconds` and
`patience.recoveryBudgetMinutes`. `normal` uses 360 seconds for a stream with
visible keep-alives, 900 for a quiet stream, 900 for non-streamed fallback and
20 minutes for recovery; `patient` doubles those values, and `0` for
`recoveryBudgetMinutes` disables the recovery cap. `MERCURY_STREAM_IDLE_TIMEOUT_MS`,
`MERCURY_API_TIMEOUT_MS` and `MERCURY_RECOVERY_BUDGET_MINUTES` override the file
values. These limits govern connection silence and recovery; model thinking
budgets remain separate.

## The local server

Values under `local.server` stage changes to Ollama's launch configuration,
applied only after you confirm the review and restart in `/config`.

| Key | What it sets |
| --- | --- |
| `local.server.maxLoadedModels` | Models kept loaded, 1–64. |
| `local.server.parallelSlots` | Concurrent requests per loaded model, 1–64. |
| `local.server.keepAlive` | A duration such as `30m`; `-1` keeps a model loaded, `0` unloads it at once. |
| `local.server.contextLength` | The window used when a request names none, 512–10485760 tokens. |

See [LOCAL-SETUP.md](LOCAL-SETUP.md) and [ENGINES.md](ENGINES.md).
