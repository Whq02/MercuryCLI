#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Browser as DriverBrowser } from 'puppeteer-core'

const ROOT = resolve(process.env.PROOF_SUBJECT_ROOT ?? join(import.meta.dir, '..', '..'))
process.env.MERCURY_BROWSER_PATH = process.execPath
process.env.MERCURY_BROWSER = '1'
process.env.MERCURY_BROWSER_NO_DISCOVERY = '1'
delete process.env.MERCURY_BROWSER_MAX_SESSIONS
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const sessions = await import(join(ROOT, 'src/services/browser/browserSession.ts'))
const { makeOwnerKey } = await import(join(ROOT, 'src/services/run/ownerKey.ts'))
const { BrowserTool } = await import(join(ROOT, 'src/tools/BrowserTool/BrowserTool.ts'))
const { FLAG_REGISTRY } = await import(join(ROOT, 'src/substrate/flagRegistry.ts'))

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

class Child extends EventEmitter {
  connected = true
  page = {
    url: () => 'http://127.0.0.1/',
    on: () => {},
    viewport: () => ({ width: 1280, height: 800 }),
    title: async () => 'fixture',
  }
  process() { return null }
  async pages() { return [this.page] }
  async close() { this.connected = false; this.emit('disconnected') }
}
let spawned = 0
sessions.setBrowserLaunchDriverForProof(async () => {
  spawned++
  return new Child() as unknown as DriverBrowser
})

type Owner = string
const owner = (lane: string, sessionId: string): Owner => makeOwnerKey({ workspace: process.cwd(), sessionId, lane })
const seen: Owner[] = []
async function launch(lane: string, sessionId: string): Promise<{ held: boolean; note: string }> {
  const key = owner(lane, sessionId)
  seen.push(key)
  const outcome = await sessions.ensureBrowserSession(key)
  return 'state' in outcome ? { held: false, note: `${outcome.state}: ${outcome.note}` } : { held: true, note: '' }
}
const liveOf = (sessionId: string): number =>
  (sessions.liveBrowserSessionCensus() as Array<{ owner: string }>).filter(row => row.owner.includes(`|${encodeURIComponent(sessionId)}|`)).length
const lifetime = (manual: string): string => manual.split('## Session lifetime')[1] ?? ''
const refusal = (count: number, cap: number, lanes: string[]): string =>
  `at-capacity: ${count} of ${cap} child browser sessions are live in this parent session (${lanes.join(', ')}); the lead has a separate slot. Close a finished session with op:"close", wait for its 5-minute idle lease to expire, or raise MERCURY_BROWSER_MAX_SESSIONS.`
const statusOf = async (lane: string, sessionId: string): Promise<string> =>
  (await BrowserTool.call({ op: 'status' } as never, { owner: owner(lane, sessionId), abortController: new AbortController() } as never)).data.result
const TEN = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(name => `agent:${name}`)

