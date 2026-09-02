#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/prove-dispatch-actions.ts — A3 re-cut to the DELIVERY
//  LAW (steer-removal follow-up, lead-authorized): the operator-action
//  intents ride the ONE delivery door.
//
//  The dead road this replaces: all three intents wrote the
//  cockpit-process command-queue — a store NO consumer in that process
//  reads (every engine runs in the session's runner), so a workflows-board
//  dispatch, a crew reply, or a folio revision request produced an
//  accepted-looking receipt and then NOTHING, forever. The receipts were
//  lies by construction.
//
//    §1 NO CHAT OPEN = an honest refusal: submitDispatch/submitReply
//       refuse with the no-chat sentence instead of accepting into a dead
//       store (RED at the pre-fix tree: the old road answered
//       'dispatch-accepted' with no session anywhere).
//    §2 THE SESSION ROUTE: with a focused session, submitDispatch and a
//       root-thread submitReply deliver through the connector's
//       sendWords — the receipt carries the door's own answer and the
//       cockpit-process queue is NEVER touched (poison).
//    §3 an empty dispatch/reply refuses honestly, before any door.
//    §4 THE AGENT ROUTE: an agent-addressed reply rides the SAME door's
//       addressed form (sendAgentNote) — same identity laws, the runner's
//       drain delivers it into that agent's own next turn; a reply with
//       no agent id refuses with the steering-surface sentence.
//    §5 THE PEN CENSUS: submitReplaceNext is GONE (there is no replaceable
//       window under instant delivery), and nothing here imports the
//       command-queue store at all (poison: a queue write returning reds).
// ============================================================================
import { checker } from '../engine-durability/harness.ts'

const t = checker()

let m: typeof import('../../src/services/attention/actions.ts') | null = null
try {
  m = await import('../../src/services/attention/actions.ts')
} catch {
  m = null
}
if (!m) {
  t.check('src/services/attention/actions.ts loads', false, 'module absent')
  t.finish('prove-dispatch-actions')
}
const A = m!
const q = await import('../../src/input-core/command-queue.ts')
const focused = await import('../../src/services/engine-connector/focusedConnector.ts')

type SendCall = { kind: 'words' | 'agent-note'; text: string; agentId?: string }

/** A minimal focused-connector stand-in: records the door calls; every
 *  other member is absent (the intents must touch only the send doors). */
function seatFakeConnector(): { calls: SendCall[]; release: () => void } {
  const calls: SendCall[] = []
  const fake = {
    carrier: 'daemon' as const,
    sessionId: () => 'fake-session',
    sendWords: async (text: string) => {
      calls.push({ kind: 'words', text })
      return { state: 'accepted' as const }
    },
    sendAgentNote: async (agentId: string, text: string) => {
      calls.push({ kind: 'agent-note', text, agentId })
      return { state: 'accepted' as const }
    },
  }
  focused.setFocusedSessionConnector(fake as never)
  return { calls, release: () => focused._resetFocusedSessionConnectorForTesting() }
}

t.section('§1 — no chat open: the honest refusal (the dead-store lie is gone)')
{
  q.resetCommandQueue()
  // The resting slot: no session focused.
  const r = await A.submitDispatch({ intentId: A.mintIntentId(), kind: 'board-dispatch', value: 'resume wf_x' })
  t.check(
    "with NO chat open the receipt is 'dispatch-unavailable' (the old road LIED 'dispatch-accepted' into a store nothing reads)",
    r.kind === 'dispatch-unavailable',
    JSON.stringify(r),
  )
  t.check('…and the cockpit-process queue took NOTHING (poison)', q.getCommandQueue().length === 0, JSON.stringify(q.getCommandQueue().map(c => c.value)))
  const rr = await A.submitReply({ intentId: A.mintIntentId(), targetSubjectId: 'thread:root', value: 'reply words' })
  t.check("submitReply refuses the same way with no chat", rr.kind === 'dispatch-unavailable', JSON.stringify(rr))
}

