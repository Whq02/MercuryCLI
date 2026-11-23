#!/usr/bin/env bun
import { check as baseCheck, cleanup, finish, refusingBridge, loadEval, section, setup, sleep, within } from './lib.js'
import type { OwnerKey } from '../../src/engine/run-owner/ownerKey.js'

const { work } = setup()
const { evalKernelManager, evalJournalDir } = await loadEval()
const { listJournalOperations } = await import('../../src/platform/substrate/operationJournal.js')
const { disposeOwner, disposeAllOwnersForShutdown, ownerLifecycleCounts } = await import(
  '../../src/engine/run-owner/ownerLifecycle.js'
)

const check = (label: string, cond: boolean, detail = '', fix = ''): void => baseCheck(label, cond, cond || !fix ? detail : detail ? `${detail} — ${fix}` : fix)

const bridge = refusingBridge()
const run = (owner: string, language: 'py' | 'js', code: string) =>
  within(
    `${language} cell`,
    60_000,
    evalKernelManager.runCell({
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
  section('two owners, three kernels — the registry sees them')
  const a1 = await run('owner-close-A', 'py', 'a = 11\na')
  const a2 = await run('owner-close-A', 'js', 'const j = 22; j')
  const b1 = await run('owner-close-B', 'py', 'b = 33\nb')
  check('A py cell ran clean', a1.status === 'ok' && a1.resultRepr === '11', JSON.stringify(a1.error ?? a1.annotations), 'a cell failed on a fresh kernel; see runCell in src/tools/engines/eval-kernels/kernelManager.ts and the error printed here')
  check('A js cell ran clean', a2.status === 'ok' && a2.resultRepr === '22', JSON.stringify(a2.error ?? a2.annotations), 'a cell failed on a fresh kernel; see runCell in src/tools/engines/eval-kernels/kernelManager.ts and the error printed here')
  check('B py cell ran clean', b1.status === 'ok' && b1.resultRepr === '33', JSON.stringify(b1.error ?? b1.annotations), 'a cell failed on a fresh kernel; see runCell in src/tools/engines/eval-kernels/kernelManager.ts and the error printed here')
  const pidsA = await journalPids('owner-close-A')
  const pidsB = await journalPids('owner-close-B')
  check('the journal carries both owners (2 + 1 pids)', pidsA.length === 2 && pidsB.length === 1, `A: ${pidsA.join(', ')} · B: ${pidsB.join(', ')}`, 'every launched kernel must be journaled as an eval.kernel operation with its owner and pid; see journalKernel in src/tools/engines/eval-kernels/kernelManager.ts')
  check('every kernel process is alive', [...pidsA, ...pidsB].every(alive), '', 'a retained kernel process died before any dispose; see the kernel launch in src/tools/engines/eval-kernels/kernelManager.ts')
  check('three kernels retained', evalKernelManager.kernelCount() === 3, String(evalKernelManager.kernelCount()), 'EvalKernelManager in src/tools/engines/eval-kernels/kernelManager.ts must keep one kernel per owner and language')
  const counts = ownerLifecycleCounts()
  check("the lifecycle registry carries the 'eval-kernels' store", counts.stores['eval-kernels'] === 3, JSON.stringify(counts.stores), 'the eval-kernels store registered at the end of src/tools/engines/eval-kernels/kernelManager.ts must report its kernelCount to ownerLifecycleCounts in src/engine/run-owner/ownerLifecycle.ts')

  section("disposing owner A through the registry reaps exactly A's kernels")
  await disposeOwner('owner-close-A' as OwnerKey)
  check('only B remains in the manager', evalKernelManager.kernelCount() === 1, String(evalKernelManager.kernelCount()), 'disposeOwner in src/engine/run-owner/ownerLifecycle.ts must reach the eval-kernels store, and EvalKernelManager.disposeOwner in src/tools/engines/eval-kernels/kernelManager.ts must drop only that owner')
  const aDead = await until(4_000, () => pidsA.every(pid => !alive(pid)))
  check("A's kernel processes are gone (kill(pid,0) census)", aDead, pidsA.filter(alive).map(String).join(', '), 'EvalKernelManager.disposeOwner in src/tools/engines/eval-kernels/kernelManager.ts must kill the processes of the owner it drops (pids printed here are still alive)')
  check("B's kernel process is untouched", pidsB.every(alive), '', 'disposing owner A must not signal owner B kernels; see EvalKernelManager.disposeOwner in src/tools/engines/eval-kernels/kernelManager.ts')
  const b2 = await run('owner-close-B', 'py', 'b')
  check("B's state is intact across A's disposal", b2.resultRepr === '33', b2.resultRepr ?? `(none; notes: ${b2.annotations.join(' | ')})`, 'owner B lost its state when owner A was disposed; see EvalKernelManager.disposeOwner in src/tools/engines/eval-kernels/kernelManager.ts')
  check("B's kernel was never replaced", b2.executionCount === 2, String(b2.executionCount), 'owner B kernel was replaced when owner A was disposed; see EvalKernelManager.disposeOwner in src/tools/engines/eval-kernels/kernelManager.ts')

  section('the closed owner comes back fresh, with no stale reap note')
  const a3 = await run('owner-close-A', 'py', 'try:\n    a\n    print("stale")\nexcept NameError:\n    print("fresh")\n')
  check('the reborn cell ran clean', a3.status === 'ok', JSON.stringify(a3.error ?? a3.annotations), 'a disposed owner must get a fresh kernel on its next cell; see runCell in src/tools/engines/eval-kernels/kernelManager.ts')
  check('state was reset by the close', a3.stdout.text.includes('fresh'), a3.stdout.text, 'the disposed owner kernel kept its namespace; EvalKernelManager.disposeOwner in src/tools/engines/eval-kernels/kernelManager.ts must remove the entry')
  check('a fresh kernel counts from one', a3.executionCount === 1, String(a3.executionCount), 'the disposed owner kernel was reused; EvalKernelManager.disposeOwner in src/tools/engines/eval-kernels/kernelManager.ts must remove the entry')
  check('no idle-reap annotation leaks into a close', !a3.annotations.join(' ').includes('reaped after'), a3.annotations.join(' | '), 'the idle-reap note in src/tools/engines/eval-kernels/kernelManager.ts must be recorded only by the idle sweep, not by disposeOwner')

  section('removal is synchronous; only the drain is deferred')
  const drain = evalKernelManager.disposeOwner('owner-close-B')
  check('B is out of the manager the moment the call returns', [...(await journalPids('owner-close-B'))].length === 1 && evalKernelManager.kernelCount() === 1, String(evalKernelManager.kernelCount()), 'EvalKernelManager.disposeOwner in src/tools/engines/eval-kernels/kernelManager.ts must remove the kernel entries before it returns and only await the process drain')
  await drain
  const bDead = await until(4_000, () => pidsB.every(pid => !alive(pid)))
  check("B's kernel process is gone after the drain", bDead, '', 'the drain returned by EvalKernelManager.disposeOwner in src/tools/engines/eval-kernels/kernelManager.ts must wait for the kernel process to exit')

  section('the shutdown sweep leaves nothing behind')
  await disposeAllOwnersForShutdown()
  check('the manager is empty', evalKernelManager.kernelCount() === 0, String(evalKernelManager.kernelCount()), 'disposeAllOwnersForShutdown in src/engine/run-owner/ownerLifecycle.ts must dispose every registered store, including eval-kernels')
  const allPids = [...pidsA, ...pidsB, ...(await journalPids('owner-close-A'))]
  const allDead = await until(4_000, () => allPids.every(pid => !alive(pid)))
  check('no kernel process survives shutdown', allDead, allPids.filter(alive).map(String).join(', '), 'the shutdown sweep in src/engine/run-owner/ownerLifecycle.ts must end every kernel process; the pids printed here are still alive')
} finally {
  await evalKernelManager.disposeAll().catch(() => undefined)
  cleanup()
}
finish('CLOSE-REAP')
