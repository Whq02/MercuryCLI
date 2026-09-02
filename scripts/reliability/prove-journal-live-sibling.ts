#!/usr/bin/env bun
// ============================================================================
//  prove-journal-live-sibling — a journal sweep never treats a live
//  same-process operation as a dead writer (release-hardening audit rank 27).
//
//  The gap: isJournalWriterAlive was pidAlive(writerPid) && writerPid !==
//  process.pid — an op recorded by THIS process was classified not-alive
//  whether it was a prior generation's leftover or a sibling executing
//  right now. Two multi-file applies running concurrently inside one
//  process qualify (parallel sub-agents each run their own tool loop, and
//  ChangeSet/Structure/AstEdit/LSP applies funnel into the shared commit
//  core): the in-process path locks cover only a commit's own paths, and
//  the journal's per-directory chain serialises only the journalled
//  section — not the pre-commit sweep. So one agent's sweep compensated
//  the sibling's mid-flight operation: the sibling's multi-file edit was
//  silently undone under it, and it reported an apply failure on an
//  internal temp path with nothing wrong in its plan. The generic
//  recoverJournalDir walker carried its own inline copy of the same bare
//  pid test.
//
//   L1 a live sibling's record answers alive while it is inside
//      runJournaledOperation, and dead once it settles
//   L2 recoverJournalDir beside the live sibling reports it WAITING and
//      compensates nothing; the sibling then commits untouched
//   L3 pid-reuse control: an UNREGISTERED same-pid record (a prior
//      generation's leftover) still classifies dead and is recovered
//   L4 one liveness owner (structural): the generic walker rides
//      isJournalWriterAlive, not an inline pid test
//
//  PROVE_SRC names another checkout's src (the A/B control: against the
//  pre-fix tree L1, L2 and L4 read red; L3 stays green).
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const journal = await import(join(SRC, 'substrate/operationJournal.ts'))

let failures = 0
const ok = (cond: boolean, label: string, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'journal-sibling-'))

// ── L1 + L2: the live sibling ──────────────────────────────────────────────
console.log('L1/L2 a live same-process sibling is alive to every sweep')
{
  let releaseStep!: () => void
  const stepGate = new Promise<void>(resolve => {
    releaseStep = resolve
  })
  let midStep!: () => void
  const reachedStep = new Promise<void>(resolve => {
    midStep = resolve
  })
  let compensated = 0

  const sibling = journal.runJournaledOperation({
    journalDir: dir,
    ownerKey: 'sibling-owner',
    kind: 'proof-live-sibling',
    idempotencyKey: 'sibling-apply',
    steps: [
      {
        id: 's1',
        target: 'file-a',
        run: async () => {
          midStep()
          await stepGate
          return {}
        },
      },
    ],
    compensate: async () => {
      compensated++
    },
    result: () => ({ done: true }),
  }) as Promise<{ outcome: string }>

  await reachedStep
  const opsWhileLive = (await journal.listJournalOperations(dir)) as Array<Record<string, unknown>>
  const liveOp = opsWhileLive.find(o => o.kind === 'proof-live-sibling')
  ok(liveOp !== undefined && liveOp.state === 'applying', 'L1 the sibling is mid-operation on disk', `state=${String(liveOp?.state)}`)
  ok(liveOp !== undefined && journal.isJournalWriterAlive(liveOp) === true, 'L1 its record answers ALIVE while it runs', `isJournalWriterAlive=${String(liveOp && journal.isJournalWriterAlive(liveOp))}`)

  // The sweep beside it — the generic walker with a compensator registered
  // for the kind (the blind dead-writer default this proof exists to stop).
  let walkerCompensations = 0
  const summary = (await journal.recoverJournalDir(dir, {
    'proof-live-sibling': {
      compensate: async () => {
        walkerCompensations++
      },
    },
  })) as { waiting: string[]; compensated: string[] }
  ok(summary.waiting.length === 1 && summary.compensated.length === 0 && walkerCompensations === 0, 'L2 the sweep reports the live sibling WAITING and compensates nothing', JSON.stringify(summary))

  releaseStep()
  const outcome = await sibling
  ok(outcome.outcome === 'committed', 'L2 the sibling commits untouched', `outcome=${outcome.outcome}`)
  const opsAfter = (await journal.listJournalOperations(dir)) as Array<Record<string, unknown>>
  const settled = opsAfter.find(o => o.kind === 'proof-live-sibling')
  ok(settled !== undefined && settled.state === 'committed' && compensated === 0, 'L2 the record is committed on disk and its compensator never ran', `state=${String(settled?.state)} compensated=${compensated}`)
  ok(settled !== undefined && journal.isJournalWriterAlive(settled) === false, 'L1 a settled record answers dead again (the registry is a bracket, not a leak)')
}

// ── L3: pid-reuse control ──────────────────────────────────────────────────
console.log('L3 an unregistered same-pid record (prior generation) still recovers')
{
  const dir2 = mkdtempSync(join(tmpdir(), 'journal-reuse-'))
  // A leftover written by "this pid" in a previous life: forged directly
  // through the journal's own publisher road by running an op that FAILS
  // mid-step, then rewriting nothing — its terminal state is 'aborted', so
  // instead forge a non-terminal record via republishJournalOperation.
  const seed = await journal
    .runJournaledOperation({
      journalDir: dir2,
      ownerKey: 'reuse-owner',
      kind: 'proof-reuse',
      idempotencyKey: 'reuse-op',
      steps: [{ id: 's1', target: 'x', run: async () => ({}) }],
      result: () => ({ ok: true }),
    })
    .then((o: { operationId: string }) => o)
  const ops = (await journal.listJournalOperations(dir2)) as Array<Record<string, unknown>>
  const committed = ops.find(o => o.operationId === seed.operationId)!
  // Republish it as if a prior same-pid generation died mid-apply.
  await journal.republishJournalOperation(dir2, {
    ...committed,
    state: 'applying',
    steps: (committed.steps as Array<Record<string, unknown>>).map(s => ({ ...s, state: 'pending' })),
  })
  const forged = ((await journal.listJournalOperations(dir2)) as Array<Record<string, unknown>>).find(
    o => o.operationId === seed.operationId,
  )!
  ok(journal.isJournalWriterAlive(forged) === false, 'L3 the unregistered same-pid record classifies DEAD', `alive=${String(journal.isJournalWriterAlive(forged))}`)
  let recovered = 0
  const summary = (await journal.recoverJournalDir(dir2, {
    'proof-reuse': {
      compensate: async () => {
        recovered++
      },
    },
  })) as { compensated: string[]; waiting: string[] }
  ok(summary.compensated.length === 1 && recovered === 1, 'L3 the sweep recovers it (the dead-writer road still works)', JSON.stringify(summary))
}

// ── L4: one liveness owner ─────────────────────────────────────────────────
console.log('L4 the generic walker rides the one liveness owner')
{
  const src = readFileSync(join(SRC, 'substrate/operationJournal.ts'), 'utf8')
  const walkerAt = src.indexOf('export async function recoverJournalDir')
  const walker = walkerAt >= 0 ? src.slice(walkerAt, walkerAt + 1200) : ''
  ok(walker.includes('isJournalWriterAlive(op)'), 'L4 recoverJournalDir consults isJournalWriterAlive')
  ok(!walker.includes('pidAlive(op.writerPid) && op.writerPid !== process.pid'), 'L4 the inline pid test is gone from the walker')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
