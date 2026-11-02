#!/usr/bin/env bun
import { check, cleanup, finish, refusingBridge, loadEval, section, setup, sleep, within } from './lib.js'

const { work } = setup()
const { evalKernelManager, EvalKernelManager } = await loadEval()
const { ProcKernel } = await import('../../src/services/eval/procKernel.js')
const { encodeHostFrame } = await import('../../src/services/eval/protocol.js')
const { primeEvalAvailability } = await import('../../src/services/eval/interpreters.js')
const { ensurePyRunner } = await import('../../src/services/eval/runnerCache.js')
const { buildKernelEnv } = await import('../../src/services/eval/kernelEnv.js')
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

async function proveInterruptChannel(): Promise<void> {
  section('Windows-shaped Python interrupt channel: scoped frames, handler, retained namespace and PID')
  const python = (await primeEvalAvailability(work)).find(row => row.language === 'py')
  check('Python is available for the channel proof', python?.available === true)
  if (!python?.interpreterPath) return
  const kernel = await ProcKernel.launch({ command: python.interpreterPath, args: [ensurePyRunner()], cwd: work, env: buildKernelEnv(), transport: 'loopback' })
  type HostFrame = Parameters<typeof encodeHostFrame>[0]
  const wire = kernel as unknown as { send: (frame: HostFrame) => void }
  const sent: HostFrame[] = []
  const send = wire.send.bind(kernel)
  wire.send = frame => { sent.push(frame); send(frame) }
  const interrupt = (id: string, token = kernel.token): void => wire.send({ t: 'interrupt', id, token })
  const exec = async (id: string, code: string, onOutput: (text: string) => void = () => undefined) => {
    let repr: string | undefined
    let error: string | undefined
    const end = await within('channel cell', 10_000, kernel.exec(id, code, {
      onStdout: onOutput, onStderr: () => undefined, onDisplay: () => undefined,
      onResult: value => { repr = value }, onError: value => { error = value.name }, onBridge: () => undefined,
    }))
    return { end, repr, error }
  }
  const shortLoop = 'import time\nprint("channel-ready", flush=True)\nuntil = time.monotonic() + 0.6\nwhile time.monotonic() < until:\n    time.sleep(0.02)'
  const whenReady = (act: () => void) => {
    let output = ''
    let acted = false
    return (chunk: string): void => {
      output += chunk
      if (!acted && output.includes('channel-ready')) { acted = true; act() }
    }
  }
  try {
    check('channel handshakes', await kernel.handshake(work))
    const seed = await exec('seed', 'import os, signal, sys\nkept = 7\noriginal_pid = os.getpid()\nsignal.getsignal(signal.SIGINT).__name__')
    check('loopback cell installs its channel interrupt handler', seed.repr === "'_channel_interrupt_handler'", JSON.stringify(seed))
    interrupt('seed')
    const stale = await exec('stale', shortLoop, whenReady(() => { interrupt('seed'); interrupt('stale', 'wrong-token') }))
    check('idle, stale-cell and wrong-token interrupts do not cancel the next cell', stale.end.kind === 'done' && stale.end.status === 'ok', JSON.stringify(stale))
    const cancelled = await exec('wire', shortLoop, whenReady(() => { interrupt('wire'); interrupt('wire') }))
    check('an interrupt frame alone cancels the running cell with KeyboardInterrupt', cancelled.end.kind === 'done' && cancelled.end.status === 'cancelled' && cancelled.error === 'KeyboardInterrupt', JSON.stringify(cancelled))
    const after = await exec('after-wire', '(kept, os.getpid() == original_pid)')
    check('the same-channel interrupt preserves bindings and process identity', after.repr === '(7, True)', JSON.stringify(after))
    const hostStopped = await exec('host', shortLoop, whenReady(() => kernel.interrupt()))
    check('ProcKernel sends the active cell and token on the interrupt channel', sent.some(frame => frame.t === 'interrupt' && frame.id === 'host' && frame.token === kernel.token), JSON.stringify(sent.filter(frame => frame.t === 'interrupt')))
    check('the host interrupt also ends in KeyboardInterrupt, not process exit', hostStopped.end.kind === 'done' && hostStopped.end.status === 'cancelled' && hostStopped.error === 'KeyboardInterrupt', JSON.stringify(hostStopped))
    const late = await exec('late', shortLoop + '\n(kept, os.getpid() == original_pid)', whenReady(() => interrupt('host')))
    check('a delayed interrupt for the previous cell cannot cancel its successor', late.end.kind === 'done' && late.end.status === 'ok' && late.repr === '(7, True)', JSON.stringify(late))
  } finally {
    await kernel.dispose()
    check('the direct channel kernel is disposed', !kernel.alive)
  }

  const manager = new EvalKernelManager({ pyTransport: 'loopback' })
  const cell = (code: string, timeoutSeconds = 10, abortSignal = new AbortController().signal) =>
    within('managed channel cell', 15_000, manager.runCell({ owner: 'channel-cancel-owner', cwd: work, input: { language: 'py', code, timeoutSeconds }, abortSignal, serveBridge: bridge }))
  try {
    const seed = await cell('import os\nkept = 7\noriginal_pid = os.getpid()')
    check('managed channel seed succeeds', seed.status === 'ok', JSON.stringify(seed.error))
    const budget = await cell('import time\nwhile True:\n    time.sleep(0.05)', 1)
    check('channel budget interrupt yields KeyboardInterrupt and keeps one kernel', budget.status === 'cancelled' && budget.error?.name === 'KeyboardInterrupt' && manager.kernelCount() === 1, JSON.stringify({ budget, kernels: manager.kernelCount() }))
    const afterBudget = await cell('(kept, os.getpid() == original_pid)')
    check('the budget interrupt keeps the namespace, PID and execution count', afterBudget.status === 'ok' && afterBudget.resultRepr === '(7, True)' && afterBudget.executionCount === 3, JSON.stringify(afterBudget))
    const abort = new AbortController()
    const busy = cell('while True:\n    pass', 0, abort.signal)
    await sleep(300)
    abort.abort()
    const stopped = await busy
    check('a user abort interrupts Python bytecode through the same channel', stopped.status === 'cancelled' && stopped.error?.name === 'KeyboardInterrupt' && manager.kernelCount() === 1, JSON.stringify(stopped))
    const afterAbort = await cell('(kept, os.getpid() == original_pid)')
    check('the user-aborted channel kernel keeps its state too', afterAbort.status === 'ok' && afterAbort.resultRepr === '(7, True)', JSON.stringify(afterAbort))
    const ignored = await cell('import signal, time\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nwhile True:\n    time.sleep(0.05)', 1)
    check('a kernel that ignores the channel still escalates and is removed', ignored.status === 'cancelled' && ignored.annotations.some(note => note.includes('not honoured')) && manager.kernelCount() === 0, JSON.stringify(ignored))
  } finally {
    await manager.disposeAll()
    check('no channel kernel remains after disposal', manager.kernelCount() === 0)
  }
}

