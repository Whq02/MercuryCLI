import { memoize } from 'lodash-es'

import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { HOOK_EVENTS } from '../../entrypoints/sdk/coreTypes.js'
import { getRegisteredHooks } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import {
  getAllHooks,
  sortMatchersByPriority,
  type HooksByEventAndMatcher,
  type IndividualHookConfig,
} from './hooksSettings.js'

/**
 * Per-event metadata (summary, payload/exit-code description, matcher
 * descriptor) and the two-level event → matcher grouping for the hooks UI.
 *
 * The exit-code convention the descriptions teach IS the dispatcher's
 * behaviour: 0 = success (stdout hidden, shown in transcript mode, or fed
 * onward depending on the event); 2 = blocking (stderr shown to the model,
 * the operation blocked or altered); any other non-zero = stderr shown to
 * the user only, execution continues.
 */

export type MatcherMetadata = {
  /** The payload field the matcher matches against. */
  field: string
  /** Candidate values, when the vocabulary is closed or derivable. */
  values?: string[]
}

export type HookEventMetadata = {
  summary: string
  description: string
  matcherMetadata?: MatcherMetadata
}

function buildHookEventMetadata(toolNames: string[]): Record<HookEvent, HookEventMetadata> {
  const exitCodes = 'Exit 0 succeeds; exit 2 blocks with stderr shown to the model; any other non-zero shows stderr to the user only and continues.'
  return {
    PreToolUse: {
      summary: 'Runs before every tool call',
      description: `Payload: the tool call's arguments. ${exitCodes} Exit 2 blocks the tool call.`,
      matcherMetadata: { field: 'tool_name', values: toolNames },
    },
    PostToolUse: {
      summary: 'Runs after a tool call succeeds',
      description: `Payload: the tool inputs and the tool response. Exit 0 output is shown in transcript mode; exit 2 shows stderr to the model immediately.`,
      matcherMetadata: { field: 'tool_name', values: toolNames },
    },
    PostToolUseFailure: {
      summary: 'Runs after a tool call fails',
      description: 'Payload: tool name, tool input, tool-use id, the error, the error type, and interrupt/timeout flags.',
      matcherMetadata: { field: 'tool_name', values: toolNames },
    },
    PermissionDenied: {
      summary: 'Runs after the auto-mode classifier denies a tool call',
      description:
        'Payload: tool name, tool input, tool-use id, and a reason. The structured output may carry a retry flag telling the model it may retry.',
      matcherMetadata: { field: 'tool_name', values: toolNames },
    },
    Notification: {
      summary: 'Runs when Mercury sends a notification',
      description: 'Payload: a message and a type.',
      matcherMetadata: {
        field: 'notification_type',
        values: [
          'permission_prompt',
          'idle_prompt',
          'auth_success',
          'elicitation_dialog',
          'elicitation_complete',
          'elicitation_response',
        ],
      },
    },
    UserPromptSubmit: {
      summary: 'Runs when the user submits a prompt',
      description: `${exitCodes} Exit 0 stdout is shown to Mercury; exit 2 blocks processing and erases the original prompt.`,
    },
    UserPromptExpansion: {
      summary: 'Runs when a slash command or MCP prompt expands',
      description:
        'Payload: the command name, arguments, source, and the original invocation. Exit 2 blocks the expansion.',
      matcherMetadata: { field: 'command_name' },
    },
    SessionStart: {
      summary: 'Runs when a session starts',
      description: 'Payload: the start source. Blocking errors are ignored; stdout is added as context.',
      matcherMetadata: { field: 'source', values: ['startup', 'resume', 'clear', 'compact'] },
    },
    SessionEnd: {
      summary: 'Runs when a session ends',
      description: 'Payload: the end reason.',
      matcherMetadata: { field: 'reason', values: ['clear', 'logout', 'prompt_input_exit', 'other'] },
    },
    Stop: {
      summary: 'Runs when the model finishes responding',
      description: `${exitCodes} Exit 2 shows stderr to the model and the conversation continues.`,
    },
    StopFailure: {
      summary: 'Runs instead of Stop when an API error ended the turn',
      description: 'Fire-and-forget: output and exit codes are ignored.',
      matcherMetadata: {
        field: 'error',
        values: [
          'rate_limit',
          'authentication_failed',
          'billing_error',
          'invalid_request',
          'server_error',
          'max_output_tokens',
          'unknown',
        ],
      },
    },
    SubagentStart: {
      summary: 'Runs when a subagent starts',
      description:
        'Payload: agent id and agent type. Stdout is shown to the subagent; blocking errors are ignored.',
      matcherMetadata: { field: 'agent_type' },
    },
    SubagentStop: {
      summary: 'Runs when a subagent finishes',
      description:
        "Payload: agent id, agent type, and the agent's transcript path. Exit 2 shows stderr to the subagent and keeps it running.",
      matcherMetadata: { field: 'agent_type' },
    },
    PreCompact: {
      summary: 'Runs before compaction',
      description:
        'Exit 0 stdout is appended as custom compaction instructions; exit 2 blocks compaction.',
      matcherMetadata: { field: 'trigger', values: ['manual', 'auto'] },
    },
    PostCompact: {
      summary: 'Runs after compaction',
      description: 'Payload: compaction details and the summary. Exit 0 stdout is shown to the user.',
      matcherMetadata: { field: 'trigger', values: ['manual', 'auto'] },
    },
    PermissionRequest: {
      summary: 'Runs when a permission dialog is displayed',
      description:
        'Payload: tool name, tool input, tool-use id. The structured output may carry an allow-or-deny decision, used when the exit code is 0.',
      matcherMetadata: { field: 'tool_name', values: toolNames },
    },
    Setup: {
      summary: 'Repo setup hooks',
      description:
        'Payload: a trigger of init or maintenance. Stdout is shown to Mercury; blocking errors are ignored.',
    },
    TeammateIdle: {
      summary: 'Runs when a teammate is about to go idle',
      description:
        'Payload: the teammate name and team name. Exit 2 shows stderr to the teammate and prevents it going idle.',
    },
    TaskCreated: {
      summary: 'Runs when a task is created',
      description:
        'Payload: task id, subject, description, teammate name, team name. Exit 2 shows stderr to the model and prevents the creation.',
    },
    TaskCompleted: {
      summary: 'Runs when a task is completed',
      description:
        'Payload: task id, subject, description, teammate name, team name. Exit 2 shows stderr to the model and prevents the completion.',
    },
    Elicitation: {
      summary: 'Runs when an MCP server requests user input',
      description:
        'Payload: the server name, message, and requested schema. The structured output carries an action of accept, decline, or cancel plus optional content; exit 2 denies.',
      matcherMetadata: { field: 'mcp_server_name' },
    },
    ElicitationResult: {
      summary: 'Runs after the user responds to an elicitation',
      description:
        'Payload: server name, action, content, mode, and elicitation id. The structured output may override the action and content; exit 2 blocks the response, turning the action into a decline.',
      matcherMetadata: { field: 'mcp_server_name' },
    },
    ConfigChange: {
      summary: 'Runs when configuration changes mid-session',
      description:
        'Payload: a source and a file path. Exit 2 blocks the change from being applied to the session.',
      matcherMetadata: {
        field: 'source',
        values: ['user_settings', 'project_settings', 'local_settings', 'policy_settings', 'skills'],
      },
    },
    WorktreeCreate: {
      summary: 'Creates an isolated worktree',
      description:
        'Payload: a suggested worktree slug. Stdout MUST be the absolute path of the created worktree directory; exit 0 means created.',
    },
    WorktreeRemove: {
      summary: 'Removes a worktree',
      description: 'Payload: the absolute worktree path.',
    },
    InstructionsLoaded: {
      summary: 'Runs when an instruction file is loaded',
      description:
        'Payload: the file path, memory type (User, Project, Local, Managed), load reason, optional matched glob patterns, an optional triggering file path, and an optional including-parent file path. Observability-only — blocking is not supported.',
      matcherMetadata: {
        field: 'load_reason',
        values: ['session_start', 'nested_traversal', 'path_glob_match', 'include', 'compact'],
      },
    },
    CwdChanged: {
      summary: 'Runs when the working directory changes',
      description:
        'Payload: the old and new working directories. MERCURY_ENV_FILE is set so the hook can write shell exports applied to subsequent shell commands; the structured output may carry absolute watch paths to register with the file watcher.',
    },
    FileChanged: {
      summary: 'Runs when a watched file changes',
      description:
        'Payload: the changed path and an event of change, add, or unlink. MERCURY_ENV_FILE is set. The matcher field names files to watch in the current directory, pipe-separated; the structured output may carry watch paths that dynamically update the watch list.',
      // Deliberately NO matcher descriptor: the UI groups every FileChanged
      // hook under the empty key even though the matcher string is exactly
      // what the file watcher parses into watch paths.
    },
  }
}

