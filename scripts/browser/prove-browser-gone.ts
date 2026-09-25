#!/usr/bin/env bun
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import http from 'node:http'
import { join } from 'node:path'
import type { Browser as DriverBrowser, LaunchOptions } from 'puppeteer-core'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
process.env.MERCURY_BROWSER_PATH = process.execPath
process.env.MERCURY_BROWSER ??= '1'
delete process.env.MERCURY_BROWSER_MAX_SESSIONS

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const SETTLE_BOX_MS = 5_000
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — prove-browser-gone exceeded 180s (an op that never settled after its browser died)')
  process.exit(1)
}, 180_000)
watchdog.unref?.()

const session = await import('../../src/services/browser/browserSession.ts')
const { BrowserTool } = await import('../../src/tools/BrowserTool/BrowserTool.ts')
const { processOwnerForLane } = await import('../../src/services/run/resolveOwner.ts')
type ToolInput = Parameters<typeof BrowserTool.call>[0]
type ToolCtx = Parameters<typeof BrowserTool.call>[1]

const GONE_MID_OP = (op: string): string => `${op}: the browser is gone (its process exited mid-op) — op:"open" starts a new one`
const GONE_LATER = 'the browser is gone (its process exited) — op:"open" starts a new one'
const CLOSED_GONE = 'closed (the browser was already gone)'
const NEVER = { result: 'never', outcome: 'never', ms: SETTLE_BOX_MS }

function pidAlive(pid: number): boolean {
  try {
    execFileSync('kill', ['-0', String(pid)], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

interface PendingWait {
  reject: (err: Error) => void
  driverWords: string
}

class FixtureChild {
  connected = true
  closed = false
  killed = false
  closeHangs = false
  realChild: ChildProcess | null = null
  readonly listeners = new Map<string, Array<() => void>>()
  readonly pending: PendingWait[] = []
  readonly page = {
    url: () => 'about:blank',
    on: () => undefined,
    viewport: () => ({ width: 1280, height: 800 }),
    close: async () => undefined,
    title: async () => 'fixture',
    frames: () => [],
    $: async () => null,
    waitForSelector: (selector: string, opts: { signal?: AbortSignal }) =>
      this.wait(opts.signal, `Waiting for selector \`${selector}\` failed`),
    waitForFunction: (_fn: unknown, opts: { signal?: AbortSignal }) =>
      this.wait(opts.signal, 'waitForFunction failed: frame got detached.'),
    waitForNavigation: (opts: { signal?: AbortSignal }) => this.wait(opts.signal, 'Navigating frame was detached'),
    locator: () => {
      const chain = {
        setTimeout: () => chain,
        setVisibility: () => chain,
        waitHandle: (opts: { signal?: AbortSignal }) => this.wait(opts.signal, null),
      }
      return chain
    },
  }
  constructor(readonly id: number) {}
  on(event: string, listener: () => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }
  once(event: string, listener: () => void): this {
    return this.on(event, listener)
  }
  off(event: string, listener: () => void): this {
    const list = this.listeners.get(event) ?? []
    const at = list.indexOf(listener)
    if (at !== -1) list.splice(at, 1)
    return this
  }
  emit(event: string): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener()
  }
  listenerCount(event: string): number {
    return (this.listeners.get(event) ?? []).length
  }
  wait(signal: AbortSignal | undefined, driverWords: string | null): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason as Error)
        return
      }
      signal?.addEventListener('abort', () => reject(signal.reason as Error), { once: true })
      if (driverWords !== null) this.pending.push({ reject, driverWords })
    })
  }
  die(): void {
    this.connected = false
    for (const wait of this.pending.splice(0)) {
      wait.reject(new Error(wait.driverWords, { cause: new Error('Protocol error (Runtime.callFunctionOn): Target closed') }))
    }
    this.emit('disconnected')
  }
  process() {
    if (this.realChild !== null) return this.realChild
    return {
      pid: 900_000 + this.id,
      exitCode: this.connected ? null : 137,
      signalCode: null,
      kill: () => {
        this.killed = true
        this.connected = false
      },
    }
  }
  async pages() {
    return [this.page]
  }
  async newPage() {
    return this.page
  }
  close(): Promise<void> {
    if (this.closeHangs) return new Promise<void>(() => {})
    this.closed = true
    this.connected = false
    return Promise.resolve()
  }
}

