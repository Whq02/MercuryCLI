#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('Run with a scratch MERCURY_CONFIG_DIR')
delete process.env.MERCURY_HOME
const scratch = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'dap-abort-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
mkdirSync(process.env.MERCURY_CONFIG_DIR)
process.chdir(scratch)
process.env.HOME = scratch
process.env.USERPROFILE = scratch
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ fixture: { command: process.execPath, args: [join(import.meta.dir, 'mock-dap-terminal.mjs')] } })
const { DebugTool } = await import(join(SRC, 'tools/DebugTool/DebugTool.ts'))
const { getDapSession, removeDapSession, _dapSessionCountForTesting } = await import(join(SRC, 'services/dap/dapClient.ts'))
const { processMainOwner } = await import(join(SRC, 'services/run/resolveOwner.ts'))
const owner = processMainOwner()
let failures = 0
const check = (label: string, ok: boolean, detail = '') => { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ' ' + detail : ''}`) }
const call = (input: any, abortController = new AbortController()) => DebugTool.call(input, { owner, abortController } as never)
const until = async (test: () => boolean) => { const end = Date.now() + 2000; while (!test() && Date.now() < end) await Bun.sleep(10); return test() }
const settledWithin = async (promise: Promise<any>, ms: number) => { let timer: ReturnType<typeof setTimeout>; try { return await Promise.race([promise, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms) })]) } finally { clearTimeout(timer!) } }
try {
  check('stop deadline accepts a longer value without a cap', DebugTool.inputSchema.safeParse({ op: 'continue', timeoutMs: 3_000_000_000 }).success)
  check('stop deadline rejects negative values', !DebugTool.inputSchema.safeParse({ op: 'continue', timeoutMs: -1 }).success)
  await call({ op: 'launch', adapter: 'fixture', program: 'fixture', stopOnEntry: true })
  const session = getDapSession(owner, 'main')!
  const stopAbort = new AbortController()
  const stopped = call({ op: 'continue', timeoutMs: 30_000 }, stopAbort)
  check('continue entered a stop wait', await until(() => session._stateWaiterCountForTesting() === 1))
  const start = Date.now()
  stopAbort.abort()
  const cancelled = await settledWithin(stopped, 250)
  check('stop cancellation settles within one 250ms poll', !!cancelled, `${Date.now() - start}ms`)
  check('stop cancellation is typed, not running/succeeded', cancelled?.data.outcome === 'failed' && cancelled.effect?.details?.cancelled === true, JSON.stringify(cancelled?.data))
  check('cancelled stop removes its waiter', session._stateWaiterCountForTesting() === 0)
  if (!cancelled) { await removeDapSession(owner, 'main'); await stopped }
  else {
    for (const op of ['next', 'stepIn', 'stepOut', 'pause', 'restart']) {
      const controller = new AbortController()
      const run = call({ op, threadId: 1 }, controller)
      await until(() => session._stateWaiterCountForTesting() === 1)
      controller.abort()
      const result = await settledWithin(run, 250)
      check(`${op}: cancellation reaches stop wait`, result?.effect?.details?.cancelled === true && session._stateWaiterCountForTesting() === 0)
    }
    const requestAbort = new AbortController()
    const request = call({ op: 'customRequest', method: 'mock/stall' }, requestAbort)
    await until(() => session._pendingRequestCountForTesting?.() === 1)
    requestAbort.abort()
    const requestResult = await settledWithin(request, 250)
    check('stalled request cancelled promptly', requestResult?.effect?.details?.cancelled === true)
    check('cancelled request removed from pending map', session._pendingRequestCountForTesting?.() === 0)
    check('later request still works', Array.isArray((await session.request('threads')).threads))
    const timeoutStart = Date.now()
    const timeout = await call({ op: 'continue', threadId: 1, timeoutMs: 40 })
    check('requested stop deadline controls the wait and text', Date.now() - timeoutStart < 500 && /40ms/.test(timeout.data.result), timeout.data.result)
    const pre = new AbortController(); pre.abort()
    const preResult = await call({ op: 'threads' }, pre)
    check('pre-aborted request never enters pending map', preResult.effect?.details?.cancelled === true && session._pendingRequestCountForTesting?.() === 0)
    await call({ op: 'disconnect' })
  }
  process.env.MOCK_DAP_STALL_INITIALIZED = '1'
  const launchAbort = new AbortController()
  const launching = call({ op: 'launch', adapter: 'fixture', program: 'fixture' }, launchAbort)
  await until(() => !!getDapSession(owner, 'main'))
  await Bun.sleep(30)
  launchAbort.abort()
  const launchResult = await settledWithin(launching, 250)
  check('cancelling initialized wait settles promptly', launchResult?.effect?.details?.cancelled === true)
  if (!launchResult) { await removeDapSession(owner, 'main'); await launching }
  check('aborted launch leaves no registered session', _dapSessionCountForTesting() === 0)
} finally {
  delete process.env.MOCK_DAP_STALL_INITIALIZED
  await removeDapSession(owner, 'main')
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`${failures} failures`)
process.exit(failures ? 1 : 0)
