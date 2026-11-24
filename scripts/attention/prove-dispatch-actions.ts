#!/usr/bin/env bun
import { checker } from '../engine-durability/harness.ts'

const t = checker()

let m: typeof import('../../src/screen/attention/actions.ts') | null = null
try {
  m = await import('../../src/screen/attention/actions.ts')
} catch {
  m = null
}
if (!m) {
  t.check('src/screen/attention/actions.ts loads', false, 'module absent')
  t.finish('prove-dispatch-actions')
}
const A = m!
const q = await import('../../src/screen/composer/input-core/command-queue.ts')
const focused = await import('../../src/engine/connector/focusedConnector.ts')

type SendCall = { kind: 'words' | 'agent-note'; text: string; agentId?: string }

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
  const r = await A.submitDispatch({ intentId: A.mintIntentId(), kind: 'board-dispatch', value: 'resume wf_x' })
  t.check(
    "with NO chat open the receipt is 'dispatch-unavailable' (the old road LIED 'dispatch-accepted' into a store nothing reads)",
    r.kind === 'dispatch-unavailable',
    JSON.stringify(r),
  )
  t.check('…and the cockpit-process queue took NOTHING (poison)', q.getCommandQueue().length === 0, JSON.stringify(q.getCommandQueue().map(c => c.value)))
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
  t.check('the cockpit-process queue stayed EMPTY through both (poison — the dead store is never written)', q.getCommandQueue().length === 0)
  seat.release()
}

t.section('§3 — empty intents refuse before any door')
{
  const seat = seatFakeConnector()
  const r = await A.submitDispatch({ intentId: A.mintIntentId(), kind: 'prompt', value: '   ' })
  t.check('an empty dispatch refuses', r.kind === 'dispatch-unavailable')
  t.check('no door was touched', seat.calls.length === 0)
  seat.release()
}

t.section('§5 — the pen census')
{
  t.check('submitReplaceNext is GONE (no replaceable window under instant delivery)', !('submitReplaceNext' in A))
}

t.section('§6 — the addressed row rides the ONE door whole (cpu-pure)')
{
  const { buildConcoursePromptRow } = await import('../../src/daemon/concourse-workers/concourseDispatch.ts')
  const identity = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111'
  const row = (await buildConcoursePromptRow('revise the folio', { mode: 'task-notification', agentId: 'ag-7', identity })) as Record<string, unknown>
  t.check('the row id IS the clientMessageId (one identity, composer to queue entry)', row.id === identity)
  t.check('the addressed form is a note row addressed to the agent', row.type === 'note' && row.to === 'ag-7' && row.content === 'revise the folio')
  const plain = (await buildConcoursePromptRow('plain words', { identity })) as Record<string, unknown>
  t.check('a plain row is a prompt row with NO agent addressing', plain.type === 'prompt' && plain.to === undefined)
}

t.finish('prove-dispatch-actions')
