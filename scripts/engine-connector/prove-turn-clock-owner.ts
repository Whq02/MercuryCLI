#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)

const { liveTurnStateOf } = await import('../../src/utils/conversationRecovery.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

let seq = 0
const uuid = (): string => `00000000-0000-4000-a000-${String(++seq).padStart(12, '0')}`
const assistant = (content: unknown[], at: string): unknown => ({
  type: 'assistant',
  uuid: uuid(),
  timestamp: at,
  message: { id: `msg_${seq}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8', content, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
})
const prompt = (text: string, at: string): unknown => ({ ...(createUserMessage({ content: text }) as object), timestamp: at })

section('§1 the fold hands a start for an in-flight turn only')
{
  const daysAgo = '2026-06-20T10:00:00.000Z'
  const settled = [prompt('first', daysAgo), assistant([{ type: 'text', text: 'done' }], '2026-06-20T10:00:05.000Z')]
  const s = liveTurnStateOf(settled as never)
  check('a settled record (prompt, answer) is idle and hands NO start — never its last prompt\'s clock', s.inFlight === false && s.turnStartedAtMs === null, j(s))
  const open = [prompt('run it', daysAgo), assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 1' } }], '2026-06-20T10:00:02.000Z')]
  const o = liveTurnStateOf(open as never)
  check('a record with an unresolved tool_use is in flight and hands its open prompt\'s clock', o.inFlight === true && o.turnStartedAtMs === Date.parse(daysAgo), j(o))
  const fresh = [prompt('the first words', '2026-09-05T09:00:00.000Z')]
  const t = liveTurnStateOf(fresh as never)
  check('a record of one unanswered prompt (a fresh session) is in flight from THAT prompt\'s clock', t.inFlight === true && t.turnStartedAtMs === Date.parse('2026-09-05T09:00:00.000Z'), j(t))
}

section('§2 the seat latches the clock once, through one owner')
{
  const src = readFileSync(join(ROOT, 'src/services/engine-connector/daemonConnector.ts'), 'utf8')
  check('the effective facts read the record\'s start, else the latch — one call', src.includes('turnStartedAtMs: this.liveState.turnStartedAtMs ?? this.turnStartLatch(inFlight)'))
  check('no facts path mints a clock inline per tick', !/turnStartedAtMs: [^\n]*\(inFlight \? Date\.now\(\)/.test(src))
  const latch = src.slice(src.indexOf('private turnStartLatch(inFlight: boolean)'), src.indexOf('private turnStartLatch(inFlight: boolean)') + 400)
  check('the latch mints once while in flight and clears when the turn ends', latch.includes('if (this.turnStartLatchMs === null) this.turnStartLatchMs = Date.now()') && latch.includes('this.turnStartLatchMs = null'))
  const fold = readFileSync(join(ROOT, 'src/utils/conversationRecovery.ts'), 'utf8')
  check('the fold\'s start is conditional on the turn being in flight', fold.includes('turnStartedAtMs: inFlight ? acc.lastPromptMs : null'))
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
