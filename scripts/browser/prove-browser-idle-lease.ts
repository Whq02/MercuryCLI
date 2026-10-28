import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { Browser as DriverBrowser } from 'puppeteer-core'

process.env.MERCURY_BROWSER_PATH = process.execPath
process.env.MERCURY_BROWSER = '1'
process.env.MERCURY_BROWSER_MAX_SESSIONS = '3'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const sessions = await import('../../src/services/browser/browserSession.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const { BrowserTool } = await import('../../src/tools/BrowserTool/BrowserTool.ts')
const timers = new Map<object, () => void>()
const realTimeout = globalThis.setTimeout
const realClear = globalThis.clearTimeout
globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => {
  if (ms !== 300_000) return realTimeout(fn, ms, ...args)
  const timer = { unref() { return timer } }
  timers.set(timer, fn)
  return timer
}) as typeof setTimeout
globalThis.clearTimeout = ((timer: object) => {
  if (!timers.delete(timer)) realClear(timer as ReturnType<typeof setTimeout>)
}) as typeof clearTimeout
let finishTitle = () => {}
let titleEntered = () => {}
const entered = new Promise<void>(resolve => { titleEntered = resolve })
const title = new Promise<string>(resolve => { finishTitle = () => resolve('fixture') })
class Child extends EventEmitter {
  connected = true
  page = {
    url: () => 'http://127.0.0.1/',
    on: () => {},
    viewport: () => ({ width: 1280, height: 800 }),
    title: () => { titleEntered(); return title },
  }
  process() { return null }
  async pages() { return [this.page] }
  async close() { this.connected = false; this.emit('disconnected') }
}
sessions.setBrowserLaunchDriverForProof(async () => new Child() as unknown as DriverBrowser)
const owner = (lane: string, sessionId = 'lease') => makeOwnerKey({ workspace: process.cwd(), sessionId, lane })
const crew = [owner('agent:a'), owner('agent:b'), owner('agent:c')]
const lead = owner('main')
const other = owner('agent:other', 'other-tree')
let failures = 0
function check(label: string, ok: boolean) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
try {
  for (const member of crew) assert.ok(!('state' in await sessions.ensureBrowserSession(member)))
  const fourth = await sessions.ensureBrowserSession(owner('agent:d'))
  check('three children retain their existing allowance', 'state' in fourth && fourth.state === 'at-capacity')
  check('three idle children cannot consume the lead slot', !('state' in await sessions.ensureBrowserSession(lead)))
  check('a different parent tree has its own allowance', !('state' in await sessions.ensureBrowserSession(other)))
  sessions.approveWebOrigin(crew[1]!, 'http://127.0.0.1/')
  sessions.approveSecretPairing(crew[1]!, 'TEST', 'http://127.0.0.1')
  const active = BrowserTool.call({ op: 'info' }, { owner: crew[0], abortController: new AbortController() } as never)
  await Promise.race([entered, new Promise((_, reject) => realTimeout(() => reject(new Error('fixture title was not reached')), 2000))])
  check('five-minute idle leases are armed', timers.size >= 3)
  for (const [timer, fire] of [...timers]) { timers.delete(timer); fire() }
  await new Promise(resolve => realTimeout(resolve, 20))
  check('idle children expire', sessions.activeSession(crew[1]!) === null && sessions.activeSession(crew[2]!) === null)
  check('idle expiry clears origins and secret pairings', !sessions.originApproved(crew[1]!, 'http://127.0.0.1') && !sessions.secretPairingApproved(crew[1]!, 'TEST', 'http://127.0.0.1'))
  check('a child mid-operation keeps its session', sessions.activeSession(crew[0]!) !== null)
  finishTitle()
  await active
  check('completion rearms the idle lease', timers.size === 1)
  for (const [timer, fire] of [...timers]) { timers.delete(timer); fire() }
  await new Promise(resolve => realTimeout(resolve, 20))
  check('the active child expires only after its operation finishes', sessions.activeSession(crew[0]!) === null)
  const prompt = await BrowserTool.prompt()
  check('the model sees the cap, reserved lead slot and lease', /3.*per.*session/.test(prompt) && /lead.*slot/i.test(prompt) && /5 minutes/.test(prompt))
} finally {
  finishTitle()
  await Promise.all([...crew, lead, other, owner('agent:d')].map(key => sessions.disposeBrowserOwner(key)))
  sessions.setBrowserLaunchDriverForProof(null)
  globalThis.setTimeout = realTimeout
  globalThis.clearTimeout = realClear
}
process.exitCode = failures ? 1 : 0
