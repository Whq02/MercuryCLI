#!/usr/bin/env bun
// ============================================================================
//  scripts/eval/prove-idle-reap.ts
// PROOF: box-civility — a retained kernel idle past the
//  TTL is reaped: the process dies (kill(pid,0) census via the journal pids),
//  the journal row closes, and the NEXT cell on the key spawns fresh AND
//  SAYS SO (state loss is annotated, never silent). A running cell is never
//  reaped mid-flight — disposal rides the per-key chain — and a kernel
//  touched inside the TTL keeps its state. Scratch home; every kernel
//  disposed.
// ============================================================================
import { check, cleanup, finish, refusingBridge, loadEval, section, setup, sleep, within } from './lib.js'

const { work } = setup()
const { EvalKernelManager, evalJournalDir } = await loadEval()
const { listJournalOperations } = await import('../../src/substrate/operationJournal.js')

const manager = new EvalKernelManager({ idleTtlMs: 600, idleSweepMs: 50 })
const bridge = refusingBridge()
const run = (owner: string, language: 'py' | 'js', code: string) =>
  within(
    `${language} cell`,
    60_000,
    manager.runCell({
      owner,
      cwd: work,
      input: { language, code },
      abortSignal: new AbortController().signal,
      serveBridge: bridge,
    }),
  )

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function journalPids(owner: string): Promise<number[]> {
  const ops = await listJournalOperations(evalJournalDir())
  return ops
    .filter(op => op.kind === 'eval.kernel' && (op.payload as { owner?: string }).owner === owner)
    .map(op => (op.payload as { pid?: number }).pid)
    .filter((pid): pid is number => typeof pid === 'number')
}

async function until(ms: number, cond: () => boolean | Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await cond()) return true
    await sleep(50)
  }
  return cond()
}

try {
  section('the idle kernel is reaped: process gone, journal row closed')
  const p1 = await run('owner-idle', 'py', 'base = 21\nbase')
  check('the seed cell ran clean', p1.status === 'ok', JSON.stringify(p1.error ?? p1.annotations))
  const pids = await journalPids('owner-idle')
  check('the journal carries the kernel pid', pids.length === 1, `pids: ${pids.join(', ')}`)
  const pid = pids[0]!
  check('the kernel is alive right after the cell', alive(pid))
  check('one kernel retained', manager.kernelCount() === 1, String(manager.kernelCount()))
  const reaped = await until(8_000, () => manager.kernelCount() === 0)
  check('the idle kernel left the manager after the TTL', reaped, String(manager.kernelCount()))
  const dead = await until(4_000, () => !alive(pid))
  check('the kernel process is gone (kill(pid,0) census)', dead)
  const rowClosed = await until(4_000, async () => {
    const ops = await listJournalOperations(evalJournalDir())
    const row = ops.find(op => (op.payload as { pid?: number }).pid === pid)
    return row !== undefined && row.state === 'committed'
  })
  check('the journal row closed at the reap', rowClosed)

  section('the next cell on the key is honest and fresh')
  const p2 = await run('owner-idle', 'py', 'try:\n    base\n    print("stale")\nexcept NameError:\n    print("fresh")\n')
  check('the post-reap cell ran clean', p2.status === 'ok', JSON.stringify(p2.error ?? p2.annotations))
  const note = p2.annotations.join(' | ')
  check('the reap is annotated, never silent', note.includes('reaped after') && note.includes('state was reset'), note)
  check('state actually reset (NameError observed)', p2.stdout.text.includes('fresh'), p2.stdout.text)
  check('a fresh kernel counts from one', p2.executionCount === 1, String(p2.executionCount))

  section('a running cell is never reaped mid-flight; a touched kernel keeps state')
  const p3 = await run('owner-busy', 'py', 'marker = 7\nimport time\ntime.sleep(1.2)\nprint("done")')
  check(
    'the long cell (2x the TTL) ran to completion',
    p3.status === 'ok' && p3.stdout.text.includes('done'),
    JSON.stringify(p3.error ?? p3.annotations),
  )
  check('no mid-cell death annotation', !p3.annotations.join(' ').includes('died'), p3.annotations.join(' | '))
  const p4 = await run('owner-busy', 'py', 'marker')
  check('state persists across cells inside the TTL', p4.resultRepr === '7', p4.resultRepr ?? `(none; notes: ${p4.annotations.join(' | ')})`)

  section('sweep: every kernel disposed, every process gone')
  await manager.disposeAll()
  check('the manager is empty', manager.kernelCount() === 0, String(manager.kernelCount()))
  const allPids = [...(await journalPids('owner-idle')), ...(await journalPids('owner-busy'))]
  check('the journal saw every spawn', allPids.length >= 3, `pids: ${allPids.join(', ')}`)
  const allDead = await until(4_000, () => allPids.every(p => !alive(p)))
  check('no kernel process survives the sweep', allDead, allPids.filter(alive).map(String).join(', '))
} finally {
  await manager.disposeAll().catch(() => undefined)
  cleanup()
}
finish('IDLE-REAP')
