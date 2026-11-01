import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pdfFixture } from './fixtures.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = mkdtempSync(join(tmpdir(), 'document-ocr-'))
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DESKTOP_PACK_DIR = resolve(import.meta.dir, '../../vendor/desktop', `${process.platform}-${process.arch}`)
const { resolveOcrEngine, ocrInstallHint } = await import('../../src/utils/ocr.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const ctx = (model: string) => ({ options: { engineModel: model }, readFileState: createFileStateCacheWithSizeLimit(100), abortController: new AbortController(), messages: [], getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) }) as never
try {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const absent = await resolveOcrEngine({ platform, native: () => undefined, probe: async () => false })
    assert.deepEqual(absent, { kind: 'unavailable', message: ocrInstallHint(platform) })
    const tesseract = await resolveOcrEngine({ platform, native: () => undefined, probe: async () => true, listLanguages: async () => ['eng', 'ara'] })
    assert.equal(tesseract.name, 'Tesseract')
  }
  const windows = await resolveOcrEngine({ platform: 'win32', native: () => ({ languages: ['en-US', 'ar-SA'], recognise: async () => 'Windows fixture' }), probe: async () => { throw new Error('native must precede PATH') } })
  assert.equal(windows.name, 'Windows OCR')
  console.log('PASS Windows/Linux OCR resolution and missing-engine hints; real Windows/Linux OCR not run')
  if (process.platform === 'darwin') {
    const { getImageProcessor } = await import('../../src/tools/FileReadTool/imageProcessor.ts')
    const sharp = await getImageProcessor()
    const svg = Buffer.from('<svg width="1200" height="240"><rect width="1200" height="240" fill="white"/><text x="40" y="120" font-size="64" font-family="Helvetica" fill="black">MERCURY RESEARCH 42</text></svg>')
    const png = await sharp(svg).png().toBuffer()
    const pngPath = join(root, 'text.png')
    writeFileSync(pngPath, png)
    const textOnly = await FileReadTool.call({ file_path: pngPath }, ctx('glm-5.3'))
    assert.equal(textOnly.data.type, 'text')
    assert.match(textOnly.data.file.content, /\[OCR: macOS Vision; languages:.*en-US/)
    assert.match(textOnly.data.file.content, /MERCURY RESEARCH 42/)
    const forced = await FileReadTool.call({ file_path: pngPath, ocr: true }, ctx('claude-sonnet-5-5'))
    assert.match(forced.data.file.content, /MERCURY RESEARCH 42/)
    const vision = await FileReadTool.call({ file_path: pngPath, crop: [0, 0, 1200, 240] }, ctx('claude-sonnet-5-5'))
    assert.equal(vision.data.type, 'image')
    assert.match(vision.data.file.caption ?? '', /MERCURY RESEARCH 42/)
    const persisted = FileReadTool.outputSchema.parse(JSON.parse(JSON.stringify(vision.data)))
    assert.match(JSON.stringify(FileReadTool.mapToolResultToToolResultBlockParam(persisted, 'vision-read')), /MERCURY RESEARCH 42/)
    const pixels = await sharp(png).removeAlpha().raw().toBuffer()
    const pdfPath = join(root, 'scan.pdf')
    writeFileSync(pdfPath, pdfFixture(['q 540 0 0 108 36 600 cm /Im1 Do Q'], { width: 1200, height: 240, rgb: pixels }))
    const scanned = await FileReadTool.call({ file_path: pdfPath }, ctx('glm-5.3'))
    assert.equal(scanned.data.type, 'text')
    assert.match(scanned.data.file.content, /--- page 1 ---/)
    assert.match(scanned.data.file.content, /\[OCR: macOS Vision; languages:.*en-US/)
    assert.match(scanned.data.file.content, /MERCURY RESEARCH 42/)
    const renderer = join(root, 'bin')
    mkdirSync(renderer)
    const jpegPath = join(root, 'rendered-page.jpg')
    writeFileSync(jpegPath, await sharp(png).jpeg().toBuffer())
    writeFileSync(join(renderer, 'pdftoppm'), `#!${process.execPath}\nimport { copyFileSync } from 'node:fs'; if (!process.argv.includes('-v')) copyFileSync(${JSON.stringify(jpegPath)}, process.argv.at(-1) + '-1.jpg');\n`, { mode: 0o755 })
    process.env.PATH = `${renderer}:${process.env.PATH}`
    const pageVision = await FileReadTool.call({ file_path: pdfPath, pages: '1' }, ctx('claude-sonnet-5-5'))
    assert.ok(JSON.stringify(pageVision.newMessages).includes('MERCURY RESEARCH 42'))
    console.log('PASS real macOS Vision OCR: PNG, explicit OCR on a vision model and scanned PDF')
  }
} finally { rmSync(root, { recursive: true, force: true }) }
