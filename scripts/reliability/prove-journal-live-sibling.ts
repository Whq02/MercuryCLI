#!/usr/bin/env bun

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

console.log('L3 an unregistered same-pid record (prior generation) still recovers')
{
  const dir2 = mkdtempSync(join(tmpdir(), 'journal-reuse-'))

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

console.log('L4 the generic walker rides the one liveness owner')
{
  const src = readFileSync(join(SRC, 'substrate/operationJournal.ts'), 'utf8')
  const walkerAt = src.indexOf('export async function recoverJournalDir')
  const walker = walkerAt >= 0 ? src.slice(walkerAt, walkerAt + 1200) : ''
  ok(walker.includes('isJournalWriterAlive(op)'), 'L4 recoverJournalDir consults isJournalWriterAlive')
  ok(!walker.includes('pidAlive(op.writerPid) && op.writerPid !== process.pid'), 'L4 the inline pid test is gone from the walker')
}

console.log('L5 a live writer this process may not signal (EPERM) is alive to the sweep, never compensated')
{
  const unsignalable = [4, 1].find(pid => {
    try {
      process.kill(pid, 0)
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  })
  if (unsignalable === undefined) {
    console.log('  [SKIP] no process on this host answers EPERM to a liveness probe (the proof runs privileged)')
  } else {
    const dir3 = mkdtempSync(join(tmpdir(), 'journal-eperm-'))
    const seed = await journal
      .runJournaledOperation({
        journalDir: dir3,
        ownerKey: 'eperm-owner',
        kind: 'proof-eperm',
        idempotencyKey: 'eperm-op',
        steps: [{ id: 's1', target: 'x', run: async () => ({}) }],
        result: () => ({ ok: true }),
      })
      .then((o: { operationId: string }) => o)
    const committed = ((await journal.listJournalOperations(dir3)) as Array<Record<string, unknown>>).find(o => o.operationId === seed.operationId)!
    await journal.republishJournalOperation(dir3, {
      ...committed,
      state: 'applying',
      writerPid: unsignalable,
      steps: (committed.steps as Array<Record<string, unknown>>).map(s => ({ ...s, state: 'pending' })),
    })
    const foreign = ((await journal.listJournalOperations(dir3)) as Array<Record<string, unknown>>).find(o => o.operationId === seed.operationId)!
    ok(journal.isJournalWriterAlive(foreign) === true, `L5 a record whose writer (pid ${unsignalable}) answers the probe with EPERM classifies ALIVE`, `alive=${String(journal.isJournalWriterAlive(foreign))}`)
    let compensatedForeign = 0
    const summary = (await journal.recoverJournalDir(dir3, {
      'proof-eperm': {
        compensate: async () => {
          compensatedForeign++
        },
      },
    })) as { compensated: string[]; waiting: string[] }
    ok(summary.waiting.includes(seed.operationId) && compensatedForeign === 0, 'L5 the sweep waits on it and never runs its compensator', JSON.stringify(summary))
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
