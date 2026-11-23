import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, reader, scratch } from './hardening-fixtures.ts'

const root = scratch('roundtrip')
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
try {
  const { read, healthy, context } = await reader(root)
  const { DocumentTool } = await import('../../src/tools/document/DocumentTool.ts')
  const call = (input: any) => DocumentTool.call(input, context, undefined as any, { uuid: crypto.randomUUID() } as any)
  const source = join(root, 'source.md'), docx = join(root, 'report.docx'), pdf = join(root, 'report.pdf'), pdf2 = join(root, 'again.pdf')
  const markdown = '# Reliable report\n\nFirst & second.\n\n- Item one\n- Item two\n\n| Label | Value |\n| --- | --- |\n| Test | 42 |\n'
  writeFileSync(source, markdown)
  const sourceBytes = readFileSync(source)
  await call({ op: 'create', output: docx, markdown })
  const docxBytes = readFileSync(docx), docxText = await read(docx)
  for (const text of ['# Reliable report', 'First & second.', 'Item one', 'Item two', '| Test | 42 |']) assert.ok(docxText.includes(text), `${text} (missing from the text read back from the created DOCX; fix the DOCX output in src/tools/document/create.ts or the DOCX read in src/tools/read)`)
  const fromDocx = await call({ op: 'convert', source: docx, output: join(root, 'from-docx.md'), renderer: 'plain' })
  await call({ op: 'convert', source, output: pdf, renderer: 'plain' })
  const pdfBytes = readFileSync(pdf), pdfText = await read(pdf)
  await call({ op: 'convert', source, output: pdf2, renderer: 'plain' })
  assert.equal(await read(pdf2), pdfText, 'extracted text must be stable despite container timestamps')
  for (const text of ['Reliable report', 'First & second.', 'Item one', 'Item two', 'Test | 42']) assert.ok(pdfText.includes(text), `${text} (missing from the text read back from the PDF converted from Markdown; fix the PDF output in src/tools/document/create.ts or convert.ts)`)
  const fromPdf = await call({ op: 'convert', source: pdf, output: join(root, 'from-pdf.md'), renderer: 'plain' })
  assert.match(readFileSync(join(root, 'from-pdf.md'), 'utf8'), /Reliable report/, 'PDF to Markdown conversion lost the heading text; fix the PDF road in src/tools/document/convert.ts')
  const csv = join(root, 'source.csv'), csvOut = join(root, 'again.csv'), workbook = join(root, 'book.xlsx')
  const csvBytes = Buffer.from('Identifier,Note\r\n00123,"a,b"\r\n007,"two\nlines"\r\n')
  writeFileSync(csv, csvBytes)
  await call({ op: 'convert', source: csv, output: workbook, renderer: 'plain' })
  await call({ op: 'convert', source: workbook, output: csvOut, renderer: 'plain' })
  assert.deepEqual(readFileSync(csvOut), csvBytes, 'CSV to XLSX to CSV must return the same bytes; fix the .csv/.xlsx conversions in src/tools/document/convert.ts')
  assert.deepEqual(readFileSync(source), sourceBytes, 'a convert must leave its source file untouched; check the writes in src/tools/document/convert.ts and files.ts')
  assert.deepEqual(readFileSync(docx), docxBytes, 'a convert must leave its source file untouched; check the writes in src/tools/document/convert.ts and files.ts')
  assert.deepEqual(readFileSync(pdf), pdfBytes, 'a convert must leave its source file untouched; check the writes in src/tools/document/convert.ts and files.ts')
  await healthy()
  await assert.rejects(call({ op: 'create', output: join(root, 'cjk.pdf'), markdown: '日本語', renderer: 'plain' }), /cannot encode.*renderer:"browser"/, 'a plain-renderer PDF of CJK text must be rejected with a message naming renderer:"browser"; see the plain PDF font catch in src/tools/document/create.ts')
  await healthy()
  console.log('DOCX conversion detail:', JSON.stringify(fromDocx.data))
  console.log('PDF conversion detail:', JSON.stringify(fromPdf.data))
  assert.match(JSON.stringify(fromDocx.data.detail), /not preserved.*(?:layout|styles)|(?:layout|styles).*not preserved/i, 'DOCX conversion detail must say layout and styles are not preserved; fix the DOCX warnings in src/tools/document/convert.ts')
  assert.match(JSON.stringify(fromPdf.data.detail), /not preserved.*(?:layout|fonts)|(?:layout|fonts).*not preserved/i, 'PDF conversion detail must say layout and fonts are not preserved; fix the PDF warnings in src/tools/document/convert.ts')
  console.log('PASS create/read DOCX, Markdown/PDF/text stability, byte-identical CSV round trip, untouched inputs, conversion limits and healthy session')
} finally { cleanup(root) }