try {
  await proveInterruptChannel()

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
  check('the next JS result names the lost state', j2.annotations.some(note => /recreated.*interrupt/.test(note) && /state|bindings/.test(note)), JSON.stringify(j2.annotations))
  const j3 = await run('js', '1')
  check('the reset notice is consumed once', !j3.annotations.some(note => /recreated.*interrupt/.test(note)), JSON.stringify(j3.annotations))

  section('escalation kill: a stuck busy-loop that never honours SIGINT')
  const e1 = await run('js', 'for (;;) {}', { timeoutSeconds: 1 })
  check('stuck cell settles cancelled (not a hang)', e1.status === 'cancelled', e1.status)
  check('escalation annotated (killed, recreate next call)', e1.annotations.some(a => a.includes('not honoured') || a.includes('killed')), JSON.stringify(e1.annotations))
  const e2 = await run('js', "'alive'")
  check('next call gets a fresh working kernel', e2.status === 'ok' && e2.resultRepr === "'alive'", e2.resultRepr)
  check('the next result also names an escalated reset', e2.annotations.some(note => /recreated.*interrupt/.test(note)), JSON.stringify(e2.annotations))

  section('abort signal cancels a cell')
  const jsAbort = new AbortController()
  const jsPending = run('js', 'await new Promise(resolve => setTimeout(resolve, 60000))', { timeoutSeconds: 0 }, jsAbort.signal)
  await sleep(700)
  jsAbort.abort()
  check('JS abort settles cancelled', (await jsPending).status === 'cancelled')
  const afterAbort = await run('js', '1')
  check('next result names the user-aborted JS reset', afterAbort.annotations.some(note => /recreated.*interrupt/.test(note)), JSON.stringify(afterAbort.annotations))
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
  const { execSync } = await import('node:child_process')
  const pids = execSync(`pgrep -P ${process.pid} || true`, { encoding: 'utf8' })
    .split('\n')
    .map(line => Number(line.trim()))
    .filter(pid => Number.isFinite(pid) && pid > 0)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGINT')
    } catch {
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
