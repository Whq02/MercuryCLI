import { extname } from 'node:path'
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, ImageRun, Header, Footer, PageNumber, PageBreak, FootnoteReferenceRun, patchDocument, PatchType, type ParagraphChild } from 'docx'
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib'
import * as ExcelJS from './workbook.js'
import PptxGenJS from 'pptxgenjs'
import { marked, type Token } from 'marked'
import { blocksMarkdown, contentBlocks, contentSheets, escapeXml, inlineHtml, plainInline, textOf } from './content.js'
import { documentPath } from './files.js'
import { printDocument } from './print.js'
import type { DocumentInput, Block, DocumentProduct } from './schema.js'
import type { DocumentIO } from './DocumentTool.js'

export async function loadImages(blocks: Block[], io: DocumentIO): Promise<Map<string, { bytes: Buffer; type: 'png' | 'jpg' }>> {
  const images = new Map<string, { bytes: Buffer; type: 'png' | 'jpg' }>()
  for (const b of blocks) if (b.kind === 'image' && !images.has(b.path)) {
    let bytes: Buffer
    if (/^data:image\/(png|jpeg);base64,[a-z0-9+/=\r\n]+$/i.test(b.path)) bytes = Buffer.from(b.path.split(',')[1]!, 'base64')
    else bytes = await io.read(b.path)
    const type = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png' : bytes[0] === 255 && bytes[1] === 216 ? 'jpg' : null
    if (!type) throw new Error(`Document image must be PNG or JPEG: ${b.path}`)
    images.set(b.path, { bytes, type })
  }
  return images
}
export async function documentHtml(input: DocumentInput, blocks: Block[], io: DocumentIO): Promise<string> {
  const images = await loadImages(blocks, io)
  const parts = blocks.map(b => {
    if (b.kind === 'heading') return `<h${b.level ?? 1}>${inlineHtml(b.text)}</h${b.level ?? 1}>`
    if (b.kind === 'paragraph') return `<p>${inlineHtml(b.text)}</p>`
    if (b.kind === 'pageBreak') return '<div class="page-break"></div>'
    if (b.kind === 'list') { const tag = b.ordered ? 'ol' : 'ul'; return `<${tag}>${b.items.map(t => `<li>${inlineHtml(t)}</li>`).join('')}</${tag}>` }
    if (b.kind === 'table') return `<table>${b.rows.map((row, i) => `<tr>${row.map(c => `<${i === 0 ? 'th' : 'td'}>${inlineHtml(textOf(c))}</${i === 0 ? 'th' : 'td'}>`).join('')}</tr>`).join('')}</table>`
    if (b.kind === 'footnote') return `<p class="footnote">[${escapeXml(b.id)}] ${inlineHtml(b.text)}</p>`
    const image = images.get(b.path)!
    return `<figure><img src="data:image/${image.type === 'jpg' ? 'jpeg' : 'png'};base64,${image.bytes.toString('base64')}" alt="${escapeXml(b.alt ?? '')}" style="max-width:100%;width:${b.width ?? 480}px;height:auto"><figcaption>${escapeXml(b.alt ?? '')}</figcaption></figure>`
  })
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${escapeXml(input.metadata?.title ?? input.titlePage?.title ?? '')}</title><style>body{font:11pt/1.5 Georgia,serif;color:#202020}h1,h2,h3,h4,h5,h6{break-after:avoid}table{border-collapse:collapse;width:100%;break-inside:auto}th,td{border:1px solid #999;padding:6px;text-align:left}tr,figure{break-inside:avoid}.page-break{break-after:page}.footnote,footer{font-size:9pt}pre{white-space:pre-wrap}</style></head><body>${input.header ? `<header>${escapeXml(input.header)}</header>` : ''}${parts.join('\n')}${input.footer ? `<footer>${escapeXml(input.footer)}</footer>` : ''}</body></html>`
}
function docxRuns(text: string, notes: Map<string, number>): ParagraphChild[] {
  const runs: ParagraphChild[] = []
  const walk = (tokens: Token[], style: { bold?: boolean; italics?: boolean; strike?: boolean } = {}): void => {
    for (const t of tokens) {
      if (t.type === 'strong' || t.type === 'em' || t.type === 'del') walk(t.tokens ?? [], { ...style, ...(t.type === 'strong' ? { bold: true } : t.type === 'em' ? { italics: true } : { strike: true }) })
      else if (t.type === 'link') walk(t.tokens ?? [], style)
      else {
        const value = t.type === 'br' ? '\n' : 'text' in t ? String(t.text) : t.raw
        for (const part of value.split(/(\[\^[^\]]+\])/)) {
          const note = /^\[\^([^\]]+)\]$/.exec(part)
          const id = note ? notes.get(note[1]!) : undefined
          if (id !== undefined) runs.push(new FootnoteReferenceRun(id))
          else runs.push(new TextRun({ text: part, ...style, ...(t.type === 'codespan' ? { font: 'Courier New' } : {}) }))
        }
      }
    }
  }
  walk(marked.Lexer.lexInline(text))
  return runs
}
export async function buildDocxBody(blocks: Block[], io: DocumentIO) {
  const images = await loadImages(blocks, io)
  const notes = new Map<string, number>()
  const footnotes: Record<number, { children: Paragraph[] }> = {}
  for (const b of blocks) if (b.kind === 'footnote') {
    if (notes.has(b.id)) throw new Error(`Duplicate footnote: ${b.id}`)
    const id = notes.size + 1
    notes.set(b.id, id)
    footnotes[id] = { children: [new Paragraph(b.text)] }
  }
  const children: (Paragraph | Table)[] = []
  for (const b of blocks) {
    if (b.kind === 'heading') children.push(new Paragraph({ children: docxRuns(b.text, notes), heading: HeadingLevel[`HEADING_${b.level ?? 1}` as keyof typeof HeadingLevel] }))
    else if (b.kind === 'paragraph') children.push(new Paragraph({ children: docxRuns(b.text, notes) }))
    else if (b.kind === 'list') b.items.forEach((text, i) => children.push(new Paragraph({ children: docxRuns(b.ordered ? `${i + 1}. ${text}` : text, notes), ...(b.ordered ? {} : { bullet: { level: 0 } }) })))
    else if (b.kind === 'table') children.push(new Table({ rows: b.rows.map(row => new TableRow({ children: row.map(value => new TableCell({ children: [new Paragraph({ children: docxRuns(textOf(value), notes) })] })) })) }))
    else if (b.kind === 'image') { const image = images.get(b.path)!; children.push(new Paragraph({ children: [new ImageRun({ data: image.bytes, type: image.type, transformation: { width: b.width ?? 480, height: b.height ?? 320 }, altText: { title: b.alt ?? '', description: b.alt ?? '', name: b.alt ?? '' } })] })) }
    else if (b.kind === 'pageBreak') children.push(new Paragraph({ children: [new PageBreak()] }))
  }
  return { children, footnotes }
}
export async function createDocx(input: DocumentInput, blocks: Block[], io: DocumentIO): Promise<Uint8Array> {
  if (input.template) {
    if (blocks.length || input.header || input.footer || input.titlePage) throw new Error('Template creation uses replacements; append a section in a separate call')
    const patches = Object.fromEntries(Object.entries(input.replacements ?? {}).map(([key, text]) => [key, { type: PatchType.PARAGRAPH, children: [new TextRun(text)] }]))
    return patchDocument({ data: await io.read(input.template), outputType: 'uint8array', patches, keepOriginalStyles: true })
  }
  const { children, footnotes } = await buildDocxBody(blocks, io)
  const margin = (input.margin ?? 54) * 20
  const size = input.paper === 'Letter' ? { width: 12240, height: 15840 } : { width: 11906, height: 16838 }
  const footerRuns: ParagraphChild[] = [new TextRun(input.footer ?? '')]
  if (input.pageNumbers) footerRuns.push(new TextRun({ children: [' ', PageNumber.CURRENT] }))
  const doc = new Document({ title: input.metadata?.title, creator: input.metadata?.author, subject: input.metadata?.subject, keywords: input.metadata?.keywords?.join(', '), footnotes, sections: [{ properties: { page: { size, margin: { top: margin, bottom: margin, left: margin, right: margin } } }, headers: input.header ? { default: new Header({ children: [new Paragraph(input.header)] }) } : undefined, footers: input.footer || input.pageNumbers ? { default: new Footer({ children: [new Paragraph({ children: footerRuns })] }) } : undefined, children: children.length ? children : [new Paragraph('')] }] })
  return Packer.toBuffer(doc)
}
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/)) {
      if (line && font.widthOfTextAtSize(`${line} ${word}`, size) > width) { lines.push(line); line = '' }
      for (const char of word) {
        if (line && font.widthOfTextAtSize(line + char, size) > width) { lines.push(line); line = '' }
        line += char
      }
      line += ' '
    }
    lines.push(line.trimEnd())
  }
  return lines
}
export async function plainPdf(input: DocumentInput, blocks: Block[], io: DocumentIO): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  if (input.metadata?.title) pdf.setTitle(input.metadata.title)
  if (input.metadata?.author) pdf.setAuthor(input.metadata.author)
  if (input.metadata?.subject) pdf.setSubject(input.metadata.subject)
  if (input.metadata?.keywords) pdf.setKeywords(input.metadata.keywords)
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const [width, height] = input.paper === 'Letter' ? [612, 792] : [595.28, 841.89]
  const margin = input.margin ?? 54
  if (margin * 2 >= width - 40 || margin * 2 >= height - 40) throw new Error('Page margins leave no content area')
  let page = pdf.addPage([width, height]), y = height - margin
  const next = (): void => { page = pdf.addPage([width, height]); y = height - margin }
  const line = (text: string, size = 11, font = regular): void => {
    let lines: string[]
    try { lines = wrap(plainInline(text), font, size, width - margin * 2) }
    catch { throw new Error('The plain PDF font cannot encode this text; use renderer:"browser" with a provisioned browser') }
    for (const row of lines) { if (y - size * 1.5 < margin) next(); page.drawText(row, { x: margin, y: y - size, size, font }); y -= size * 1.5 }
    y -= 5
  }
  const images = await loadImages(blocks, io)
  for (const b of blocks) {
    io.signal.throwIfAborted()
    if (b.kind === 'pageBreak') next()
    else if (b.kind === 'heading') line(b.text, 24 - ((b.level ?? 1) - 1) * 2, bold)
    else if (b.kind === 'paragraph') line(b.text)
    else if (b.kind === 'list') b.items.forEach((t, i) => line(`${b.ordered ? `${i + 1}.` : '-'} ${t}`))
    else if (b.kind === 'table') b.rows.forEach(row => line(row.map(textOf).join(' | ')))
    else if (b.kind === 'footnote') line(`[${b.id}] ${b.text}`, 9)
    else {
      const source = images.get(b.path)!
      const image = source.type === 'png' ? await pdf.embedPng(source.bytes) : await pdf.embedJpg(source.bytes)
      const scale = Math.min((b.width ?? image.width) / image.width, (width - margin * 2) / image.width, (height - margin * 2) / image.height)
      const w = image.width * scale, h = image.height * scale
      if (y - h < margin) next()
      page.drawImage(image, { x: margin, y: y - h, width: w, height: h }); y -= h + 10
    }
  }
  pdf.getPages().forEach((p, i) => {
    if (input.header) p.drawText(input.header, { x: margin, y: height - margin / 2, size: 9, font: regular })
    if (input.footer) p.drawText(input.footer, { x: margin, y: margin / 2, size: 9, font: regular })
    if (input.pageNumbers) p.drawText(String(i + 1), { x: width - margin, y: margin / 2, size: 9, font: regular })
  })
  return pdf.save()
}
export async function createDocument(input: DocumentInput, io: DocumentIO): Promise<DocumentProduct> {
  if (!input.output) throw new Error('create requires output')
  const output = documentPath(input.output), format = extname(output).toLowerCase()
  const blocks = contentBlocks(input)
  let bytes: Uint8Array, road: string
  if (format === '.md') { bytes = Buffer.from(blocksMarkdown(blocks)); road = 'markdown' }
  else if (format === '.html') { bytes = Buffer.from(await documentHtml(input, blocks, io)); road = 'html' }
  else if (format === '.docx') { bytes = await createDocx(input, blocks, io); road = input.template ? 'docx template' : 'docx' }
  else if (format === '.pdf') {
    const printed = await printDocument(await documentHtml(input, blocks, io), input, io.owner, io.signal)
    bytes = printed ?? await plainPdf(input, blocks, io)
    if (printed && input.metadata) {
      const pdf = await PDFDocument.load(printed)
      if (input.metadata.title !== undefined) pdf.setTitle(input.metadata.title)
      if (input.metadata.author !== undefined) pdf.setAuthor(input.metadata.author)
      if (input.metadata.subject !== undefined) pdf.setSubject(input.metadata.subject)
      if (input.metadata.keywords !== undefined) pdf.setKeywords(input.metadata.keywords)
      bytes = await pdf.save()
    }
    road = printed ? 'browser print' : 'pdf-lib plain layout'
  } else if (format === '.xlsx') {
    const book = new ExcelJS.Workbook()
    book.creator = input.metadata?.author ?? ''
    book.title = input.metadata?.title ?? ''
    for (const sheet of contentSheets(input, blocks)) {
      const page = book.addWorksheet(sheet.name)
      page.addRows(sheet.rows)
      page.getRow(1).font = { bold: true }
      page.columns.forEach(column => { column.width = 24 })
      page.headerFooter.oddHeader = input.header ?? ''
      page.headerFooter.oddFooter = `${input.footer ?? ''}${input.pageNumbers ? ' &P' : ''}`
    }
    const prose = blocks.filter(b => b.kind !== 'table' && b.kind !== 'image' && b.kind !== 'pageBreak')
    let contentSheet = book.worksheets[0]!
    if (prose.length && blocks.some(b => b.kind === 'table')) {
      let name = 'Document', n = 1
      while (book.getWorksheet(name)) name = `Document${n++}`
      contentSheet = book.addWorksheet(name)
      for (const b of prose) {
        if (b.kind === 'heading' || b.kind === 'paragraph' || b.kind === 'footnote') contentSheet.addRow([b.kind, plainInline(b.text)])
        else if (b.kind === 'list') b.items.forEach(t => contentSheet.addRow(['list', plainInline(t)]))
      }
      contentSheet.columns.forEach(column => { column.width = 40 })
    }
    const images = await loadImages(blocks, io)
    let imageRow = contentSheet.rowCount + 1
    for (const b of blocks) if (b.kind === 'image') {
      const image = images.get(b.path)!
      const id = book.addImage({ buffer: image.bytes as unknown as ExcelJS.Buffer, extension: image.type === 'jpg' ? 'jpeg' : 'png' })
      contentSheet.addImage(id, { tl: { col: 0, row: imageRow }, ext: { width: b.width ?? 480, height: b.height ?? 320 } })
      imageRow += Math.ceil((b.height ?? 320) / 20) + 1
    }
    bytes = new Uint8Array(await book.xlsx.writeBuffer()); road = 'exceljs'
  } else if (format === '.pptx') {
    const deck = new PptxGenJS()
    deck.layout = 'LAYOUT_WIDE'
    deck.author = input.metadata?.author ?? ''
    deck.title = input.metadata?.title ?? input.titlePage?.title ?? ''
    const masterObjects: PptxGenJS.SlideMasterProps['objects'] = []
    if (input.header) masterObjects.push({ text: { text: input.header, options: { x: 0.6, y: 0.1, w: 12, h: 0.25, fontSize: 10 } } })
    if (input.footer) masterObjects.push({ text: { text: input.footer, options: { x: 0.6, y: 7.1, w: 11, h: 0.25, fontSize: 10 } } })
    deck.defineSlideMaster({ title: 'Document', objects: masterObjects, ...(input.pageNumbers ? { slideNumber: { x: 12, y: 7.1, w: 0.5, h: 0.25, fontSize: 10 } } : {}) })
    const images = await loadImages(blocks, io)
    let slide = deck.addSlide({ masterName: 'Document' }), y = 0.5
    const next = (): void => { slide = deck.addSlide({ masterName: 'Document' }); y = 0.5 }
    const text = (value: string, size: number, bold = false): void => {
      const lines = value.split('\n').flatMap(v => v.match(/.{1,85}(?:\s|$)|.{1,85}/g) ?? [''])
      for (const part of lines) {
        const h = size / 72 * 1.6
        if (y + h > 6.8) next()
        slide.addText(plainInline(part), { x: 0.6, y, w: 12, h, fontSize: size, bold, breakLine: false }); y += h
      }
      y += 0.15
    }
    for (const b of blocks) {
      if (b.kind === 'pageBreak') next()
      else if (b.kind === 'heading') { if (y > 0.5 && (b.level ?? 1) === 1) next(); text(b.text, 28, true) }
      else if (b.kind === 'paragraph') text(b.text, 18)
      else if (b.kind === 'footnote') text(`[${b.id}] ${b.text}`, 12)
      else if (b.kind === 'list') b.items.forEach((t, i) => text(`${b.ordered ? `${i + 1}.` : '•'} ${t}`, 18))
      else if (b.kind === 'table') { if (y > 5) next(); slide.addTable(b.rows.map(r => r.map(value => ({ text: textOf(value) }))), { x: 0.6, y, w: 12, fontSize: 16, autoPage: true, autoPageRepeatHeader: true }); y = 7 }
      else { if (y > 2) next(); const image = images.get(b.path)!; slide.addImage({ data: `image/${image.type === 'jpg' ? 'jpeg' : 'png'};base64,${image.bytes.toString('base64')}`, x: 0.6, y, w: 8, h: 4 }); y += 4.2 }
    }
    bytes = await deck.write({ outputType: 'uint8array' }) as Uint8Array; road = 'pptxgenjs'
  } else throw new Error(`Unsupported Document output format: ${format}`)
  return { road, files: [{ path: output, bytes }] }
}
