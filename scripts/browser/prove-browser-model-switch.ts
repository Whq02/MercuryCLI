import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'browser-model-switch-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_BROWSER_PATH = process.execPath
const browser = await import('../../src/services/browser/browserSession.ts')
const { BrowserTool } = await import('../../src/tools/BrowserTool/BrowserTool.ts')
const { ownerFromToolUseContext } = await import('../../src/services/run/resolveOwner.ts')
const { settleModelSelection } = await import('../../src/utils/model/modelTransition.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
let pressed = 0
const page = { url: () => 'https://example.test/', on: () => {}, viewport: () => ({ width: 1280, height: 800 }), title: async () => 'fixture', evaluate: async () => undefined, keyboard: { press: async () => { pressed++ } } }
const child = { connected: true, on: () => {}, process: () => null, pages: async () => [page], newPage: async () => page, close: async () => {} }
browser.setBrowserLaunchDriverForProof(async () => child as never)
let state = { engineModel: 'claude-opus-5-5' as string | null, engineModelForSession: null as string | null, pendingModelSwitch: null }
const context = (agentId = 'switch-fixture') => ({ agentId, options: { engineModel: state.engineModel }, abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) }) as never
const owner = ownerFromToolUseContext(context())
try {
  assert.equal((await BrowserTool.checkPermissions({ op: 'open', url: page.url() }, context())).behavior, 'ask')
  assert.ok(!('state' in await browser.ensureBrowserSession(owner)))
  browser.approveWebOrigin(owner, 'https://example.test')
  const initial = browser.activeSession(owner)
  const changed = settleModelSelection(state, 'gpt-5.6-sol', { turnActive: false })
  assert.equal(changed.kind, 'applied')
  Object.assign(state, changed.patch)
  assert.equal(ownerFromToolUseContext(context()), owner)
  assert.equal(browser.activeSession(owner), initial)
  assert.equal((await BrowserTool.checkPermissions({ op: 'press', key: 'Tab' }, context())).behavior, 'allow')
  const acted = await BrowserTool.call({ op: 'press', key: 'Tab' }, context())
  assert.equal(acted.data.outcome, 'succeeded', acted.data.result)
  assert.equal(pressed, 1)
  assert.equal((await BrowserTool.checkPermissions({ op: 'open', url: page.url() }, context('other-agent'))).behavior, 'ask')
  await browser.closeBrowserSessionDetailed(owner)
  assert.equal((await BrowserTool.checkPermissions({ op: 'open', url: page.url() }, context())).behavior, 'ask')
  console.log('PASS same browser and origin grant survive the model switch; another agent and a closed session still ask')
} finally {
  await browser.closeBrowserSessionDetailed(owner)
  browser.setBrowserLaunchDriverForProof(null)
  rmSync(home, { recursive: true, force: true })
}
