#!/usr/bin/env bun
const { entryToRecord } = await import('../../src/fabric/entryCodec.js')
const { BODY_SHAPE_KINDS, bodyShapeIssue, validateRecord } = await import('../../src/fabric/validate.js')
const { decodeTranscriptBuffer } = await import('../../src/fabric/transcriptDecode.js')
const { ordinalOf } = await import('../../src/fabric/ordinal.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${t}`)
}

const ctx = () => {
  let n = 0
  return {
    sessionId: '00000000-aaaa-4000-8000-000000000001' as never,
    nextOrdinal: () => ordinalOf(++n) as never,
    observedAt: '2026-08-03T00:00:00.000Z',
    source: { channel: 'sdk' } as const,
  }
}
let uuidN = 0
const uuid = (): string => `00000000-bbbb-4000-8000-${String(++uuidN).padStart(12, '0')}`
const attachmentLine = (type: string, fields: Record<string, unknown>): string =>
  JSON.stringify(entryToRecord({ type: 'attachment', uuid: uuid(), timestamp: '2026-08-01T10:00:00.000Z', attachment: { type, ...fields } } as never, ctx() as never))
const noticeLine = (subtype: string, fields: Record<string, unknown>): string =>
  JSON.stringify(entryToRecord({ type: 'system', subtype, uuid: uuid(), timestamp: '2026-08-01T10:00:00.000Z', ...fields } as never, ctx() as never))
type Decoded = { entries: unknown[]; invalid: Array<{ index: number; kind: string; reason: string }>; malformed: unknown[]; totalLines: number }
const decode = (lines: string[]): Decoded => decodeTranscriptBuffer<unknown>(lines.join('\n') + '\n') as Decoded

type Fixture = { good: Record<string, unknown>; bad: Array<{ label: string; field: string; fields: Record<string, unknown> }> }

