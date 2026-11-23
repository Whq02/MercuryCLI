#!/usr/bin/env bun
import { checker } from '../engine-durability/harness.ts'

const t = checker()

let A: typeof import('../../src/screen/attention/actions.ts') | null = null
try {
  A = await import('../../src/screen/attention/actions.ts')
} catch {
  A = null
}
if (!A || typeof (A as Record<string, unknown>).submitReply !== 'function') {
  t.check('actions.ts exports submitReply', false, 'absent at this tree')
  t.finish('prove-peek-reply')
}
const q = await import('../../src/screen/composer/input-core/command-queue.ts')
const focused = await import('../../src/engine/connector/focusedConnector.ts')

t.section('§1 — the reply routes (the delivery door)')
{
  q.resetCommandQueue()
  const calls: Array<{ kind: string; text: string; agentId?: string }> = []
  focused.setFocusedSessionConnector({
    carrier: 'daemon',
    sessionId: () => 'fake',
    sendWords: async (text: string) => {
      calls.push({ kind: 'words', text })
      return { state: 'accepted' as const }
    },
    sendAgentNote: async (agentId: string, text: string) => {
      calls.push({ kind: 'agent-note', text, agentId })
      return { state: 'accepted' as const }
    },
  } as never)
  const r1 = await A!.submitReply({ intentId: 'i1', targetSubjectId: 'thread:root', value: 'go on' })
  t.check(
    "root reply rides sendWords (route 'session')",
    r1.kind === 'dispatch-accepted' && r1.route === 'session' && calls[0]?.kind === 'words' && calls[0]?.text === 'go on',
  )
  const r2 = await A!.submitReply({
    intentId: 'i2',
    targetSubjectId: 'thread:exec-42',
    agentId: 'agent-real-7',
    value: 'focus the tail',
  })
  t.check(
    "thread reply rides sendAgentNote with the REAL agent id (route 'agent')",
    r2.kind === 'dispatch-accepted' && r2.route === 'agent' && calls.some(c => c.kind === 'agent-note' && c.agentId === 'agent-real-7' && c.text === 'focus the tail'),
  )
  const r2b = await A!.submitReply({ intentId: 'i2b', targetSubjectId: 'thread:crew:alice', value: 'hi' })
  t.check(
    'a thread with NO real agent id refuses honestly (review B2 — the undeliverable lane)',
    r2b.kind === 'dispatch-unavailable' && r2b.reason.includes('steer'),
  )
  const r3 = await A!.submitReply({ intentId: 'i3', targetSubjectId: 'thread:root', value: '  ' })
  t.check('an empty reply refuses', r3.kind === 'dispatch-unavailable')
  const r4 = await A!.submitReply({ intentId: 'i4', targetSubjectId: 'review:x', value: 'hm' })
  t.check('an unroutable subject refuses honestly', r4.kind === 'dispatch-unavailable')
  t.check('the cockpit-process queue was never touched (poison)', q.getCommandQueue().length === 0)
  focused._resetFocusedSessionConnectorForTesting()
  q.resetCommandQueue()
}


t.finish('prove-peek-reply')
