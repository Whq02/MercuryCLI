import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { PDFDocument } from 'pdf-lib'
import mammoth from 'mammoth'
import ExcelJS from 'exceljs'

;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const { createDocument } = await import('../../src/tools/DocumentTool/create.ts')
const { convertDocument, handlePdf, selectedPages, htmlMarkdown } = await import('../../src/tools/DocumentTool/convert.ts')
const { parsePdfText } = await import('../../src/tools/DocumentTool/pdfAdapter.ts')
const { safeForOffice, parseXml } = await import('../../src/tools/DocumentTool/archive.ts')
const { whichSync } = await import('../../src/utils/which.ts')
const io = { read: async (path: string) => readFileSync(path), signal: new AbortController().signal }
const save = (product: Awaited<ReturnType<typeof createDocument>>): void => { for (const file of product.files) writeFileSync(file.path, file.bytes) }
try {
  for (const format of ['docx', 'pdf', 'html', 'md', 'pptx']) save(await createDocument({ op: 'create', output: join(proofHome, `source.${format}`), markdown: '# Conversion\n\nEvidence paragraph\n\n| Claim | Count |\n| --- | --- |\n| Test | 42 |', renderer: 'plain' }, io))
  for (const from of ['docx', 'pdf', 'html', 'md']) for (const to of ['docx', 'pdf', 'html', 'md']) {
    if (from === to) continue
    const product = await convertDocument({ op: 'convert', source: join(proofHome, `source.${from}`), output: join(proofHome, `${from}-to.${to}`), renderer: 'plain' }, io)
    save(product)
    const bytes = Buffer.from(product.files[0]!.bytes)
    if (to === 'docx') assert.match((await mammoth.extractRawText({ buffer: bytes })).value, /Evidence paragraph/)
    else if (to === 'pdf') assert.match((await parsePdfText(bytes)).pages.map(p => p.text).join('\n'), /Evidence paragraph/)
    else assert.match(bytes.toString(), /Evidence paragraph/)
  }
  const slides = await convertDocument({ op: 'convert', source: join(proofHome, 'source.pptx'), output: join(proofHome, 'slides.pdf'), renderer: 'plain' }, io)
  assert.match((await parsePdfText(slides.files[0]!.bytes)).pages[0]!.text, /Evidence paragraph/)
  assert.match(htmlMarkdown('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'), /\| 1 \| 2 \|/)
  const first = join(proofHome, 'source.pdf')
  const second = join(proofHome, 'second.pdf')
  save(await createDocument({ op: 'create', output: second, markdown: '# Second', blocks: [{ kind: 'pageBreak' }, { kind: 'paragraph', text: 'Third' }], renderer: 'plain' }, io))
  const merged = await handlePdf({ op: 'merge', sources: [first, second], output: join(proofHome, 'merged.pdf'), metadata: { title: 'Merged', author: 'Author' } }, io)
  save(merged)
  const pdf = await PDFDocument.load(merged.files[0]!.bytes)
  assert.equal(pdf.getPageCount(), 3)
  assert.equal(pdf.getTitle(), 'Merged')
  const split = await handlePdf({ op: 'split', source: join(proofHome, 'merged.pdf'), parts: [{ pages: '3,1', output: join(proofHome, 'part1.pdf') }, { pages: '2', output: join(proofHome, 'part2.pdf') }], rotate: 90 }, io)
  const part = await PDFDocument.load(split.files[0]!.bytes)
  assert.equal(part.getPageCount(), 2)
  assert.equal(part.getPages()[0]!.getRotation().angle, 90)
  assert.match((await parsePdfText(split.files[0]!.bytes)).pages[0]!.text, /Third/)
  assert.throws(() => selectedPages('0,2', 3), /outside/)
  assert.throws(() => selectedPages('2-1', 3), /outside/)
  const csv = join(proofHome, 'source.csv')
  writeFileSync(csv, 'Name,Value\r\n"A, B","line 1\nline 2"\r\n')
  const workbook = await convertDocument({ op: 'convert', source: csv, output: join(proofHome, 'table.xlsx'), sheet: 'Evidence' }, io)
  save(workbook)
  const back = await convertDocument({ op: 'convert', source: join(proofHome, 'table.xlsx'), output: join(proofHome, 'back.csv') }, io)
  assert.equal(Buffer.from(back.files[0]!.bytes).toString(), readFileSync(csv, 'utf8'))
  const multi = new ExcelJS.Workbook(); multi.addWorksheet('A'); multi.addWorksheet('B')
  writeFileSync(join(proofHome, 'multi.xlsx'), Buffer.from(await multi.xlsx.writeBuffer()))
  await assert.rejects(convertDocument({ op: 'convert', source: join(proofHome, 'multi.xlsx'), output: join(proofHome, 'multi.csv') }, io), /Choose sheet/)
  const appended = await convertDocument({ op: 'convert', source: join(proofHome, 'source.docx'), output: join(proofHome, 'appended.docx'), append: true, markdown: '# Appendix\n\nMore evidence[^n]\n\n[^n]: Appendix source', metadata: { title: 'Appendix report', author: 'Author' } }, io)
  const appendixText = (await mammoth.extractRawText({ buffer: Buffer.from(appended.files[0]!.bytes) })).value
  assert.match(appendixText, /Evidence paragraph/)
  assert.match(appendixText, /More evidence/)
  const zip = unzipSync(appended.files[0]!.bytes)
  assert.match(strFromU8(zip['word/footnotes.xml']!), /Appendix source/)
  assert.match(strFromU8(zip['docProps/core.xml']!), /Appendix report/)
  assert.equal(strFromU8(zip['word/styles.xml']!), strFromU8(unzipSync(readFileSync(join(proofHome, 'source.docx')))['word/styles.xml']!))
  assert.ok(safeForOffice(readFileSync(join(proofHome, 'source.docx'))))
  assert.throws(() => parseXml('<!DOCTYPE r [<!ENTITY x SYSTEM "file:///secret">]><r>&x;</r>'), /document type/)
  for (const converter of ['soffice', 'pandoc']) {
    if (!whichSync(converter)) { console.log(`SKIP live ${converter}: not on PATH`); continue }
    const to = converter === 'soffice' ? 'pdf' : 'html'
    const external = await convertDocument({ op: 'convert', source: join(proofHome, 'source.docx'), output: join(proofHome, `external.${to}`), renderer: converter === 'soffice' ? 'libreoffice' : 'pandoc' }, io)
    assert.ok(external.files[0]!.bytes.length)
    assert.equal(external.road, converter === 'soffice' ? 'LibreOffice' : 'pandoc')
  }
  console.log('PASS convert: twelve text-document directions, slide text to PDF, CSV round trip, PDF order/split/rotate/metadata and styled DOCX append with footnotes')
} finally { rmSync(proofHome, { recursive: true, force: true }) }