const ATTACHMENTS: Record<string, Fixture> = {
  task_reminder: {
    good: { content: [{ id: '1', status: 'pending', subject: 's' }], itemCount: 1 },
    bad: [
      { label: 'content is a number', field: 'content', fields: { content: 5, itemCount: 1 } },
      { label: 'content holds a null row', field: 'content', fields: { content: [null], itemCount: 1 } },
    ],
  },
  diagnostics: {
    good: { files: [{ uri: 'file:///a.ts', diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'm', severity: 1 }] }], isNew: true },
    bad: [
      { label: 'the file list is missing', field: 'files', fields: { isNew: true } },
      { label: 'a file without its diagnostics list', field: 'diagnostics', fields: { files: [{ uri: 'file:///a.ts' }], isNew: true } },
      { label: 'a diagnostic without its range', field: 'range', fields: { files: [{ uri: 'file:///a.ts', diagnostics: [{ message: 'm' }] }], isNew: true } },
    ],
  },
  invoked_skills: { good: { skills: [{ name: 'n', path: 'p', content: 'c' }] }, bad: [{ label: 'skills is text', field: 'skills', fields: { skills: 'n' } }] },
  relevant_memories: { good: { memories: [{ path: 'p', content: 'c', mtimeMs: 1 }] }, bad: [{ label: 'memories is null', field: 'memories', fields: { memories: null } }] },
  nested_memory: { good: { content: { path: 'p', content: 'c' } }, bad: [{ label: 'content is text', field: 'content', fields: { content: 'c' } }] },
  selected_lines_in_ide: {
    good: { ideName: 'x', lineStart: 1, lineEnd: 2, filename: 'f', content: 'text', displayPath: 'f' },
    bad: [{ label: 'content is a list', field: 'content', fields: { ideName: 'x', lineStart: 1, lineEnd: 2, filename: 'f', content: ['t'], displayPath: 'f' } }],
  },
  queued_command: {
    good: { prompt: 'hello' },
    bad: [
      { label: 'a block list holding a null block', field: 'prompt', fields: { prompt: [null] } },
      { label: 'prompt is a bare object', field: 'prompt', fields: { prompt: { text: 'x' } } },
    ],
  },
  teammate_mailbox: {
    good: { messages: [{ from: 'a', text: 't', timestamp: 'now' }] },
    bad: [
      { label: 'messages is text', field: 'messages', fields: { messages: 't' } },
      { label: 'a message without its text', field: 'text', fields: { messages: [{ from: 'a' }] } },
    ],
  },
  agent_roster: {
    good: { rows: [{ taskType: 'local_agent', name: 'n', taskId: 'i', status: 'running', address: null, agents: [{ label: 'l', state: 's' }] }] },
    bad: [
      { label: 'rows is text', field: 'rows', fields: { rows: 'r' } },
      { label: 'a row whose agents is text', field: 'agents', fields: { rows: [{ taskType: 't', name: 'n', taskId: 'i', status: 's', address: null, agents: 'x' }] } },
    ],
  },
  hook_additional_context: {
    good: { content: ['ctx'], hookName: 'h', toolUseID: 't', hookEvent: 'PostToolUse' },
    bad: [{ label: 'content is text', field: 'content', fields: { content: 'ctx', hookName: 'h', toolUseID: 't', hookEvent: 'PostToolUse' } }],
  },
  hook_blocking_error: {
    good: { hookName: 'h', blockingError: { command: 'c', blockingError: 'e' }, toolUseID: 't', hookEvent: 'PreToolUse' },
    bad: [{ label: 'blockingError is text', field: 'blockingError', fields: { hookName: 'h', blockingError: 'e', toolUseID: 't', hookEvent: 'PreToolUse' } }],
  },
  deferred_tools_delta: {
    good: { addedNames: [], addedLines: ['a'], removedNames: [], body: 'b' },
    bad: [
      { label: 'addedLines is text', field: 'addedLines', fields: { addedNames: [], addedLines: 'a', removedNames: [] } },
      { label: 'removedNames is a number', field: 'removedNames', fields: { addedNames: [], addedLines: [], removedNames: 5 } },
      { label: 'addedNames carries a number', field: 'addedNames', fields: { addedNames: [7], addedLines: [], removedNames: [] } },
      { label: 'body is an object', field: 'body', fields: { addedNames: [], addedLines: [], removedNames: [], body: {} } },
    ],
  },
  held_tools: {
    good: { names: ['Read'], body: 'b' },
    bad: [
      { label: 'names is text', field: 'names', fields: { names: 'Read', body: 'b' } },
      { label: 'body is missing', field: 'body', fields: { names: ['Read'] } },
    ],
  },
  agent_listing_delta: {
    good: { addedTypes: [], addedLines: ['a'], removedTypes: [], isInitial: true, showConcurrencyNote: false },
    bad: [{ label: 'removedTypes is null', field: 'removedTypes', fields: { addedTypes: [], addedLines: [], removedTypes: null, isInitial: true, showConcurrencyNote: false } }],
  },
  mcp_instructions_delta: {
    good: { addedNames: [], addedBlocks: ['b'], removedNames: [] },
    bad: [{ label: 'addedBlocks is an object', field: 'addedBlocks', fields: { addedNames: [], addedBlocks: {}, removedNames: [] } }],
  },
  harness_map_delta: { good: { added: ['a'], removed: [] }, bad: [{ label: 'added is text', field: 'added', fields: { added: 'a', removed: [] } }] },
  file: {
    good: { filename: 'a.ts', content: { type: 'text', file: { filePath: 'a.ts', content: 'x', numLines: 1, startLine: 1, totalLines: 1 } }, displayPath: 'a.ts' },
    bad: [
      { label: 'content is text', field: 'content', fields: { filename: 'a.ts', content: 'x', displayPath: 'a.ts' } },
      { label: 'filename is missing', field: 'filename', fields: { content: { type: 'text', file: {} }, displayPath: 'a.ts' } },
    ],
  },
  compact_file_reference: { good: { filename: 'a.ts', displayPath: 'a.ts' }, bad: [{ label: 'displayPath is a number', field: 'displayPath', fields: { filename: 'a.ts', displayPath: 5 } }] },
  pdf_reference: { good: { filename: 'a.pdf', pageCount: 2, fileSize: 10, displayPath: 'a.pdf' }, bad: [{ label: 'pageCount is text', field: 'pageCount', fields: { filename: 'a.pdf', pageCount: '2', fileSize: 10, displayPath: 'a.pdf' } }] },
  already_read_file: {
    good: { filename: 'a.ts', content: { type: 'text', file: { filePath: 'a.ts', content: 'x', numLines: 1, startLine: 1, totalLines: 1 } }, displayPath: 'a.ts' },
    bad: [{ label: 'content is a list', field: 'content', fields: { filename: 'a.ts', content: ['x'], displayPath: 'a.ts' } }],
  },
  edited_text_file: { good: { filename: 'a.ts', snippet: 's' }, bad: [{ label: 'snippet is missing', field: 'snippet', fields: { filename: 'a.ts' } }] },
  edited_image_file: { good: { filename: 'a.png', content: { type: 'image', file: { base64: '', type: 'image/png', originalSize: 1 } } }, bad: [{ label: 'content is text', field: 'content', fields: { filename: 'a.png', content: 'x' } }] },
  directory: { good: { path: 'd', content: '- a.ts', displayPath: 'd' }, bad: [{ label: 'content is a list', field: 'content', fields: { path: 'd', content: ['a.ts'], displayPath: 'd' } }] },
  opened_file_in_ide: { good: { filename: 'a.ts' }, bad: [{ label: 'filename is a number', field: 'filename', fields: { filename: 5 } }] },
  contract_reminder: { good: { text: 't', status: 'draft', amendments: 0, ackOwed: true }, bad: [{ label: 'amendments is text', field: 'amendments', fields: { text: 't', status: 'draft', amendments: 'none', ackOwed: true } }] },
  dynamic_skill: { good: { skillDir: 'd', skillNames: ['s'], displayPath: 'd' }, bad: [{ label: 'skillNames is text', field: 'skillNames', fields: { skillDir: 'd', skillNames: 's', displayPath: 'd' } }] },
  skill_listing: {
    good: { content: 'c', skillCount: 1, isInitial: true, removedNames: [], truncation: null },
    bad: [
      { label: 'content is a list', field: 'content', fields: { content: ['c'], skillCount: 1, isInitial: true } },
      { label: 'removedNames is text', field: 'removedNames', fields: { content: 'c', skillCount: 1, isInitial: true, removedNames: 'n' } },
    ],
  },
  skill_discovery: { good: { skills: [{ name: 'n', description: 'd' }], signal: { kind: 'k' }, source: 'native' }, bad: [{ label: 'skills is text', field: 'skills', fields: { skills: 'n', signal: null, source: 'native' } }] },
  plan_mode: { good: { reminderType: 'full', planFilePath: 'p.md', planExists: false }, bad: [{ label: 'planExists is text', field: 'planExists', fields: { reminderType: 'full', planFilePath: 'p.md', planExists: 'no' } }] },
  plan_mode_reentry: { good: { planFilePath: 'p.md' }, bad: [{ label: 'planFilePath is missing', field: 'planFilePath', fields: {} }] },
  plan_mode_exit: { good: { planFilePath: 'p.md', planExists: true }, bad: [{ label: 'planFilePath is a number', field: 'planFilePath', fields: { planFilePath: 5, planExists: true } }] },
  auto_mode: { good: { reminderType: 'sparse' }, bad: [{ label: 'reminderType is a number', field: 'reminderType', fields: { reminderType: 1 } }] },
  auto_mode_exit: { good: {}, bad: [] },
  mode_pack: { good: { mode: 'apollo', text: 't' }, bad: [{ label: 'text is a list', field: 'text', fields: { mode: 'apollo', text: ['t'] } }] },
  mode_pack_exit: { good: { mode: 'autopilot', reason: 'r' }, bad: [{ label: 'mode is missing', field: 'mode', fields: { reason: 'r' } }] },
  repo_surface_map: { good: { markdown: '# m' }, bad: [{ label: 'markdown is an object', field: 'markdown', fields: { markdown: {} } }] },
  context_capsule: {
    good: { markdown: '# c', digest: 'd', semDigest: 's', refs: ['src/a.ts'], delta: null },
    bad: [
      { label: 'refs is text', field: 'refs', fields: { markdown: '# c', digest: 'd', refs: 'src/a.ts', delta: null } },
      { label: 'delta is a number', field: 'delta', fields: { markdown: '# c', digest: 'd', refs: [], delta: 5 } },
    ],
  },
  ultra_effort: { good: { reminderType: 'full' }, bad: [{ label: 'reminderType is null', field: 'reminderType', fields: { reminderType: null } }] },
  ultra_effort_exit: { good: {}, bad: [] },
  supercode_keyword: { good: {}, bad: [] },
  critical_system_reminder: { good: { content: 'c' }, bad: [{ label: 'content is a list', field: 'content', fields: { content: ['c'] } }] },
  taste_recall: { good: { content: 'c' }, bad: [{ label: 'content is missing', field: 'content', fields: {} }] },
  plan_file_reference: { good: { planFilePath: 'p.md', planContent: '# p' }, bad: [{ label: 'planContent is an object', field: 'planContent', fields: { planFilePath: 'p.md', planContent: {} } }] },
  mcp_resource: { good: { server: 's', uri: 'u', name: 'n', content: { contents: [] } }, bad: [{ label: 'content is text', field: 'content', fields: { server: 's', uri: 'u', name: 'n', content: 'c' } }] },
  command_permissions: { good: { allowedTools: ['Bash(ls:*)'] }, bad: [{ label: 'allowedTools carries a number', field: 'allowedTools', fields: { allowedTools: [1] } }] },
  agent_mention: { good: { agentType: 'scout' }, bad: [{ label: 'agentType is missing', field: 'agentType', fields: {} }] },
  task_status: {
    good: { taskId: 'i', taskType: 'local_agent', status: 'completed', description: 'd', deltaSummary: null },
    bad: [{ label: 'deltaSummary is a list', field: 'deltaSummary', fields: { taskId: 'i', taskType: 'local_agent', status: 'completed', description: 'd', deltaSummary: ['s'] } }],
  },
  async_hook_response: {
    good: { processId: 'p', hookName: 'h', hookEvent: 'PostToolUse', response: { continue: true }, stdout: '', stderr: '' },
    bad: [{ label: 'response is text', field: 'response', fields: { processId: 'p', hookName: 'h', hookEvent: 'PostToolUse', response: 'ok', stdout: '', stderr: '' } }],
  },
  token_usage: { good: { used: 1, total: 2, remaining: 1 }, bad: [{ label: 'remaining is text', field: 'remaining', fields: { used: 1, total: 2, remaining: '1' } }] },
  budget_usd: { good: { used: 0.5, total: 1, remaining: 0.5 }, bad: [{ label: 'total is null', field: 'total', fields: { used: 0.5, total: null, remaining: 0.5 } }] },
  output_token_usage: { good: { turn: 1, session: 2, budget: null }, bad: [{ label: 'budget is text', field: 'budget', fields: { turn: 1, session: 2, budget: 'many' } }] },
  usage_limit_notice: { good: { key: 'k', provider: 'p', window: 'w', pct: 80, text: 't' }, bad: [{ label: 'pct is text', field: 'pct', fields: { key: 'k', provider: 'p', window: 'w', pct: '80', text: 't' } }] },
  structured_output: { good: { data: { ok: true } }, bad: [] },
  team_context: {
    good: { agentId: 'a', agentName: 'n', teamName: 't', teamConfigPath: 'c', taskListPath: 'l' },
    bad: [{ label: 'taskListPath is missing', field: 'taskListPath', fields: { agentId: 'a', agentName: 'n', teamName: 't', teamConfigPath: 'c' } }],
  },
  hook_cancelled: { good: { hookName: 'h', toolUseID: 't', hookEvent: 'PreToolUse' }, bad: [{ label: 'hookName is a number', field: 'hookName', fields: { hookName: 1, toolUseID: 't', hookEvent: 'PreToolUse' } }] },
  hook_non_blocking_error: {
    good: { hookName: 'h', stderr: 'e', stdout: '', exitCode: 1, toolUseID: 't', hookEvent: 'PostToolUse' },
    bad: [{ label: 'exitCode is text', field: 'exitCode', fields: { hookName: 'h', stderr: 'e', stdout: '', exitCode: '1', toolUseID: 't', hookEvent: 'PostToolUse' } }],
  },
  hook_error_during_execution: {
    good: { content: 'c', hookName: 'h', toolUseID: 't', hookEvent: 'PreToolUse' },
    bad: [{ label: 'content is a list', field: 'content', fields: { content: ['c'], hookName: 'h', toolUseID: 't', hookEvent: 'PreToolUse' } }],
  },
  hook_stopped_continuation: {
    good: { message: 'm', hookName: 'h', toolUseID: 't', hookEvent: 'Stop' },
    bad: [{ label: 'message is a list', field: 'message', fields: { message: ['m'], hookName: 'h', toolUseID: 't', hookEvent: 'Stop' } }],
  },
  hook_success: { good: { content: '', hookName: 'h', toolUseID: 't', hookEvent: 'SessionStart' }, bad: [{ label: 'content is null', field: 'content', fields: { content: null, hookName: 'h', toolUseID: 't', hookEvent: 'SessionStart' } }] },
  hook_system_message: { good: { content: 'c', hookName: 'h', toolUseID: 't', hookEvent: 'PreToolUse' }, bad: [{ label: 'toolUseID is missing', field: 'toolUseID', fields: { content: 'c', hookName: 'h', hookEvent: 'PreToolUse' } }] },
  hook_permission_decision: { good: { decision: 'allow', toolUseID: 't', hookEvent: 'PermissionRequest' }, bad: [{ label: 'decision is a boolean', field: 'decision', fields: { decision: true, toolUseID: 't', hookEvent: 'PermissionRequest' } }] },
  bypassed_ask: {
    good: { toolUseID: 't', mode: 'bypassPermissions', road: 'toolAskRule', reason: 'r' },
    bad: [{ label: 'reason is missing', field: 'reason', fields: { toolUseID: 't', mode: 'bypassPermissions', road: 'toolAskRule' } }],
  },
  verify_plan_reminder: { good: {}, bad: [] },
  max_turns_reached: { good: { maxTurns: 3, turnCount: 3 }, bad: [{ label: 'maxTurns is text', field: 'maxTurns', fields: { maxTurns: '3', turnCount: 3 } }] },
  current_session_memory: { good: { content: 'c', path: 'p', tokenCount: 1 }, bad: [{ label: 'tokenCount is text', field: 'tokenCount', fields: { content: 'c', path: 'p', tokenCount: 'one' } }] },
  teammate_shutdown_batch: { good: { count: 2 }, bad: [{ label: 'count is text', field: 'count', fields: { count: 'two' } }] },
  compaction_reminder: { good: {}, bad: [] },
  context_efficiency: { good: {}, bad: [] },
  date_change: { good: { newDate: '2026-08-02' }, bad: [{ label: 'newDate is a number', field: 'newDate', fields: { newDate: 20260802 } }] },
  deepthink_effort: { good: {}, bad: [] },
  bound_prefix: {
    good: { boundKey: 'k', rosterEnabled: true, roster: [{ name: 'Read', deferred: false }], sections: [{ name: 's', key: null, text: 't' }], systemContext: { gitStatus: 'clean' } },
    bad: [
      { label: 'roster is text', field: 'roster', fields: { boundKey: 'k', rosterEnabled: true, roster: 'Read', sections: [] } },
      { label: 'sections holds a null row', field: 'sections', fields: { boundKey: 'k', rosterEnabled: true, roster: [], sections: [null] } },
      { label: 'systemContext is a list', field: 'systemContext', fields: { boundKey: 'k', rosterEnabled: true, roster: [], sections: [], systemContext: ['x'] } },
    ],
  },
  dead_thinking: { good: { dead: [{ messageId: 'm', blockIndex: 0 }] }, bad: [{ label: 'dead is text', field: 'dead', fields: { dead: 'm' } }] },
  run_protocol_delta: { good: { tools: ['Run'], body: 'b' }, bad: [{ label: 'tools is text', field: 'tools', fields: { tools: 'Run', body: 'b' } }] },
  lane_boundary: { good: { laneId: 'l', goal: 'g', boundary: 'b' }, bad: [{ label: 'boundary is missing', field: 'boundary', fields: { laneId: 'l', goal: 'g' } }] },
  bagel_console: { good: { errorCount: 1, warningCount: 0, sample: 's' }, bad: [{ label: 'errorCount is text', field: 'errorCount', fields: { errorCount: 'one', warningCount: 0, sample: 's' } }] },
  user_context: { good: { body: 'b' }, bad: [{ label: 'body is a list', field: 'body', fields: { body: ['b'] } }] },
  compact_operator_messages: {
    good: { messages: [{ ordinal: 1, text: 't' }], omitted: 0 },
    bad: [
      { label: 'messages is text', field: 'messages', fields: { messages: 't', omitted: 0 } },
      { label: 'a message without its text', field: 'text', fields: { messages: [{ ordinal: 1 }], omitted: 0 } },
      { label: 'omitted is text', field: 'omitted', fields: { messages: [], omitted: 'none' } },
    ],
  },
}

