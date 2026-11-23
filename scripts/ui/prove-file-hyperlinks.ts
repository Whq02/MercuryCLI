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
mock.module('../../src/platform/host-os/browser.js', () => ({
  openPath: async (path: string) => { paths.push(path); return true },
  openBrowser: async (url: string) => { urls.push(url); return true },
}))
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const { FullscreenLayout } = await import('../../src/screen/fullscreen-layout/FullscreenLayout.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { default: instances } = await import('../../src/screen/renderer/instances.js')
const target: { onHyperlinkClick?: (url: string) => void } = {}
const previous = instances.get(process.stdout)
instances.set(process.stdout, target as never)
const board = await mountOffscreen(createElement(AppStateProvider, null,
  createElement(FullscreenLayout, { scrollable: null, bottom: null })), 80, 24)
try {
  assert(await waitFor(() => target.onHyperlinkClick !== undefined, 2000), `FullscreenLayout never set ink.onHyperlinkClick within 2s; check the useEffect that assigns it in src/screen/fullscreen-layout/FullscreenLayout.tsx (it needs MERCURY_FULLSCREEN on)\n${board.screen()}`)
  for (const name of ['with space.ts', '日本語.ts', 'literal#hash%.ts']) {
    const path = join(process.cwd(), name)
    target.onHyperlinkClick!(pathToFileURL(path).href)
    assert.equal(paths.at(-1), path, `a file: link did not reach openPath as its file path; check onHyperlinkClick (fileURLToPath then openPath) in src/screen/fullscreen-layout/FullscreenLayout.tsx`)
  }
  target.onHyperlinkClick!('https://example.test/a%20b')
  assert.deepEqual(urls, ['https://example.test/a%20b'], 'a web link did not reach openBrowser unchanged; check the non-file branch of onHyperlinkClick in src/screen/fullscreen-layout/FullscreenLayout.tsx')
  const before = paths.length
  assert.doesNotThrow(() => target.onHyperlinkClick!('file://['), 'a malformed file: link threw; onHyperlinkClick in src/screen/fullscreen-layout/FullscreenLayout.tsx must catch the fileURLToPath error')
  assert.equal(paths.length, before, 'a malformed file: link was still opened; onHyperlinkClick in src/screen/fullscreen-layout/FullscreenLayout.tsx must not call openPath when fileURLToPath throws')
  console.log('PASS file hyperlinks: spaces, Unicode, reserved characters, web URL, malformed URL')
} finally {
  board.unmount()
  if (previous) instances.set(process.stdout, previous)
  else instances.delete(process.stdout)
  rmSync(scratch, { recursive: true, force: true })
}
assert.equal(target.onHyperlinkClick, undefined, 'ink.onHyperlinkClick stayed set after unmount; the useEffect cleanup in src/screen/fullscreen-layout/FullscreenLayout.tsx must reset it to undefined')
console.log('PASS file hyperlink handler removed on unmount')
process.exit(0)
