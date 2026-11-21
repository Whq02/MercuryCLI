import { once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { check, cleanup, finish, loadEval, refusingBridge, setup, within } from './lib.js'
import type { ProcKernel } from '../../src/services/eval/procKernel.js'

const { work } = setup()
const { EvalKernelManager } = await loadEval()
type Seam = { kernels: Map<string, { kernel: ProcKernel }> }
const manager = new EvalKernelManager()
const called: string[] = []
const kernel = { kill: () => called.push('graceful'), killNow: () => called.push('immediate') } as unknown as ProcKernel
;(manager as unknown as Seam).kernels.set('fixture', { kernel })
manager.killAllForShutdown()
check('the synchronous shutdown sweep uses immediate termination before forgetting a kernel', called.join(',') === 'immediate', called.join(','))
check('the shutdown sweep clears its map synchronously', manager.kernelCount() === 0)
manager.killAllForShutdown()
check('a second shutdown does not signal the forgotten process again', called.length === 1)

const real = new EvalKernelManager()
let live: ProcKernel | undefined
try {
  const result = await within('start the resistant kernel', 60_000, real.runCell({
    owner: 'shutdown-kill', cwd: work,
    input: { language: 'py', code: 'import signal\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nprint("final-line")' },
    abortSignal: new AbortController().signal,
    serveBridge: refusingBridge(),
  }))
  check('the completed cell retains its final output before shutdown', result.status === 'ok' && result.stdout.text === 'final-line\n', JSON.stringify(result))
  live = [...(real as unknown as Seam).kernels.values()][0]?.kernel
  check('the real kernel is retained after the completed cell', live !== undefined && live.alive)
  if (live) {
    const child = (live as unknown as { child: ChildProcess }).child
    const exit = once(child, 'exit')
    let immediate = false
    const original = live.killNow.bind(live)
    live.killNow = () => { immediate = true; original() }
    real.killAllForShutdown()
    check('the real sweep signals now rather than scheduling work after process exit', immediate)
    const [code, signal] = await within('the resistant kernel exit', 5_000, exit)
    check('a kernel that ignores the polite signal is ended by the final sweep', code === null && signal === 'SIGKILL', `${code}/${signal}`)
    check('the kernel and its manager are both settled', !live.alive && real.kernelCount() === 0)
  }
} finally {
  live?.killNow()
  await real.disposeAll()
  await manager.disposeAll()
  cleanup()
}
finish('SHUTDOWN-KILL')
