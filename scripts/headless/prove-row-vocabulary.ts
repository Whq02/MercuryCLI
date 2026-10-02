#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'rows-vocab-'))

const vocabulary = await import('../../src/rows/vocabulary.ts')
const project = await import('../../src/rows/project.ts')
const read = await import('../../src/rows/read.ts')

const {
  ROWS_SCHEMA,
  ROW_TYPES,
  PARTIAL_ROW_TYPES,
  INPUT_ROW_TYPES,
  OUTCOME_STATUSES,
  ERROR_CLASSES,
  RowSchema,
  InputRowSchema,
  usageOf,
  statusOfTerminal,
  errorClassOf,
  stopWordOf,
  exitCodeOf,
  OUTCOME_SENTENCES,
} = vocabulary

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

const root = join(import.meta.dir, '..', '..')
const scope = { session_id: 'sess-1', turn: 2 }
const stamper = project.createRowStamper(() => '2026-10-02T00:00:00.000Z')
const usage = { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 3, output_tokens: 7, output_tokens_details: { thinking_tokens: 2 } }

section('V1 one schema per type, one projector arm per type, every projected row parses')
const projected: Record<string, unknown[]> = {
  session: [project.sessionRow(scope, { version: '1.0.0', cwd: '/w', model: 'm', mode: 'default', tools: ['Bash'], mcpServers: [{ name: 's', status: 'connected' }], commands: ['/help'], agents: ['a'], skills: ['k'], extensions: [{ name: 'e', path: '/e', id: 'e1' }] })],
  turn: [project.turnStartedRow(scope, { turnId: 't-1', messageIds: ['m-1'], model: 'm' }), project.turnWaitingRow(scope, { turnId: 't-1', agents: 2 })],
  text: project.itemRowsOf(scope, 'm-1', [{ type: 'text', text: 'hello', phase: 'final_answer' }]),
  reasoning: project.itemRowsOf(scope, 'm-1', [{ type: 'thinking', thinking: 'hm' }, { type: 'redacted_thinking' }]),
  tool_call: project.itemRowsOf(scope, 'm-1', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]),
  tool_result: project.toolResultRowsOf(scope, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ok' }] }]),
  tool_update: [project.toolUpdateRow(scope, { callId: 'toolu_1', tick: 1, source: 'shell', line: 'x', elapsedS: 1.5 })],
  step: [project.stepRow(scope, { messageId: 'm-1', model: 'm', stopReason: 'end_turn', usage })],
  outcome: [project.outcomeRow(scope, { turnId: 't-1', status: 'completed', stopReason: 'end_turn', answer: 'done', steps: 1, wallMs: 10, apiMs: 5, costUsd: 0.01, usage, models: project.modelUsageRows({ m: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.01 } }), denials: [] })],
  wait: [project.waitRow(scope, null), project.retryWaitRow(scope, { attempt: 1, of: 3, reason: 'overloaded', delayMs: 100, httpStatus: 529, sinceMs: 0 })],
  heartbeat: [project.heartbeatRow(scope)],
  compaction: [project.compactionRow(scope, null, 'manual'), project.compactionEndedRow(scope, { trigger: 'auto', tokensBefore: 1000 })],
  mode: [project.modeRow(scope, 'default')],
  rate_limit: [project.rateLimitRow(scope, { status: 'allowed_warning', isUsingOverage: false, utilization: 0.9 })],
  task: [project.taskRow(scope, { state: 'started', taskId: 'task-1', description: 'd' })],
  notice: [project.noticeRow(scope, 'warning', 'careful', 'w1')],
  command_output: [project.commandOutputRow(scope, 'out', '/status')],
  mission_updated: [project.missionUpdatedRow(scope)],
  samples_updated: [project.samplesUpdatedRow(scope)],
  block_start: project.partialRowsOf(scope, 'm-1', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
  text_delta: project.partialRowsOf(scope, 'm-1', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'he' } }),
  reasoning_delta: project.partialRowsOf(scope, 'm-1', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'h' } }),
  tool_input_delta: project.partialRowsOf(scope, 'm-1', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"c' } }),
  retracted: [project.retractedRow(scope, 'm-1')],
}
const everyType = [...ROW_TYPES, ...PARTIAL_ROW_TYPES]
check('ROWS_SCHEMA is 1', ROWS_SCHEMA === 1)
check(`${everyType.length} row types, each with a projector arm`, everyType.every(type => (projected[type]?.length ?? 0) > 0), everyType.filter(type => (projected[type]?.length ?? 0) === 0).join(','))
check('no projector arm yields a type outside the vocabulary', Object.keys(projected).every(type => (everyType as readonly string[]).includes(type)))
const schema = RowSchema()
for (const type of everyType) {
  for (const draft of projected[type] ?? []) {
    const stamped = stamper.stamp(draft as never)
    const parsed = schema.safeParse(stamped)
    check(`${type} row parses`, parsed.success, parsed.success ? '' : j(parsed.error.issues.slice(0, 2)))
    if (parsed.success) check(`${type} row keeps its type after parsing`, (parsed.data as { type: string }).type === type)
  }
}
const sessionOnly = stamper.stamp(projected.session![0] as never) as Record<string, unknown>
check('the session row carries no turn (it opens the stream before any turn)', sessionOnly.turn === undefined)
check('a stamped row carries seq and timestamp from the stamper', typeof sessionOnly.seq === 'number' && sessionOnly.timestamp === '2026-10-02T00:00:00.000Z')
check('seq rises by one per stamp', (stamper.stamp(project.heartbeatRow(scope)) as { seq: number }).seq === stamper.seq)

