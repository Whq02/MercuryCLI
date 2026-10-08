#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const C = await import('../../src/utils/hooks/contract.ts')

const WIRE_EVENT_ORDER = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'UserPromptSubmit',
  'UserPromptExpansion', 'SessionStart', 'SessionEnd', 'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'PermissionRequest',
  'Setup', 'TaskCreated', 'TaskCompleted',
  'Elicitation', 'ElicitationResult', 'ConfigChange', 'WorktreeCreate', 'WorktreeRemove',
  'InstructionsLoaded', 'CwdChanged', 'FileChanged', 'Interrupt',
] as const

const base = { session_id: 's', transcript_path: '/t.jsonl', cwd: '/w' }

check('HOOK_EVENTS is the table\'s key list, in the wire order', JSON.stringify(C.HOOK_EVENTS) === JSON.stringify(WIRE_EVENT_ORDER), `got ${C.HOOK_EVENTS.length} names`)
check('hookEventTable has a row for every event', Object.keys(C.hookEventTable).length === WIRE_EVENT_ORDER.length)

const eventSpecificFields: Record<string, Record<string, unknown>> = {
  PreToolUse: { tool_name: 'Bash', tool_input: {} },
  PostToolUse: { tool_name: 'Bash', tool_input: {}, tool_response: {} },
  PostToolUseFailure: { tool_name: 'Bash', tool_input: {}, error: 'boom' },
  PermissionRequest: { tool_name: 'Bash', tool_input: {} },
  Notification: { message: 'hi' },
  UserPromptSubmit: { prompt: 'go' },
  UserPromptExpansion: { expansion_type: 'slash_command', prompt: 'expanded' },
  SessionStart: { source: 'startup' },
  SessionEnd: { reason: 'clear' },
  Stop: { stop_hook_active: false },
  StopFailure: { error: 'x' },
  SubagentStart: {},
  SubagentStop: { stop_hook_active: false },
  PreCompact: { trigger: 'manual', custom_instructions: null },
  PostCompact: { trigger: 'auto' },
  Setup: { trigger: 'init' },
  TaskCreated: { task_id: 't1' },
  TaskCompleted: { task_id: 't1' },
  Elicitation: { mcp_server_name: 'srv', message: 'm' },
  ElicitationResult: { mcp_server_name: 'srv', action: 'accept' },
  ConfigChange: { source: 'user_settings' },
  WorktreeCreate: { name: 'wt' },
  WorktreeRemove: { worktree_path: '/w' },
  InstructionsLoaded: { file_path: '/f', instruction_scope: 'User', load_reason: 'session_start' },
  CwdChanged: { new_cwd: '/n' },
  FileChanged: { file_path: '/f', event: 'change' },
  Interrupt: { turn_id: 't', reason: 'operator', tools: [] },
}

for (const event of WIRE_EVENT_ORDER) {
  const parsed = C.hookEventInputSchema(event)().safeParse({ ...base, hook_event_name: event, ...eventSpecificFields[event] })
  check(`the ${event} row's input schema parses its own event`, parsed.success, parsed.success ? '' : JSON.stringify((parsed as { error?: { issues: unknown[] } }).error?.issues?.[0]))
}

const outputSpecific: Record<string, Record<string, unknown>> = {
  PreToolUse: { permissionDecision: 'allow' },
  UserPromptSubmit: { additionalContext: 'c' },
  SessionStart: { watchPaths: ['/tmp'] },
  Setup: { additionalContext: 'c' },
  SubagentStart: { additionalContext: 'c' },
  PostToolUse: { updatedMCPToolOutput: {} },
  PostToolUseFailure: { additionalContext: 'c' },
  Notification: { additionalContext: 'c' },
  PermissionRequest: { decision: { behavior: 'allow' } },
  Elicitation: { action: 'accept', content: {} },
  ElicitationResult: { action: 'cancel' },
  WorktreeCreate: { worktreePath: '/wt' },
  CwdChanged: { watchPaths: [] },
  FileChanged: { watchPaths: [] },
}

const OUTPUT_UNION = [
  'PreToolUse', 'UserPromptSubmit', 'SessionStart', 'Setup', 'SubagentStart',
  'PostToolUse', 'PostToolUseFailure', 'Notification', 'PermissionRequest',
  'Elicitation', 'ElicitationResult', 'WorktreeCreate', 'CwdChanged', 'FileChanged',
] as const

for (const event of OUTPUT_UNION) {
  const parsed = C.SyncHookJSONOutputSchema().safeParse({ hookSpecificOutput: { hookEventName: event, ...outputSpecific[event] } })
  check(`the ${event} row's output schema parses inside the sync output`, parsed.success)
}

const sync = C.SyncHookJSONOutputSchema().safeParse({ decision: 'block', reason: 'r', continue: false, stopReason: 's', suppressOutput: true, systemMessage: 'm' })
check('the transport-wide fields of the sync output still parse', sync.success)

const asyncOk = C.HookJSONOutputSchema().safeParse({ async: true, asyncTimeout: 5 })
check('the async form still parses through the combined schema', asyncOk.success)

const matchExpectations: Array<[string, Record<string, unknown>, string | undefined]> = [
  ['PreToolUse', { tool_name: 'Bash' }, 'Bash'],
  ['PostToolUse', { tool_name: 'Read' }, 'Read'],
  ['SessionStart', { source: 'resume' }, 'resume'],
  ['ConfigChange', { source: 'skills' }, 'skills'],
  ['UserPromptExpansion', { command_name: 'review' }, 'review'],
  ['Setup', { trigger: 'maintenance' }, 'maintenance'],
  ['Notification', { notification_type: 'permission' }, 'permission'],
  ['SessionEnd', { reason: 'logout' }, 'logout'],
  ['Interrupt', { reason: 'cut' }, 'cut'],
  ['StopFailure', { error: 'x' }, 'x'],
  ['SubagentStop', { agent_type: 'crew' }, 'crew'],
  ['Elicitation', { mcp_server_name: 'srv' }, 'srv'],
  ['InstructionsLoaded', { load_reason: 'compact' }, 'compact'],
  ['FileChanged', { file_path: '/a/b/c.txt' }, 'c.txt'],
  ['FileChanged', { file_path: '/a/b/' }, 'b'],
  ['TaskCreated', {}, undefined],
  ['Stop', {}, undefined],
]

for (const [event, fields, expected] of matchExpectations) {
  const got = C.hookEventMatchQuery(event as never, { hook_event_name: event, ...fields } as never)
  check(`the ${event} row's match field answers ${JSON.stringify(expected)}`, got === expected, `got ${JSON.stringify(got)}`)
}

const matchingSource = readFileSync(join(import.meta.dir, '../../src/utils/hooks/matching.ts'), 'utf8')
check('matching reads the table for the match field (no per-event switch left)', !matchingSource.includes("case 'PreToolUse':"), matchingSource.includes('hookEventMatchQuery') ? '' : 'and calls hookEventMatchQuery')

check('the SessionEnd row carries the 1500ms shutdown timeout', C.hookEventTable.SessionEnd.timeoutMs === 1500, String(C.hookEventTable.SessionEnd.timeoutMs))
check('SessionStart and Setup refuse http hooks from the table', C.hookEventTable.SessionStart.noHttp === true && C.hookEventTable.Setup.noHttp === true)

if (failures > 0) {
  console.log(`❌ ${failures} HOOK EVENT TABLE CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ the hook event table is the one owner of the per-event facts')
