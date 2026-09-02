/**
 * Centralized tool-progress event types.
 *
 * Each running tool streams `ToolProgress<P>` envelopes (see `src/Tool.ts`)
 * whose `data` is one of the per-tool progress shapes below. They are wrapped by
 * `ProgressMessage<P>` (`src/types/message.ts`) once threaded into the
 * conversation, and rendered by each tool's `renderToolUseProgressMessage`
 * (e.g. `tools/BashTool/UI.tsx`, `tools/MCPTool/UI.tsx`).
 *
 * This module is the single source of truth so producers (the tools), consumers
 * (the UI renderers), and `Tool.ts` can all reference the shapes WITHOUT the
 * import cycle that would arise from importing them from the tool modules
 * directly. `Tool.ts` re-exports several of these for backwards compatibility.
 *
 * Every member of `ToolProgressData` carries a string-literal `type`
 * discriminant distinct from the hook channel's `'hook_progress'`
 * (`src/types/hooks.ts`), which is how `filterToolProgressMessages` in
 * `Tool.ts` separates tool progress from hook progress on the shared
 * `ProgressMessage` stream.
 */

import type { AgentId } from './ids.js'
import type { AssistantMessage, NormalizedUserMessage } from './message.js'

// ============================================================================
// Shell (BashTool / PowerShellTool)
// ============================================================================

/**
 * Streamed output snapshot from a running `BashTool` command. Emitted by
 * `BashTool.call`'s onProgress with the cumulative output, the elapsed time, and
 * the running line/byte counts; rendered by `ShellProgressMessage`
 * (`components/shell/ShellProgressMessage.tsx`).
 */
export type BashProgress = {
  type: 'bash_progress'
  /** Tail slice of output shown live (already size-bounded by the poller). */
  output: string
  /** Full accumulated output (stripped + line-counted by the renderer). */
  fullOutput: string
  /**
   * Required: the collapsed-group renderer
   * (`components/messages/CollapsedReadSearchContent.tsx`) compares + assigns
   * these to `number` without an undefined guard after narrowing on `type`.
   */
  elapsedTimeSeconds: number
  totalLines: number
  /** Optional — the shell generator yields it optionally. */
  totalBytes?: number
  /** Background-task id once the command is backgrounded. */
  taskId?: string
  timeoutMs?: number
  /** LIVENESS: the command's OWN deadline budget in ms — always the
   *  effective timeout (default or requested), where `timeoutMs` rides only
   *  a model-requested one (the result row's timeout note keys on that).
   *  The runner's ephemeral progress frame carries it to the daemon-hosted
   *  status row ("running a tool for 4m (its own timeout at 10m)"). */
  budgetMs?: number
}

/**
 * Streamed snapshot from a running `TestTool` runner-lane execution (
 * Family 3): one bounded line — live parsed pass/fail so far + elapsed.
 * Rendered by TestTool's renderToolUseProgressMessage.
 */
export type TestProgress = {
  type: 'test_progress'
  /** One bounded status line ('node-test · 12 passed · 1 failed · 8s'). */
  line: string
  elapsedTimeSeconds: number
}

/**
 * Streamed output snapshot from a running `PowerShellTool` command. Structurally
 * identical to {@link BashProgress} (both feed `ShellProgressMessage`), but with
 * its own discriminant so the two backends stay distinguishable on the wire.
 */
export type PowerShellProgress = {
  type: 'powershell_progress'
  output: string
  fullOutput: string
  elapsedTimeSeconds: number
  totalLines: number
  totalBytes: number
  taskId?: string
  timeoutMs?: number
  /** LIVENESS: the command's own deadline budget (see BashProgress). */
  budgetMs?: number
}

/**
 * The shell-progress payload shared across both shell backends. Bash-mode input
 * (`utils/processUserInput/processBashCommand.tsx`) and `BashModeProgress`
 * (`components/BashModeProgress.tsx`) accept this so the same progress UI drives
 * either `BashTool` or `PowerShellTool` — both emit a member of this union.
 */
export type ShellProgress = BashProgress | PowerShellProgress

// ============================================================================
// AgentTool / SkillTool (forked sub-agent message forwarding)
// ============================================================================

/**
 * A forwarded sub-agent message from a running `AgentTool` task. Each normalized
 * tool_use/tool_result block produced by the child agent is streamed up so the
 * parent renders live sub-agent activity (`tools/AgentTool/UI.tsx`, which
 * narrows on `message.type` === 'assistant' | 'user').
 */
export type AgentToolProgress = {
  type: 'agent_progress'
  /**
   * A single normalized child message — an assistant message (one tool_use
   * block) or a normalized user message (one tool_result block). Renderers feed
   * it straight into `MessageComponent`, whose `message` prop accepts exactly
   * `AssistantMessage | NormalizedUserMessage` (`components/Message.tsx`).
   */
  message: AssistantMessage | NormalizedUserMessage
  /** The dispatched prompt; only populated on the first progress event. */
  prompt: string
  agentId: AgentId
}

/**
 * A forwarded sub-agent message from a running `SkillTool` execution. Mirrors
 * {@link AgentToolProgress} (skills run as a forked agent) with its own
 * discriminant; rendered by `tools/SkillTool/UI.tsx`.
 */
export type SkillToolProgress = {
  type: 'skill_progress'
  message: AssistantMessage | NormalizedUserMessage
  /** The skill content used as the agent prompt. */
  prompt: string
  agentId: AgentId
}

// ============================================================================
// MCPTool
// ============================================================================

