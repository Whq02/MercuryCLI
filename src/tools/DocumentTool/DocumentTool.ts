import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { findEocdOffset, readZipEntries } from '../FileReadTool/readRichFormats.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { buildTool, type ToolUseContext } from '../../Tool.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import { documentSchema, type DocumentInput, type DocumentProduct } from './schema.js'
import { captureDestinations, commitDocuments, digest, documentPath, documentPaths, documentPermission } from './files.js'

export const DOCUMENT_TOOL_NAME = 'Document'
const DOCUMENT_WIRE = 'Create and handle local research documents. Ops: create, convert, merge, split, inspect, cite. output selects the format; source names an input. Writes use file permissions; replacing an output needs its expectedSha256 from inspect. DOI resolution contacts Crossref only when dois is supplied.'
const DOCUMENT_MANUAL = `Create and handle research documents locally. The output extension selects the format. Inputs, templates and image paths use read permissions; every destination uses write permissions. Existing outputs require expectedSha256 keyed by absolute path, using the digest returned by inspect. A changed destination refuses rather than replacing newer work.

create: output plus markdown or blocks (heading, paragraph, list, table, image, pageBreak, footnote). Outputs: docx, pdf, pptx, xlsx, html, md. titlePage, header, footer, metadata, paper (A4 or Letter), margin (points) and pageNumbers configure paged documents. Images are local PNG or JPEG files. Footnote text uses [^id] with a footnote block or a Markdown definition. CSV text, JSON record arrays and named sheets create XLSX. template plus replacements fills {{key}} placeholders in a DOCX while keeping its styles; do not combine a template with new blocks.

convert: source and output. DOCX, PDF, HTML and Markdown convert between each other; PPTX converts to PDF; XLSX and CSV convert both ways. PDF-to-PDF with pages extracts those ranges in the stated order; rotate turns the extracted pages clockwise. With no pages, it keeps all pages. append:true adds markdown or blocks to a source DOCX; metadata sets title and author. Use a different output to keep the source unchanged.

merge: sources in order and one PDF output. split: one source PDF and parts:[{pages,output}]. Page numbers start at 1; ranges such as 1-3,7 preserve order. All destinations are checked before any file is written.

inspect: source only. Returns pages where known, outline, table dimensions, image counts, metadata, word count and sha256, not the body. DOCX pagination depends on layout; explicit breaks are counted separately. PDF tables are not inferred from positioned text. Each PDF page reports whether it has a text layer and images.

cite: bibtex, references or dois; style is apa, ieee, chicago or harvard. Returns a reference list and in-text keys; optional output is md, html or docx. These are basic journal-article and book formats, not a CSL processor; Chicago is author-date. Only dois triggers network requests, to api.crossref.org; redirects and automatic retries are refused. Crossref metadata is public; abstracts may carry copyright and are not used.

PDF creation uses the provisioned bundled browser for HTML typography, or pdf-lib with a plain layout when no browser is available. renderer can select browser or plain explicitly. The plain font cannot encode every script; use the browser for those characters. Conversion uses LibreOffice or pandoc when installed and suitable, with a separate temporary profile and no source overwrite; renderer can select either explicitly. External relationships, linked fields and embedded programs stay off external converters. Pure-JavaScript conversion reflows content; slide text fallback does not preserve slide layout. Results name the road and any conversion warnings. Check the exported pages before handing over a report.`

export type DocumentIO = { read: (path: string) => Promise<Buffer>; signal: AbortSignal; owner?: import('../../services/run/ownerKey.js').OwnerKey }
async function renderDocument(input: DocumentInput, io: DocumentIO): Promise<DocumentProduct> {
  if (input.op === 'create') return (await import('./create.js')).createDocument(input, io)
  if (input.op === 'convert') return (await import('./convert.js')).convertDocument(input, io)
  if (input.op === 'merge' || input.op === 'split') return (await import('./convert.js')).handlePdf(input, io)
  if (input.op === 'cite') return (await import('./cite.js')).citeDocument(input, io)
  if (input.op === 'inspect') return (await import('./inspect.js')).inspectDocument(input, io)
  throw new Error(`Document ${input.op} needs a supported input and output format`)
}

