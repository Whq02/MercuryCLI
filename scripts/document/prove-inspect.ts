import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument, PDFName, PDFString } from 'pdf-lib'

;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const { createDocument } = await import('../../src/tools/DocumentTool/create.ts')
const { inspectDocument } = await import('../../src/tools/DocumentTool/inspect.ts')
const { digest } = await import('../../src/tools/DocumentTool/files.ts')
const io = { read: async (path: string) => readFileSync(path), signal: new AbortController().signal }
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
try {
  const png = join(proofHome, 'image.png'); writeFileSync(png, pngBytes)
  for (const format of ['docx', 'pdf', 'pptx', 'xlsx', 'md', 'html']) {
    const output = join(proofHome, `structure.${format}`)
    const product = await createDocument({ op: 'create', output, markdown: '# Outline title\n\nPRIVATE_BODY_SENTINEL\n\n| Column | Count |\n| --- | --- |\n| Private cell | 7 |', renderer: 'plain', metadata: { title: 'Structure fixture', author: 'Author' }, blocks: [{ kind: 'image', path: png }] }, io)
    writeFileSync(output, product.files[0]!.bytes)
    const result = await inspectDocument({ op: 'inspect', source: output }, io)
    const map = result.detail as any
    assert.equal(result.files.length, 0)
    assert.equal(map.sha256, digest(readFileSync(output)))
    assert.equal(map.format, format)
    assert.ok(map.wordCount > 0)
    assert.doesNotMatch(JSON.stringify(map), /PRIVATE_BODY_SENTINEL|Private cell/)
    if (format === 'docx') {
      assert.equal(map.outline[0].title, 'Outline title')
      assert.deepEqual(map.tables, [{ rows: 2, columns: 2 }])
      assert.equal(map.images, 1)
      assert.equal(map.metadata.title, 'Structure fixture')
      assert.equal(map.pages, null)
    } else if (format === 'pdf') {
      assert.equal(map.pages, 1)
      assert.equal(map.pageMap[0].hasTextLayer, true)
      assert.equal(map.images, 1)
      assert.equal(map.tables, null)
    } else if (format === 'xlsx') assert.deepEqual(map.tables[0], { name: 'Table1', rows: 2, columns: 2, tables: 0 })
  }
  const pdf = await PDFDocument.create()
  const textPage = pdf.addPage(); textPage.drawText('Body not returned')
  const image = await pdf.embedPng(pngBytes)
  pdf.addPage().drawImage(image, { x: 0, y: 0, width: 10, height: 10 })
  pdf.addPage()
  const outlineRoot = pdf.context.obj({ Type: 'Outlines' })
  const rootRef = pdf.context.register(outlineRoot)
  const item = pdf.context.obj({ Title: PDFString.of('PDF heading'), Parent: rootRef, Dest: [textPage.ref, 'Fit'] })
  const itemRef = pdf.context.register(item)
  outlineRoot.set(PDFName.of('First'), itemRef); outlineRoot.set(PDFName.of('Last'), itemRef)
  pdf.catalog.set(PDFName.of('Outlines'), rootRef)
  const path = join(proofHome, 'mixed.pdf'); writeFileSync(path, await pdf.save())
  const mixed = (await inspectDocument({ op: 'inspect', source: path }, io)).detail as any
  assert.equal(mixed.pages, 3)
  assert.deepEqual(mixed.pageMap.map((p: any) => p.hasTextLayer), [true, false, false])
  assert.deepEqual(mixed.pageMap.map((p: any) => p.hasImages), [false, true, false])
  assert.deepEqual(mixed.outline, [{ level: 1, title: 'PDF heading', page: 1 }])
  assert.doesNotMatch(JSON.stringify(mixed), /Body not returned/)
  const csv = join(proofHome, 'table.csv'); writeFileSync(csv, 'Name,Value\nA,2\n')
  assert.deepEqual(((await inspectDocument({ op: 'inspect', source: csv }, io)).detail as any).tables, [{ rows: 2, columns: 2 }])
  console.log('PASS inspect: structure without body, SHA-256, headings, table sizes, image counts, metadata, PDF outlines and per-page text-layer/image flags')
} finally { rmSync(proofHome, { recursive: true, force: true }) }
