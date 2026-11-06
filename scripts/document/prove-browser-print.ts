import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import { parsePDFOptions } from 'puppeteer-core/internal/common/util.js'

;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const ROOT = resolve(import.meta.dir, '..', '..')
const resolver = await import('../../src/services/browser/browserResolver.ts')
const sessions = await import('../../src/services/browser/browserSession.ts')
const { printDocument } = await import('../../src/tools/DocumentTool/print.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const owner = makeOwnerKey({ workspace: proofHome, sessionId: 'proof', lane: 'main' })
const fresh = (): AbortSignal => new AbortController().signal

type Glyph = { text: string; x: number; baseline: number }
type Sheet = { width: number; height: number; glyphs: Glyph[] }
const readerNotes: string[] = []
async function readSheets(bytes: Uint8Array): Promise<Sheet[]> {
  const pack = join(ROOT, 'vendor/pdfjs/extracted')
  const { log, warn } = console
  console.log = console.warn = (...args: unknown[]) => { readerNotes.push(args.map(String).join(' ')) }
  try {
    const api = await import(pathToFileURL(join(pack, 'legacy/build/pdf.mjs')).href)
    api.GlobalWorkerOptions.workerSrc = pathToFileURL(join(pack, 'legacy/build/pdf.worker.mjs')).href
    const task = api.getDocument({ data: bytes.slice(), isEvalSupported: false, useWorkerFetch: false, useSystemFonts: false, cMapUrl: `${pack}/cmaps/`, cMapPacked: true, standardFontDataUrl: `${pack}/standard_fonts/`, disableFontFace: true, isOffscreenCanvasSupported: false, isImageDecoderSupported: false })
    try {
      return await readPages(await task.promise)
    } finally { await task.destroy() }
  } finally { console.log = log; console.warn = warn }
}
async function readPages(doc: any): Promise<Sheet[]> {
  const sheets: Sheet[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const [left, bottom, right, top] = page.view as number[]
    const height = top! - bottom!
    const content = await page.getTextContent()
    const glyphs: Glyph[] = content.items.filter((item: any) => typeof item.str === 'string' && item.str.trim() !== '').map((item: any) => ({ text: item.str.trim(), x: item.transform[4] - left!, baseline: height - (item.transform[5] - bottom!) }))
    sheets.push({ width: right! - left!, height, glyphs })
    page.cleanup()
  }
  return sheets
}

const fixture = (words: string, pages: number): string => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:12pt serif}p{margin:0}.page-break{break-after:page}</style></head><body>${Array.from({ length: pages }, (_, i) => `${i > 0 ? '<div class="page-break"></div>' : ''}<p>${words} page ${i + 1}</p>`).join('')}</body></html>`
const near = (actual: number, wanted: number, within: number, what: string): void => assert.ok(Math.abs(actual - wanted) <= within, `${what}: ${actual} is not within ${within} of ${wanted}`)

async function liveLeg(): Promise<string> {
  const resolution = resolver.resolveBrowser()
  if (resolution.state !== 'ok') {
    console.log(`  [SKIP] live print: no drivable browser in the proof home (${resolution.note}); MERCURY_BROWSER_CACHE_DIR=<config home>/browsers names a managed Chrome-for-Testing cache and runs this leg; the driver-parser legs carry the law`)
    return 'live print skipped'
  }
  console.log(`  live print through ${resolution.label} (${resolution.executablePath})`)
  const legs: { input: Parameters<typeof printDocument>[1]; margin: number; sheet: [number, number]; pages: number; words: string }[] = [
    { input: { op: 'create' }, margin: 54, sheet: [595.28, 841.89], pages: 2, words: 'Default margin' },
    { input: { op: 'create', margin: 36, paper: 'Letter', pageNumbers: true }, margin: 36, sheet: [612, 792], pages: 1, words: 'Half inch margin' },
  ]
  for (const leg of legs) {
    const bytes = await printDocument(fixture(leg.words, leg.pages), leg.input, owner, fresh())
    assert.ok(bytes && bytes.length > 1000, `${leg.words}: the browser returned ${bytes?.length ?? 'no'} bytes`)
    assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('ascii'), '%PDF-')
    const loaded = await PDFDocument.load(bytes)
    assert.equal(loaded.getPageCount(), leg.pages, `${leg.words}: page count`)
    for (const [index, page] of loaded.getPages().entries()) {
      const box = page.getMediaBox()
      near(box.width, leg.sheet[0], 2, `${leg.words}: page ${index + 1} media box width`)
      near(box.height, leg.sheet[1], 2, `${leg.words}: page ${index + 1} media box height`)
    }
    const sheets = await readSheets(bytes)
    assert.equal(sheets.length, leg.pages)
    const drawn: number[] = []
    for (const [index, sheet] of sheets.entries()) {
      const line = sheet.glyphs.find(glyph => glyph.text.startsWith(leg.words))
      assert.ok(line, `${leg.words}: page ${index + 1} carries no body text; glyphs ${JSON.stringify(sheet.glyphs)}; reader notes ${JSON.stringify(readerNotes)}`)
      const row = sheet.glyphs.filter(glyph => Math.abs(glyph.baseline - line.baseline) < 1).sort((a, b) => a.x - b.x)
      assert.equal(row.map(glyph => glyph.text).join(' '), `${leg.words} page ${index + 1}`)
      near(line.x, leg.margin, 1, `${leg.words}: page ${index + 1} body text x offset (the left margin as drawn)`)
      drawn.push(line.x)
      assert.ok(line.baseline > leg.margin && line.baseline < leg.margin + 24, `${leg.words}: page ${index + 1} first baseline ${line.baseline} from the top does not sit just inside a ${leg.margin}pt top margin`)
      if (leg.input.pageNumbers) {
        const number = sheet.glyphs.find(glyph => glyph.text === String(index + 1) && glyph.baseline > sheet.height - leg.margin)
        assert.ok(number, `${leg.words}: page ${index + 1} has no page number inside the bottom margin; glyphs ${JSON.stringify(sheet.glyphs)}`)
      }
    }
    console.log(`  live ${leg.words.toLowerCase()} (${leg.input.paper ?? 'A4'}, ${leg.pages} page${leg.pages > 1 ? 's' : ''}): media box ${sheets[0]!.width.toFixed(2)}x${sheets[0]!.height.toFixed(2)}pt, body text at x=${drawn.map(x => x.toFixed(2)).join(' and ')}pt for a ${leg.margin}pt margin`)
  }
  return `live print through ${resolution.label}: A4 default margin drawn at 54pt over two pages, Letter margin 36 drawn at 36pt with its page number`
}

try {
  const liveWords = await liveLeg()
  const decisions: string[] = []
  let requests: (r: any) => void = () => undefined
  let closeCount = 0, options: any, parsed: any, html = ''
  mock.module('../../src/services/browser/browserResolver.js', () => ({ ...resolver, resolveBrowser: () => ({ state: 'ok', source: 'managed-cache', executablePath: '/fixture/chrome' }) }))
  mock.module('../../src/services/browser/browserSession.js', () => ({ ...sessions,
    ensureBrowserSession: async () => ({ page: {
      setJavaScriptEnabled: async (enabled: boolean) => assert.equal(enabled, false),
      setRequestInterception: async (enabled: boolean) => assert.equal(enabled, true),
      on: (_event: string, callback: (r: any) => void) => { requests = callback },
      setContent: async (text: string) => { html = text },
      pdf: async (value: any) => { options = value; parsed = parsePDFOptions(value); return new Uint8Array([37, 80, 68, 70]) },
    } }),
    closeBrowserSession: async () => { closeCount++; return true },
  }))
  const browserFlag = process.env.MERCURY_BROWSER
  process.env.MERCURY_BROWSER = '0'
  try {
    assert.equal(await printDocument('<p>Off</p>', { op: 'create' }, owner, fresh()), null)
    await assert.rejects(printDocument('<p>Off</p>', { op: 'create', renderer: 'browser' }, owner, fresh()), /disabled/)
    assert.equal(closeCount, 0)
  } finally { if (browserFlag === undefined) delete process.env.MERCURY_BROWSER; else process.env.MERCURY_BROWSER = browserFlag }
  const standIn = async (input: Parameters<typeof printDocument>[1]): Promise<void> => {
    const bytes = await printDocument('<p>Print fixture</p>', input, owner, fresh())
    assert.equal(Buffer.from(bytes!).toString(), '%PDF')
    assert.equal(html, '<p>Print fixture</p>')
  }
  await standIn({ op: 'create' })
  assert.equal(options.format, 'A4')
  assert.equal(options.margin.top, '0.75in')
  assert.deepEqual(parsed.margin, { top: 0.75, left: 0.75, bottom: 0.75, right: 0.75 })
  assert.equal(options.displayHeaderFooter, false)
  await standIn({ op: 'create', paper: 'Letter', margin: 72, pageNumbers: true })
  assert.equal(options.format, 'Letter')
  assert.deepEqual(options.margin, { top: '1in', bottom: '1in', left: '1in', right: '1in' })
  assert.deepEqual(parsed.margin, { top: 1, left: 1, bottom: 1, right: 1 })
  assert.equal(parsed.width, 8.5)
  assert.equal(parsed.height, 11)
  assert.equal(options.displayHeaderFooter, true)
  await standIn({ op: 'create', margin: 36 })
  assert.equal(options.margin.left, '0.5in')
  assert.equal(parsed.margin.left, 0.5)
  for (const url of ['https://example.com/', 'file:///secret', 'data:text/html,hello', 'data:image/png;base64,YQ==']) requests({ isInterceptResolutionHandled: () => false, url: () => url, continue: async () => decisions.push('allow'), abort: async () => decisions.push('deny') })
  assert.deepEqual(decisions, ['deny', 'deny', 'deny', 'allow'])
  assert.equal(closeCount, 3)
  console.log(`PASS print contract: bundled session owner, Letter/page numbers, scripts disabled, network and file URLs denied, session closed after every print; margins in points reach the driver as inches (54 as 0.75in, 72 as 1in, 36 as 0.5in) and pass its own page.pdf option parser; ${liveWords}`)
} finally { rmSync(proofHome, { recursive: true, force: true }) }
