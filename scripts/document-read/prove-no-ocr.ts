import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, pdfFixture, reader, scratch } from './hardening-fixtures.ts'

const root = scratch('no-ocr')
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.env.MERCURY_DESKTOP_PACK_DIR = join(root, 'no-desktop-pack')
const originalPath = process.env.PATH
process.env.PATH = join(root, 'empty-bin')
mkdirSync(process.env.PATH)
try {
  const { read, healthy } = await reader(root)
  const { resolveOcrEngine } = await import('../../src/tools/kit/ocr.ts')
  const path = join(root, 'scan.pdf')
  writeFileSync(path, pdfFixture(['q 20 0 0 20 40 600 cm /Im1 Do Q'], { width: 1, height: 1, rgb: Buffer.from([0, 0, 0]) }))
  let message = ''
  try { message = `RETURNED ${await read(path)}` } catch (error) { message = (error as Error).message }
  console.log(message)
  await healthy()
  assert.match(message, /scan\.pdf.*image-only PDF/i, `reading an image-only PDF without OCR must throw an error naming the file and 'image-only PDF'; fix the throw in src/tools/read/call/pdfLane.ts. Got: ${message}`)
  assert.match(message, /install|Add-WindowsCapability/i, `the image-only PDF error must carry the OCR install hint; fix ocrInstallHint in src/tools/kit/ocr.ts. Got: ${message}`)
  assert.doesNotMatch(message, /unavailable|fallback|verified|RETURNED|\n\s*at /, `the image-only PDF error must be plain: no 'unavailable', 'fallback', 'verified', returned content or stack frames; RETURNED means the read succeeded instead of throwing (src/tools/read/call/pdfLane.ts). Got: ${message}`)
  for (const [platform, install, unrelated] of [['darwin', /brew install tesseract/, /apt-get|Windows/], ['linux', /apt-get install tesseract-ocr/, /brew|Windows/], ['win32', /Add-WindowsCapability.*Language\.OCR/, /brew|apt-get/]] as const) {
    const result = await resolveOcrEngine({ platform, native: () => undefined, probe: async () => false })
    assert.equal(result.kind, 'unavailable', `resolveOcrEngine in src/tools/kit/ocr.ts must return kind 'unavailable' for ${platform} when no native engine and no Tesseract are found`)
    if (result.kind === 'unavailable') { assert.match(result.message, install, `the ${platform} OCR hint must name its own install command; fix ocrInstallHint in src/tools/kit/ocr.ts. Got: ${result.message}`); assert.doesNotMatch(result.message, unrelated, `the ${platform} OCR hint must not mention another platform's install command; fix ocrInstallHint in src/tools/kit/ocr.ts. Got: ${result.message}`) }
  }
  console.log('PASS image-only PDF names the file and the platform OCR install; Windows, Linux, macOS hints and same-session health')
} finally { process.env.PATH = originalPath; cleanup(root) }