/** Memoised by the SORTED, joined tool-name list so per-render fresh arrays hit the cache. */
export const getHookEventMetadata = memoize(buildHookEventMetadata, (toolNames: string[]) =>
  [...toolNames].sort().join(','),
)

/**
 * The hooks UI grouping: a plain object keyed by event whose values are
 * plain objects keyed by matcher — EVERY hook event present as a key (an
 * empty object when it has no hooks). An event with no matcher descriptor
 * forces the empty-string key regardless of what a settings/session hook
 * declared. Registered extension hooks are folded in afterwards — only
 * matchers carrying an extension root (presence test); extension hooks use their
 * OWN matcher string as the key directly, with extensionName = the extension id.
 */
export function groupHooksByEventAndMatcher(
  appState: AppState,
  toolNames: string[],
): HooksByEventAndMatcher {
  const metadata = getHookEventMetadata(toolNames)
  const grouped = {} as HooksByEventAndMatcher
  for (const event of HOOK_EVENTS) {
    grouped[event] = {}
  }
  const pushRow = (row: IndividualHookConfig, key: string): void => {
    const byMatcher = grouped[row.event]
    if (!byMatcher) return
    const rows = byMatcher[key] ?? []
    rows.push(row)
    byMatcher[key] = rows
  }
  for (const row of getAllHooks(appState)) {
    // Settings/session rows: the empty-string forcing applies when the
    // event carries no matcher descriptor.
    const key = metadata[row.event]?.matcherMetadata ? (row.matcher ?? '') : ''
    pushRow(row, key)
  }

  const registered = getRegisteredHooks()
  if (registered) {
    for (const event of Object.keys(registered) as HookEvent[]) {
      for (const matcher of registered[event] ?? []) {
        // Extension branch on the PRESENCE of the extension-root member.
        if (!('extensionRoot' in matcher)) continue
        const extensionId = 'extensionId' in matcher ? matcher.extensionId : undefined
        for (const config of matcher.hooks ?? []) {
          pushRow(
            {
              event,
              config,
              matcher: matcher.matcher,
              source: 'extensionHook',
              ...(extensionId !== undefined ? { extensionName: extensionId as string } : {}),
            },
            // Extension hooks use their OWN matcher string as the key directly.
            matcher.matcher ?? '',
          )
        }
      }
    }
  }
  return grouped
}

export function getSortedMatchersForEvent(
  hooksByEventAndMatcher: HooksByEventAndMatcher,
  event: HookEvent,
): string[] {
  return sortMatchersByPriority(
    Object.keys(hooksByEventAndMatcher[event] ?? {}),
    hooksByEventAndMatcher,
    event,
  )
}

/** A null matcher maps to the empty-string key. */
export function getHooksForMatcher(
  hooksByEventAndMatcher: HooksByEventAndMatcher,
  event: HookEvent,
  matcher: string | null,
): IndividualHookConfig[] {
  return hooksByEventAndMatcher[event]?.[matcher ?? ''] ?? []
}

export function getMatcherMetadata(event: HookEvent, toolNames: string[]): MatcherMetadata | undefined {
  return getHookEventMetadata(toolNames)[event]?.matcherMetadata
}
