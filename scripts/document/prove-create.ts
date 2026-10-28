import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import ExcelJS from 'exceljs'
import mammoth from 'mammoth'
import { Document, Packer, Paragraph, TextRun } from 'docx'

;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const { createDocument } = await import('../../src/tools/DocumentTool/create.ts')
const { captureDestinations, commitDocuments } = await import('../../src/tools/DocumentTool/files.ts')
const io = { read: async (path: string) => readFileSync(path), signal: new AbortController().signal }
const png = join(proofHome, 'image.png')
writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'))
const common = { op: 'create' as const, renderer: 'plain' as const, markdown: '# Evidence\n\nA **bold** paragraph with note[^n].\n\n- First\n- Second\n\n| Name | Value |\n| --- | --- |\n| Sample | 42 |\n\n[^n]: A source.', titlePage: { title: 'Research', author: 'Example Author' }, header: 'Research', footer: 'Draft', pageNumbers: true, metadata: { title: 'Evidence report', author: 'Example Author' }, blocks: [{ kind: 'image' as const, path: png, alt: 'Fixture', width: 40, height: 40 }, { kind: 'pageBreak' as const }, { kind: 'paragraph' as const, text: 'Final page' }] }
try {
  for (const format of ['docx', 'pdf', 'pptx', 'xlsx', 'html', 'md']) {
    const output = join(proofHome, `report.${format}`)
    const input = { ...common, output }
    const targets = captureDestinations(input)
    const product = await createDocument(input, io)
    commitDocuments(product, targets, io.signal)
    const bytes = readFileSync(output)
    assert.ok(bytes.length)
    if (format === 'docx') {
      const zip = unzipSync(bytes)
      for (const name of ['word/document.xml', 'word/styles.xml', 'word/footnotes.xml', 'word/header1.xml', 'word/footer1.xml']) assert.ok(zip[name], name)
      const xml = strFromU8(zip['word/document.xml']!)
      assert.match(xml, /w:tbl/)
      assert.match(xml, /w:footnoteReference/)
      assert.match(xml, /w:b/)
      assert.ok(Object.keys(zip).some(k => k.startsWith('word/media/')))
      assert.match((await mammoth.extractRawText({ buffer: bytes })).value, /Evidence/)
    } else if (format === 'pdf') {
      assert.equal(product.road, 'pdf-lib plain layout')
      const pdf = await PDFDocument.load(bytes)
      assert.equal(pdf.getPageCount(), 3)
      assert.equal(pdf.getTitle(), 'Evidence report')
      const operators = pdf.getPages().flatMap(page => {
        const contents = page.node.Contents()
        const entries = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : []
        return entries.map(entry => { const stream = pdf.context.lookup(entry); return stream instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(stream).decode()).toString() : '' })
      }).join('\n')
      assert.match(operators, /<45766964656E6365> Tj/)
      assert.match(operators, /<46696E616C2070616765> Tj/)
    } else if (format === 'pptx') {
      const zip = unzipSync(bytes)
      const slides = Object.keys(zip).filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))
      assert.ok(slides.length >= 3)
      assert.match(slides.map(s => strFromU8(zip[s]!)).join(''), /Evidence/)
    } else if (format === 'xlsx') {
      const book = new ExcelJS.Workbook()
      await book.xlsx.load(bytes as any)
      assert.equal(book.worksheets[0]!.getCell('B2').value, '42')
      assert.ok(unzipSync(bytes)['xl/workbook.xml'])
    } else {
      assert.match(bytes.toString(), /Evidence/)
      if (format === 'html') { assert.match(bytes.toString(), /<table>/); assert.match(bytes.toString(), /data:image\/png/); assert.match(bytes.toString(), /default-src 'none'/) }
    }
  }
  for (const data of [{ csv: 'Name,Value\r\n"Two, words","a\nb"\r\n', sheet: 'CSV' }, { json: [{ Name: 'Sample', Value: 7 }], sheet: 'JSON' }]) {
    const product = await createDocument({ op: 'create', output: join(proofHome, `${data.sheet}.xlsx`), ...data }, io)
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(product.files[0]!.bytes as any)
    assert.equal(book.worksheets[0]!.name, data.sheet)
    assert.equal(book.worksheets[0]!.rowCount, 2)
  }
  const template = join(proofHome, 'template.docx')
  writeFileSync(template, await Packer.toBuffer(new Document({ styles: { paragraphStyles: [{ id: 'EvidenceStyle', name: 'Evidence Style', run: { color: '123456' } }] }, sections: [{ children: [new Paragraph({ style: 'EvidenceStyle', children: [new TextRun('{{name}}')] })] }] })))
  const result = await createDocument({ op: 'create', output: join(proofHome, 'filled.docx'), template, replacements: { name: 'Filled title' } }, io)
  const original = unzipSync(readFileSync(template)), patched = unzipSync(result.files[0]!.bytes)
  assert.equal(strFromU8(patched['word/styles.xml']!), strFromU8(original['word/styles.xml']!))
  assert.match(strFromU8(patched['word/document.xml']!), /Filled title/)
  assert.doesNotMatch(strFromU8(patched['word/document.xml']!), /\{\{name\}\}/)
  const html = await createDocument({ op: 'create', output: join(proofHome, 'safe.html'), markdown: '<script>fetch("https://example.com")</script>' }, io)
  assert.doesNotMatch(Buffer.from(html.files[0]!.bytes).toString(), /<script>/)
  await assert.rejects(createDocument({ op: 'create', output: join(proofHome, 'remote.pdf'), blocks: [{ kind: 'image', path: 'https://example.com/image.png' }] }, { ...io, read: async () => { throw new Error('No remote image reads') } }), /No remote image reads/)
  console.log('PASS create: six formats read back; DOCX package parts, styles and placeholders; PDF pages and content streams; spreadsheet CSV/JSON and HTML escaping')
} finally { rmSync(proofHome, { recursive: true, force: true }) }