const spawned: FixtureChild[] = []
const launches: LaunchOptions[] = []
session.setBrowserLaunchDriverForProof(async options => {
  launches.push(options)
  const child = new FixtureChild(spawned.length + 1)
  spawned.push(child)
  return child as unknown as DriverBrowser
})
const ctxFor = (lane: string, controller = new AbortController()): ToolCtx =>
  ({ agentId: lane, abortController: controller }) as unknown as ToolCtx
async function op(lane: string, input: ToolInput, controller?: AbortController): Promise<{ result: string; outcome: string; ms: number }> {
  const t0 = Date.now()
  const { data } = await BrowserTool.call(input, ctxFor(lane, controller))
  return { result: data.result, outcome: data.outcome, ms: Date.now() - t0 }
}
function boxed(work: Promise<{ result: string; outcome: string; ms: number }>) {
  return Promise.race([work, tick(SETTLE_BOX_MS).then(() => NEVER)])
}

console.log('============================================================')
console.log(' browser gone — a browser that dies mid-op settles every pending op at once with the gone word, and a close that kills really ends the process')
console.log(' red on the base: G1/G2/G4 (the words are the driver\'s wrappers), G3 (the act wait never settles), G6 (the process outlives "was ended"); R1/R2/R4 the same on a real browser')
console.log('============================================================')

console.log('G1 a pending waitFor selector settles at once with the gone word when the browser dies')
{
  const lane = 'fixture-gone-wait-selector'
  const OWNER = processOwnerForLane(lane)
  const opened = await session.ensureBrowserSession(OWNER)
  check('G1 the fixture session is live', !('state' in opened))
  const fixture = spawned[spawned.length - 1]!
  const pending = boxed(op(lane, { op: 'waitFor', selector: '#never', timeoutMs: 30_000 } as ToolInput))
  await tick(50)
  const diedAt = Date.now()
  fixture.die()
  const settled = await pending
  check('G1 the wait settled at once (within the box)', settled.outcome === 'failed' && Date.now() - diedAt < 1_000, `${settled.outcome} after ${Date.now() - diedAt}ms`)
  check("G1 …with the gone word, not the driver's wrapper", settled.result === GONE_MID_OP('waitFor'), settled.result)
  check('G1 the op released its death listener', fixture.listenerCount('disconnected') === 1, `${fixture.listenerCount('disconnected')} listeners`)
  await session.disposeBrowserOwner(OWNER)
}

console.log('G2 a pending waitFor text (the function wait) settles the same way')
{
  const lane = 'fixture-gone-wait-text'
  const OWNER = processOwnerForLane(lane)
  await session.ensureBrowserSession(OWNER)
  const fixture = spawned[spawned.length - 1]!
  const pending = boxed(op(lane, { op: 'waitFor', text: 'never here', timeoutMs: 30_000 } as ToolInput))
  await tick(50)
  const diedAt = Date.now()
  fixture.die()
  const settled = await pending
  check('G2 the text wait settled at once with the gone word', settled.result === GONE_MID_OP('waitFor') && Date.now() - diedAt < 1_000, `${settled.result} after ${Date.now() - diedAt}ms`)
  await session.disposeBrowserOwner(OWNER)
}

