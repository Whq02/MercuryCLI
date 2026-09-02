#!/usr/bin/env bun
// ============================================================================
//  scripts/eval/prove-kernel-cancel.ts
//  PROOF (spec c.4 #2): the cancellation lattice — runtime-budget interrupt
//  (Python survives with state; JS recreates, annotated), abort-signal
//  interrupt, escalation kill on stuck native code, idle-SIGINT immunity,
//  stdin refusal, dead-kernel retry-once. Deterministic: every wait is
//  bounded and every timing assertion is one-sided (a budget MUST fire; no
//  upper-bound flake).
// ============================================================================
import { check, cleanup, finish, refusingBridge, loadEval, section, setup, sleep, within } from './lib.js'

const { work } = setup()
const { evalKernelManager } = await loadEval()
const bridge = refusingBridge()

const run = (
  language: 'py' | 'js',
  code: string,
  extra: Partial<{ reset: boolean; timeoutSeconds: number }> = {},
  abortSignal: AbortSignal = new AbortController().signal,
) =>
  within(
    `${language} cell`,
    90_000,
    evalKernelManager.runCell({
      owner: 'cancel-owner',
      cwd: work,
      input: { language, code, ...extra },
      abortSignal,
      serveBridge: bridge,
    }),
  )

try {
  section('runtime budget interrupts Python; the kernel SURVIVES with state')
  const seed = await run('py', 'kept = 7')
  check('seed cell ok', seed.status === 'ok')
  const b1 = await run('py', 'import time\nwhile True:\n    time.sleep(0.05)\n', { timeoutSeconds: 1 })
  check('budget cell cancelled', b1.status === 'cancelled', b1.status)
  check('cancellation annotated with the budget reason', b1.annotations.some(a => a.includes('runtime budget')), JSON.stringify(b1.annotations))
  check('survival + reset guidance annotated', b1.annotations.some(a => a.includes('kernel survived')), JSON.stringify(b1.annotations))
  const b2 = await run('py', 'kept')
  check('python state SURVIVED the interrupt', b2.status === 'ok' && b2.resultRepr === '7', b2.resultRepr ?? JSON.stringify(b2.error))

  section('JS cancel: honoured for await-shaped code; kernel recreated honestly')
  const j0 = await run('js', 'var jsKept = 1')
  check('js seed ok', j0.status === 'ok')
  const j1 = await run('js', 'await new Promise(r => setTimeout(r, 60_000))', { timeoutSeconds: 1 })
  check('js await cell cancelled', j1.status === 'cancelled', j1.status)
  check('js recreation annotated (state reset is honest)', j1.annotations.some(a => a.includes('recreated')), JSON.stringify(j1.annotations))
  const j2 = await run('js', "typeof jsKept === 'undefined' ? 'reset' : 'kept'")
  check('js kernel really was recreated', j2.status === 'ok' && j2.resultRepr === "'reset'", j2.resultRepr)

  section('escalation kill: a stuck busy-loop that never honours SIGINT')
  const e1 = await run('js', 'for (;;) {}', { timeoutSeconds: 1 })
  check('stuck cell settles cancelled (not a hang)', e1.status === 'cancelled', e1.status)
  check('escalation annotated (killed, recreate next call)', e1.annotations.some(a => a.includes('not honoured') || a.includes('killed')), JSON.stringify(e1.annotations))
  const e2 = await run('js', "'alive'")
  check('next call gets a fresh working kernel', e2.status === 'ok' && e2.resultRepr === "'alive'", e2.resultRepr)

  section('abort signal cancels a cell')
  const controller = new AbortController()
  const pending = run('py', 'import time\ntime.sleep(120)\n', { timeoutSeconds: 0 }, controller.signal)
  await sleep(700)
  controller.abort()
  const a1 = await pending
  check('aborted cell reports cancelled', a1.status === 'cancelled', a1.status)
  check('abort annotated as user abort', a1.annotations.some(a => a.includes('abort')), JSON.stringify(a1.annotations))

  section('idle-SIGINT immunity: a stray signal cannot kill a parked kernel')
  const i0 = await run('py', 'idle_mark = 3')
  check('idle seed ok', i0.status === 'ok')
  // Reach into the manager's registry indirectly: a stray SIGINT to every
  // child python of THIS process while no cell runs.
  const { execSync } = await import('node:child_process')
  const pids = execSync(`pgrep -P ${process.pid} || true`, { encoding: 'utf8' })
    .split('\n')
    .map(line => Number(line.trim()))
    .filter(pid => Number.isFinite(pid) && pid > 0)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGINT')
    } catch {
      /* not ours */
    }
  }
  await sleep(300)
  const i1 = await run('py', 'idle_mark')
  check('kernel ignored the stray idle SIGINT (state intact)', i1.status === 'ok' && i1.resultRepr === '3', i1.resultRepr ?? JSON.stringify(i1.error))

  section('interactive stdin is a typed refusal, never a hang')
  const s1 = await run('py', 'input()', { timeoutSeconds: 10 })
  check('input() refused with a typed error', s1.status === 'error' && (s1.error?.value ?? '').includes('stdin'), JSON.stringify(s1.error))

  section('dead-kernel retry-once: an externally killed kernel mid-cell')
  const k0 = await run('py', 'import os\nmy_pid = os.getpid()\nmy_pid')
  const kernelPid = Number(k0.resultRepr)
  check('read the kernel pid', Number.isFinite(kernelPid) && kernelPid > 0, k0.resultRepr)
  const killer = (async (): Promise<void> => {
    await sleep(600)
    try {
      process.kill(kernelPid, 'SIGKILL')
    } catch {
      /* raced */
    }
  })()
  const k1 = await run('py', 'import time\ntime.sleep(2)\n', { timeoutSeconds: 0 })
  await killer
  check('cell settled despite the murdered kernel', k1.status === 'ok' || k1.status === 'error', k1.status)
  check('retry-once annotated', k1.annotations.some(a => a.includes('retried once')), JSON.stringify(k1.annotations))
  const k2 = await run('py', "'fresh'")
  check('replacement kernel serves the next cell', k2.status === 'ok' && k2.resultRepr === "'fresh'", k2.resultRepr)
} finally {
  await evalKernelManager.disposeAll()
  check('no kernel left behind', evalKernelManager.kernelCount() === 0)
  cleanup()
}
finish('KERNEL-CANCEL')
