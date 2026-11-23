import { once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { check, cleanup, finish, loadEval, refusingBridge, setup, within } from './lib.js'
import type { ProcKernel } from '../../src/tools/engines/eval-kernels/procKernel.js'

const checkWithHint = (label: string, cond: boolean, hint: string, detail = ''): void => check(label, cond, cond ? detail : detail ? `${detail} — ${hint}` : hint)

const { work } = setup()
const { EvalKernelManager } = await loadEval()
type Seam = { kernels: Map<string, { kernel: ProcKernel }> }
const manager = new EvalKernelManager()
const called: string[] = []
const kernel = { kill: () => called.push('graceful'), killNow: () => called.push('immediate') } as unknown as ProcKernel
;(manager as unknown as Seam).kernels.set('fixture', { kernel })
manager.killAllForShutdown()
checkWithHint('the synchronous shutdown sweep uses immediate termination before forgetting a kernel', called.join(',') === 'immediate', 'killAllForShutdown in src/tools/engines/eval-kernels/kernelManager.ts must call the kernel killNow, not kill', called.join(','))
checkWithHint('the shutdown sweep clears its map synchronously', manager.kernelCount() === 0, 'killAllForShutdown in src/tools/engines/eval-kernels/kernelManager.ts must clear its kernels map before it returns')
manager.killAllForShutdown()
checkWithHint('a second shutdown does not signal the forgotten process again', called.length === 1, 'killAllForShutdown in src/tools/engines/eval-kernels/kernelManager.ts must forget each kernel it signals')

const real = new EvalKernelManager()
let live: ProcKernel | undefined
try {
  const result = await within('start the resistant kernel', 60_000, real.runCell({
    owner: 'shutdown-kill', cwd: work,
    input: { language: 'py', code: 'import signal\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nprint("final-line")' },
    abortSignal: new AbortController().signal,
    serveBridge: refusingBridge(),
  }))
  checkWithHint('the completed cell retains its final output before shutdown', result.status === 'ok' && result.stdout.text === 'final-line\n', 'runCell in src/tools/engines/eval-kernels/kernelManager.ts must return the cell stdout and status ok for a py cell that ignores SIGTERM', JSON.stringify(result))
  live = [...(real as unknown as Seam).kernels.values()][0]?.kernel
  checkWithHint('the real kernel is retained after the completed cell', live !== undefined && live.alive, 'runCell in src/tools/engines/eval-kernels/kernelManager.ts must keep the kernel in its kernels map after a completed cell')
  if (live) {
    const child = (live as unknown as { child: ChildProcess }).child
    const exit = once(child, 'exit')
    let immediate = false
    const original = live.killNow.bind(live)
    live.killNow = () => { immediate = true; original() }
    real.killAllForShutdown()
    checkWithHint('the real sweep signals now rather than scheduling work after process exit', immediate, 'killAllForShutdown in src/tools/engines/eval-kernels/kernelManager.ts must call killNow on each kernel synchronously')
    const [code, signal] = await within('the resistant kernel exit', 5_000, exit)
    checkWithHint('a kernel that ignores the polite signal is ended by the final sweep', code === null && signal === 'SIGKILL', 'killNow in src/tools/engines/eval-kernels/procKernel.ts must end the child with SIGKILL', `${code}/${signal}`)
    checkWithHint('the kernel and its manager are both settled', !live.alive && real.kernelCount() === 0, 'killNow in src/tools/engines/eval-kernels/procKernel.ts must mark the kernel not alive, and killAllForShutdown in src/tools/engines/eval-kernels/kernelManager.ts must empty its map')
  }
} finally {
  live?.killNow()
  await real.disposeAll()
  await manager.disposeAll()
  cleanup()
}
finish('SHUTDOWN-KILL')
