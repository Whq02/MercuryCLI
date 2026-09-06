# Hooks

A hook is something Mercury runs at a named moment of a session: a shell
command, a prompt a model answers, an agent that checks something, or an
HTTP endpoint that receives the moment's facts. Hooks live in settings files
(user, project, local and managed policy) under the `hooks` key; a skill or
an extension can declare its own in its frontmatter or manifest, and
`/hooks` browses every hook the session carries.

## Declaring hooks

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "./scripts/check-command.sh" }]
      }
    ]
  }
}
```

Each event names a list of entries. An entry has an optional `matcher` and
the `hooks` it runs:

- `matcher` is matched against the event's tool name on the tool events
  (PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest,
  PermissionDenied). An absent or empty matcher, or `*`, matches everything;
  a plain name matches that tool, `Read|Edit` matches either; anything else
  is a regular expression. An entry whose matcher is not a valid regular
  expression is refused whole, so a broken matcher never widens into a
  match-everything hook.
- `hooks` is the list of hooks to run when the matcher matches.

### The four kinds

Every hook has a `type`:

- `command` runs `command` in a shell (`shell` picks `bash`, the default, or
  `powershell`). `async: true` runs it in the background without blocking;
  `asyncRewake: true` also wakes the model when the hook exits with the
  blocking status.
- `prompt` has a model answer `prompt`; `$ARGUMENTS` in the prompt receives
  the hook input JSON. `model` picks the model (default: the small fast
  model).
- `agent` has an agent verify `prompt`; `$ARGUMENTS` receives the hook
  input JSON, the timeout defaults to 60 seconds, and `model` never runs the
  smallest model.
- `http` posts the hook input JSON to `url`. `headers` may reference
  environment variables as `$VAR` or `${VAR}`, but only the names listed in
  `allowedEnvVars` are interpolated; every other reference resolves to an
  empty string.

Every kind also accepts `if` (a condition in permission-rule syntax such as
`Bash(git *)`, evaluated against the tool events' input; a hook whose
condition does not match is skipped, never spawned), `timeout` (seconds),
`statusMessage` (shown in the spinner while the hook runs) and `once` (run
once, then removed).

## Events

Every hook input carries `hook_event_name`, `session_id`, `transcript_path`,
`cwd` and `permission_mode`. The event adds its own fields:

| Event | Fires | Fields |
| --- | --- | --- |
| `PreToolUse` | before a tool call runs | `tool_name`, `tool_input`, `tool_use_id` |
| `PostToolUse` | after a tool call succeeds | `tool_name`, `tool_input`, `tool_response`, `tool_use_id` |
| `PostToolUseFailure` | after a tool call fails | `tool_name`, `tool_input`, `tool_use_id`, `error`, `is_interrupt` |
| `PermissionRequest` | when a tool call needs the operator's consent | `tool_name`, `tool_input`, `permission_suggestions` |
| `PermissionDenied` | when a tool call was refused | `tool_name`, `tool_input`, `tool_use_id`, `reason` |
| `Notification` | when Mercury notifies the operator | `message`, `title`, `notification_type` |
| `UserPromptSubmit` | when the operator sends a prompt | `prompt` |
| `UserPromptExpansion` | when a slash command expands into a prompt | `expansion_type`, `command_name`, `command_args`, `command_source`, `prompt` |
| `SessionStart` | when a session starts or resumes | `source`, `agent_type`, `model` |
| `SessionEnd` | when a session ends | `reason` |
| `Setup` | when Mercury is started with `--init`, `--init-only` or `--maintenance` | `trigger` (`init` or `maintenance`) |
| `Stop` | when the model ends its turn | `stop_hook_active`, `last_assistant_message` |
| `StopFailure` | when a turn ends in an error | `error`, `error_details`, `last_assistant_message` |
| `SubagentStart` | when a sub-agent starts | `agent_id`, `agent_type` |
| `SubagentStop` | when a sub-agent ends its turn | `stop_hook_active`, `agent_id`, `agent_transcript_path`, `agent_type`, `last_assistant_message` |
| `PreCompact` | before a compaction | `trigger`, `custom_instructions` |
| `PostCompact` | after a compaction | `trigger`, `compact_summary` |
| `TeammateIdle` | when a teammate goes idle | `teammate_name`, `team_name` |
| `TaskCreated` | when a task is created | `task_id`, `task_subject`, `task_description`, `teammate_name`, `team_name` |
| `TaskCompleted` | when a task completes | the same fields as `TaskCreated` |
| `Elicitation` | when an MCP server asks the operator something | `mcp_server_name`, `message`, `mode`, `url`, `elicitation_id` |
| `ElicitationResult` | when that question is answered | `mcp_server_name`, `elicitation_id`, `mode`, `action`, `content` |
| `ConfigChange` | when a settings file changes | `source`, `file_path` |
| `WorktreeCreate` | when a worktree is provisioned | `name` |
| `WorktreeRemove` | when a worktree is removed | `worktree_path` |
| `InstructionsLoaded` | when an instruction file is loaded | `file_path`, `memory_type`, `load_reason`, `globs`, `trigger_file_path` |
| `CwdChanged` | when the working directory changes | `old_cwd`, `new_cwd` |
| `FileChanged` | when a watched file changes | `file_path`, `event` |

## What a hook answers

A `command` hook answers with its exit code and its stdout:

- exit code 0: success; stdout is the answer, either plain text (shown as the
  hook's output) or one JSON object (read as below);
- exit code 2: the event is blocked, and stderr is the reason the model sees;
- any other exit code: a non-blocking error, reported to the operator.

The JSON answer may carry `continue` (false stops the whole turn, with
`stopReason` shown to the operator), `suppressOutput` (keep stdout out of
the transcript), `systemMessage` (a message shown to the operator),
`decision: "block"` with `reason` (block the event; on PreToolUse the
permission answer is the event-specific one below, never this field), and
`hookSpecificOutput` with `hookEventName` set to the event that ran:

- `PreToolUse`: `permissionDecision` (`allow`, `deny` or `ask`),
  `permissionDecisionReason`, `updatedInput` (the input the tool runs with),
  `additionalContext`.
- `PermissionRequest`: `decision` with `behavior: "allow"` (optionally
  `updatedInput`, `updatedPermissions`) or `behavior: "deny"` (optionally
  `message`, `interrupt`).
- `PermissionDenied`: `retry`.
- `UserPromptSubmit`, `Notification`, `SubagentStart`, `Setup`,
  `PostToolUseFailure`: `additionalContext`.
- `SessionStart`: `additionalContext`, `initialUserMessage`, `watchPaths`.
- `PostToolUse`: `additionalContext`, `updatedMCPToolOutput`.
- `Elicitation`, `ElicitationResult`: `action` (`accept`, `decline` or
  `cancel`), `content`.
- `CwdChanged`, `FileChanged`: `watchPaths`.
- `WorktreeCreate`: `worktreePath` (the path the hook provisioned).

A `hookSpecificOutput` whose `hookEventName` is not the event that ran is a
loud error, never a silent merge. Prompt, agent and HTTP hooks answer with
the same JSON object.

## Policy

Managed policy settings can tighten the hook surface: `disableAllHooks`
disables every hook, managed ones included, and `allowManagedHooksOnly`
restricts execution to the hooks the policy settings define. The trust gate
that keeps a project's hooks from running before the workspace is trusted is
in [TRUST.md](TRUST.md).
