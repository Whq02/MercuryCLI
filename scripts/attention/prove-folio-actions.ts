#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/prove-folio-actions.ts — C1: the folio's
//  actions.
//
//  EXPECT-RED at the pre-fix tree (the module is the fix), promoted in the
//  same commit. Behavioral against a SCRATCH review store (the folio
//  journey's isolation seam — the live store is never touched).
//
//    §1 DECISIONS — accept / mark-reviewed / request-revision land the
//       store's own status vocabulary; refusals pass through verbatim.
//    §2 IDEMPOTENCE — a replayed intentId returns its receipt with NO
//       second owner write (journal length pinned).
//    §3 FEEDBACK ROUTES — the producing session rides the main queue; a
//       live producer agent rides the addressed lane; owner-unavailable
//       RETAINS with the honest offer (the comments already live durably).
//    §4 ANCHOR HONESTY LIVE — an md-block comment either RELOCATES
//       to the moved block or reads OUTDATED after a revision; never a
//       silent wrong anchor.
// ============================================================================
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
process.env.MERCURY_REVIEW_ARTIFACTS_DIR = mkdtempSync(join(tmpdir(), 'rv-folio-actions-'))

let m: typeof import('../../src/services/workbench/folioActions.ts') | null = null
try {
  m = await import('../../src/services/workbench/folioActions.ts')
} catch {
  m = null
}
if (!m || typeof m.applyFolioAction !== 'function') {
  t.check('folioActions loads with applyFolioAction', false, 'module or export absent')
  t.finish('prove-folio-actions')
}
const A = m!
const store = await import('../../src/utils/artifacts/reviewStore.ts')
const { listMdBlocks } = await import('../../src/utils/artifacts/anchors.ts')
const q = await import('../../src/input-core/command-queue.ts')
const focused = await import('../../src/services/engine-connector/focusedConnector.ts')
// The delivery door, fake and same-tick: the folio routes are proven by
// WHAT reached WHICH door — the cockpit-process queue must stay untouched.
const doorCalls: Array<{ kind: 'words' | 'agent-note'; text: string; agentId?: string }> = []
focused.setFocusedSessionConnector({
  carrier: 'daemon',
  sessionId: () => 'folio-fake',
  sendWords: async (text: string) => {
    doorCalls.push({ kind: 'words', text })
    return { state: 'accepted' as const }
  },
  sendAgentNote: async (agentId: string, text: string) => {
    doorCalls.push({ kind: 'agent-note', text, agentId })
    return { state: 'accepted' as const }
  },
} as never)

const mk = (title: string, md: string): string => {
  const r = store.createReviewArtifact({
    kind: 'plan',
    title,
    producer: { sessionId: 'someone-else' },
    workspace: { roots: [process.cwd()] },
    body: { kind: 'plan', markdown: md },
    initialStatus: 'ready-for-review',
  })
  if (!r.ok) throw new Error(r.reason)
  return r.value.id
}

t.section('§1 — decisions land the store vocabulary')
{
  // Separate artifacts per decision — the store's transition legality is
  // part of the contract (accepted is terminal; refusals §1c pin it).
  const id = mk('decide me', '# plan\n\nblock one')
  const r1 = await A.applyFolioAction({ intentId: 'i1', kind: 'accept', artifactId: id, version: 1, by: 'operator' })
  t.check("accept → 'accepted'", r1.kind === 'applied' && r1.status === 'accepted')
  const idB = mk('revise me', '# plan\n\nblock one')
  const r2 = await A.applyFolioAction({ intentId: 'i2', kind: 'request-revision', artifactId: idB, version: 1 })
  t.check("request-revision → 'revision-requested'", r2.kind === 'applied' && r2.status === 'revision-requested', r2.kind === 'refused' ? r2.reason : r2.kind)
  const r2b = await A.applyFolioAction({ intentId: 'i2b', kind: 'request-revision', artifactId: id, version: 1 })
  t.check('an ILLEGAL transition (accepted → revision-requested) refuses verbatim', r2b.kind === 'refused' && r2b.reason.includes('illegal'), r2b.kind)
  const r3 = await A.applyFolioAction({ intentId: 'i3', kind: 'mark-reviewed', artifactId: id, version: 99 })
  t.check('a bad version refuses verbatim', r3.kind === 'refused' && r3.reason.includes('no version'))
}

