import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'browser-error-remedies-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_BROWSER_PATH = process.execPath
const browser = await import('../../src/services/browser/browserSession.ts')
const { BrowserTool, driverFailureWords } = await import('../../src/tools/BrowserTool/BrowserTool.ts')
const { processOwnerForLane } = await import('../../src/services/run/resolveOwner.ts')
const owner = processOwnerForLane('error-fixture')
const cdpEvents = new Map<string, (event: any) => void>()
const cdp = { send: async () => ({}), on: (name: string, fn: (event: any) => void) => { cdpEvents.set(name, fn) } }
let fail = 'click'
const page = {
  url: () => 'http://127.0.0.1:37919/fixture', on() {}, viewport: () => ({ width: 1280, height: 800 }), title: async () => 'fixture page',
  createCDPSession: async () => cdp,
  $: async () => ({}), frames: () => [],
  locator: () => ({ setTimeout() { return this }, setVisibility() { return this }, waitHandle: async () => ({ scrollIntoView: async () => { throw new Error('Node is either not clickable or not an Element') } }) }),
  evaluate: async () => { if (fail === 'click') throw new Error('Node is either not clickable or not an Element') },
  goto: async (url: string) => {
    cdpEvents.get('Network.requestWillBeSent')?.({ requestId: 'blocked-fixture', request: { url } })
    cdpEvents.get('Network.loadingFailed')?.({ requestId: 'blocked-fixture', blockedReason: 'mixed-content', errorText: 'net::ERR_BLOCKED_BY_CLIENT' })
    throw new Error(`net::ERR_BLOCKED_BY_CLIENT at ${url}`)
  },
}
const child = { connected: true, on() {}, off() {}, process: () => null, pages: async () => [page], newPage: async () => page, close: async () => {} }
browser.setBrowserLaunchDriverForProof(async () => child as never)
const context = { agentId: 'error-fixture', abortController: new AbortController() } as never
let failures = 0
const check = (name: string, ok: boolean, detail: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`); if (!ok) failures++ }
try {
  await browser.ensureBrowserSession(owner)
  const click = await BrowserTool.call({ op: 'click', selector: '#route-target' }, context)
  check('unclickable element names scroll and route waiting', click.data.outcome === 'failed' && /scroll/.test(click.data.result) && /waitFor/.test(click.data.result) && !click.data.result.includes('Node is either'), click.data.result)
  fail = 'network'
  const opened = await BrowserTool.call({ op: 'open', url: page.url() }, context)
  check('blocked request names the reported policy and next step', opened.data.outcome === 'failed' && /mixed-content/.test(opened.data.result) && /console|operator/.test(opened.data.result), opened.data.result)
  const unknown = driverFailureWords('open', 'net::ERR_BLOCKED_BY_CLIENT at https://example.test/')
  check('unreported policy is not invented', unknown !== null && /not report/.test(unknown), unknown ?? '(no translation)')
  assert.equal(failures, 0)
} finally {
  await browser.closeBrowserSessionDetailed(owner)
  browser.setBrowserLaunchDriverForProof(null)
  rmSync(home, { recursive: true, force: true })
}
