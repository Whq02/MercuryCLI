import type { SessionRow, ToolCallRow, ToolResultRow, OutcomeRow, TaskRow, CompactionRow } from '../../rows/vocabulary.js'
import { taskRow, type RowScope, type Unstamped } from '../../rows/project.js'
import type { HookExecutionEvent } from './hookEvents.js'
import type { HookEvent } from './contract.js'
import { runHookEvent } from './engine.js'

export type HookFactRow = Unstamped<SessionRow> | Unstamped<ToolCallRow> | Unstamped<ToolResultRow> | Unstamped<OutcomeRow> | Unstamped<TaskRow> | Unstamped<CompactionRow>
type Road = Parameters<typeof runHookEvent>[0]

export function hookFieldsFromRow(event: HookEvent, row: HookFactRow, fields: Record<string, unknown> = {}, call?: Unstamped<ToolCallRow>): Road['fields'] {
  const out: Record<string, unknown> = { ...fields }
  switch (row.type) {
    case 'session':
      if (event === 'SessionStart') { out.model = row.model; out.permission_mode = row.mode }
      break
    case 'tool_call':
      out.tool_name = row.tool
      out.tool_input = row.input
      out.tool_use_id = row.call_id
      break
    case 'tool_result':
      if (!call || call.call_id !== row.call_id) throw new Error('A hook tool result must carry its own tool call facts')
      out.tool_name = call.tool
      out.tool_input = call.input
      out.tool_use_id = call.call_id
      if (event === 'PostToolUse') out.tool_response = fields.tool_response ?? row.output
      if (event === 'PostToolUseFailure') { out.error = row.output; out.is_interrupt = row.status === 'aborted' }
      break
    case 'outcome':
      if (event === 'StopFailure') { out.error = row.error?.class ?? 'unknown'; out.error_details = row.error?.message }
      if (event === 'Stop' || event === 'SubagentStop') out.last_assistant_message = row.answer
      break
    case 'task':
      if (event === 'SubagentStart' || event === 'SubagentStop') { out.agent_id = row.task_id; out.agent_type = row.task_type ?? '' }
      break
    case 'compaction':
      out.trigger = row.trigger === 'overflow' ? 'auto' : row.trigger
      break
  }
  return out as Road['fields']
}

export async function* runHookEventFromRow({ event, row, session, call, fields, ...options }: Omit<Road, 'fields' | 'sessionId' | 'cwd'> & {
  row: HookFactRow
  session: Pick<SessionRow, 'session_id' | 'cwd'>
  call?: Unstamped<ToolCallRow>
  fields?: Record<string, unknown>
}): ReturnType<typeof runHookEvent> {
  if (row.session_id !== session.session_id || (call && call.session_id !== session.session_id)) throw new Error('A hook row must belong to its firing session')
  yield* runHookEvent({ ...options, event, fields: hookFieldsFromRow(event, row, fields, call), sessionId: session.session_id, cwd: session.cwd })
}

export function hookTaskRow(scope: RowScope, event: HookExecutionEvent): Unstamped<TaskRow> {
  return taskRow(scope, {
    state: event.type === 'started' ? 'started' : event.type === 'progress' ? 'progress' : 'ended',
    taskId: event.hookId,
    callId: scope.parent_call_id,
    taskType: 'hook',
    description: event.hookName,
    ...(event.type === 'started' ? {} : { summary: event.output }),
    ...(event.type === 'response' ? { status: event.outcome === 'success' ? 'completed' : event.outcome === 'cancelled' ? 'stopped' : 'failed' } : {}),
  })
}

export async function* runHookInput(options: Parameters<typeof import('./engine.js').executeHooks>[0]): ReturnType<typeof runHookEvent> {
  const { hookInput, ...run } = options
  const { hook_event_name: event, session_id, cwd, transcript_path, ...fields } = hookInput
  let facts: Road['fields'] = fields
  if ('tool_name' in hookInput && 'tool_input' in hookInput) {
    const call: Unstamped<ToolCallRow> = {
      type: 'tool_call', session_id, tool: hookInput.tool_name, input: hookInput.tool_input as Record<string, unknown>, call_id: 'tool_use_id' in hookInput ? hookInput.tool_use_id ?? run.toolUseID : run.toolUseID, message_id: run.toolUseID, block: 0,
    }
    const projected = hookFieldsFromRow(event, call, fields) as Record<string, unknown>
    if (!('tool_use_id' in hookInput)) delete projected.tool_use_id
    facts = projected as Road['fields']
  }
  yield* runHookEvent({ ...run, event, fields: facts, sessionId: session_id, cwd, transcriptPath: transcript_path })
}
