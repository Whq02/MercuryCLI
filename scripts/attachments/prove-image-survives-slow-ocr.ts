import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const arg = process.argv.indexOf('--source-root')
const root = arg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[arg + 1]!)
const scratch = mkdtempSync(join(tmpdir(), 'image-survives-slow-ocr-'))
const binDir = join(scratch, 'bin')
mkdirSync(binDir, { recursive: true })
const prevPath = process.env.PATH
const prevDesktopPack = process.env.MERCURY_DESKTOP_PACK_DIR
const prevDelay = process.env.MERCURY_TEST_OCR_DELAY_MS
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DESKTOP_PACK_DIR = join(scratch, 'no-desktop-pack')
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const stubScript = join(binDir, 'tesseract-stub.mjs')
writeFileSync(
  stubScript,
  [
    "if (process.argv.includes('--version')) { console.log('tesseract 5.0.0'); process.exit(0) }",
    "if (process.argv.includes('--list-langs')) { console.log('List of available languages (1):\\neng'); process.exit(0) }",
    "process.on('SIGTERM', () => process.exit(0))",
    "process.on('SIGINT', () => process.exit(0))",
    "const mode = process.env.MERCURY_TEST_OCR_DELAY_MS ?? 'hang'",
    "if (mode === 'hang') { setTimeout(() => process.exit(0), 30000) } else {",
    "  setTimeout(() => { console.log('MERCURY SLOW OCR SURVIVED'); process.exit(0) }, Number(mode))",
    '}',
  ].join('\n'),
)
if (process.platform === 'win32') {
  writeFileSync(join(binDir, 'tesseract.cmd'), `@echo off\r\n"${process.execPath}" "${stubScript}" %*\r\n`)
} else {
  writeFileSync(join(binDir, 'tesseract'), `#!/bin/sh\nexec "${process.execPath}" "${stubScript}" "$@"\n`, { mode: 0o755 })
}
process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`

try {
  const { processAtMentionedFiles } = await import(`${root}/src/engine/attachments/mentionResolvers.ts`)
  const { normalizeAttachmentForAPI } = await import(`${root}/src/engine/messages/attachmentText.ts`)
  const { FileReadTool } = await import(`${root}/src/tools/read/ReadTool.ts`)
  const { getEmptyToolPermissionContext } = await import(`${root}/src/tools/kit/tool.ts`)
  const { createFileStateCacheWithSizeLimit } = await import(`${root}/src/platform/files/fileStateCache.ts`)
  const { getImageProcessor } = await import(`${root}/src/platform/images/imageProcessor.ts`)

  const sharp = await getImageProcessor()
  const makePng = (name: string, b: number): Promise<string> =>
    sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 244, g: 244, b } } })
      .png()
      .toBuffer()
      .then(buf => {
        const path = join(scratch, name)
        writeFileSync(path, buf)
        return path
      })
  const [hangPng, explicitPng, textModelPng] = await Promise.all([
    makePng('hang.png', 240),
    makePng('explicit.png', 239),
    makePng('text-model.png', 238),
  ])

  const makeContext = (engineModel: string) => ({
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
    options: { engineModel },
    readFileState: createFileStateCacheWithSizeLimit(100),
    abortController: new AbortController(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    messages: [],
  })

  process.env.MERCURY_TEST_OCR_DELAY_MS = 'hang'
  const started = performance.now()
  const rows = await processAtMentionedFiles(`describe @${hangPng}`, makeContext('claude-sonnet-5-5') as never)
  const elapsedMs = Math.round(performance.now() - started)

  assert.equal(rows.length, 1, `expected 1 attachment row, got ${rows.length}: ${JSON.stringify(rows).slice(0, 300)}`)
  const row = rows[0] as { type: string; content?: { type?: string; file?: { base64?: string; caption?: string } }; reason?: string }
  assert.equal(row.type, 'file', `image mention was dropped instead of kept as a file row (elapsed=${elapsedMs}ms): ${JSON.stringify(row).slice(0, 300)}`)
  assert.equal(row.content?.type, 'image', `expected image content in file row: ${JSON.stringify(row.content).slice(0, 200)}`)
  assert.ok((row.content?.file?.base64?.length ?? 0) > 0, 'image base64 must be non-empty')
  assert.ok(!(row.content?.file?.caption ?? '').includes('[OCR:'), `hanging OCR should be omitted from caption: ${row.content?.file?.caption}`)
  assert.ok(elapsedMs < 8_000, `mention waited too long (${elapsedMs}ms) instead of bounding caption OCR`)

  const apiMessages = normalizeAttachmentForAPI(row as never)
  const serialized = JSON.stringify(apiMessages)
  assert.ok(serialized.includes('"type":"image"'), `normalized API attachment must carry the image block: ${serialized.slice(0, 300)}`)
  assert.ok(!serialized.includes('took longer than 10 seconds'), 'normalized API attachment must not carry the 10s drop note')
  console.log(`PASS hanging OCR: mention yielded the image in ${elapsedMs}ms without OCR caption`)

  process.env.MERCURY_TEST_OCR_DELAY_MS = '3600'
  const [explicitOcr, textOnlyModel] = await Promise.all([
    FileReadTool.call({ file_path: explicitPng, ocr: true }, makeContext('claude-sonnet-5-5') as never),
    FileReadTool.call({ file_path: textModelPng }, makeContext('glm-5.3') as never),
  ])
  assert.equal(explicitOcr.data.type, 'text', `explicit ocr: true must return text, got ${explicitOcr.data.type}`)
  assert.match(explicitOcr.data.file.content, /MERCURY SLOW OCR SURVIVED/)
  assert.equal(textOnlyModel.data.type, 'text', `text-only model must return text, got ${textOnlyModel.data.type}`)
  assert.match(textOnlyModel.data.file.content, /MERCURY SLOW OCR SURVIVED/)
  console.log('PASS content OCR: explicit ocr:true and non-image model still wait past the caption ceiling')
} finally {
  if (prevPath === undefined) delete process.env.PATH
  else process.env.PATH = prevPath
  if (prevDesktopPack === undefined) delete process.env.MERCURY_DESKTOP_PACK_DIR
  else process.env.MERCURY_DESKTOP_PACK_DIR = prevDesktopPack
  if (prevDelay === undefined) delete process.env.MERCURY_TEST_OCR_DELAY_MS
  else process.env.MERCURY_TEST_OCR_DELAY_MS = prevDelay
  rmSync(scratch, { recursive: true, force: true })
}
