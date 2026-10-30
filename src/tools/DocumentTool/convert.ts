import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PDFDocument, degrees } from 'pdf-lib'
import * as ExcelJS from './workbook.js'
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { patchDocument, PatchType } from 'docx'
import { getScratchpadDir } from '../../utils/permissions/filesystem.js'
import { whichSync } from '../../utils/which.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { documentPath } from './files.js'
import { contentBlocks, markdownBlocks, writeCsv } from './content.js'
import { buildDocxBody, createDocument } from './create.js'
import { documentArchive, elements, WORD_NS, DRAW_NS, xmlPart, setXmlPart, packDocument, safeForOffice, presentationSlides } from './archive.js'
import { parsePdfText, pdfTextRoad } from './pdfAdapter.js'
import type { Block, DocumentInput, DocumentProduct } from './schema.js'
import type { DocumentIO } from './DocumentTool.js'

export function selectedPages(ranges: string | undefined, count: number): number[] {
  if (!ranges) return Array.from({ length: count }, (_, i) => i)
  const out: number[] = []
  for (const part of ranges.split(',')) {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part)
    if (!match) throw new Error(`Invalid page range: ${part}`)
    const start = Number(match[1]), end = Number(match[2] ?? match[1])
    if (start < 1 || end > count || end < start) throw new Error(`Page range ${part} is outside 1-${count}`)
    for (let n = start; n <= end; n++) out.push(n - 1)
  }
  return out
}
function pdfMetadata(pdf: PDFDocument, input: DocumentInput): void {
  if (input.metadata?.title !== undefined) pdf.setTitle(input.metadata.title)
  if (input.metadata?.author !== undefined) pdf.setAuthor(input.metadata.author)
  if (input.metadata?.subject !== undefined) pdf.setSubject(input.metadata.subject)
  if (input.metadata?.keywords !== undefined) pdf.setKeywords(input.metadata.keywords)
}
export async function handlePdf(input: DocumentInput, io: DocumentIO): Promise<DocumentProduct> {
  if (input.op === 'merge') {
    if (!input.sources?.length || !input.output) throw new Error('merge requires sources and output')
    const merged = await PDFDocument.create()
    for (const source of input.sources) {
      io.signal.throwIfAborted()
      const pdf = await PDFDocument.load(await io.read(source))
      for (const page of await merged.copyPages(pdf, pdf.getPageIndices())) merged.addPage(page)
    }
    pdfMetadata(merged, input)
    return { road: 'pdf-lib merge', files: [{ path: documentPath(input.output), bytes: await merged.save() }] }
  }
  if (!input.source) throw new Error('PDF page operations require source')
  const original = await PDFDocument.load(await io.read(input.source))
  const parts = input.op === 'split' ? input.parts : input.output ? [{ pages: input.pages, output: input.output }] : undefined
  if (!parts?.length) throw new Error('split requires parts with pages and output')
  const files = []
  for (const part of parts) {
    io.signal.throwIfAborted()
    const pdf = await PDFDocument.create()
    if (original.getTitle()) pdf.setTitle(original.getTitle()!)
    if (original.getAuthor()) pdf.setAuthor(original.getAuthor()!)
    for (const page of await pdf.copyPages(original, selectedPages(part.pages, original.getPageCount()))) {
      if (input.rotate) page.setRotation(degrees((page.getRotation().angle + input.rotate) % 360))
      pdf.addPage(page)
    }
    pdfMetadata(pdf, input)
    files.push({ path: documentPath(part.output), bytes: await pdf.save() })
  }
  return { road: 'pdf-lib pages', files }
}
export function htmlMarkdown(html: string): string {
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  turndown.remove(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta'])
  turndown.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const rows = Array.from((node as HTMLElement).querySelectorAll('tr')).map(row => Array.from(row.querySelectorAll('th,td')).map(c => (c.textContent ?? '').trim().replaceAll('|', '\\|').replaceAll('\n', ' ')))
      return '\n\n' + rows.map((row, i) => `| ${row.join(' | ')} |${i === 0 ? `\n| ${row.map(() => '---').join(' | ')} |` : ''}`).join('\n') + '\n\n'
    },
  })
  return turndown.turndown(html)
}
async function sourceBlocks(source: string, bytes: Buffer, io: DocumentIO): Promise<{ blocks: Block[]; road: string; warnings?: string[] }> {
  const ext = extname(source).toLowerCase()
  if (ext === '.pdf') {
    const document = await parsePdfText(bytes)
    if (document.pages.some(p => p.hasTextLayer && !p.text.trim())) throw new Error('PDF text uses unsupported fonts; the PDF text reader is required for this conversion')
    if (document.pages.some(p => !p.hasTextLayer && p.hasImages)) throw new Error('PDF contains image-only pages; read those pages with OCR before converting their text')
    return { road: pdfTextRoad, blocks: document.pages.flatMap((p, i) => [...(i ? [{ kind: 'pageBreak' as const }] : []), { kind: 'paragraph' as const, text: p.text }]) }
  }
  if (ext === '.pptx') {
    const entries = documentArchive(bytes)
    const slideNames = presentationSlides(entries)
    return { road: 'OOXML slide text', warnings: ['Slide text is reflowed; use LibreOffice to preserve slide layout'], blocks: slideNames.flatMap((name, i) => [...(i ? [{ kind: 'pageBreak' as const }] : []), ...elements(xmlPart(entries, name), DRAW_NS, 'p').map(p => ({ kind: 'paragraph' as const, text: elements(p, DRAW_NS, 't').map(t => t.textContent ?? '').join('') }))]) }
  }
  let markdown: string, road: string, warnings: string[] | undefined
  if (ext === '.docx') {
    const converted = await mammoth.convertToHtml({ buffer: bytes }, { externalFileAccess: false })
    markdown = htmlMarkdown(converted.value); road = 'mammoth'; warnings = converted.messages.map(m => m.message)
  } else if (ext === '.html' || ext === '.htm') { markdown = htmlMarkdown(bytes.toString('utf8')); road = 'turndown' }
  else if (ext === '.md' || ext === '.markdown') { markdown = bytes.toString('utf8'); road = 'marked' }
  else throw new Error(`Unsupported source format: ${ext}`)
  const blocks = markdownBlocks(markdown).map(b => {
    if (b.kind !== 'image' || /^data:/i.test(b.path)) return b
    if (/^[a-z][a-z0-9+.-]*:/i.test(b.path)) documentPath(b.path)
    return { ...b, path: resolve(dirname(documentPath(source)), b.path) }
  })
  for (const b of blocks) if (b.kind === 'image' && !b.path.startsWith('data:')) await io.read(b.path)
  return { blocks, road, warnings }
}
async function externalConvert(input: DocumentInput, bytes: Buffer, io: DocumentIO): Promise<DocumentProduct | null> {
  const from = extname(input.source!).toLowerCase(), to = extname(input.output!).slice(1).toLowerCase()
  const choice = input.renderer ?? 'auto'
  if (!['auto', 'libreoffice', 'pandoc'].includes(choice)) return null
  const soffice = whichSync('soffice')
  const pandoc = whichSync('pandoc')
  const office = to === 'pdf' && ['.docx', '.pptx'].includes(from) && choice !== 'pandoc'
  const pandocRoute = from === '.docx' && ['html', 'md'].includes(to) && choice !== 'libreoffice'
  const binary = office ? soffice : pandocRoute ? pandoc : null
  if (!binary) {
    if (choice !== 'auto') throw new Error(`${choice} is unavailable for ${from} to ${to}`)
    return null
  }
  if (!safeForOffice(bytes)) {
    if (choice !== 'auto') throw new Error('External converters require documents without external relationships, embedded programs or linked fields')
    return null
  }
  if (pandocRoute && to === 'md' && Object.keys(documentArchive(bytes)).some(name => name.startsWith('word/media/'))) return null
  const scratch = getScratchpadDir()
  mkdirSync(scratch, { recursive: true })
  const dir = mkdtempSync(join(scratch, 'document-'))
  try {
    const staged = join(dir, `input${from}`), output = join(dir, `input.${to}`)
    writeFileSync(staged, bytes)
    const profile = join(dir, 'office-profile')
    mkdirSync(profile)
    writeFileSync(join(profile, 'registrymodifications.xcu'), '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>')
    const args = office ? [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--norestore', '--convert-to', to, '--outdir', dir, staged] : ['--sandbox', '--from=docx', `--to=${to === 'md' ? 'gfm' : 'html'}`, '--wrap=none', ...(to === 'html' ? ['--embed-resources', '--standalone'] : []), '--output', output, staged]
    const result = await execFileNoThrowWithCwd(binary, args, { cwd: dir, abortSignal: io.signal, timeout: 120_000, env: { HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: dir } })
    if (result.code !== 0) throw new Error(`${office ? 'LibreOffice' : 'pandoc'} exited ${result.code}: ${result.stderr || result.error}`)
    return { road: office ? 'LibreOffice' : 'pandoc', files: [{ path: documentPath(input.output!), bytes: readFileSync(output) }] }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
async function appendDocx(input: DocumentInput, bytes: Buffer, io: DocumentIO): Promise<DocumentProduct> {
  const entries = documentArchive(bytes), doc = xmlPart(entries, 'word/document.xml')
  const body = elements(doc, WORD_NS, 'body')[0]
  if (!body) throw new Error('DOCX has no document body')
  const key = `append_${randomUUID().replaceAll('-', '')}`
  const paragraph = doc.createElementNS(WORD_NS, 'w:p'), run = doc.createElementNS(WORD_NS, 'w:r'), text = doc.createElementNS(WORD_NS, 'w:t')
  text.textContent = `{{${key}}}`; run.appendChild(text); paragraph.appendChild(run)
  const section = Array.from(body.childNodes).find(node => node.nodeType === 1 && (node as Element).localName === 'sectPr')
  body.insertBefore(paragraph, section ?? null)
  setXmlPart(entries, 'word/document.xml', doc)
  const { children, footnotes } = await buildDocxBody(contentBlocks(input), io)
  const result = await patchDocument({ data: packDocument(entries), outputType: 'uint8array', patches: { [key]: { type: PatchType.DOCUMENT, children } }, footnotes, keepOriginalStyles: true, properties: { title: input.metadata?.title, creator: input.metadata?.author } })
  return { road: 'docx append', files: [{ path: documentPath(input.output!), bytes: result }] }
}
export async function convertDocument(input: DocumentInput, io: DocumentIO): Promise<DocumentProduct> {
  if (!input.source || !input.output) throw new Error('convert requires source and output')
  const from = extname(input.source).toLowerCase(), to = extname(input.output).toLowerCase()
  const bytes = await io.read(input.source)
  if (from === '.pdf' && to === '.pdf') return handlePdf(input, io)
  if (input.append || (from === '.docx' && to === '.docx' && input.metadata)) {
    if (from !== '.docx' || to !== '.docx') throw new Error('append requires DOCX source and output')
    return appendDocx(input, bytes, io)
  }
  if (from === '.xlsx' && to === '.csv') {
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(bytes as unknown as ExcelJS.Buffer)
    if (book.worksheets.length > 1 && !input.sheet) throw new Error(`Choose sheet: ${book.worksheets.map(s => s.name).join(', ')}`)
    const sheet = input.sheet ? book.getWorksheet(input.sheet) : book.worksheets[0]
    if (!sheet) throw new Error(`Worksheet not found: ${input.sheet ?? ''}`)
    const rows: unknown[][] = []
    for (let r = 1; r <= sheet.rowCount; r++) {
      const row = []
      for (let c = 1; c <= sheet.columnCount; c++) row.push(sheet.getRow(r).getCell(c).text)
      rows.push(row)
    }
    return { road: 'exceljs CSV', files: [{ path: documentPath(input.output), bytes: Buffer.from(writeCsv(rows)) }] }
  }
  if (from === '.csv' && to === '.xlsx') return createDocument({ ...input, op: 'create', csv: bytes.toString('utf8') }, io)
  if (from === '.json' && to === '.xlsx') return createDocument({ ...input, op: 'create', json: JSON.parse(bytes.toString('utf8')) }, io)
  const external = await externalConvert(input, bytes, io)
  if (external) return external
  const source = await sourceBlocks(input.source, bytes, io)
  const result = await createDocument({ ...input, op: 'create', markdown: undefined, blocks: source.blocks }, io)
  return { ...result, road: `${source.road} to ${result.road}`, detail: { warnings: source.warnings ?? [], layout: 'reflowed' } }
}
