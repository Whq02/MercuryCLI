#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import type http from 'node:http'
import { join } from 'node:path'
import type { Frame } from 'puppeteer-core'
import { ROOT, check, finish, lead, pageOf, requireBrowser, run, section, serve } from './harness.ts'

await requireBrowser()

const DIST = process.env.PROVE_DIST ?? join(ROOT, 'dist')
const BUNDLE = join(DIST, 'mercury.mjs')
const DRIVER = join(ROOT, 'node_modules', 'puppeteer-core')
const LINES = [
  '#handleFrameTree(session, frameTree) {',
  'const held = this.frame(frameTree.frame.id)?.client;',
  'if (held && held !== session && !held.detached && held.target()._targetId === frameTree.frame.id) {',
  'return;',
  '}',
  'if (frameTree.frame.parentId) {',
  'this.#onFrameAttached(session, frameTree.frame.id, frameTree.frame.parentId);',
  'this.frame(frameTree.frame.id)?.updateClient(session);',
  '}',
]
const BUNDLED =
  /#[\w$]+\(([\w$]+),([\w$]+)\)\{(?:let|const|var) ([\w$]+)=this\.frame\(\2\.frame\.id\)\?\.client;if\(\3&&\3!==\1&&!\3\.detached&&\3\.target\(\)\._targetId===\2\.frame\.id\)return;if\(\2\.frame\.parentId\)\{?this\.#[\w$]+\(\1,\2\.frame\.id,\2\.frame\.parentId\)[,;]this\.frame\(\2\.frame\.id\)\?\.updateClient\(\1\)/
const INSTALL = 'run `bun install` in this checkout, or in the one its node_modules is a link to'
const LOADS = 6
const GAPS = [3, 2.5, 4, 2, 3, 2.5]
const TABS = 3
const ACT_MS = 3000
const STOOD_MS = 6000
const HELD_MS = 5000

interface Stage {
  late: boolean
  asked: Promise<void>
  askedNow: () => void
  taken: Promise<void>
  takenNow: () => void
  inner: Promise<void>
  innerNow: () => void
  page: string | null
  wire: unknown
  holding: boolean
  draining: boolean
  queue: string[]
  listed: boolean
  after: boolean
}
let stage: Stage | null = null
const nap = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const gate = (): { wait: Promise<void>; open: () => void } => {
  let open = (): void => {}
  const wait = new Promise<void>(resolve => {
    open = resolve
  })
  return { wait, open }
}
const within = (wait: Promise<void>): Promise<void> =>
  Promise.race([
    wait,
    new Promise<void>(done => {
      const bound = setTimeout(done, HELD_MS)
      bound.unref?.()
    }),
  ])

let port = 0
const A = await serve(0, (req: http.IncomingMessage, res: http.ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://fixture')
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  const leaf = (query: string): string => `http://localhost:${port}/leaf?${query}`
  if (url.pathname === '/six') {
    res.end(`<!doctype html><title>six</title><p id="top">six</p>
<script>
  let at = performance.now()
  for (let n = 1; n <= 6; n++) {
    while (performance.now() < at) {}
    const frame = document.createElement('iframe')
    frame.src = '${leaf('n=')}' + n + '&load=${url.searchParams.get('load') ?? ''}'
    document.body.appendChild(frame)
    at = performance.now() + ${Number(url.searchParams.get('gap') ?? '2')}
  }
</script>`)
    return
  }
  if (url.pathname === '/opener') {
    res.end(`<!doctype html><title>opener</title><a id="pop" target="_blank" href="/${url.searchParams.get('page') ?? 'popped'}?turn=${url.searchParams.get('turn') ?? ''}">pop</a>`)
    return
  }
  if (url.pathname === '/popped') {
    res.end(`<!doctype html><title>popped</title><iframe src="${leaf(`n=1&turn=${url.searchParams.get('turn') ?? ''}`)}"></iframe><p id="top">popped</p>`)
    return
  }
  if (url.pathname === '/holding') {
    res.end(`<!doctype html><title>holding</title><iframe src="http://localhost:${port}/nest${url.search}"></iframe><p id="top">holding</p>`)
    return
  }
  if (url.pathname === '/nest') {
    const now = stage
    now?.askedNow()
    void (now === null ? Promise.resolve() : within(now.taken)).then(() => res.end(`<!doctype html><title>nest</title><button id="who" onclick="this.textContent = 'clicked'">nest ${url.search}</button><iframe src="/inner${url.search}"></iframe>`))
    return
  }
  if (url.pathname === '/inner') {
    res.end(`<!doctype html><title>inner</title><p id="who">inner ${url.search}</p>`)
    const now = stage
    if (now !== null) setTimeout(now.innerNow, 50)
    return
  }
  res.end(`<!doctype html><title>leaf</title><button id="who" onclick="this.textContent = 'clicked'">leaf ${url.search}</button>`)
})
port = A.port