t.section('§2 — idempotent replay (no second owner write)')
{
  const id = mk('replay me', '# plan\n\nblock')
  const before = store.readReviewArtifactJournal(id).length
  const a = await A.applyFolioAction({ intentId: 'dup-1', kind: 'accept', artifactId: id, version: 1 })
  const afterOnce = store.readReviewArtifactJournal(id).length
  const b = await A.applyFolioAction({ intentId: 'dup-1', kind: 'accept', artifactId: id, version: 1 })
  const afterTwice = store.readReviewArtifactJournal(id).length
  t.check('the first apply wrote ONE status event', afterOnce === before + 1)
  t.check(
    'the replay returned the SAME receipt with NO second write',
    b === a && afterTwice === afterOnce,
  )
}

t.section('§3 — the feedback routes')
{
  const id = mk('route me', '# plan\n\nblock')
  store.addReviewComment({ artifactId: id, version: 1, anchor: { t: 'whole' }, author: 'op', body: 'tighten the tail' })
  // Owner unavailable: foreign producer, no agent id → retained honestly.
  const r1 = await A.applyFolioAction({ intentId: 'f1', kind: 'send-feedback', artifactId: id, version: 1 })
  t.check(
    'owner-unavailable RETAINS with the honest offer',
    r1.kind === 'feedback-retained' && r1.retained === 1 && r1.reason.includes('retained'),
  )
  // A live producer agent rides the door's addressed form.
  doorCalls.length = 0
  const r2 = await A.applyFolioAction({
    intentId: 'f2',
    kind: 'send-feedback',
    artifactId: id,
    version: 1,
    producerAgentId: 'agent-77',
  })
  t.check(
    "a live producer agent rides sendAgentNote (route 'agent')",
    r2.kind === 'feedback-routed' &&
      r2.route === 'agent' &&
      doorCalls.length === 1 &&
      doorCalls[0]!.kind === 'agent-note' &&
      doorCalls[0]!.agentId === 'agent-77' &&
      doorCalls[0]!.text.includes('tighten the tail'),
  )
  t.check('the cockpit-process queue stayed untouched (poison)', q.getCommandQueue().length === 0)
  // No open comments → honest refusal.
  const id2 = mk('empty me', '# plan\n\nblock')
  const r3 = await A.applyFolioAction({ intentId: 'f3', kind: 'send-feedback', artifactId: id2, version: 1 })
  t.check('no open comments refuses honestly', r3.kind === 'refused')

  // The PRODUCING SESSION route (wave-C review: the header claimed it, no
  // leg drove it — every artifact was minted foreign): an artifact THIS
  // session produced routes its feedback onto the MAIN command queue.
  q.resetCommandQueue()
  const { getSessionId } = await import('../../src/bootstrap/state.ts')
  const own = store.createReviewArtifact({
    kind: 'plan',
    title: 'my own plan',
    producer: { sessionId: getSessionId() },
    workspace: { roots: [process.cwd()] },
    body: { kind: 'plan', markdown: '# plan\n\nmine' },
    initialStatus: 'ready-for-review',
  })
  if (!own.ok) throw new Error(own.reason)
  store.addReviewComment({ artifactId: own.value.id, version: 1, anchor: { t: 'whole' }, author: 'op', body: 'sharpen it' })
  doorCalls.length = 0
  const r4 = await A.applyFolioAction({ intentId: 'f4', kind: 'send-feedback', artifactId: own.value.id, version: 1 })
  t.check(
    "the producing session rides sendWords (route 'session')",
    r4.kind === 'feedback-routed' &&
      r4.route === 'session' &&
      doorCalls.length === 1 &&
      doorCalls[0]!.kind === 'words' &&
      doorCalls[0]!.text.includes('sharpen it'),
    JSON.stringify({ kind: r4.kind, doorCalls: doorCalls.length }),
  )

  // The agent lane from the ARTIFACT'S OWN producer binding (wave-C review:
  // the board never supplies producerAgentId — the owner fallback is the
  // one path production can reach).
  const bound = store.createReviewArtifact({
    kind: 'plan',
    title: 'agent-bound plan',
    producer: { sessionId: 'someone-else', agentId: 'agent-88' },
    workspace: { roots: [process.cwd()] },
    body: { kind: 'plan', markdown: '# plan\n\nbound' },
    initialStatus: 'ready-for-review',
  })
  if (!bound.ok) throw new Error(bound.reason)
  store.addReviewComment({ artifactId: bound.value.id, version: 1, anchor: { t: 'whole' }, author: 'op', body: 'from the binding' })
  doorCalls.length = 0
  const r5 = await A.applyFolioAction({ intentId: 'f5', kind: 'send-feedback', artifactId: bound.value.id, version: 1 })
  t.check(
    'the artifact\'s own producer.agentId reaches the addressed door without caller help',
    r5.kind === 'feedback-routed' &&
      doorCalls.length === 1 &&
      doorCalls[0]!.agentId === 'agent-88',
    JSON.stringify({ kind: r5.kind, doorCalls: doorCalls.length }),
  )
}

