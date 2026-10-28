import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Document, Packer, Paragraph } from 'docx'
import { PDFDocument } from 'pdf-lib'
import ExcelJS from 'exceljs'
import PptxGenJS from 'pptxgenjs'
import mammoth from 'mammoth'
import { unzipSync } from 'fflate'
import { marked } from 'marked'

process.env.MERCURY_CONFIG_DIR = join(proofHome, 'config')
mkdirSync(process.env.MERCURY_CONFIG_DIR)
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const { setCwdState, setOriginalCwd } = await import('../../src/bootstrap/state.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { documentPermission, captureDestinations, commitDocuments, digest } = await import('../../src/tools/DocumentTool/files.ts')
const { documentSchema } = await import('../../src/tools/DocumentTool/schema.ts')
const { DocumentTool } = await import('../../src/tools/DocumentTool/DocumentTool.ts')
const root = join(proofHome, 'project')
mkdirSync(root)
setOriginalCwd(root)
setCwdState(root)
try {
  assert.equal(typeof (globalThis as any).document, 'undefined')
  const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Library fixture')] }] }))
  assert.ok(unzipSync(docx)['word/document.xml'])
  assert.match((await mammoth.convertToHtml({ buffer: docx })).value, /Library fixture/)
  const pdf = await PDFDocument.create()
  pdf.addPage().drawText('Library fixture')
  assert.equal((await PDFDocument.load(await pdf.save())).getPageCount(), 1)
  const book = new ExcelJS.Workbook()
  book.addWorksheet('Evidence').addRow(['Library fixture', 3])
  const xlsx = await book.xlsx.writeBuffer()
  const reread = new ExcelJS.Workbook()
  await reread.xlsx.load(xlsx)
  assert.equal(reread.getWorksheet('Evidence')!.getCell('B1').value, 3)
  const slides = new PptxGenJS()
  slides.addSlide().addText('Library fixture', { x: 1, y: 1, w: 4, h: 1 })
  assert.ok(unzipSync(await slides.write({ outputType: 'uint8array' }) as Uint8Array)['ppt/slides/slide1.xml'])
  assert.match(marked.parse('# Library fixture') as string, /<h1>/)
  const lock = JSON.parse(readFileSync(new URL('../../vendor/document-libs.lock.json', import.meta.url), 'utf8'))
  for (const row of lock.packages) {
    const pkg = JSON.parse(readFileSync(new URL(`../../node_modules/${row.name}/package.json`, import.meta.url), 'utf8'))
    assert.equal(pkg.version, row.version)
    assert.equal(pkg.license, row.license)
    assert.match(row.sha256, /^[a-f0-9]{64}$/)
  }
  const context = { ...getEmptyToolPermissionContext(), mode: 'implement' as const }
  const output = join(root, 'draft.md')
  const input = documentSchema.parse({ op: 'create', output, markdown: '# Draft' })
  assert.equal(DocumentTool.shouldDefer, true)
  assert.equal(DocumentTool.renderToolUseMessage(input), null)
  assert.equal(documentPermission(input, context).behavior, 'allow', JSON.stringify(documentPermission(input, context)))
  assert.equal(documentPermission({ ...input, output: join(proofHome, 'outside.md') }, context).behavior, 'ask')
  assert.equal(documentPermission(input, { ...context, alwaysDenyRules: { session: ['Write(draft.md)'] } }).behavior, 'deny')
  const outside = join(proofHome, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, join(root, 'link'))
  assert.equal(documentPermission({ ...input, output: join(root, 'link', 'escape.md') }, context).behavior, 'ask')
  assert.throws(() => documentPermission({ ...input, output: output + '\n' }, context), /control characters/)
  const targets = captureDestinations(input)
  assert.deepEqual(commitDocuments({ road: 'markdown', files: [{ path: output, bytes: Buffer.from('# Draft') }] }, targets, new AbortController().signal), [output])
  assert.throws(() => captureDestinations(input), /expectedSha256/)
  const pinned = { ...input, expectedSha256: { [output]: digest(readFileSync(output)) } }
  const stale = captureDestinations(pinned)
  writeFileSync(output, 'operator edit')
  assert.throws(() => commitDocuments({ road: 'markdown', files: [{ path: output, bytes: Buffer.from('lost edit') }] }, stale, new AbortController().signal), /changed during rendering/)
  assert.equal(readFileSync(output, 'utf8'), 'operator edit')
  console.log('PASS foundation: six pinned libraries under Bun without DOM; permissions, symlinks, control paths, stale replacement, deferred schema and no new screen renderer')
} finally { rmSync(proofHome, { recursive: true, force: true }) }