t.section('§2 — the session route: delivery through the ONE door')
{
  q.resetCommandQueue()
  const seat = seatFakeConnector()
  const id = A.mintIntentId()
  const r = await A.submitDispatch({ intentId: id, kind: 'board-dispatch', value: 'resume wf_x' })
  t.check("the receipt is 'dispatch-accepted' on the session route", r.kind === 'dispatch-accepted' && r.route === 'session', JSON.stringify(r))
  t.check('the intent id echoes', r.kind === 'dispatch-accepted' && r.intentId === id)
  t.check('the words reached sendWords exactly once', seat.calls.length === 1 && seat.calls[0]?.kind === 'words' && seat.calls[0]?.text === 'resume wf_x')
  const beforeReply = seat.calls.length
  const rootReply = await A.submitReply({ intentId: A.mintIntentId(), targetSubjectId: 'thread:root', value: 'root words' })
  t.check('a root-thread reply rides sendWords too', rootReply.kind === 'dispatch-accepted' && seat.calls.length === beforeReply + 1 && seat.calls[beforeReply]?.kind === 'words')
  t.check('the cockpit-process queue stayed EMPTY through both (poison — the dead store is never written)', q.getCommandQueue().length === 0)
  seat.release()
}

t.section('§3 — empty intents refuse before any door')
{
  const seat = seatFakeConnector()
  const r = await A.submitDispatch({ intentId: A.mintIntentId(), kind: 'prompt', value: '   ' })
  t.check('an empty dispatch refuses', r.kind === 'dispatch-unavailable')
  const rr = await A.submitReply({ intentId: A.mintIntentId(), targetSubjectId: 'thread:root', value: '' })
  t.check('an empty reply refuses', rr.kind === 'dispatch-unavailable')
  t.check('no door was touched', seat.calls.length === 0)
  seat.release()
}

t.section('§4 — the agent route: the addressed form of the same door')
{
  const seat = seatFakeConnector()
  const r = await A.submitReply({ intentId: A.mintIntentId(), targetSubjectId: 'thread:ag-7', agentId: 'ag-7', value: 'revise the folio' })
  t.check('an agent-addressed reply rides sendAgentNote', r.kind === 'dispatch-accepted' && r.route === 'agent', JSON.stringify(r))
  t.check('…with the agent id and the words intact', seat.calls.some(c => c.kind === 'agent-note' && c.agentId === 'ag-7' && c.text === 'revise the folio'))
  const noAgent = await A.submitReply({ intentId: A.mintIntentId(), targetSubjectId: 'thread:seat-9', value: 'words' })
  t.check('a non-root thread with NO real agent id refuses (never an invisible sit-forever)', noAgent.kind === 'dispatch-unavailable')
  t.check('the queue stayed empty (poison)', q.getCommandQueue().length === 0)
  seat.release()
}

t.section('§5 — the pen census')
{
  t.check('submitReplaceNext is GONE (no replaceable window under instant delivery)', !('submitReplaceNext' in A))
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../../src/services/attention/actions.ts', import.meta.url), 'utf8')
  t.check('actions.ts never imports the command-queue store (poison)', !src.includes("input-core/command-queue"))
  t.check('actions.ts never speaks drainUnderUI (the marker died with its reader)', !src.includes('drainUnderUI'))
}

t.section('§6 — the addressed frame rides the ONE wire whole (cpu-pure)')
{
  const { buildConcoursePromptFrame } = await import('../../src/daemon/concourseDispatch.ts')
  const identity = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111'
  const frame = JSON.parse(
    buildConcoursePromptFrame('revise the folio', { mode: 'task-notification', agentId: 'ag-7', identity }),
  ) as Record<string, unknown>
  t.check('the frame uuid IS the clientMessageId (one identity, composer to queue entry)', frame.uuid === identity)
  t.check('the addressed form rides mode + agentId on the frame', frame.mode === 'task-notification' && frame.agentId === 'ag-7')
  const plain = JSON.parse(buildConcoursePromptFrame('plain words', { identity })) as Record<string, unknown>
  t.check('a plain frame carries NO agent addressing', plain.mode === undefined && plain.agentId === undefined)
}

t.section('§6 — the addressed frame rides the ONE wire whole (cpu-pure)')
{
  const { buildConcoursePromptFrame } = await import('../../src/daemon/concourseDispatch.ts')
  const identity = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111'
  const frame = JSON.parse(
    buildConcoursePromptFrame('revise the folio', { mode: 'task-notification', agentId: 'ag-7', identity }),
  ) as Record<string, unknown>
  t.check('the frame uuid IS the clientMessageId (one identity, composer to queue entry)', frame.uuid === identity)
  t.check('the addressed form rides mode + agentId on the frame', frame.mode === 'task-notification' && frame.agentId === 'ag-7')
  const plain = JSON.parse(buildConcoursePromptFrame('plain words', { identity })) as Record<string, unknown>
  t.check('a plain frame carries NO agent addressing', plain.mode === undefined && plain.agentId === undefined)
}

t.finish('prove-dispatch-actions')
