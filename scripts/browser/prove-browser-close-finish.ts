#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import type http from 'node:http'
import { join } from 'node:path'
import { ROOT, check, finish, lead, ownerOf, pageOf, requireBrowser, run, section, serve, sessions } from './harness.ts'

await requireBrowser()

const CLOSE: number = sessions.BROWSER_CLOSE_BOUND_MS
const FINISH: number = sessions.BROWSER_FINISH_BOUND_MS ?? 0
const HOLD = CLOSE + 500
const REAPED = 'session closed (browser reaped; origin approvals wiped)'
const SILENT = `session closed — the browser did not answer within ${CLOSE / 1000}s and its process was ended (origin approvals wiped)`
const UNFINISHED = `session closed — the browser did not finish quitting within ${FINISH / 1000}s and its process was ended (origin approvals wiped)`
const nap = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const A = await serve(0, (req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`<!doctype html><title>${(req.url ?? '/').slice(1) || 'root'}</title><p>${req.url}</p>`)
})

class StandIn {
  connected = true
  ended: string | null = null
  exited = false
  readonly page = {
    url: () => 'about:blank',
    on: () => undefined,
    viewport: () => ({ width: 1280, height: 800 }),
    close: async () => undefined,
    title: async () => 'stand-in',
  }
  constructor(
    private readonly takesQuit: boolean,
    private readonly exitsAfterMs: number | null,
  ) {}
  on(): this {
    return this
  }
  process() {
    return {
      exitCode: this.exited ? 0 : null,
      signalCode: this.ended,
      kill: (signal: string) => {
        this.ended = signal
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
    if (!this.takesQuit) return new Promise<void>(() => {})
    this.connected = false
    if (this.exitsAfterMs === null) return new Promise<void>(() => {})
    return new Promise<void>(done =>
      setTimeout(() => {
        this.exited = true
        done()
      }, this.exitsAfterMs!),
    )
  }
}

const leases: Array<() => void> = []
let leasing = false
const realTimeout = globalThis.setTimeout
const realClear = globalThis.clearTimeout
const held = new Set<object>()
globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
  if (!leasing || ms !== 300_000) return realTimeout(fn, ms, ...rest)
  const timer = { unref: () => timer }
  held.add(timer)
  leases.push(() => {
    if (held.delete(timer)) fn()
  })
  return timer
}) as typeof setTimeout
globalThis.clearTimeout = ((timer: object) => {
  if (!held.delete(timer)) realClear(timer as ReturnType<typeof setTimeout>)
}) as typeof clearTimeout

const ctx = (lane: string): { agentId: string } => ({ agentId: `close-finish-${lane}` })
const lanes = { tool: ctx('tool'), disposal: ctx('disposal'), idle: ctx('idle'), mute: ctx('mute'), stuck: ctx('stuck'), never: ctx('never'), silent: ctx('silent') }
const stand = {
  tool: new StandIn(true, HOLD),
  disposal: new StandIn(true, HOLD),
  idle: new StandIn(true, HOLD),
  mute: new StandIn(false, null),
  stuck: new StandIn(true, null),
}
for (const name of ['tool', 'disposal', 'idle', 'mute', 'stuck'] as const) {
  sessions.setBrowserLaunchDriverForProof(async () => stand[name])
  leasing = name === 'idle'
  const opened = await sessions.ensureBrowserSession(ownerOf(lanes[name]))
  leasing = false
  if (opened === null || 'state' in opened) throw new Error(`the stand-in session ${name} did not open: ${JSON.stringify(opened)}`)
}
sessions.setBrowserLaunchDriverForProof(null)

const timed = async <T>(work: Promise<T>): Promise<{ value: T; ms: number }> => {
  const t0 = Date.now()
  const value = await work
  return { value, ms: Date.now() - t0 }
}
const viaTool = run({ op: 'close' }, lanes.tool)
const viaDisposal = timed(sessions.disposeBrowserOwner(ownerOf(lanes.disposal)) as Promise<void>)
const viaLease = (async (): Promise<number> => {
  const t0 = Date.now()
  for (const fire of leases.splice(0)) fire()
  while (!stand.idle.exited && stand.idle.ended === null && Date.now() - t0 < FINISH + 4000) await nap(25)
  return Date.now() - t0
})()
const mute = run({ op: 'close' }, lanes.mute)
const stuck = run({ op: 'close' }, lanes.stuck)