section('V2 snake_case at every depth')
function keysDeep(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => keysDeep(item, `${path}[${i}]`))
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => [`${path}.${key}`, ...keysDeep(inner, `${path}.${key}`)])
}
const offenders: string[] = []
for (const type of everyType) {
  for (const draft of projected[type] ?? []) {
    for (const key of keysDeep(draft)) {
      const leaf = key.split('.').pop() ?? ''
      if (leaf.startsWith('[')) continue
      if (!/^[a-z][a-z0-9_]*$/.test(leaf)) offenders.push(`${type}${key}`)
    }
  }
}
check('every key of every projected row is snake_case (tool input keys excepted)', offenders.filter(k => !k.startsWith('tool_call.input')).length === 0, offenders.slice(0, 5).join(' '))

section('V3 no row type is a message kind of the engine or the transcript')
const messageKinds = ['assistant', 'user', 'system', 'result', 'stream_event', 'attachment', 'progress', 'tool_use_summary', 'control_request', 'control_response', 'control_cancel_request', 'keep_alive', 'summary', 'custom_title', 'file-history-snapshot']
const collisions = [...everyType, ...INPUT_ROW_TYPES].filter(type => messageKinds.includes(type))
check('zero collisions', collisions.length === 0, collisions.join(','))

section('V4 Terminal → status is total over query/transitions.ts')
const transitionsSource = readFileSync(join(root, 'src/query/transitions.ts'), 'utf8')
const terminalBlock = transitionsSource.slice(transitionsSource.indexOf('export type Terminal ='), transitionsSource.indexOf('export type Terminal =') + 900)
const reasons = [...terminalBlock.matchAll(/\{ reason: '([a-z_]+)'/g)].map(m => m[1]!)
check(`transitions.ts declares ${reasons.length} terminal reasons (12 read)`, reasons.length === 12, reasons.join(','))
for (const reason of reasons) {
  const mapped = statusOfTerminal({ reason } as never, null)
  check(`terminal ${reason} → status ${mapped?.status ?? 'undefined'}`, mapped !== undefined && (OUTCOME_STATUSES as readonly string[]).includes(mapped.status))
}
check('a completing terminal is completed', statusOfTerminal({ reason: 'completed' }, null).status === 'completed')
check('the stop hook terminals read completed', statusOfTerminal({ reason: 'stop_hook_prevented' }, null).status === 'completed' && statusOfTerminal({ reason: 'hook_stopped' }, null).status === 'completed')
check('max_turns reads turn_limit', statusOfTerminal({ reason: 'max_turns', turnCount: 3 }, null).status === 'turn_limit')
const turnCutSource = readFileSync(join(root, 'src/utils/messages/turnCut.ts'), 'utf8')
const cutKinds = turnCutSource.match(/export type TurnCutKind = ([^\n]+)/)?.[1]?.match(/'([a-z-]+)'/g)?.map(k => k.slice(1, -1)) ?? []
check(`turnCut.ts declares ${cutKinds.length} cut kinds (4 read)`, cutKinds.length === 4, cutKinds.join(','))
for (const kind of cutKinds) {
  const mapped = statusOfTerminal({ reason: 'aborted_streaming' }, kind as never)
  check(`abort under cut ${kind} → ${mapped.status}${mapped.errorClass ? '/' + mapped.errorClass : ''}`, (OUTCOME_STATUSES as readonly string[]).includes(mapped.status))
}
check('an operator abort is interrupted', statusOfTerminal({ reason: 'aborted_tools' }, 'operator').status === 'interrupted')
check('an idle-timeout abort is failed/idle_timeout', j(statusOfTerminal({ reason: 'aborted_streaming' }, 'idle-timeout')) === j({ status: 'failed', errorClass: 'idle_timeout' }))
check('every error class the mapping yields is in ERROR_CLASSES', reasons.every(reason => { const c = statusOfTerminal({ reason } as never, null).errorClass; return c === undefined || (ERROR_CLASSES as readonly string[]).includes(c) }))
check('an unknown assistant error class reads model', errorClassOf('something_else') === 'model' && errorClassOf(undefined) === 'model')
check('rate_limit and billing_error map to their classes', errorClassOf('rate_limit') === 'rate_limit' && errorClassOf('billing_error') === 'billing')

section('V5 usage conversion and the exit code')
const converted = usageOf(usage)
check('input_tokens = input + cache_read + cache_creation', converted.input_tokens === 18, j(converted))
check('cached_input_tokens = cache_read', converted.cached_input_tokens === 5)
check('cache_write_input_tokens = cache_creation', converted.cache_write_input_tokens === 3)
check('output_tokens carried', converted.output_tokens === 7)
check('reasoning_output_tokens from thinking_tokens', converted.reasoning_output_tokens === 2)
check('no reasoning key without thinking tokens', usageOf({ ...usage, output_tokens_details: null }).reasoning_output_tokens === undefined)
check('negative counts clamp to zero', usageOf({ input_tokens: -1, cache_read_input_tokens: -2, cache_creation_input_tokens: 0, output_tokens: -3 }).input_tokens === 0)
check('exit code 0 only for completed', exitCodeOf('completed') === 0 && OUTCOME_STATUSES.filter(s => s !== 'completed').every(s => exitCodeOf(s) === 1))
check('every non-completed status except refused/failed has a sentence', OUTCOME_STATUSES.filter(s => s !== 'completed' && s !== 'refused' && s !== 'failed').every(s => typeof (OUTCOME_SENTENCES as Record<string, unknown>)[s] === 'function'))
check('stop words: pause_turn reads pause, hook terminals read hook, unknown reads undefined', stopWordOf('pause_turn') === 'pause' && stopWordOf('hook_stopped') === 'hook' && stopWordOf('whatever') === undefined && stopWordOf(null) === undefined)

section('V6 the reader: bare row, row notification, torn and foreign lines')
const bare = stamper.stamp(project.noticeRow(scope, 'error', 'x'))
const bareLine = JSON.stringify(bare)
const notified = JSON.stringify({ jsonrpc: '2.0', method: 'row', params: bare })
check('parseRow of a bare line equals the row', j(read.parseRow(bareLine)) === j(bare))
check('parseRow of a row notification equals the same row', j(read.parseRow(notified)) === j(bare))
check('a torn line reads null without throwing', read.parseRow(bareLine.slice(0, 20)) === null)
check('a foreign JSON-RPC message reads null', read.parseRow(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'turn/interrupt', params: {} })) === null)
check('a control frame reads null', read.parseRow(JSON.stringify({ type: 'control_request', request_id: 'r', request: {} })) === null)
check('a blank line reads null', read.parseRow('   ') === null)
check('a JSON array reads null', read.parseRow('[1,2]') === null)
check('a non-object JSON value reads null', read.parseRow('"text"') === null && read.parseRow('42') === null)
const outcome = stamper.stamp(projected.outcome![0] as never) as Record<string, unknown>
check('isOutcome / outcomeFailed on a completed outcome', read.isOutcome(read.parseRow(JSON.stringify(outcome))) && !read.outcomeFailed(outcome as never))
check('turnOpened / turnWaiting predicates', read.turnOpened(read.parseRow(JSON.stringify(stamper.stamp(projected.turn![0] as never)))) && read.turnWaiting(read.parseRow(JSON.stringify(stamper.stamp(projected.turn![1] as never)))))
check('mainThreadStep ignores a sub-agent step', read.mainThreadStep(read.parseRow(JSON.stringify(stamper.stamp(project.stepRow({ ...scope, parent_call_id: 'toolu_9' }, { messageId: 'm', model: 'm', stopReason: null, usage }))))) === false)
check('isRowType / isInputRowType', read.isRowType('outcome') && read.isRowType('text_delta') && !read.isRowType('assistant') && read.isInputRowType('prompt') && !read.isInputRowType('user'))

section('V7 input rows')
const inputSchema = InputRowSchema()
check('a prompt row with string content parses', inputSchema.safeParse({ type: 'prompt', content: 'hi', id: 'c-1', priority: 'next' }).success)
check('a prompt row with blocks parses', inputSchema.safeParse({ type: 'prompt', content: [{ type: 'text', text: 'hi' }, { type: 'image', media_type: 'image/png', data: 'AA==' }] }).success)
check('a shell row parses', inputSchema.safeParse({ type: 'shell', command: '/status' }).success)
check('a note row parses', inputSchema.safeParse({ type: 'note', to: 'lead', content: 'ping' }).success)
check('a user frame is not an input row', !inputSchema.safeParse({ type: 'user', message: { role: 'user', content: 'hi' } }).success)
check('an unknown priority is refused', !inputSchema.safeParse({ type: 'prompt', content: 'hi', priority: 'soon' }).success)

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ prove-row-vocabulary: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ prove-row-vocabulary: the row vocabulary, projector and reader agree')
