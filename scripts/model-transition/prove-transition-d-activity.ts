#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'ctm-d-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'

const act = await import('../../src/crew/crewmates/activity.js')
const dispatch = await import('../../src/crew/crewmates/dispatch.js')

let failures = 0
const ACTIVITY_FAIL_HINT =
  'fix classifyActivity, activityIdOf, ingestActivity or cachedActivityFeed in src/crew/crewmates/activity.ts (a tool_call_update must fold into the existing row; ids are adapterKind:sessionId:...), or DELIVERY_STATES in src/crew/crewmates/dispatch.ts, not this check'
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(
    `  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} — ` : ''}${ACTIVITY_FAIL_HINT}` : ''}`,
  )
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}


function seatInput(kind: string, payload: Record<string, unknown>, sourceEventId = `e-${Math.abs(JSON.stringify(payload).length)}-${kind}`): Parameters<typeof act.classifyActivity>[0] {
  return {
    event: { kind, payload, sourceEventId, atMs: 1754000000000 } as never,
    agentId: 'crew:test-agent' as never,
    sessionId: 'sess-1',
    adapterKind: 'opencode',
    conversationId: 'conv-1',
  }
}


section('§C D05 — activity rows settle in place')
{
  act._resetActivityFeedForTesting()
  act.ingestActivity(
    seatInput('session/update', { sessionId: 'sess-1', update: { sessionUpdate: 'tool_call', toolCallId: 'tu_settle', title: 'bun test', kind: 'execute', status: 'in_progress' } }),
  )
  const afterStart = act.cachedActivityFeed()
  const started = afterStart.order.length
  act.ingestActivity(
    seatInput('session/update', { sessionId: 'sess-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tu_settle', status: 'completed' } }),
  )
  const afterSettle = act.cachedActivityFeed()
  check('the result folds into the SAME row (no duplicate)', afterSettle.order.length === started, `rows=${afterSettle.order.length}`)
  const row = afterSettle.rows.get(afterSettle.order.find(id => id.includes('tu_settle'))!)
  check('the row settled in place (phase left running)', row !== undefined && row.phase !== 'running', row?.phase)
  check('the activityId stayed the owner id (stable key)', row !== undefined && row.activityId.includes('tool:tu_settle'))
  act._resetActivityFeedForTesting()
}

section('§D D02 — identical identities across shared views')
{
  const a = act.classifyActivity(seatInput('session/update', { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } } }))
  check('agent/session/conversation ids pass through verbatim', String(a.agentId) === 'crew:test-agent' && a.sessionId === 'sess-1' && a.conversationId === 'conv-1')
  const i1 = seatInput('session/update', { update: { sessionUpdate: 'plan', entries: [] } }, 'stable-ev')
  const id1 = act.activityIdOf(i1)
  const id2 = act.activityIdOf(i1)
  check('activityId is deterministic (same input ⇒ same id)', id1 === id2)
  check('…and session-scoped (two seats never fold each other)', id1.startsWith('opencode:sess-1:'))
}


section('§G D03/D04 — role/handoff/delivery truth where it ships')
{
  check('tri-state delivery is the exported vocabulary', JSON.stringify(dispatch.DELIVERY_STATES) === JSON.stringify(['delivered', 'not-delivered', 'delivery-unknown']))
}

console.log(
  failures === 0
    ? '\n ✅ ACTIVITY — one vocabulary, settled rows, ratified cursor, shipped role truth'
    : `\n ❌ ACTIVITY — ${failures} failure(s)`,
)
process.exit(failures === 0 ? 0 : 1)