console.log('G3 a pending act (click on the locator road, which retries until its own deadline) settles at once when the browser dies')
{
  const lane = 'fixture-gone-click'
  const OWNER = processOwnerForLane(lane)
  await session.ensureBrowserSession(OWNER)
  const fixture = spawned[spawned.length - 1]!
  const pending = boxed(op(lane, { op: 'click', selector: '#never', timeoutMs: 30_000 } as ToolInput))
  await tick(50)
  const diedAt = Date.now()
  fixture.die()
  const settled = await pending
  check(`G3 the click settled within ${SETTLE_BOX_MS}ms of the death (the base runs to its full deadline)`, settled.outcome !== 'never' && Date.now() - diedAt < 1_000, `${settled.outcome} after ${Date.now() - diedAt}ms`)
  check('G3 …with the gone word, not "the element never appeared"', settled.result === GONE_MID_OP('click'), settled.result)
  await session.disposeBrowserOwner(OWNER)
}

console.log('G4 a scoped extract (the read wait) settles at once with the gone word')
{
  const lane = 'fixture-gone-extract'
  const OWNER = processOwnerForLane(lane)
  await session.ensureBrowserSession(OWNER)
  const fixture = spawned[spawned.length - 1]!
  const pending = boxed(op(lane, { op: 'extract', selector: '#never', timeoutMs: 30_000 } as ToolInput))
  await tick(50)
  fixture.die()
  const settled = await pending
  check('G4 the read wait settled with the gone word', settled.result === GONE_MID_OP('extract'), settled.result)
  await session.disposeBrowserOwner(OWNER)
}

console.log('G5 the ops after the death: the next op names it, close says already gone at once, a later close finds nothing, open starts a fresh browser')
{
  const lane = 'fixture-gone-after'
  const OWNER = processOwnerForLane(lane)
  await session.ensureBrowserSession(OWNER)
  const before = spawned.length
  spawned[spawned.length - 1]!.die()
  const info = await op(lane, { op: 'info' } as ToolInput)
  check('G5 the op after the death refuses at once with the plain sentence', info.outcome === 'failed' && info.result === GONE_LATER && info.ms < 500, `${info.result} after ${info.ms}ms`)
  const closed = await boxed(op(lane, { op: 'close' } as ToolInput))
  check("G5 close answers 'closed (the browser was already gone)' at once", closed.result === CLOSED_GONE && closed.outcome === 'succeeded' && closed.ms < 1_000, `${closed.result} after ${closed.ms}ms`)
  const again = await op(lane, { op: 'close' } as ToolInput)
  check('G5 a second close finds no open session', again.result === 'no open session' && again.outcome === 'no-change', again.result)
  const reopened = await session.ensureBrowserSession(OWNER)
  check('G5 open after the death launches a fresh browser', !('state' in reopened) && spawned.length === before + 1, `${spawned.length - before} new launches`)
  await session.disposeBrowserOwner(OWNER)
}

console.log('G6 a close that lapses into the kill really ends the process (a child that ignores SIGTERM, as a frozen browser does)')
{
  const lane = 'fixture-frozen-kill'
  const OWNER = processOwnerForLane(lane)
  await session.ensureBrowserSession(OWNER)
  const fixture = spawned[spawned.length - 1]!
  const stubborn = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  await tick(300)
  fixture.realChild = stubborn
  fixture.closeHangs = true
  const pid = stubborn.pid!
  check('G6 the stand-in process is alive before the close', typeof pid === 'number' && pidAlive(pid))
  const closed = await boxed(op(lane, { op: 'close' } as ToolInput))
  check(`G6 close returned within the bound (${session.BROWSER_CLOSE_BOUND_MS}ms + slack)`, closed.outcome !== 'never' && closed.ms <= session.BROWSER_CLOSE_BOUND_MS + 1_500, `${closed.result} after ${closed.ms}ms`)
  check('G6 …saying the process was ended', /its process was ended/.test(closed.result), closed.result)
  const goneBy = Date.now() + 1_000
  while (Date.now() < goneBy && pidAlive(pid)) await tick(50)
  check('G6 the process IS ended within a second of that claim (the base sent a SIGTERM the process ignored)', !pidAlive(pid), `pid ${pid} still answers`)
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      stubborn.kill('SIGKILL')
    } catch {}
  }
  await session.disposeBrowserOwner(OWNER)
}