try {
  console.log('A1 the variable unset: no count')
  {
    const results = []
    for (const lane of TEN) results.push(await launch(lane, 'allowance-unset'))
    check('the first three children of one parent each hold a live browser', results.slice(0, 3).every(r => r.held))
    check('a fourth child of the same parent launches its browser as the first did', results[3]!.held, results[3]!.note)
    check('a tenth child of the same parent launches its browser as the first did', results[9]!.held, results[9]!.note)
    check('ten browsers are live for that parent', liveOf('allowance-unset') === 10, String(liveOf('allowance-unset')))
    const lead = await launch('main', 'allowance-unset')
    check('the lead launches beside them', lead.held, lead.note)
    const status = await statusOf('main', 'allowance-unset')
    const line = status.split('\n').find(l => l.startsWith('other live sessions:')) ?? ''
    check('status names the other live sessions, the lease and the grants, and no count', line.startsWith('other live sessions: 10 (') && line.endsWith('; idle lease: 5 minutes; grants never cross owners') && !line.includes('cap'), line)
    const manual = await BrowserTool.prompt({} as never)
    check('the manual names the five-minute lease and no count', lifetime(manual).includes('5 minutes idle closes a browser') && !/child browsers|lead slot|\bcap\b/i.test(lifetime(manual)), lifetime(manual))
  }

  console.log('A2 an empty or invalid value: no count')
  for (const value of ['', '   ', '0', '-2', 'many']) {
    process.env.MERCURY_BROWSER_MAX_SESSIONS = value
    const sessionId = `allowance-invalid-${JSON.stringify(value)}`
    const results = []
    for (const lane of TEN.slice(0, 4)) results.push(await launch(lane, sessionId))
    check(`the value ${JSON.stringify(value)} leaves the fourth child its browser`, results.every(r => r.held), results.map(r => r.note).filter(Boolean).join(' | '))
    check(`the value ${JSON.stringify(value)} is read as no count`, sessions.browserSessionCap() === null, String(sessions.browserSessionCap()))
  }

  console.log('A3 the variable at 3: the allowance of three, as it was')
  {
    process.env.MERCURY_BROWSER_MAX_SESSIONS = '3'
    const results = []
    for (const lane of TEN.slice(0, 4)) results.push(await launch(lane, 'allowance-three'))
    check('three children hold their browsers', results.slice(0, 3).every(r => r.held))
    check('the fourth is refused in the same sentence, with its count and its lanes', !results[3]!.held && results[3]!.note === refusal(3, 3, TEN.slice(0, 3)), results[3]!.note)
    const lead = await launch('main', 'allowance-three')
    check('three children cannot consume the lead slot', lead.held, lead.note)
    const elsewhere = await launch('agent:a', 'allowance-three-other-parent')
    check('another parent session has its own allowance', elsewhere.held, elsewhere.note)
    const status = await statusOf('main', 'allowance-three')
    const line = status.split('\n').find(l => l.startsWith('other live sessions:')) ?? ''
    check('status names the count that was set', line.includes('; cap: 3 children per parent session, plus the lead slot; idle lease: 5 minutes; grants never cross owners'), line)
    const manual = await BrowserTool.prompt({} as never)
    check('the manual names the count that was set, the lead slot and the lease', /3 child browsers per session plus a reserved lead slot; 5 minutes idle closes a browser/.test(lifetime(manual)), lifetime(manual))
    const refusedOpen = await BrowserTool.call({ op: 'open', url: 'http://127.0.0.1:9/' } as never, { owner: owner('agent:e', 'allowance-three'), abortController: new AbortController() } as never)
    seen.push(owner('agent:e', 'allowance-three'))
    check('the open operation answers the refusal as it did', refusedOpen.data.outcome === 'failed' && refusedOpen.data.result === `browser session refused: ${refusal(3, 3, TEN.slice(0, 3)).slice('at-capacity: '.length)}`, refusedOpen.data.result)
  }

  console.log('A4 the variable at 1: the second is refused with the count 1')
  {
    process.env.MERCURY_BROWSER_MAX_SESSIONS = '1'
    const first = await launch('agent:a', 'allowance-one')
    const second = await launch('agent:b', 'allowance-one')
    check('the first child holds its browser', first.held, first.note)
    check('the second is refused with the count 1 and the holding lane', !second.held && second.note === refusal(1, 1, ['agent:a']), second.note)
    const before = spawned
    const again = await launch('agent:b', 'allowance-one')
    check('a refused launch starts no browser', !again.held && spawned === before, `${spawned - before} started`)
    const lead = await launch('main', 'allowance-one')
    check('the lead keeps its separate slot at 1', lead.held, lead.note)
    const manual = await BrowserTool.prompt({} as never)
    check('the manual names the count that is set, not a fixed three', lifetime(manual).trimStart().startsWith('Cap: 1 child browsers per session plus a reserved lead slot; 5 minutes idle closes a browser'), lifetime(manual))
  }

  console.log('A5 the words that said three')
  {
    delete process.env.MERCURY_BROWSER_MAX_SESSIONS
    const row = FLAG_REGISTRY.find((flag: { env: string }) => flag.env === 'MERCURY_BROWSER_MAX_SESSIONS') as { off: string } | undefined
    check('the registry row says what unset means: no cap', row !== undefined && row.off === 'no cap', row?.off ?? '(no row)')
    const page = readFileSync(join(ROOT, 'docs', 'BROWSER.md'), 'utf8')
    check('the page names no default of three and still names the variable, the lead slot and separate parents', !/three child browsers by default/.test(page) && page.includes('`MERCURY_BROWSER_MAX_SESSIONS`') && page.includes("the lead's slot") && page.includes('separate parent sessions have separate allowances'))
    check('no default count is exported', !('BROWSER_SESSION_CAP_DEFAULT' in sessions))
  }
} finally {
  delete process.env.MERCURY_BROWSER_MAX_SESSIONS
  await Promise.all(seen.map(key => sessions.disposeBrowserOwner(key)))
  sessions.setBrowserLaunchDriverForProof(null)
}

console.log(`\n${checks} checks, ${failures} failures`)
if (failures > 0) console.error(`prove-browser-allowance: ${failures} FAILURE(S)`)
else console.log('prove-browser-allowance: the allowance is the set value, and no count without one')
process.exit(failures === 0 ? 0 : 1)