const NOTICES: Record<string, Fixture> = {
  stop_hook_summary: {
    good: { hookCount: 1, hookInfos: [{ command: 'c', durationMs: 1 }], hookErrors: [], preventedContinuation: false, hasOutput: false, level: 'info' },
    bad: [
      { label: 'hookInfos is text', field: 'hookInfos', fields: { hookCount: 'many', hookInfos: 'x', hookErrors: [], preventedContinuation: false, hasOutput: false, level: 'info' } },
      { label: 'hookErrors is a number', field: 'hookErrors', fields: { hookCount: 1, hookInfos: [], hookErrors: 5, preventedContinuation: false, hasOutput: false, level: 'info' } },
    ],
  },
  memory_saved: {
    good: { writtenPaths: ['a/b.md'] },
    bad: [
      { label: 'writtenPaths is text', field: 'writtenPaths', fields: { writtenPaths: 'a/b.md' } },
      { label: 'a path that is a number', field: 'writtenPaths', fields: { writtenPaths: [5] } },
    ],
  },
  permission_retry: { good: { commands: ['ls'] }, bad: [{ label: 'commands is text', field: 'commands', fields: { commands: 'ls' } }] },
}

section('§A the registry and the fixtures name the same kinds, both ways')
const sorted = (xs: readonly string[]): string => [...xs].sort().join(',')
check('every registered attachment kind has a fixture and every fixture is registered', sorted(BODY_SHAPE_KINDS.attachment) === sorted(Object.keys(ATTACHMENTS)), `${sorted(BODY_SHAPE_KINDS.attachment)} vs ${sorted(Object.keys(ATTACHMENTS))}`)
check('every registered notice kind has a fixture and every fixture is registered', sorted(BODY_SHAPE_KINDS.notice) === sorted(Object.keys(NOTICES)), `${sorted(BODY_SHAPE_KINDS.notice)} vs ${sorted(Object.keys(NOTICES))}`)

