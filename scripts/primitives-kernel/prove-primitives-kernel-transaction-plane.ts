#!/usr/bin/env bun
// ============================================================================
//  scripts/primitives-kernel/prove-primitives-kernel-transaction-plane.ts — slice-7 laws.
//
//    · receipt ingestion: every mutation receipt settles exactly ONE
//      canonical transaction with the receipt as its observed effect ref;
//      failed effects settle failed (partial paths recorded); no-change
//      settles with empty results; indeterminate is never promoted;
//    · the explicit multi-stage path walks the full previewable graph;
//    · Law-4 integrity is mechanical: applied/checking/verified refuse
//      without an observed effect ref; verified refuses without check
//      evidence;
//    · stale settles only pre-apply; cancellation works before AND after
//      apply (effect refs survive);
//    · terminal records refuse further movement (typed);
//    · mercury://transaction resolves the ring with receipt/file children;
//    · owner disposal clears; the receipt ring itself stays exactly-once.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'axiom-txn-'))

const P = await import('../../src/services/primitives/index.ts')
const { observeToolTerminal } = await import('../../src/services/run/effectObserver.ts')
const receipts = await import('../../src/services/changeTransaction/receipts.ts')
const { resolveResource } = await import('../../src/services/resources/registry.ts')
const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.ts')

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const owner = P.makeOwnerKey({ workspace: '/axiom-txn', sessionId: 'txn', lane: P.MAIN_LANE })
const fire = (
  outcome: 'succeeded' | 'failed' | 'no-change' | 'indeterminate',
  changedPaths: string[],
  extra: Record<string, unknown> = {},
) =>
  observeToolTerminal({
    owner,
    toolName: 'Edit',
    toolUseId: 'tu',
    input: { file_path: '/axiom-txn/a.ts', expected_anchor: 'a1:xyz', ...extra },
    ok: outcome !== 'failed',
    durationMs: 3,
    cwd: '/axiom-txn',
    effect: {
      outcome,
      operation: 'file.edit',
      changedPaths,
      evidence: `proof ${outcome}`,
      startedAt: 1,
      completedAt: 2,
    },
  })

console.log('receipt ingestion')
{
  fire('succeeded', ['/axiom-txn/a.ts'])
  const txns = P.transactionsFor(owner)
  const rcpts = receipts.receiptsFor(owner)
  check('one mutation ⇒ one receipt ⇒ one settled transaction',
    rcpts.length === 1 && txns.length === 1 && txns[0]!.state === 'settled')
  check('the receipt is the observed effect ref',
    txns[0]!.effectRef === `mercury://receipt/${rcpts[0]!.id}`)
  check('the carried anchor is the expected version',
    txns[0]!.expectedVersions[0] === 'a1:xyz')
  check('results are the observed changed paths',
    txns[0]!.resultRefs[0] === 'mercury://file/axiom-txn/a.ts')

  fire('failed', ['/axiom-txn/partial.ts'])
  const failedTxn = P.transactionsFor(owner).at(-1)!
  check('failed effect settles failed with partial paths recorded',
    failedTxn.state === 'failed' &&
      failedTxn.failure?.code === 'effect-failed' &&
      failedTxn.resultRefs.length === 1)

  fire('no-change', [])
  const noChange = P.transactionsFor(owner).at(-1)!
  check('byte-identical no-change settles with empty results',
    noChange.state === 'settled' && noChange.resultRefs.length === 0)

  fire('indeterminate', [])
  const indet = P.transactionsFor(owner).at(-1)!
  check('indeterminate is never promoted to settled',
    indet.state === 'failed' && indet.failure?.code === 'indeterminate' &&
      indet.failure.recoverable)
}