interface Heard {
  method?: string
  sessionId?: string
  params?: { sessionId?: string; targetInfo?: { type?: string } }
  result?: { frameTree?: { frame: { parentId?: string }; childFrames?: unknown[] } }
}
const { Connection } = (await import(join(ROOT, 'node_modules/puppeteer-core/lib/puppeteer/cdp/Connection.js'))) as { Connection: { prototype: { _rawSend: (...args: unknown[]) => unknown; onMessage: (message: string) => unknown } } }
const kinds = new Map<string, string>()
const under = new Map<string, string>()
const ofPage = (session: string): boolean => kinds.get(session) === 'page' && kinds.get(under.get(session) ?? '') === 'tab'
const own = (method: unknown): boolean => method === 'Runtime.runIfWaitingForDebugger' || method === 'Target.setAutoAttach'
const send = Connection.prototype._rawSend
Connection.prototype._rawSend = function (this: unknown, callbacks: unknown, method: unknown, params: unknown, session: unknown, ...rest: unknown[]) {
  const now = stage
  const go = (): unknown => send.call(this, callbacks, method, params, session, ...rest)
  if (now === null || typeof session !== 'string' || own(method)) return go()
  if (session === now.page) return within(now.asked).then(go)
  if (now.late && kinds.get(session) === 'iframe' && under.get(session) === now.page) return within(now.inner).then(go)
  return go()
}
const take = Connection.prototype.onMessage
const drain = (now: Stage): void => {
  const next = now.queue.shift()
  if (next === undefined) {
    now.holding = false
    return
  }
  take.call(now.wire, next)
  setImmediate(() => drain(now))
}
const handOver = (now: Stage): void => {
  if (!now.holding || now.draining) return
  now.draining = true
  drain(now)
}
Connection.prototype.onMessage = function (this: unknown, message: string) {
  const now = stage
  if (now === null && !message.includes('"Target.attachedToTarget"')) return take.call(this, message)
  let heard: Heard
  try {
    heard = JSON.parse(message) as Heard
  } catch {
    return take.call(this, message)
  }
  if (heard.method === 'Target.attachedToTarget') {
    const born = String(heard.params?.sessionId)
    kinds.set(born, String(heard.params?.targetInfo?.type))
    under.set(born, String(heard.sessionId))
    if (now !== null && now.page === null && ofPage(born)) now.page = born
  }
  if (now === null || now.page === null || typeof heard.sessionId !== 'string') return take.call(this, message)
  const tree = heard.result?.frameTree
  if (heard.sessionId === now.page && !(heard.method ?? '').startsWith('Target.')) {
    if (now.holding) {
      now.queue.push(message)
      return undefined
    }
    if (tree === undefined || tree.frame.parentId !== undefined || now.draining) return take.call(this, message)
    now.listed = (tree.childFrames ?? []).length === 1
    now.wire = this
    now.holding = true
    now.queue.push(message)
    const bound = setTimeout(() => handOver(now), HELD_MS)
    bound.unref?.()
    now.takenNow()
    return undefined
  }
  if (tree !== undefined && tree.frame.parentId !== undefined && kinds.get(heard.sessionId) === 'iframe' && under.get(heard.sessionId) === now.page) {
    const out = take.call(this, message)
    now.after = now.holding && !now.draining
    handOver(now)
    return out
  }
  return take.call(this, message)
}