section('§B per kind: a well-formed body folds; a body that fails its shape is thinned and named with the kind and the field')
const goodLines: string[] = []
const badLines: string[] = []
for (const [family, fixtures, line] of [
  ['attachment', ATTACHMENTS, attachmentLine],
  ['notice', NOTICES, noticeLine],
] as const) {
  for (const [kind, fixture] of Object.entries(fixtures)) {
    const good = line(kind, fixture.good)
    goodLines.push(good)
    const g = decode([good])
    check(`${family} ${kind}: the well-formed body folds`, g.entries.length === 1 && g.invalid.length === 0, JSON.stringify(g.invalid))
    for (const bad of fixture.bad) {
      const b = line(kind, bad.fields)
      badLines.push(b)
      const d = decode([b])
      const first = d.invalid[0]
      check(
        `${family} ${kind}: ${bad.label} is thinned and named`,
        d.entries.length === 0 && d.invalid.length === 1 && first?.kind === 'body-invalid' && first.reason.includes(`${family} ${kind}`) && first.reason.includes(bad.field),
        JSON.stringify(d.invalid),
      )
    }
  }
}

section('§C the retention law: an unregistered kind folds whatever its body; a registered kind keeps fields the shape does not name')
{
  const unknownAttachment = decode([attachmentLine('never_seen_kind', { content: 5, files: 'x' })])
  check('an unregistered attachment kind with a strange body folds', unknownAttachment.entries.length === 1 && unknownAttachment.invalid.length === 0, JSON.stringify(unknownAttachment.invalid))
  const unknownNotice = decode([noticeLine('never_seen_notice', { hookInfos: 'x', writtenPaths: 5 })])
  check('an unregistered notice kind with a strange body folds', unknownNotice.entries.length === 1 && unknownNotice.invalid.length === 0, JSON.stringify(unknownNotice.invalid))
  const extra = decode([attachmentLine('task_reminder', { content: [], itemCount: 0, laterField: { anything: true } })])
  check('a registered kind with an extra field the shape does not name folds', extra.entries.length === 1 && extra.invalid.length === 0, JSON.stringify(extra.invalid))
  const projected = extra.entries[0] as { attachment?: { laterField?: unknown } }
  check('and the extra field reaches the entry as it was', JSON.stringify(projected.attachment?.laterField) === '{"anything":true}', JSON.stringify(projected))
}