console.log("G7 the operator's interrupt still reads as the interrupt, never as a dead browser")
{
  const lane = 'fixture-interrupt'
  const OWNER = processOwnerForLane(lane)
  await session.ensureBrowserSession(OWNER)
  const controller = new AbortController()
  const pending = boxed(op(lane, { op: 'waitFor', selector: '#never', timeoutMs: 30_000 } as ToolInput, controller))
  await tick(50)
  controller.abort()
  const settled = await pending
  check('G7 the interrupted wait names the operator', settled.result === 'waitFor interrupted by the operator — the wait was released, nothing further was done', settled.result)
  check('G7 the browser is still live afterwards', session.activeSession(OWNER) !== null)
  await session.disposeBrowserOwner(OWNER)
}

console.log('R the real browser, killed and frozen from outside (skips by name when no managed browser resolves)')
{
  session.setBrowserLaunchDriverForProof(null)
  delete process.env.MERCURY_BROWSER_PATH
  const { resolveBrowser } = await import('../../src/services/browser/browserResolver.ts')
  const resolution = resolveBrowser()
  if (resolution.state !== 'ok' || process.platform === 'win32') {
    console.log(
      `  [SKIP] R no drivable browser here (${resolution.state !== 'ok' ? resolution.note : 'win32'}) — point MERCURY_BROWSER_CACHE_DIR at a managed Chrome-for-Testing cache (<config home>/browsers) or MERCURY_BROWSER_PATH at a Chromium binary to run the real legs; the fixture legs above carry the law`,
    )
  } else {
    const page = http.createServer((req, res) => {
      if (req.url === '/slow') return
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>gone</title><p id="p">gone</p>')
    })
    await new Promise<void>(resolve => page.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(page.address() as { port: number }).port}/`
    const pidOf = (owner: ReturnType<typeof processOwnerForLane>): number | undefined =>
      session.activeSession(owner)?.browser.process()?.pid
    try {
      console.log('R1 a pending waitFor settles at once with the gone word when the browser is SIGKILLed')
      {
        const lane = 'real-gone-wait'
        const OWNER = processOwnerForLane(lane)
        const opened = await op(lane, { op: 'open', url } as ToolInput)
        check('R1 the real browser opened the local page', opened.outcome === 'succeeded', opened.result.slice(0, 160))
        const pid = pidOf(OWNER)
        if (typeof pid === 'number') {
          const pending = boxed(op(lane, { op: 'waitFor', selector: '#never', timeoutMs: 30_000 } as ToolInput))
          await tick(500)
          const killedAt = Date.now()
          process.kill(pid, 'SIGKILL')
          const settled = await pending
          check('R1 the wait settled within a second of the kill', settled.outcome === 'failed' && Date.now() - killedAt < 1_500, `${settled.outcome} after ${Date.now() - killedAt}ms`)
          check('R1 …with the gone word', settled.result === GONE_MID_OP('waitFor'), settled.result)
          console.log('R3 the ops after the death on the real browser')
          const info = await op(lane, { op: 'info' } as ToolInput)
          check('R3 the next op names the dead browser', info.result === GONE_LATER && info.outcome === 'failed', info.result)
          const closed = await boxed(op(lane, { op: 'close' } as ToolInput))
          check("R3 close answers 'closed (the browser was already gone)' within the bound", closed.result === CLOSED_GONE && closed.ms <= session.BROWSER_CLOSE_BOUND_MS, `${closed.result} after ${closed.ms}ms`)
          const reopened = await op(lane, { op: 'open', url } as ToolInput)
          check('R3 open after the death starts a fresh browser', reopened.outcome === 'succeeded' && pidOf(OWNER) !== pid, reopened.result.slice(0, 120))
          const plain = await op(lane, { op: 'close' } as ToolInput)
          check('R3 the fresh browser closes politely with the plain words', plain.result === 'session closed (browser reaped; origin approvals wiped)', plain.result)
        }
        await session.disposeBrowserOwner(OWNER)
      }
      console.log('R2 a pending act (click on the locator road) settles at once when the browser is SIGKILLed')
      {
        const lane = 'real-gone-click'
        const OWNER = processOwnerForLane(lane)
        await op(lane, { op: 'open', url } as ToolInput)
        const pid = pidOf(OWNER)
        if (typeof pid === 'number') {
          const pending = boxed(op(lane, { op: 'click', selector: '#never', timeoutMs: 20_000 } as ToolInput))
          await tick(500)
          const killedAt = Date.now()
          process.kill(pid, 'SIGKILL')
          const settled = await pending
          check(`R2 the click settled within ${SETTLE_BOX_MS}ms of the kill (the base retries to its 20s deadline)`, settled.outcome !== 'never' && Date.now() - killedAt < 1_500, `${settled.outcome} after ${Date.now() - killedAt}ms`)
          check('R2 …with the gone word', settled.result === GONE_MID_OP('click'), settled.result)
        }
        await session.disposeBrowserOwner(OWNER)
      }
      console.log('R4 a frozen browser (SIGSTOP): close returns within the bound and its process is really ended')
      {
        const lane = 'real-frozen'
        const OWNER = processOwnerForLane(lane)
        await op(lane, { op: 'open', url } as ToolInput)
        const pid = pidOf(OWNER)
        if (typeof pid === 'number') {
          process.kill(pid, 'SIGSTOP')
          await tick(200)
          const closed = await boxed(op(lane, { op: 'close' } as ToolInput))
          check(`R4 close returned within the bound (${session.BROWSER_CLOSE_BOUND_MS}ms + slack)`, closed.outcome !== 'never' && closed.ms <= session.BROWSER_CLOSE_BOUND_MS + 1_500, `${closed.result} after ${closed.ms}ms`)
          check('R4 …saying the process was ended', /its process was ended/.test(closed.result), closed.result)
          const goneBy = Date.now() + 1_000
          while (Date.now() < goneBy && pidAlive(pid)) await tick(50)
          check('R4 the frozen process IS ended within a second (the base SIGTERMed a stopped process)', !pidAlive(pid), `pid ${pid} still answers`)
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {}
          try {
            process.kill(pid, 'SIGKILL')
          } catch {}
        }
        await session.disposeBrowserOwner(OWNER)
      }
      console.log('R5 a pending navigation wait settles at once with the gone word')
      {
        const lane = 'real-gone-nav'
        const OWNER = processOwnerForLane(lane)
        await op(lane, { op: 'open', url } as ToolInput)
        const pid = pidOf(OWNER)
        if (typeof pid === 'number') {
          const pressed = await op(lane, { op: 'press', key: 'Escape' } as ToolInput)
          check('R5 an act settled the navigation ledger first', pressed.outcome === 'succeeded', pressed.result)
          const pending = boxed(op(lane, { op: 'waitFor', timeoutMs: 30_000 } as ToolInput))
          await tick(500)
          const killedAt = Date.now()
          process.kill(pid, 'SIGKILL')
          const settled = await pending
          check('R5 the navigation wait settled at once with the gone word', settled.result === GONE_MID_OP('waitFor') && Date.now() - killedAt < 1_500, `${settled.result} after ${Date.now() - killedAt}ms`)
        }
        await session.disposeBrowserOwner(OWNER)
      }
    } finally {
      await new Promise<void>(resolve => page.close(() => resolve()))
    }
  }
}

clearTimeout(watchdog)
console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('✅ ALL BROWSER-GONE PROOFS PASS')
else console.log(`❌ ${failures} BROWSER-GONE PROOF(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