export const DocumentTool = buildTool({
  name: DOCUMENT_TOOL_NAME,
  shouldDefer: true,
  searchHint: 'create convert inspect documents spreadsheets slides PDFs citations',
  wireDescription() { return DOCUMENT_WIRE },
  inputSchema: documentSchema,
  maxResultSizeChars: 60_000,
  capability: {
    intents: ['create research documents', 'convert office files', 'assemble PDF pages', 'format bibliographies'],
    units: ['text-mutation', 'source-reading'],
    class: 'mutation',
    operations: ['create', 'convert', 'merge', 'split', 'inspect', 'cite'],
    transaction: { kind: 'file', receipts: true },
    evidence: ['change', 'artifact'],
    resources: ['file', 'receipt'],
    cancellation: 'cooperative',
    latency: 'interactive',
    proof: 'scripts/document/prove-foundation.ts',
  },
  async description() { return DOCUMENT_WIRE },
  async prompt() { return DOCUMENT_MANUAL },
  isReadOnly(input: DocumentInput) { return input?.op === 'inspect' || (input?.op === 'cite' && !input.output) },
  isConcurrencySafe(input: DocumentInput) { return input?.op === 'inspect' },
  isOpenWorld(input: DocumentInput) { return input?.op === 'cite' && Boolean(input.dois?.length) },
  getPath(input?: Partial<DocumentInput>) { return input?.output ?? input?.source },
  async checkPermissions(input: DocumentInput, context: ToolUseContext) { return documentPermission(input, context.getAppState().toolPermissionContext) },
  async validateInput(input: DocumentInput) {
    try {
      documentPaths(input)
      if (input.op !== 'inspect' && input.op !== 'cite' && input.op !== 'split' && !input.output) throw new Error('Document requires output')
      if (['inspect', 'convert', 'split'].includes(input.op) && !input.source) throw new Error(`${input.op} requires source`)
      if (input.op === 'inspect' && input.output) throw new Error('inspect does not write an output')
      if (input.op === 'create' && input.source) throw new Error('Use convert to create a document from a source file')
      if (input.op === 'create' && ['libreoffice', 'pandoc'].includes(input.renderer ?? '')) throw new Error('LibreOffice and pandoc are convert renderers')
      if (input.op === 'merge' && !input.sources?.length) throw new Error('merge requires PDF sources')
      if (input.op === 'split' && (!input.parts?.length || input.output)) throw new Error('split requires parts, each with pages and output')
      if (input.op === 'merge' || input.op === 'split') {
        const paths = documentPaths(input)
        if ([...paths.reads, ...paths.writes].some(path => extname(path).toLowerCase() !== '.pdf')) throw new Error('merge and split take PDF files')
      }
      return { result: true as const }
    } catch (error) { return { result: false as const, message: String(error), errorCode: 1 } }
  },
  async call(input: DocumentInput, context, canUseTool, parent) {
    const startedAt = Date.now()
    const checked = documentPermission(input, context.getAppState().toolPermissionContext)
    if (checked.behavior === 'deny') throw new Error(checked.message)
    const paths = documentPaths(input)
    const approved = new Set(paths.reads)
    const io: DocumentIO = {
      signal: context.abortController.signal,
      owner: ownerFromToolUseContext(context),
      read: async path => {
        io.signal.throwIfAborted()
        const file = documentPath(path)
        const decision = checkReadPermissionForTool({ name: 'Read', getPath: () => file }, input, context.getAppState().toolPermissionContext)
        if (decision.behavior === 'deny') throw new Error(decision.message)
        if (!approved.has(file) && decision.behavior !== 'allow') {
          const result = await canUseTool(DocumentTool, { op: 'inspect', source: file }, context, parent, context.toolUseId ?? parent.uuid, decision)
          if (result.behavior !== 'allow') throw new Error(result.message)
        }
        approved.add(file)
        const bytes = readFileSync(file)
        if (/^\.(?:docx|xlsx|pptx|odt|ods|odp|epub)$/i.test(extname(file))) {
          if (findEocdOffset(bytes) === -1) throw new Error(`${file}: truncated ZIP; central directory is missing.`)
          readZipEntries(bytes, file)
        }
        return bytes
      },
    }
    const targets = captureDestinations(input)
    const product = await renderDocument(input, io).catch(error => {
      const raw = error instanceof Error ? error.message : 'Document could not be read.'
      const message = raw.startsWith('Input document to `PDFDocument.load` is encrypted.') ? 'The PDF is encrypted. Open it with its password in a PDF reader and save an unencrypted copy.' : raw
      throw new Error(input.source && !message.includes(input.source) ? `${input.source}: ${message}` : message)
    })
    io.signal.throwIfAborted()
    const changedPaths = commitDocuments(product, targets, io.signal)
    const files = product.files.map(file => ({ path: file.path, bytes: file.bytes.byteLength, sha256: digest(file.bytes) }))
    const data = { op: input.op, road: product.road, files, detail: product.detail }
    return { data, effect: { outcome: 'succeeded' as const, operation: `document.${input.op}`, changedPaths, evidence: JSON.stringify(files), startedAt, completedAt: Date.now() } }
  },
  mapToolResultToToolResultBlockParam(data: unknown, toolUseId: string) { return { type: 'tool_result' as const, tool_use_id: toolUseId, content: JSON.stringify(data, null, 2) } },
})