t.section('§4 — anchor honesty across a revision (RV-25, live)')
{
  const md1 = '# plan\n\nalpha block\n\n## tail\n\nbeta block'
  const id = mk('anchor me', md1)
  // BOTH honest directions pinned exactly (an either/or form is vacuous
  // here: a fixture anchored to the one block guaranteed to survive never
  // exercises its OUTDATED arm):
  // the '# plan' heading block survives the rewrite BYTE-IDENTICAL (honest
  // relocation), the 'beta block' vanishes (the ONLY honest outcome is
  // outdated — a silent re-anchor to different content is the forbidden
  // guess).
  const blocks = listMdBlocks(md1)
  const surviving = blocks.find(b => b.text === '# plan')!
  const vanishing = blocks.find(b => /beta/.test(b.text))!
  const cKeep = store.addReviewComment({
    artifactId: id,
    version: 1,
    anchor: { t: 'md-block', headingPath: surviving.headingPath, blockDigest: surviving.digest, ordinal: 0 },
    author: 'op',
    body: 'anchored to the surviving heading block',
  })
  const cGone = store.addReviewComment({
    artifactId: id,
    version: 1,
    anchor: { t: 'md-block', headingPath: vanishing.headingPath, blockDigest: vanishing.digest, ordinal: 0 },
    author: 'op',
    body: 'anchored to the vanishing block',
  })
  t.check('(rig) both md-block comments landed', cKeep.ok === true && cGone.ok === true)
  const rev = store.reviseReviewArtifact({
    id,
    body: { kind: 'plan', markdown: '# plan\n\nREWRITTEN ENTIRELY\n\nnothing survives' },
    producer: { sessionId: 'someone-else' },
    workspace: { roots: [process.cwd()] },
  })
  t.check('(rig) v2 landed', rev.ok === true)
  const state = store.readReviewArtifactState(id)!
  const kept = state.comments.find(c => c.body === 'anchored to the surviving heading block')!
  const gone = state.comments.find(c => c.body === 'anchored to the vanishing block')!
  t.check(
    'the surviving-content comment RELOCATED (version moved, state open)',
    kept.state === 'open' && kept.version === 2,
    `state=${kept.state} v=${kept.version}`,
  )
  t.check(
    'the vanished-content comment reads OUTDATED — never a silent wrong anchor',
    gone.state === 'outdated',
    `state=${gone.state} v=${gone.version}`,
  )
}

t.finish('prove-folio-actions')
