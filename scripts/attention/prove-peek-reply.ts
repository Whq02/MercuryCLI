#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/prove-peek-reply.ts — A4: the reply route +
//  the first-character law.
//
//  EXPECT-RED at the pre-fix tree, promoted in the same commit.
//
//    §1 submitReply routes over the DELIVERY DOOR (steer-removal re-cut):
//       the session root rides sendWords; a live thread rides the door's
//       addressed form (sendAgentNote — the REAL agent id, never a row
//       id); empty and unroutable replies refuse honestly; the
//       cockpit-process queue is never touched (poison).
//    §2 the FIRST-CHARACTER law: type-to-compose exists ONLY at the panes'
//       detail level (where hotkeys are dead — no collisions can eat a
//       character), and the board seeds the reply draft with the exact
//       character typed.
// ============================================================================
import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

let A: typeof import('../../src/services/attention/actions.ts') | null = null
try {
  A = await import('../../src/services/attention/actions.ts')
} catch {
  A = null
}
if (!A || typeof (A as Record<string, unknown>).submitReply !== 'function') {
  t.check('actions.ts exports submitReply', false, 'absent at this tree')
  t.finish('prove-peek-reply')
}
const q = await import('../../src/input-core/command-queue.ts')
const focused = await import('../../src/services/engine-connector/focusedConnector.ts')

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

t.section('§2 — the first-character law')
{
  const panes = readFileSync('src/components/mercury-ui/NavigablePanes.tsx', 'utf8')
  t.check(
    "type-to-compose is gated to the DETAIL level (hotkeys dead there — no key can eat the character)",
    panes.includes("nav.level === 'detail'") && panes.includes('onTypeToCompose'),
  )
  // The board's peek-reply composer was retired in place with the WORK panel
  // — the prompts panel is a
  // record and composes nothing at the detail level.
  const panel = readFileSync('src/components/prompts-panel/PromptsPanel.tsx', 'utf8')
  t.check(
    'the prompts panel wires no type-to-compose (nothing composes from a record row)',
    !panel.includes('onTypeToCompose'),
  )
}

t.finish('prove-peek-reply')