section('§D a whole buffer keeps its accounting: every line is an entry or a named invalid, nothing vanishes')
{
  const all = decode([...goodLines, ...badLines])
  check(
    'entries + invalid == the input lines, goods folded, bads thinned',
    all.entries.length === goodLines.length && all.invalid.length === badLines.length && all.malformed.length === 0 && all.totalLines === goodLines.length + badLines.length,
    `entries=${all.entries.length} invalid=${all.invalid.length} malformed=${all.malformed.length} total=${all.totalLines}`,
  )
  check('every invalid carries the body-invalid kind', all.invalid.every(i => i.kind === 'body-invalid'))
}

section('§E the issue reader answers null for a record that has no body of a registered kind')
{
  const input = validateRecord(JSON.parse(JSON.stringify(entryToRecord({ type: 'user', uuid: uuid(), timestamp: '2026-08-01T10:00:00.000Z', message: { role: 'user', content: 'x' } } as never, ctx() as never))))
  check('an input record has no body issue', input.ok && bodyShapeIssue(input.record) === null)
  const good = validateRecord(JSON.parse(attachmentLine('diagnostics', ATTACHMENTS.diagnostics!.good)))
  check('a well-formed diagnostics body has no issue', good.ok && bodyShapeIssue(good.record) === null)
  const bad = validateRecord(JSON.parse(attachmentLine('diagnostics', { files: 'x', isNew: true })))
  const issue = bad.ok ? bodyShapeIssue(bad.record) : null
  check('a malformed diagnostics body names the kind and the field on its path', issue !== null && issue.path === 'attachment diagnostics.files', JSON.stringify(issue))
}

console.log(`\n${failures === 0 ? 'prove-body-shape-registry: ALL LAWS HOLD' : `prove-body-shape-registry: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
