import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mock } from 'bun:test'
import { createElement } from 'react'
import { mountOffscreen, pinSourceRef, waitFor } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const scratch = mkdtempSync(join(tmpdir(), 'file-hyperlinks-'))
delete process.env.MERCURY_HOME
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_REDUCED_MOTION = '1'
const paths: string[] = []
const urls: string[] = []
mock.module('../../src/utils/browser.js', () => ({
  openPath: async (path: string) => { paths.push(path); return true },
  openBrowser: async (url: string) => { urls.push(url); return true },
}))
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { default: instances } = await import('../../src/ink/instances.js')
const target: { onHyperlinkClick?: (url: string) => void } = {}
const previous = instances.get(process.stdout)
instances.set(process.stdout, target as never)
const board = await mountOffscreen(createElement(AppStateProvider, null,
  createElement(FullscreenLayout, { scrollable: null, bottom: null })), 80, 24)
try {
  assert(await waitFor(() => target.onHyperlinkClick !== undefined, 2000), board.screen())
  for (const name of ['with space.ts', '日本語.ts', 'literal#hash%.ts']) {
    const path = join(process.cwd(), name)
    target.onHyperlinkClick!(pathToFileURL(path).href)
    assert.equal(paths.at(-1), path)
  }
  target.onHyperlinkClick!('https://example.test/a%20b')
  assert.deepEqual(urls, ['https://example.test/a%20b'])
  const before = paths.length
  assert.doesNotThrow(() => target.onHyperlinkClick!('file://['))
  assert.equal(paths.length, before)
  console.log('PASS file hyperlinks: spaces, Unicode, reserved characters, web URL, malformed URL')
} finally {
  board.unmount()
  if (previous) instances.set(process.stdout, previous)
  else instances.delete(process.stdout)
  rmSync(scratch, { recursive: true, force: true })
}
assert.equal(target.onHyperlinkClick, undefined)
console.log('PASS file hyperlink handler removed on unmount')
process.exit(0)