const posix = process.platform !== 'win32'
interface Staged {
  pid: number
  cut: number
  left: string
}
function stage(context: { agentId?: string }, resumeAfterMs: number | null): Staged {
  const browser = sessions.activeSession(ownerOf(context)).browser
  const child = browser.process()
  const staged: Staged = { pid: child.pid as number, cut: -1, left: '' }
  const t0 = Date.now()
  browser.once('disconnected', () => {
    staged.cut = Date.now() - t0
    try {
      process.kill(-staged.pid, 'SIGSTOP')
    } catch {}
    if (resumeAfterMs === null) return
    setTimeout(() => {
      try {
        process.kill(-staged.pid, 'SIGCONT')
      } catch {}
    }, Math.max(resumeAfterMs - staged.cut, 0))
  })
  child.once('exit', (code: number | null, signal: string | null) => {
    staged.left = signal ?? `code ${code}`
  })
  return staged
}

await run({ op: 'open', url: `${A.origin}/healthy` })
const healthy = await run({ op: 'close' })
const { Connection } = (await import(join(ROOT, 'node_modules/puppeteer-core/lib/puppeteer/cdp/Connection.js'))) as { Connection: { prototype: { _rawSend: (...args: unknown[]) => unknown } } }
const send = Connection.prototype._rawSend
let holdQuit = false
Connection.prototype._rawSend = function (this: unknown, callbacks: unknown, method: unknown, ...rest: unknown[]) {
  if (method !== 'Browser.close' || !holdQuit) return send.call(this, callbacks, method, ...rest)
  holdQuit = false
  return new Promise((resolve, reject) =>
    setTimeout(() => {
      try {
        ;(send.call(this, callbacks, method, ...rest) as Promise<unknown>).then(resolve, reject)
      } catch (error) {
        reject(error)
      }
    }, HOLD),
  )
}
await run({ op: 'open', url: `${A.origin}/silent` }, lanes.silent)
const silentPid = sessions.activeSession(ownerOf(lanes.silent)).browser.process().pid as number
holdQuit = true
const silent = await run({ op: 'close' }, lanes.silent)
Connection.prototype._rawSend = send
await nap(200)
const silentGone = !alive(silentPid)

let slowStaged: Staged | null = null
let slow: { result: string; ms: number } | null = null
let kept: unknown[] = []
let neverStaged: Staged | null = null
let never: { result: string; ms: number } | null = null
if (posix) {
  await run({ op: 'open', url: `${A.origin}/kept` })
  await pageOf().evaluate(() => {
    document.cookie = 'kept=cookie-close-finish; max-age=3600; path=/'
    localStorage.setItem('kept', 'storage-close-finish')
  })
  slowStaged = stage(lead, HOLD)
  slow = await run({ op: 'close' })
  await nap(300)
  await run({ op: 'open', url: `${A.origin}/again` })
  kept = await pageOf().evaluate(() => [document.cookie, localStorage.getItem('kept')])
  await run({ op: 'close' })
  await run({ op: 'open', url: `${A.origin}/never` }, lanes.never)
  neverStaged = stage(lanes.never, null)
  never = await run({ op: 'close' }, lanes.never)
}

section('S0 the two bounds of a close')
check(
  `a browser that took the quit is given longer to finish than the ${CLOSE / 1000}s a browser is given to answer it`,
  FINISH > CLOSE,
  `BROWSER_CLOSE_BOUND_MS ${CLOSE}, BROWSER_FINISH_BOUND_MS ${sessions.BROWSER_FINISH_BOUND_MS}`,
)
console.log(`    a healthy browser’s close took ${healthy.ms} ms here: ${healthy.result}`)

section('S1 stand-in browsers, on every platform: which one is ended, and when')
{
  const answered = await mute
  check(
    `a browser that does not answer the quit, its connection still open, is ended at ${CLOSE / 1000}s with the sentence it had (holds on the parent too)`,
    answered.result === SILENT && answered.ms >= CLOSE - 50 && answered.ms < CLOSE + 4000 && stand.mute.ended === 'SIGKILL',
    `${answered.result} after ${answered.ms}ms, ended ${stand.mute.ended}`,
  )
  const closed = await viaTool
  check(
    `a browser that took the quit and exits ${HOLD / 1000}s after it is not ended: the tool’s close waits and answers that it was reaped`,
    closed.result === REAPED && closed.ms >= HOLD - 50 && closed.ms < FINISH && stand.tool.ended === null && stand.tool.exited,
    `${closed.result} after ${closed.ms}ms, ended ${stand.tool.ended}`,
  )
  const disposed = await viaDisposal
  check(
    'an owner’s disposal, the road an exit takes, waits for it by the same rule',
    disposed.ms >= HOLD - 50 && disposed.ms < FINISH && stand.disposal.ended === null && stand.disposal.exited,
    `after ${disposed.ms}ms, ended ${stand.disposal.ended}, exited ${stand.disposal.exited}`,
  )
  const leased = await viaLease
  check(
    'the idle lease’s close leaves it to finish by the same rule',
    leased >= HOLD - 50 && leased < FINISH && stand.idle.ended === null && stand.idle.exited,
    `after ${leased}ms, ended ${stand.idle.ended}, exited ${stand.idle.exited}`,
  )
  const lapsed = await stuck
  check(
    `a browser that took the quit and never exits is ended ${FINISH / 1000}s after the quit, and the answer says so`,
    lapsed.result === UNFINISHED && lapsed.ms >= FINISH - 50 && lapsed.ms < FINISH + 2500 && stand.stuck.ended === 'SIGKILL',
    `${lapsed.result} after ${lapsed.ms}ms, ended ${stand.stuck.ended}`,
  )
}

