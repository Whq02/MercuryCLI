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
  const { resolveOcrEngine } = await import('../../src/utils/ocr.ts')
  const path = join(root, 'scan.pdf')
  writeFileSync(path, pdfFixture(['q 20 0 0 20 40 600 cm /Im1 Do Q'], { width: 1, height: 1, rgb: Buffer.from([0, 0, 0]) }))
  let message = ''
  try { message = `RETURNED ${await read(path)}` } catch (error) { message = (error as Error).message }
  console.log(message)
  await healthy()
  assert.match(message, /scan\.pdf.*image-only PDF/i)
  assert.match(message, /install|Add-WindowsCapability/i)
  assert.doesNotMatch(message, /unavailable|fallback|verified|RETURNED|\n\s*at /)
  for (const [platform, install, unrelated] of [['darwin', /brew install tesseract/, /apt-get|Windows/], ['linux', /apt-get install tesseract-ocr/, /brew|Windows/], ['win32', /Add-WindowsCapability.*Language\.OCR/, /brew|apt-get/]] as const) {
    const result = await resolveOcrEngine({ platform, native: () => undefined, probe: async () => false })
    assert.equal(result.kind, 'unavailable')
    if (result.kind === 'unavailable') { assert.match(result.message, install); assert.doesNotMatch(result.message, unrelated) }
  }
  console.log('PASS image-only PDF names the file and the platform OCR install; Windows, Linux, macOS hints and same-session health')
} finally { process.env.PATH = originalPath; cleanup(root) }
