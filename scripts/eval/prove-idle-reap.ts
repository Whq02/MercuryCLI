#!/usr/bin/env bun
import { check, cleanup, finish, refusingBridge, loadEval, section, setup, sleep, within } from './lib.js'

const checkWithHint = (label: string, cond: boolean, detail: string | undefined, hint: string) => check(label, cond, cond ? detail : detail ? `${detail}. ${hint}` : hint)
const { work } = setup()
const { EvalKernelManager, evalJournalDir } = await loadEval()
const { listJournalOperations } = await import('../../src/platform/substrate/operationJournal.js')

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
  checkWithHint('the seed cell ran clean', p1.status === 'ok', JSON.stringify(p1.error ?? p1.annotations), 'runCell in src/tools/engines/eval-kernels/kernelManager.ts failed to run the Python cell; this check needs a working python3')
  const pids = await journalPids('owner-idle')
  checkWithHint('the journal carries the kernel pid', pids.length === 1, `pids: ${pids.join(', ')}`, 'expected one eval.kernel journal row for this owner; look at journalKernel and getOrSpawn in src/tools/engines/eval-kernels/kernelManager.ts')
  const pid = pids[0]!
  checkWithHint('the kernel is alive right after the cell', alive(pid), '', 'the kernel pid in the journal is not a live process; look at getOrSpawn in src/tools/engines/eval-kernels/kernelManager.ts')
  checkWithHint('one kernel retained', manager.kernelCount() === 1, String(manager.kernelCount()), 'runCell in src/tools/engines/eval-kernels/kernelManager.ts must keep the kernel after the cell finishes')
  const reaped = await until(8_000, () => manager.kernelCount() === 0)
  checkWithHint('the idle kernel left the manager after the TTL', reaped, String(manager.kernelCount()), 'sweep in src/tools/engines/eval-kernels/kernelManager.ts must dispose a kernel idle past idleTtlMs (600 ms here, swept every 50 ms)')
  const dead = await until(4_000, () => !alive(pid))
  checkWithHint('the kernel process is gone (kill(pid,0) census)', dead, '', 'disposeKey in src/tools/engines/eval-kernels/kernelManager.ts must kill the kernel process when sweep reaps it')
  const rowClosed = await until(4_000, async () => {
    const ops = await listJournalOperations(evalJournalDir())
    const row = ops.find(op => (op.payload as { pid?: number }).pid === pid)
    return row !== undefined && row.state === 'committed'
  })
  checkWithHint('the journal row closed at the reap', rowClosed, '', 'disposeKey in src/tools/engines/eval-kernels/kernelManager.ts must close the eval.kernel journal row as committed when the kernel is reaped')

  section('the next cell on the key is honest and fresh')
  const p2 = await run('owner-idle', 'py', 'try:\n    base\n    print("stale")\nexcept NameError:\n    print("fresh")\n')
  checkWithHint('the post-reap cell ran clean', p2.status === 'ok', JSON.stringify(p2.error ?? p2.annotations), 'runCell in src/tools/engines/eval-kernels/kernelManager.ts must spawn a fresh kernel for a key whose kernel was reaped')
  const note = p2.annotations.join(' | ')
  checkWithHint('the reap is annotated, never silent', note.includes('reaped after') && note.includes('state was reset'), note, 'getOrSpawn in src/tools/engines/eval-kernels/kernelManager.ts must push the reaped-after-idle annotation (from reapedIdle) onto the first cell after a reap')
  checkWithHint('state actually reset (NameError observed)', p2.stdout.text.includes('fresh'), p2.stdout.text, 'the cell after a reap must run on a new kernel without the old variable; the reap in sweep in src/tools/engines/eval-kernels/kernelManager.ts did not drop the old state')
  checkWithHint('a fresh kernel counts from one', p2.executionCount === 1, String(p2.executionCount), 'a respawned kernel must restart its execution count at 1; look at getOrSpawn in src/tools/engines/eval-kernels/kernelManager.ts')

  section('a running cell is never reaped mid-flight; a touched kernel keeps state')
  const p3 = await run('owner-busy', 'py', 'marker = 7\nimport time\ntime.sleep(1.2)\nprint("done")')
  checkWithHint(
    'the long cell (2x the TTL) ran to completion',
    p3.status === 'ok' && p3.stdout.text.includes('done'),
    JSON.stringify(p3.error ?? p3.annotations),
    'sweep in src/tools/engines/eval-kernels/kernelManager.ts reaped a kernel while its cell was running; a running cell must keep lastUsedAt fresh or be skipped',
  )
  checkWithHint('no mid-cell death annotation', !p3.annotations.join(' ').includes('died'), p3.annotations.join(' | '), 'a kernel died mid-cell; check that sweep in src/tools/engines/eval-kernels/kernelManager.ts does not dispose a kernel that is executing')
  const p4 = await run('owner-busy', 'py', 'marker')
  checkWithHint('state persists across cells inside the TTL', p4.resultRepr === '7', p4.resultRepr ?? `(none; notes: ${p4.annotations.join(' | ')})`, 'a kernel used within idleTtlMs must keep its variables; check that runCell in src/tools/engines/eval-kernels/kernelManager.ts refreshes lastUsedAt when a cell ends')

  section('sweep: every kernel disposed, every process gone')
  await manager.disposeAll()
  checkWithHint('the manager is empty', manager.kernelCount() === 0, String(manager.kernelCount()), 'disposeAll in src/tools/engines/eval-kernels/kernelManager.ts must remove every retained kernel')
  const allPids = [...(await journalPids('owner-idle')), ...(await journalPids('owner-busy'))]
  checkWithHint('the journal saw every spawn', allPids.length >= 3, `pids: ${allPids.join(', ')}`, 'expected at least three eval.kernel journal rows (idle, respawn, busy); journalKernel in src/tools/engines/eval-kernels/kernelManager.ts must record each spawn')
  const allDead = await until(4_000, () => allPids.every(p => !alive(p)))
  checkWithHint('no kernel process survives the sweep', allDead, allPids.filter(alive).map(String).join(', '), 'the pids listed are still alive; disposeAll and disposeKey in src/tools/engines/eval-kernels/kernelManager.ts must kill each kernel process')
} finally {
  await manager.disposeAll().catch(() => undefined)
  cleanup()
}
finish('IDLE-REAP')
