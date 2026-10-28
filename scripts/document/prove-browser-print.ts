import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { rmSync } from 'node:fs'

;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const decisions: string[] = []
let requests: (r: any) => void = () => undefined
let closeCount = 0, options: any, html = ''
const resolver = await import('../../src/services/browser/browserResolver.ts')
const sessions = await import('../../src/services/browser/browserSession.ts')
mock.module('../../src/services/browser/browserResolver.js', () => ({ ...resolver, resolveBrowser: () => ({ state: 'ok', source: 'managed-cache', executablePath: '/fixture/chrome' }) }))
mock.module('../../src/services/browser/browserSession.js', () => ({ ...sessions,
  ensureBrowserSession: async () => ({ page: {
    setJavaScriptEnabled: async (enabled: boolean) => assert.equal(enabled, false),
    setRequestInterception: async (enabled: boolean) => assert.equal(enabled, true),
    on: (_event: string, callback: (r: any) => void) => { requests = callback },
    setContent: async (text: string) => { html = text },
    pdf: async (value: any) => { options = value; return new Uint8Array([37, 80, 68, 70]) },
  } }),
  closeBrowserSession: async () => { closeCount++; return true },
}))
const { printDocument } = await import('../../src/tools/DocumentTool/print.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
try {
  const owner = makeOwnerKey({ workspace: proofHome, sessionId: 'proof', lane: 'main' })
  const browserFlag = process.env.MERCURY_BROWSER
  process.env.MERCURY_BROWSER = '0'
  try {
    assert.equal(await printDocument('<p>Off</p>', { op: 'create' }, owner, new AbortController().signal), null)
    await assert.rejects(printDocument('<p>Off</p>', { op: 'create', renderer: 'browser' }, owner, new AbortController().signal), /disabled/)
    assert.equal(closeCount, 0)
  } finally { if (browserFlag === undefined) delete process.env.MERCURY_BROWSER; else process.env.MERCURY_BROWSER = browserFlag }
  const bytes = await printDocument('<p>Print fixture</p>', { op: 'create', paper: 'Letter', margin: 72, pageNumbers: true }, owner, new AbortController().signal)
  assert.equal(Buffer.from(bytes!).toString(), '%PDF')
  assert.equal(html, '<p>Print fixture</p>')
  assert.equal(options.format, 'Letter')
  assert.equal(options.margin.top, '72pt')
  assert.equal(options.displayHeaderFooter, true)
  for (const url of ['https://example.com/', 'file:///secret', 'data:text/html,hello', 'data:image/png;base64,YQ==']) requests({ isInterceptResolutionHandled: () => false, url: () => url, continue: async () => decisions.push('allow'), abort: async () => decisions.push('deny') })
  assert.deepEqual(decisions, ['deny', 'deny', 'deny', 'allow'])
  assert.equal(closeCount, 1)
  console.log('PASS print contract: bundled session owner, Letter/margins/page numbers, scripts disabled, network and file URLs denied, session closed; stand-in page, not a live browser render')
} finally { rmSync(proofHome, { recursive: true, force: true }) }