section('S2 a real browser')
check(
  `a browser the quit request reaches ${HOLD / 1000}s late is silent at ${CLOSE / 1000}s and is ended then, as before (holds on the parent too)`,
  silent.result === SILENT && silent.ms >= CLOSE - 50 && silent.ms < CLOSE + 4000 && silentGone,
  `${silent.result} after ${silent.ms}ms, process ${silentGone ? 'gone' : 'still there'}`,
)
if (!posix) {
  console.log('  [SKIP] a browser that took the quit and is stopped until after the close’s first bound: the close waits, the process ends by itself, and the next start finds the cookie and the stored value (three checks) — not run on win32: the leg holds the browser’s exit with SIGSTOP, which win32 does not have; the stand-in legs above carry the law')
  console.log('  [SKIP] a browser that took the quit and is never let go on: ended at the second bound, and the answer says so (two checks) — not run on win32, for the same reason')
} else {
  check(
    `a browser that took the quit, stopped until ${HOLD / 1000}s after it: the close waits and answers that it was reaped`,
    slow!.result === REAPED && slow!.ms >= HOLD - 50 && slow!.ms < FINISH && slowStaged!.cut >= 0 && slowStaged!.cut < CLOSE,
    `${slow!.result} after ${slow!.ms}ms, connection closed at ${slowStaged!.cut}ms`,
  )
  check('its process ended by itself, with no signal', slowStaged!.left.startsWith('code '), `left by ${slowStaged!.left || 'nothing yet'}`)
  check('and the next start finds the cookie and the stored value set before that close', String(kept[0]).includes('kept=cookie-close-finish') && kept[1] === 'storage-close-finish', JSON.stringify(kept))
  const lapsed = never!
  check(
    `a browser that took the quit and is never let go on is ended ${FINISH / 1000}s after the quit, and the answer says so`,
    lapsed.result === UNFINISHED && lapsed.ms >= FINISH - 50 && lapsed.ms < FINISH + 2500 && neverStaged!.cut >= 0 && neverStaged!.cut < CLOSE,
    `${lapsed.result} after ${lapsed.ms}ms, connection closed at ${neverStaged!.cut}ms`,
  )
  await nap(200)
  check('and its process was ended, not left stopped (holds on the parent too)', neverStaged!.left === 'SIGKILL' && !alive(neverStaged!.pid), `left by ${neverStaged!.left || 'nothing yet'}, pid ${alive(neverStaged!.pid) ? 'alive' : 'gone'}`)
}

section('S3 one rule, not a copy of it')
{
  const service = readFileSync(join(ROOT, 'src/services/browser/browserSession.ts'), 'utf8')
  const tool = readFileSync(join(ROOT, 'src/tools/BrowserTool/BrowserTool.ts'), 'utf8')
  const asks = [...service.matchAll(/\bbrowser\.close\(\)/g)].length + [...tool.matchAll(/\bbrowser\.close\(\)/g)].length
  const body = (from: string, to: string): string => service.slice(service.indexOf(from), service.indexOf(to))
  const closer = body('async function closeChild(', 'async function closePage(')
  check(
    'one function asks a browser to quit, and the idle lease and an owner’s disposal both call it (holds on the parent too)',
    asks === 1 && closer.includes('browser.close()') && body('function armIdleLease(', 'export function beginBrowserActivity(').includes('closeChild(') && body('dispose: async state =>', 'retain: state =>').includes('closeChild('),
    `${asks} place(s) ask a browser to quit`,
  )
}

globalThis.setTimeout = realTimeout
globalThis.clearTimeout = realClear
await finish('prove-browser-close-finish', [lead, ...Object.values(lanes)])