section('S0 the driver this checkout runs carries the mend')
{
  const installed = existsSync(join(DRIVER, 'package.json')) ? (JSON.parse(readFileSync(join(DRIVER, 'package.json'), 'utf8')) as { version?: string }).version ?? '' : ''
  const text = existsSync(join(DRIVER, 'lib', 'puppeteer', 'cdp', 'FrameManager.js')) ? readFileSync(join(DRIVER, 'lib', 'puppeteer', 'cdp', 'FrameManager.js'), 'utf8') : ''
  const lines = text.split('\n').map(line => line.trim())
  const at = lines.indexOf(LINES[0]!)
  const odd = at === -1 ? -1 : LINES.findIndex((line, index) => lines[at + index] !== line)
  check(
    'the driver installed here carries the patch in its own text, where a frame tree is handled',
    at !== -1 && odd === -1,
    `puppeteer-core ${installed || 'is not installed'}; ${at === -1 ? 'its FrameManager.js holds no #handleFrameTree' : `line ${at + odd + 1} of its FrameManager.js reads \`${lines[at + odd]}\` where the patch writes \`${LINES[odd]}\``}: this node_modules was installed before the patch or with another — ${INSTALL}`,
  )
  if (!existsSync(BUNDLE)) {
    console.log(`  [SKIP] the built bundle carries the patch too — no built bundle at ${BUNDLE}`)
  } else {
    const bundle = readFileSync(BUNDLE, 'utf8')
    const handlers = [...bundle.matchAll(/this\.#[\w$]+\([\w$]+,([\w$]+)\.frame\.id,\1\.frame\.parentId\)/g)]
    check(
      'the built bundle carries the patch too, in the driver’s one handler of a frame tree',
      handlers.length === 1 && BUNDLED.test(bundle),
      handlers.length !== 1 ? `the bundle holds ${handlers.length} such handlers where this proof looks for one` : `the bundle was built from a driver without the patch — ${INSTALL}, then build again`,
    )
  }
}

interface Act {
  what: string
  ms: number
  ok: boolean
  said: string
}
const stood = Symbol('stood')
const act = async (what: string, input: Parameters<typeof run>[0], holds: (result: string) => boolean): Promise<Act> => {
  const began = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<typeof stood>(resolve => {
    timer = setTimeout(() => resolve(stood), STOOD_MS)
  })
  const answer = await Promise.race([run(input), late]).finally(() => clearTimeout(timer))
  if (answer === stood) return { what, ms: Date.now() - began, ok: false, said: `did not answer within ${STOOD_MS / 1000} s` }
  return { what, ms: answer.ms, ok: answer.outcome !== 'failed' && answer.outcome !== 'threw' && holds(answer.result) && answer.ms <= ACT_MS, said: answer.result.replace(/\s+/g, ' ').slice(0, 160) }
}
const worst = (acts: Act[]): string => {
  const bad = acts.filter(one => !one.ok)
  const slowest = acts.reduce((most, one) => Math.max(most, one.ms), 0)
  return bad.length === 0 ? `the slowest of ${acts.length} took ${slowest} ms` : `${bad.length} of ${acts.length}: ${bad.slice(0, 3).map(one => `${one.what} took ${one.ms} ms: ${one.said}`).join(' ; ')}`
}

section('S1 six frames of another site added side by side: each is reached through the driver')
const reads: Act[] = []
const clicks: Act[] = []
const absent: Act[] = []
for (let load = 0; load < LOADS && reads.every(one => one.ok) && clicks.every(one => one.ok) && absent.every(one => one.ok); load++) {
  await run({ op: 'open', url: `${A.origin}/six?gap=${GAPS[load % GAPS.length]}&load=${load}` })
  for (let n = 1; n <= 6 && reads.every(one => one.ok) && clicks.every(one => one.ok); n++) {
    const frame = `leaf?n=${n}&load=${load}`
    reads.push(await act(`extract in frame ${n} of load ${load}`, { op: 'extract', frame, timeoutMs: ACT_MS }, result => result.includes(`leaf ?n=${n}&load=${load}`)))
    clicks.push(await act(`click in frame ${n} of load ${load}`, { op: 'click', frame, selector: '#who', timeoutMs: ACT_MS }, () => true))
  }
  if (load === 0 && reads.every(one => one.ok) && clicks.every(one => one.ok)) {
    const waited = await act(`click on an absent element of load ${load}`, { op: 'click', selector: '#nowhere', timeoutMs: 2000 }, () => true)
    absent.push({ ...waited, ok: waited.ms >= 2000 && waited.ms < 5000 && waited.said.includes('no element for selector #nowhere within the 2000ms deadline') })
  }
}
check(`an extract addressed to each frame answers with that frame’s words within the act’s own ${ACT_MS / 1000} s, in ${LOADS} loads`, reads.length === LOADS * 6 && reads.every(one => one.ok), worst(reads))
check(`a click addressed to each frame lands within the act’s own ${ACT_MS / 1000} s`, clicks.length === LOADS * 6 && clicks.every(one => one.ok), worst(clicks))
console.log(`    ${reads.length} extracts, the slowest ${reads.reduce((most, one) => Math.max(most, one.ms), 0)} ms; ${clicks.length} clicks, the slowest ${clicks.reduce((most, one) => Math.max(most, one.ms), 0)} ms`)

section('S2 an act on the page itself is not held by its frames')
check('a click that waits two seconds for an element that is not there answers in about two seconds on such a load', absent.length === 1 && absent.every(one => one.ok), absent.map(one => `${one.what} took ${one.ms} ms: ${one.said}`).join(' ; ') || 'not reached')

section('S3 a tab an act opened, whose first frame is another site’s')
{
  const popped: Act[] = []
  let turns = 0
  for (let turn = 0; turn < TABS && popped.every(one => one.ok); turn++) {
    await run({ op: 'open', url: `${A.origin}/opener?turn=${turn}` })
    const opened = await run({ op: 'click', selector: '#pop' })
    const tab = /kept as tab (\S+) at/.exec(opened.result)?.[1] ?? ''
    if (tab === '') {
      popped.push({ what: `the tab of turn ${turn}`, ms: opened.ms, ok: false, said: opened.result.replace(/\s+/g, ' ').slice(0, 160) })
      break
    }
    const frame = `leaf?n=1&turn=${turn}`
    for (let waited = 0; waited < 50 && !pageOf(lead, tab).frames().some(child => child.url().includes(frame)); waited++) await nap(100)
    popped.push(await act(`extract in the frame of turn ${turn}`, { op: 'extract', tab, frame, timeoutMs: ACT_MS }, result => result.includes(`leaf ?n=1&turn=${turn}`)))
    popped.push(await act(`click in the frame of turn ${turn}`, { op: 'click', tab, frame, selector: '#who', timeoutMs: ACT_MS }, () => true))
    await run({ op: 'close', tab })
    turns++
  }
  check('its frame answers an extract and a click addressed to it within the act’s own time, three tabs running', turns === TABS && popped.every(one => one.ok), worst(popped))
}

section('S4 such a tab when its page’s own frame tree, taken while the frame was still the page’s own, reaches the driver after the frame’s own')
const ordered = async (late: boolean, turns: number[]): Promise<{ made: number; tried: number; reached: Act[]; kept: Act[] }> => {
  const reached: Act[] = []
  const kept: Act[] = []
  let made = 0
  let tried = 0
  for (const turn of turns) {
    tried++
    await run({ op: 'open', url: `${A.origin}/opener?page=holding&turn=${turn}` })
    const asked = gate()
    const taken = gate()
    const inner = gate()
    const now: Stage = { late, asked: asked.wait, askedNow: asked.open, taken: taken.wait, takenNow: taken.open, inner: inner.wait, innerNow: inner.open, page: null, wire: null, holding: false, draining: false, queue: [], listed: false, after: false }
    stage = now
    const opened = await run({ op: 'click', selector: '#pop' })
    const tab = /kept as tab (\S+) at/.exec(opened.result)?.[1] ?? ''
    if (tab === '') {
      stage = null
      reached.push({ what: `the tab of turn ${turn}`, ms: opened.ms, ok: false, said: opened.result.replace(/\s+/g, ' ').slice(0, 160) })
      break
    }
    const frame = `nest?turn=${turn}`
    const there = (): Frame | undefined => pageOf(lead, tab).frames().find(child => child.url().includes(frame))
    for (let waited = 0; waited < 50 && there()?.childFrames().length !== 1; waited++) await nap(100)
    for (let waited = 0; waited < 50 && now.holding; waited++) await nap(100)
    stage = null
    if (now.listed && now.after) made++
    const held = there()
    kept.push({
      what: `the driver’s list of frames in turn ${turn}`,
      ms: 0,
      ok: held !== undefined && held.childFrames().length === 1,
      said: held === undefined ? `holds no frame at ${frame}: ${pageOf(lead, tab).frames().filter(child => child.parentFrame() !== null).map(child => child.url() || 'a frame with no address').join(', ') || 'no child frame'}` : `${held.childFrames().length} frames inside it`,
    })
    reached.push(await act(`extract in the frame of turn ${turn}`, { op: 'extract', tab, frame, timeoutMs: ACT_MS }, result => result.includes(`nest ?turn=${turn}`)))
    if (reached.every(one => one.ok)) reached.push(await act(`click in the frame of turn ${turn}`, { op: 'click', tab, frame, selector: '#who', timeoutMs: ACT_MS }, () => true))
    if (reached.every(one => one.ok)) kept.push(await act(`extract in the frame inside it, turn ${turn}`, { op: 'extract', tab, frame: `inner?turn=${turn}`, timeoutMs: ACT_MS }, result => result.includes(`inner ?turn=${turn}`)))
    await run({ op: 'close', tab })
    if (!reached.every(one => one.ok)) break
  }
  return { made, tried, reached, kept }
}
const rest = (acts: Act[], whole: number): string => (acts.length === whole ? worst(acts) : `${worst(acts)}; the rest was not read once a frame did not answer`)
{
  const first = await ordered(false, [0, 1])
  check(
    'handed to the driver right after the frame’s own tree: the frame answers an extract and a click addressed to it within the act’s own time, in two tabs where that order was made',
    first.made === 2 && first.reached.length === 4 && first.reached.every(one => one.ok),
    `the order was made in ${first.made} of the ${first.tried} tabs tried; ${rest(first.reached, 4)}`,
  )
  check('and the driver keeps the frame at its address with the frame inside it, which answers an extract too', first.kept.length === 4 && first.kept.every(one => one.ok), rest(first.kept, 4))
  const second = await ordered(true, [2, 3])
  check(
    'the same where the frame’s document was there before the driver’s own commands reached its target: the frame answers an extract and a click addressed to it within the act’s own time, in two tabs where that order was made',
    second.made === 2 && second.reached.length === 4 && second.reached.every(one => one.ok),
    `the order was made in ${second.made} of the ${second.tried} tabs tried; ${rest(second.reached, 4)}`,
  )
  check('and there too the driver keeps the frame at its address with the frame inside it, which answers an extract too', second.kept.length === 4 && second.kept.every(one => one.ok), rest(second.kept, 4))
}

Connection.prototype._rawSend = send
Connection.prototype.onMessage = take
await finish('prove-browser-frames-reached', [lead])
