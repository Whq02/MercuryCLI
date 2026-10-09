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

const EVENTS = [
  'turn.start', 'turn.answer', 'turn.end',
  'tool.before', 'tool.after',
  'permission.ask', 'permission.decided',
  'crewmate.start', 'crewmate.end',
  'compaction.before', 'compaction.after',
  'session.start', 'session.end', 'session.state',
  'file.changed',
] as const

const base = { session_id: 's', transcript_path: '/t.jsonl', cwd: '/w' }
const usage = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 }

check('HOOK_EVENTS is the fifteen moments, in the page order', JSON.stringify(C.HOOK_EVENTS) === JSON.stringify(EVENTS), JSON.stringify(C.HOOK_EVENTS))
check('hookEventTable has a row for every event and no other', Object.keys(C.hookEventTable).length === EVENTS.length)
check('isHookEvent knows the fifteen and nothing else', EVENTS.every(e => C.isHookEvent(e)) && !C.isHookEvent('turn.cut') && !C.isHookEvent('tool.failed') && !C.isHookEvent('') && !C.isHookEvent('constructor'))
check('the kinds are run, question and crewmate', JSON.stringify(C.HOOK_KINDS) === JSON.stringify(['run', 'question', 'crewmate']))
check('the timeout defaults are 600 / 30 / 60 seconds by kind', C.HOOK_TIMEOUT_DEFAULT_S.run === 600 && C.HOOK_TIMEOUT_DEFAULT_S.question === 30 && C.HOOK_TIMEOUT_DEFAULT_S.crewmate === 60)
check('the cut budget is 1.5 s', C.HOOK_CUT_BUDGET_MS === 1500)

const fields: Record<(typeof EVENTS)[number], Record<string, unknown>> = {
  'turn.start': { turn_id: 't1', prompt: 'go' },
  'turn.answer': { turn_id: 't1', answer: 'done', again: false },
  'turn.end': { turn_id: 't1', status: 'interrupted', cut: { reason: 'operator', tools: ['Bash'] }, steps: 2, wall_ms: 10, usage },
  'tool.before': { tool: 'Bash', input: { command: 'ls' }, call_id: 'c1' },
  'tool.after': { tool: 'Bash', input: {}, output: 'ok', call_id: 'c1', ok: true, cut: false },
  'permission.ask': { tool: 'Bash', input: {}, call_id: 'c1' },
  'permission.decided': { tool: 'Bash', input: {}, call_id: 'c1', decision: 'denied', by: 'rule' },
  'crewmate.start': { prompt: 'do it', model: 'm', directory: '/w' },
  'crewmate.end': { status: 'finished' },
  'compaction.before': { trigger: 'manual', tokens: 100 },
  'compaction.after': { method: 'summary', trigger: 'auto', tokens_before: 100, tokens_after: 10 },
  'session.start': { reason: 'new', model: 'm' },
  'session.end': { reason: 'quit' },
  'session.state': { state: 'needs-you', from: 'working', workspace: '/w' },
  'file.changed': { path: '.env', change: 'changed' },
}

for (const event of EVENTS) {
  const schema = C.hookPayloadSchema(event)
  const own = schema.safeParse({ ...base, event, ...fields[event] })
  check(`${event}: its payload schema parses its own payload`, own.success, own.success ? '' : JSON.stringify(own.error.issues).slice(0, 200))
  const other = EVENTS.find(e => e !== event) as string
  check(`${event}: the payload schema refuses another event's name`, !schema.safeParse({ ...base, event: other, ...fields[event] }).success)
  check(`${event}: the row names its moment, its roads and its answers`, typeof C.hookEventTable[event].moment === 'string' && C.hookEventTable[event].moment.length > 10 && C.hookEventTable[event].roads.length > 0 && Array.isArray(C.hookEventTable[event].answers))
}

const matchFields: Record<(typeof EVENTS)[number], string | undefined> = {
  'turn.start': undefined,
  'turn.answer': undefined,
  'turn.end': 'status',
  'tool.before': 'tool',
  'tool.after': 'tool',
  'permission.ask': 'tool',
  'permission.decided': 'tool',
  'crewmate.start': 'crewmate_type',
  'crewmate.end': 'status',
  'compaction.before': 'trigger',
  'compaction.after': 'method',
  'session.start': 'reason',
  'session.end': 'reason',
  'session.state': 'state',
  'file.changed': 'path',
}
for (const event of EVENTS) {
  check(`${event}: match field ${matchFields[event] ?? 'none'}`, C.hookEventTable[event].match === matchFields[event], String(C.hookEventTable[event].match))
}
check('hookMatchValue reads the match field from the payload', C.hookMatchValue('tool.before', { tool: 'Bash' }) === 'Bash' && C.hookMatchValue('turn.end', { status: 'failed' }) === 'failed' && C.hookMatchValue('turn.start', { prompt: 'x' }) === undefined)
check('hookMatchValues lists a closed vocabulary and nothing for an open field', JSON.stringify(C.hookMatchValues('turn.end')) === JSON.stringify(['completed', 'blocked', 'refused', 'interrupted', 'turn_limit', 'budget_limit', 'schema_unmet', 'loop_stopped', 'failed']) && JSON.stringify(C.hookMatchValues('session.state')) === JSON.stringify(['needs-you', 'stalled', 'ready-to-review', 'paused', 'completed', 'failed', 'cancelled']) && C.hookMatchValues('tool.before') === undefined)

