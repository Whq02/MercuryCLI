import { extname } from 'node:path'
import * as ExcelJS from './workbook.js'
import { digest, documentPath } from './files.js'
import { documentArchive, xmlPart, elements, WORD_NS, DRAW_NS, SLIDE_NS, presentationSlides } from './archive.js'
import { markdownBlocks, parseCsv, plainInline } from './content.js'
import { htmlMarkdown } from './convert.js'
import { parsePdfText, pdfTextRoad } from './pdfAdapter.js'
import { pdfStructure } from './pdfStructure.js'
import type { DocumentIO } from './DocumentTool.js'
import type { Block, DocumentInput, DocumentProduct } from './schema.js'

const words = (text: string): number => [...new Intl.Segmenter('en', { granularity: 'word' }).segment(text)].filter(s => s.isWordLike).length
const metadataOf = (entries: Record<string, Uint8Array>): Record<string, string> => {
  if (!entries['docProps/core.xml']) return {}
  const core = xmlPart(entries, 'docProps/core.xml')
  return Object.fromEntries(Array.from(core.documentElement.childNodes).filter(node => node.nodeType === 1).map(node => [(node as Element).localName, node.textContent ?? '']))
}
function blockMap(blocks: Block[]) {
  return {
    outline: blocks.flatMap(b => b.kind === 'heading' ? [{ level: b.level ?? 1, title: plainInline(b.text) }] : []),
    tables: blocks.flatMap(b => b.kind === 'table' ? [{ rows: b.rows.length, columns: Math.max(0, ...b.rows.map(r => r.length)) }] : []),
    images: blocks.filter(b => b.kind === 'image').length,
    pageBreaks: blocks.filter(b => b.kind === 'pageBreak').length,
    wordCount: words(blocks.map(b => b.kind === 'heading' || b.kind === 'paragraph' || b.kind === 'footnote' ? plainInline(b.text) : b.kind === 'list' ? b.items.map(plainInline).join(' ') : b.kind === 'table' ? b.rows.flat().join(' ') : '').join('\n')),
  }
}
export async function inspectDocument(input: DocumentInput, io: DocumentIO): Promise<DocumentProduct> {
  if (!input.source || input.output) throw new Error('inspect requires source and does not write an output')
  const bytes = await io.read(input.source)
  const format = extname(input.source).toLowerCase().slice(1)
  const base = { path: documentPath(input.source), format, bytes: bytes.byteLength, sha256: digest(bytes) }
  let structure: Record<string, unknown>, road = 'document structure'
  if (format === 'pdf') {
    const pdf = await parsePdfText(bytes)
    structure = { pages: pdf.pageCount, pageMap: pdf.pages.map(page => ({ page: page.pageNumber, hasTextLayer: page.hasTextLayer, hasImages: page.hasImages, wordCount: page.hasTextLayer && !page.text.trim() ? null : words(page.text) })), wordCount: pdf.pages.some(p => p.hasTextLayer && !p.text.trim()) ? null : words(pdf.pages.map(p => p.text).join('\n')), ...(await pdfStructure(bytes)), tables: null, metadata: pdf.metadata }
    road = pdfTextRoad
  } else if (format === 'docx') {
    const entries = documentArchive(bytes), doc = xmlPart(entries, 'word/document.xml')
    const paragraphs = elements(doc, WORD_NS, 'p')
    const styles = entries['word/styles.xml'] ? xmlPart(entries, 'word/styles.xml') : null
    const styleLevels = new Map<string, number>()
    if (styles) for (const style of elements(styles, WORD_NS, 'style')) {
      const level = elements(style, WORD_NS, 'outlineLvl')[0]?.getAttributeNS(WORD_NS, 'val')
      const id = style.getAttributeNS(WORD_NS, 'styleId')
      if (id && level !== undefined && level !== null && level !== '') styleLevels.set(id, Number(level) + 1)
    }
    structure = {
      pages: null,
      pageBreaks: elements(doc, WORD_NS, 'br').filter(node => node.getAttributeNS(WORD_NS, 'type') === 'page').length,
      outline: paragraphs.flatMap(p => {
        const style = elements(p, WORD_NS, 'pStyle')[0]?.getAttributeNS(WORD_NS, 'val') ?? ''
        const explicit = elements(p, WORD_NS, 'outlineLvl')[0]?.getAttributeNS(WORD_NS, 'val')
        const level = explicit ? Number(explicit) + 1 : styleLevels.get(style) ?? (/^Heading[1-6]$/i.test(style) ? Number(style.slice(-1)) : null)
        return level === null || level === undefined || level > 6 ? [] : [{ level, title: elements(p, WORD_NS, 't').map(t => t.textContent ?? '').join('') }]
      }),
      tables: elements(doc, WORD_NS, 'tbl').map(table => { const rows = elements(table, WORD_NS, 'tr'); return { rows: rows.length, columns: Math.max(0, ...rows.map(r => elements(r, WORD_NS, 'tc').length)) } }),
      images: elements(doc, DRAW_NS, 'blip').length,
      wordCount: words(paragraphs.map(p => elements(p, WORD_NS, 't').map(t => t.textContent ?? '').join('')).join('\n')),
      metadata: metadataOf(entries),
      pagination: 'DOCX page count depends on layout; explicit page breaks are counted separately',
    }
  } else if (format === 'pptx') {
    const entries = documentArchive(bytes)
    const slides = presentationSlides(entries)
    const maps = slides.map((name, i) => {
      const doc = xmlPart(entries, name)
      return { page: i + 1, title: elements(doc, SLIDE_NS, 'sp').filter(shape => elements(shape, SLIDE_NS, 'ph').some(ph => ['title', 'ctrTitle'].includes(ph.getAttribute('type') ?? ''))).flatMap(shape => elements(shape, DRAW_NS, 't').map(t => t.textContent ?? '')).join(' ') || null, tables: elements(doc, DRAW_NS, 'tbl').map(table => ({ rows: elements(table, DRAW_NS, 'tr').length, columns: elements(table, DRAW_NS, 'gridCol').length })), images: elements(doc, DRAW_NS, 'blip').length, wordCount: words(elements(doc, DRAW_NS, 'p').map(p => elements(p, DRAW_NS, 't').map(t => t.textContent ?? '').join('')).join('\n')) }
    })
    structure = { pages: slides.length, outline: maps.filter(p => p.title !== null).map(p => ({ page: p.page, title: p.title })), tables: maps.flatMap(p => p.tables.map(t => ({ page: p.page, ...t }))), images: maps.reduce((n, p) => n + p.images, 0), wordCount: maps.reduce((n, p) => n + p.wordCount, 0), metadata: metadataOf(entries) }
  } else if (format === 'xlsx') {
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(bytes as unknown as ExcelJS.Buffer)
    let wordCount = 0
    const tables = book.worksheets.map(sheet => {
      sheet.eachRow(row => row.eachCell(cell => { wordCount += words(cell.text) }))
      return { name: sheet.name, rows: sheet.rowCount, columns: sheet.columnCount, tables: sheet.getTables().length }
    })
    structure = { pages: null, outline: [], tables, images: book.worksheets.reduce((count, sheet) => count + sheet.getImages().length, 0), wordCount, metadata: { title: book.title, author: book.creator, subject: book.subject } }
  } else if (format === 'csv') {
    const table = parseCsv(bytes.toString('utf8'))
    structure = { pages: null, outline: [], tables: [{ rows: table.length, columns: Math.max(0, ...table.map(r => r.length)) }], images: 0, wordCount: words(table.flat().join(' ')), metadata: {} }
  } else if (['md', 'markdown', 'html', 'htm'].includes(format)) {
    const text = bytes.toString('utf8')
    structure = { pages: null, ...blockMap(markdownBlocks(format === 'html' || format === 'htm' ? htmlMarkdown(text) : text)), metadata: {} }
  } else throw new Error(`Unsupported inspect format: ${format}`)
  return { files: [], road, detail: { ...base, ...structure } }
}
