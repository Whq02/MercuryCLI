#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
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
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — prove-browser-bounds exceeded 120s (a close that never returned: the base tree awaits browser.close() with no bound)')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

const session = await import('../../src/services/browser/browserSession.ts')
const { BrowserTool, driverFailureWords } = await import('../../src/tools/BrowserTool/BrowserTool.ts')
const { processOwnerForLane } = await import('../../src/services/run/resolveOwner.ts')
type ToolInput = Parameters<typeof BrowserTool.call>[0]
type ToolCtx = Parameters<typeof BrowserTool.call>[1]

class FixtureChild {
  connected = true
  closed = false
  killed = false
  exitCode: number | null = null
  closeHangs = false
  readonly listeners = new Map<string, Array<() => void>>()
  readonly page = {
    url: () => 'about:blank',
    on: () => undefined,
    viewport: () => ({ width: 1280, height: 800 }),
    close: async () => undefined,
    title: async () => 'fixture',
  }
  constructor(
    readonly id: number,
    private readonly log: string[],
  ) {}
  on(event: string, listener: () => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }
  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }
  process() {
    return {
      pid: 900_000 + this.id,
      exitCode: this.exitCode,
      signalCode: null,
      kill: () => {
        this.killed = true
        this.connected = false
        this.exitCode = this.exitCode ?? 137
        this.log.push(`killed:${this.id}`)
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
    this.log.push(`close-called:${this.id}`)
    if (this.closeHangs) return new Promise<void>(() => {})
    this.closed = true
    this.connected = false
    return Promise.resolve()
  }
}

const log: string[] = []
const spawned: FixtureChild[] = []
const launches: LaunchOptions[] = []
session.setBrowserLaunchDriverForProof(async options => {
  launches.push(options)
  const child = new FixtureChild(spawned.length + 1, log)
  spawned.push(child)
  return child as unknown as DriverBrowser
})
function reset(): void {
  log.length = 0
  spawned.length = 0
}
const ctxFor = (lane: string): ToolCtx => ({ agentId: lane, abortController: new AbortController() }) as unknown as ToolCtx
async function op(lane: string, input: ToolInput): Promise<{ result: string; outcome: string }> {
  const { data } = await BrowserTool.call(input, ctxFor(lane))
  return { result: data.result, outcome: data.outcome }
}

console.log('============================================================')
console.log(' browser bounds — every close ends, a dead browser settles its ops')
console.log(' red on the base: B1 (close awaits for ever — the watchdog fires), B2, B3, B4, B6 (the words are the base\'s generic ones)')
console.log('============================================================')

console.log('B1 a close that never answers falls to the kill within the bound')
{
  reset()
  const lane = 'fixture-hung-close'
  const OWNER = processOwnerForLane(lane)
  const opened = await session.ensureBrowserSession(OWNER)
  check('B1 the fixture session is live', !('state' in opened) && spawned.length === 1)
  spawned[0]!.closeHangs = true
  const t0 = Date.now()
  const closed = await Promise.race([session.closeBrowserSessionDetailed(OWNER), tick(session.BROWSER_CLOSE_BOUND_MS + 4_000).then(() => ({ outcome: 'never' as const }))])
  const took = Date.now() - t0
  check(`B1 closeBrowserSession returns within the bound (${session.BROWSER_CLOSE_BOUND_MS} ms + slack), never for ever`, closed.outcome !== 'never' && took <= session.BROWSER_CLOSE_BOUND_MS + 1_500, `${closed.outcome} after ${took}ms`)
  check('B1 the lapse ends the process (killed) and says so', closed.outcome === 'killed' && spawned[0]!.killed === true, `${closed.outcome} · ${log.join(' ')}`)
  check('B1 the owner holds no session afterwards', session.activeSession(OWNER) === null && session.liveBrowserSessionCensus().every(row => row.owner !== OWNER))
}

console.log('B2 the tool\'s close on a browser whose process already exited answers at once with the owner\'s words')
{
  reset()
  const lane = 'fixture-gone-process'
  const OWNER = processOwnerForLane(lane)
  const opened = await session.ensureBrowserSession(OWNER)
  check('B2 the fixture session is live', !('state' in opened))
  spawned[0]!.closeHangs = true
  spawned[0]!.exitCode = 0
  const t0 = Date.now()
  const closed = await Promise.race([op(lane, { op: 'close' } as ToolInput), tick(session.BROWSER_CLOSE_BOUND_MS + 4_000).then(() => ({ result: 'never', outcome: 'never' }))])
  const took = Date.now() - t0
  check("B2 close answers 'closed (the browser was already gone)'", closed.result === 'closed (the browser was already gone)' && closed.outcome === 'succeeded', `${closed.result} after ${took}ms`)
  check('B2 …at once — no wait on a close that can never be answered', took < 1_000, `${took}ms`)
  check('B2 close() was never awaited on the dead child', !log.includes('close-called:1'), log.join(' '))
}

console.log('B3 a disconnected browser settles: the session is gone the moment the driver says so, the next op names it, close says already gone')
{
  reset()
  const lane = 'fixture-disconnected'
  const OWNER = processOwnerForLane(lane)
  const opened = await session.ensureBrowserSession(OWNER)
  check('B3 the fixture session is live', !('state' in opened))
  check("B3 the launch registered the driver's disconnected listener", (spawned[0]!.listeners.get('disconnected') ?? []).length === 1, JSON.stringify([...spawned[0]!.listeners.keys()]))
  spawned[0]!.connected = false
  spawned[0]!.emit('disconnected')
  check('B3 the owner holds no session the moment the browser disconnects (no lazy read needed)', session.activeSession(OWNER) === null && session.sessionGoneAt(OWNER) !== null)
  const info = await op(lane, { op: 'info' } as ToolInput)
  check('B3 an op arriving on the dead session refuses at once with the one plain sentence', info.outcome === 'failed' && info.result === 'the browser is gone (its process exited) — op:"open" starts a new one', info.result)
  const closed = await op(lane, { op: 'close' } as ToolInput)
  check("B3 close after the disconnect answers 'closed (the browser was already gone)'", closed.result === 'closed (the browser was already gone)' && closed.outcome === 'succeeded', closed.result)
  const again = await op(lane, { op: 'close' } as ToolInput)
  check('B3 a second close finds nothing and says no open session (the gone mark was spent)', again.result === 'no open session' && again.outcome === 'no-change', again.result)
  const plain = await op(lane, { op: 'info' } as ToolInput)
  check('B3 an op after the close reads the plain no-session words (a closed session is not a dead one)', plain.result === 'no open session — use op:"open" first', plain.result)
}

console.log('B4 the launch bounds every protocol call')
{
  check('B4 the launch passes protocolTimeout equal to the navigation cap (no CDP call outlives the tool\'s own longest deadline)', launches.length > 0 && launches.every(o => o.protocolTimeout === session.BROWSER_PROTOCOL_TIMEOUT_MS) && session.NAVIGATION_CAP_MS === session.BROWSER_PROTOCOL_TIMEOUT_MS, JSON.stringify(launches.map(o => o.protocolTimeout)))
  check('B4 the close bound is a few seconds', session.BROWSER_CLOSE_BOUND_MS >= 1_000 && session.BROWSER_CLOSE_BOUND_MS <= 10_000, String(session.BROWSER_CLOSE_BOUND_MS))
}

console.log('B5 a plain close still closes politely and says so (byte-identical words)')
{
  reset()
  const lane = 'fixture-plain-close'
  const OWNER = processOwnerForLane(lane)
  await session.ensureBrowserSession(OWNER)
  const closed = await op(lane, { op: 'close' } as ToolInput)
  check('B5 the polite close keeps its words', closed.result === 'session closed (browser reaped; origin approvals wiped)' && closed.outcome === 'succeeded' && spawned[0]!.closed === true && spawned[0]!.killed === false, closed.result)
}

console.log('B6 the words a dead or silent browser leaves in an op\'s result')
{
  const gone = driverFailureWords('extract', 'Protocol error (Runtime.callFunctionOn): Target closed')
  check('B6 a protocol error on a closed target names the dead browser and the way out', gone === 'extract: the browser is gone (its process exited mid-op) — op:"open" starts a new one', String(gone))
  const silent = driverFailureWords('screenshot', "Page.captureScreenshot timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed.")
  check('B6 a protocol timeout names the bound in seconds and the doors', silent === `screenshot: the browser did not answer within ${session.BROWSER_PROTOCOL_TIMEOUT_MS / 1000}s — its process may be gone; op:"close" ends the session, op:"open" starts a new one`, String(silent))
  check('B6 any other failure keeps the generic words (null: the caller spells `op failed: message`)', driverFailureWords('click', 'no element for selector #x') === null)
}

console.log('B7 the real browser, killed from outside: close returns within the bound (skips by name when no browser resolves)')
{
  session.setBrowserLaunchDriverForProof(null)
  delete process.env.MERCURY_BROWSER_PATH
  const { resolveBrowser } = await import('../../src/services/browser/browserResolver.ts')
  const resolution = resolveBrowser()
  if (resolution.state !== 'ok' || process.platform === 'win32') {
    console.log(`  [SKIP] B7 no drivable browser here (${resolution.state !== 'ok' ? resolution.note : 'win32'}) — the fixture legs above carry the law`)
  } else {
    const lane = 'real-killed-outside'
    const OWNER = processOwnerForLane(lane)
    const page = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>bounds</title><p>bounds</p>')
    })
    await new Promise<void>(resolve => page.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(page.address() as { port: number }).port}/`
    try {
      const opened = await op(lane, { op: 'open', url } as ToolInput)
      check('B7 the real browser opened the fixture page', opened.outcome === 'succeeded', opened.result.slice(0, 160))
      const live = session.activeSession(OWNER)
      const pid = live?.browser.process()?.pid
      check('B7 the session names its process', typeof pid === 'number', String(pid))
      if (typeof pid === 'number') {
        process.kill(pid, 'SIGKILL')
        const goneBy = Date.now() + 5_000
        while (Date.now() < goneBy && live?.browser.connected) await tick(50)
        const t0 = Date.now()
        const closed = await Promise.race([op(lane, { op: 'close' } as ToolInput), tick(session.BROWSER_CLOSE_BOUND_MS + 4_000).then(() => ({ result: 'never', outcome: 'never' }))])
        const took = Date.now() - t0
        check(`B7 close after the outside kill returns within the bound`, closed.outcome !== 'never' && took <= session.BROWSER_CLOSE_BOUND_MS + 1_500, `${closed.result} after ${took}ms`)
        check("B7 …and says the browser was already gone (or that it was ended)", /already gone|was ended|session closed/.test(closed.result), closed.result)
        try {
          execFileSync('kill', ['-0', String(pid)], { stdio: 'ignore' })
          check('B7 the browser process is gone', false, `pid ${pid} still answers`)
        } catch {
          check('B7 the browser process is gone', true)
        }
      }
    } finally {
      await session.disposeBrowserOwner(OWNER)
      await new Promise<void>(resolve => page.close(() => resolve()))
    }
  }
}

clearTimeout(watchdog)
console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('✅ ALL BROWSER-BOUNDS PROOFS PASS')
else console.log(`❌ ${failures} BROWSER-BOUNDS PROOF(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