const answers: Record<(typeof EVENTS)[number], string[]> = {
  'turn.start': ['block', 'stop', 'context', 'notice'],
  'turn.answer': ['block', 'stop', 'context', 'notice'],
  'turn.end': ['notice'],
  'tool.before': ['block', 'stop', 'context', 'notice', 'permission', 'input'],
  'tool.after': ['block', 'stop', 'context', 'notice', 'output'],
  'permission.ask': ['block', 'stop', 'notice', 'permission', 'input', 'rules'],
  'permission.decided': ['notice'],
  'crewmate.start': ['context', 'notice'],
  'crewmate.end': ['notice'],
  'compaction.before': ['instructions', 'notice'],
  'compaction.after': ['context', 'notice'],
  'session.start': ['context', 'notice', 'prompt', 'watch'],
  'session.end': [],
  'session.state': [],
  'file.changed': ['notice', 'watch'],
}
for (const event of EVENTS) {
  check(`${event}: reads exactly ${answers[event].join(', ') || 'nothing'}`, JSON.stringify(C.hookAnswerFieldsOf(event)) === JSON.stringify(answers[event]), JSON.stringify(C.hookAnswerFieldsOf(event)))
  const schema = C.hookAnswerSchema(event)
  for (const field of answers[event]) {
    const value = field === 'permission' ? 'allow' : field === 'input' ? { a: 1 } : field === 'output' ? 'o' : field === 'rules' ? [] : field === 'watch' ? ['x'] : 'words'
    check(`${event}: the answer schema accepts ${field}`, schema.safeParse({ [field]: value }).success)
  }
  const foreign = C.HOOK_ANSWER_FIELDS.find(f => !answers[event].includes(f))
  if (foreign !== undefined) {
    check(`${event}: the answer schema refuses ${foreign} (not a field this event reads)`, !schema.safeParse({ [foreign]: foreign === 'watch' ? ['x'] : foreign === 'rules' ? [] : foreign === 'input' ? {} : 'x' }).success)
  }
}
check('permission answers allow or ask; a deny is block', C.hookAnswerSchema('tool.before').safeParse({ permission: 'ask' }).success && !C.hookAnswerSchema('tool.before').safeParse({ permission: 'deny' }).success)
check('an answer with a field no event has is refused', !C.HookAnswerSchema().safeParse({ decision: 'block' }).success && !C.HookAnswerSchema().safeParse({ specifics: {} }).success)

check('session.end and session.state run only run hooks; every other event runs all three', JSON.stringify(C.hookKindsOf('session.end')) === '["run"]' && JSON.stringify(C.hookKindsOf('session.state')) === '["run"]' && EVENTS.filter(e => e !== 'session.end' && e !== 'session.state').every(e => C.hookKindsOf(e).length === 3))
check('the 1.5 s budget rides session.end always, and turn.end and tool.after on a cut', C.hookEventTable['session.end'].budget?.when === 'always' && C.hookEventTable['turn.end'].budget?.when === 'cut' && C.hookEventTable['tool.after'].budget?.when === 'cut' && C.hookEventTable['tool.before'].budget === undefined)
check('plain stdout is context on session.start, turn.start, crewmate.start and compaction.after only', EVENTS.filter(e => C.hookEventTable[e].stdoutIsContext === true).join(',') === 'turn.start,crewmate.start,compaction.after,session.start')
check('the environment file rides session.start and file.changed only', EVENTS.filter(e => C.hookEventTable[e].envFile === true).join(',') === 'session.start,file.changed')
check('session.state fires on the daemon road alone', JSON.stringify(C.hookEventTable['session.state'].roads) === '["daemon"]')
check('file.changed is the one watchable event', EVENTS.filter(e => C.hookEventTable[e].watchable === true).join(',') === 'file.changed')
check('a background answer reads context and notice only', JSON.stringify(C.HOOK_BACKGROUND_ANSWER_FIELDS) === '["context","notice"]')

const docs = readFileSync(join(import.meta.dir, '..', '..', 'docs', 'HOOKS.md'), 'utf8')
const documented = [...docs.matchAll(/^\| `([a-z]+\.[a-z]+)` \|/gm)].map(m => m[1])
check('docs/HOOKS.md documents exactly the fifteen events, in the table order', JSON.stringify(documented) === JSON.stringify(EVENTS), JSON.stringify(documented))
for (const event of EVENTS) {
  const row = C.hookEventTable[event]
  const line = docs.split('\n').find(l => l.startsWith(`| \`${event}\` |`)) ?? ''
  if (row.match !== undefined) check(`docs: ${event} names its match field ${row.match}`, line.includes(`| \`${row.match}\` |`), line.slice(0, 120))
  for (const field of row.answers.filter(f => f !== 'notice')) check(`docs: ${event} names the answer field ${field}`, line.includes(`\`${field}`), line.slice(0, 160))
}
const skillWords = readFileSync(join(import.meta.dir, '..', '..', 'src', 'skills', 'bundled', 'updateConfig.ts'), 'utf8')
check('the bundled update-config skill lists no event by hand — it reads the table', /hookEventTable/.test(skillWords) && !/\| turn\.start \|/.test(skillWords))

if (failures > 0) {
  console.error(`\nprove-hook-event-table: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-hook-event-table: all green')