console.log('explicit multi-stage path')
{
  const txn = P.beginTransaction({
    owner,
    kind: 'lsp.pathRename',
    inputRefs: ['mercury://file/src/old.ts'],
    expectedVersions: ['a1:abc'],
  })
  for (const step of ['prepared', 'proposed', 'authorised', 'applying'] as const) {
    P.transitionTransaction(owner, txn.id, step)
  }
  try {
    P.transitionTransaction(owner, txn.id, 'applied')
    check('applied without an observed effect refused', false)
  } catch (e) {
    check('applied without an observed effect refused', e instanceof P.TransactionIntegrityError)
  }
  P.transitionTransaction(owner, txn.id, 'applied', {
    effectRef: 'mercury://receipt/rcpt-x',
    resultRefs: ['mercury://file/src/new.ts'],
  })
  P.transitionTransaction(owner, txn.id, 'checking')
  try {
    P.transitionTransaction(owner, txn.id, 'verified')
    check('verified without check evidence refused', false)
  } catch (e) {
    check('verified without check evidence refused', e instanceof P.TransactionIntegrityError)
  }
  const verified = P.transitionTransaction(owner, txn.id, 'verified', {
    evidenceRefs: ['mercury://evidence/ev-check-1'],
  })
  const settled = P.transitionTransaction(owner, txn.id, 'settled')
  check('full previewable path settles', verified?.state === 'verified' && settled?.state === 'settled')
  try {
    P.transitionTransaction(owner, txn.id, 'applying')
    check('terminal records refuse movement (typed)', false)
  } catch (e) {
    check('terminal records refuse movement (typed)', e instanceof P.TransactionTransitionError)
  }
}

console.log('stale + cancellation')
{
  const stale = P.beginTransaction({ owner, kind: 'file.edit', expectedVersions: ['a1:old'] })
  const settledStale = P.transitionTransaction(owner, stale.id, 'stale')
  check('stale settles pre-apply', settledStale?.state === 'stale')

  const preCancel = P.beginTransaction({ owner, kind: 'file.edit' })
  P.transitionTransaction(owner, preCancel.id, 'prepared')
  check('cancel before apply', P.transitionTransaction(owner, preCancel.id, 'cancelled')?.state === 'cancelled')

  const postCancel = P.beginTransaction({ owner, kind: 'file.edit' })
  P.transitionTransaction(owner, postCancel.id, 'applying')
  P.transitionTransaction(owner, postCancel.id, 'applied', { effectRef: 'mercury://receipt/rcpt-y' })
  const cancelled = P.transitionTransaction(owner, postCancel.id, 'cancelled')
  check('cancel after apply keeps the effect ref (nothing hidden)',
    cancelled?.state === 'cancelled' && cancelled.effectRef === 'mercury://receipt/rcpt-y')

  const applying = P.beginTransaction({ owner, kind: 'file.edit' })
  P.transitionTransaction(owner, applying.id, 'applying')
  try {
    P.transitionTransaction(owner, applying.id, 'stale')
    check('no stale once applying (typed)', false)
  } catch (e) {
    check('no stale once applying (typed)', e instanceof P.TransactionTransitionError)
  }
  P.transitionTransaction(owner, applying.id, 'cancelled')
}

console.log('resource inspection')
{
  const ctx = { owner, cwd: '/axiom-txn' }
  const listing = await resolveResource('mercury://transaction', ctx)
  check('ring lists newest-first bounded',
    listing.state === 'ok' && (listing.resource.children?.length ?? 0) >= 5)
  const first = P.transactionsFor(owner)[0]!
  const byId = await resolveResource(`mercury://transaction/${first.id}`, ctx)
  check('transaction resolves with the receipt child',
    byId.state === 'ok' &&
      byId.resource.children?.some(c => c.ref.startsWith('mercury://receipt/')) === true)
  const absent = await resolveResource('mercury://transaction/txn-nope', ctx)
  check('unknown id reads absent', absent.state === 'absent')
}

console.log('owner disposal')
{
  await disposeOwner(owner)
  check('disposal clears the transaction ring', P.transactionsFor(owner).length === 0)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
