import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pdfFixture, textPage } from './fixtures.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = mkdtempSync(join(tmpdir(), 'pdf-text-'))
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.env.MERCURY_BARE = '1'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const src = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { FileReadTool } = await import(`${src}/tools/FileReadTool/FileReadTool.ts`)
const { getEmptyToolPermissionContext } = await import(`${src}/Tool.ts`)
const { createFileStateCacheWithSizeLimit } = await import(`${src}/utils/fileStateCache.ts`)
const context = (model: string) => ({ options: { engineModel: model }, readFileState: createFileStateCacheWithSizeLimit(100), abortController: new AbortController(), messages: [], getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) })
async function read(input: object, model = 'glm-5.3') {
  const ctx = context(model)
  const valid = await FileReadTool.validateInput(input, ctx)
  assert.equal(valid.result, true, valid.message)
  return FileReadTool.call(input, ctx, undefined, { uuid: crypto.randomUUID() })
}
try {
  const path = join(root, 'paper.pdf')
  writeFileSync(path, pdfFixture(Array.from({ length: 200 }, (_, i) => i === 0 ? 'BT /F1 12 Tf 40 740 Td (Item) Tj 180 0 Td (Value) Tj -180 -20 Td (Mercury) Tj 180 0 Td (42) Tj ET' : textPage(`Research page ${i + 1}`))))
  for (const model of ['glm-5.3', 'gpt-5.2', 'claude-sonnet-5-5']) {
    const r = await read({ file_path: path, offset: 1, limit: 4 }, model)
    assert.equal(r.data.type, 'text')
    assert.match(r.data.file.content, /--- page 1 ---/)
    assert.match(r.data.file.content, /Mercury\t42/)
    assert.equal(r.data.file.numLines, 4)
    assert.ok(!r.newMessages?.some((m: any) => JSON.stringify(m).includes('"type":"document"')))
  }
  const selected = await read({ file_path: path, pages: '200' })
  assert.match(selected.data.file.content, /--- page 200 ---\nResearch page 200/)
  const tail = await read({ file_path: path, offset: -2 })
  assert.match(tail.data.file.content, /Research page 200/)
  const { extractPdfText, parsePdfText } = await import(`${src}/utils/pdfText.ts`)
  const a = await extractPdfText(path)
  const b = await extractPdfText(path)
  assert.deepEqual(a, b)
  assert.equal(a.pageCount, 200)
  assert.equal(a.pages[0].hasTextLayer, true)
  const image = await parsePdfText(pdfFixture(['q 20 0 0 20 40 600 cm /Im1 Do Q'], { width: 1, height: 1, rgb: Buffer.from([0, 0, 0]) }))
  assert.equal(image.pages[0].hasTextLayer, false)
  assert.equal(image.pages[0].hasImages, true)
  await assert.rejects(parsePdfText(Buffer.from('not a PDF')), /PDF/)
  await assert.rejects(parsePdfText(pdfFixture([textPage('too big')]), 3), /limit/)
  writeFileSync(path, pdfFixture([textPage('Changed bytes')]))
  assert.match((await extractPdfText(path)).pages[0].text, /Changed bytes/)
  console.log('PASS PDF text: 200 pages, all model roads, table rows, windows, page selection, content hash cache, images and invalid files')
} finally {
  rmSync(root, { recursive: true, force: true })
}