/**
 * Progress for an MCP tool call (`services/mcp/client.ts`). Emitted on tool
 * start/completion/failure, and (for servers that report it) as fine-grained
 * progress relayed from the MCP SDK's `onprogress`. The renderer
 * (`tools/MCPTool/UI.tsx`) reads `progress` / `total` / `progressMessage`
 * directly off the payload, so the variant-specific fields are optional on the
 * common shape rather than split into a strict discriminated union.
 */
export type MCPProgress = {
  type: 'mcp_progress'
  status: 'started' | 'completed' | 'failed' | 'progress'
  serverName: string
  toolName: string
  /** Wall-clock duration, set on the 'completed' / 'failed' events. */
  elapsedTimeMs?: number
  /** Current progress count (MCP SDK `Progress.progress`). */
  progress?: number
  /** Optional total for a ratio bar (MCP SDK `Progress.total`). */
  total?: number
  /** Optional human-readable status (MCP SDK `Progress.message`). */
  progressMessage?: string
}

// ============================================================================
// WebSearchTool
// ============================================================================

/**
 * Progress for a `WebSearchTool` call. A discriminated union narrowed on `type`
 * by `tools/WebSearchTool/UI.tsx`: `query_update` as each search query is parsed
 * from the model stream, then `search_results_received` once a
 * `web_search_tool_result` block arrives.
 */
export type WebSearchProgress =
  | {
      type: 'query_update'
      query: string
    }
  | {
      type: 'search_results_received'
      resultCount: number
      query: string
    }

// ============================================================================
// TaskOutputTool
// ============================================================================

/**
 * Progress for a blocking `TaskOutputTool` retrieval — emitted once while it
 * waits for the target background task to finish (`tools/TaskOutputTool`'s
 * renderer reads `taskDescription` / `taskType`).
 */
export type TaskOutputProgress = {
  type: 'waiting_for_task'
  taskDescription: string
  taskType: string
}

// ============================================================================
// REPLTool (ant-only)
// ============================================================================

/**
 * Progress for the internal REPL tool (`USER_TYPE === 'ant'` / repl-mode only).
 * The REPL runs inner tools; each emits a `repl_tool_call` event with the
 * inner tool's name + input so the collapsed-group renderer can surface a live
 * hint while the (virtual) child messages are still pending
 * (`components/messages/CollapsedReadSearchContent.tsx` narrows on
 * `type === 'repl_tool_call'` && `phase === 'start'`, then reads `toolInput` /
 * `toolName`). The tool module itself is require-loaded behind the gate.
 */
export type REPLToolProgress = {
  type: 'repl_tool_call'
  /** Lifecycle of the inner tool call. */
  phase: 'start' | 'end'
  /** Inner tool name (fallback hint). */
  toolName: string
  /** Inner tool input (cast to the inner tool's schema at the use site). */
  toolInput: unknown
}

// ============================================================================
// Workflow (SDK task_progress)
// ============================================================================

/**
 * A workflow state-change delta carried on the SDK `task_progress` event
 * (`utils/task/sdkProgress.ts` → `utils/sdkEventQueue.ts`). Structurally mirrors
 * `WorkflowProgressEvent` (`tasks/LocalWorkflowTask/LocalWorkflowTask.tsx`);
 * declared here to keep `types/tools.ts` a leaf module free of the workflow
 * task's import graph. Clients upsert by `${type}:${index}` then group by phase.
 */
export type SdkWorkflowProgress =
  | { type: 'workflow_log'; message: string }
  | {
      type: 'workflow_phase'
      /** Coalesce key (last-write-wins); doubles as array position. */
      index: number
      title: string
      kind?: 'phase' | 'child'
    }
  | {
      type: 'workflow_agent'
      /** Coalesce key (last-write-wins) AND the agent's array position. */
      index: number
      label: string
      /** 'stopped' = parent settled mid-flight; 'skipped' = operator skip. */
      state: 'start' | 'progress' | 'done' | 'error' | 'stopped' | 'skipped'
      phaseIndex?: number
      phaseTitle?: string
      tokens?: number
      toolCalls?: number
      durationMs?: number
      error?: string
      cached?: boolean
      [k: string]: unknown
    }

// ============================================================================
// Union
// ============================================================================


// ============================================================================
// EvalTool
// ============================================================================

/**
 * Progress from a running eval cell (`tools/EvalTool`). Two kinds share the
 * discriminant: a throttled live output tail while the kernel streams, and a
 * forwarded NESTED event (a bridge re-entered tool call's tool_use/result
 * pair) rendered like agent progress by `tools/EvalTool/UI.tsx`.
 */
export type EvalToolProgress =
  | {
      type: 'eval_progress'
      kind: 'output'
      stream: 'stdout' | 'stderr'
      /** Bounded rolling tail (not cumulative). */
      tail: string
      language: string
      title?: string
    }
  | {
      type: 'eval_progress'
      kind: 'nested'
      message: AssistantMessage | NormalizedUserMessage
    }

/**
 * The discriminated union of every tool-progress payload. Used as the generic
 * bound `P extends ToolProgressData` on `Tool` / `ToolDef` / `ToolProgress` /
 * `ToolCallProgress` in `src/Tool.ts`, and as the default `P` so tools that omit
 * an explicit progress type still emit a member of this union. Every member has
 * a `type` discriminant that is never `'hook_progress'`.
 */
export type ToolProgressData =
  | BashProgress
  | PowerShellProgress
  | TestProgress
  | AgentToolProgress
  | SkillToolProgress
  | MCPProgress
  | WebSearchProgress
  | TaskOutputProgress
  | REPLToolProgress
  | EvalToolProgress
