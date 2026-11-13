import { readFileSync, statSync } from 'node:fs'
import { PDF_MAX_EXTRACT_SIZE } from '../../constants/apiLimits.js'
import { extname } from 'node:path'
import { findEocdOffset, readZipEntries, extractZipEntryBuffer, RICH_CONTAINER_MAX_BYTES, RICH_ENTRY_MAX_BYTES } from '../FileReadTool/readRichFormats.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { buildTool, type ToolUseContext } from '../../Tool.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import { documentSchema, type DocumentInput, type DocumentProduct } from './schema.js'
import { captureDestinations, commitDocuments, digest, documentPath, documentPaths, documentPermission } from './files.js'

export const DOCUMENT_TOOL_NAME = 'Document'
const DOCUMENT_WIRE = 'Create and handle local research documents. Ops: create, convert, merge, split, inspect, cite. output selects the format; source names an input. Writes use file permissions; replacing an output needs its expectedSha256 from inspect. DOI resolution contacts Crossref only when dois is supplied.'
const DOCUMENT_MANUAL = `Inputs, templates and images use read permissions; destinations use write permissions. Replacing an existing file requires expectedSha256 keyed by absolute path from inspect; changed destinations refuse.

create: output (.docx, .pdf, .pptx, .xlsx, .html, .md) with markdown or blocks (local PNG/JPEG images; [^id] footnotes). csv, json or sheets create XLSX. titlePage, header, footer, metadata, paper, margin and pageNumbers configure paged outputs. template + replacements fills {{key}} in a DOCX preserving styles (never combine with blocks).

convert: source + output. Converts among DOCX, PDF, HTML and Markdown; PPTX → PDF; XLSX ↔ CSV. PDF → PDF with pages extracts ranges in order (omitted keeps all); rotate turns selected pages clockwise. append:true appends markdown/blocks to source DOCX; metadata sets title/author; use a distinct output to keep source unchanged.

merge: ordered PDF sources → PDF output. split: PDF source → parts:[{pages,output}]. All destinations are checked before writing.

inspect: source only. Returns page count (where known), outline, table dimensions, image counts, metadata, word count, sha256 and per-page PDF text-layer/image presence — not body text (DOCX pagination is layout-dependent; PDF tables are not inferred from positioned text).

cite: bibtex, references or dois; returns reference list and in-text keys (optional .md/.html/.docx output; basic article/book formats, Chicago author-date). Only dois contacts api.crossref.org (no redirects or retries; abstracts unused).

Renderers: PDF create uses bundled browser (renderer:"browser") or plain pdf-lib ("plain", limited script coverage). convert uses installed LibreOffice or pandoc in a temporary profile when suitable ("libreoffice"|"pandoc"), keeping external links/fields/embedded programs off external converters; JS fallback reflows content without slide layout. Results report the road and warnings. Check the exported pages before handing over a report.`

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
  searchHint: 'create, convert, merge, split and inspect local documents, and format citations',
  searchKeywords: ['create', 'convert', 'inspect', 'documents', 'spreadsheets', 'slides', 'PDFs', 'citations', 'docx', 'xlsx', 'pptx', 'pdf', 'bibtex', 'doi'],
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
        const max = extname(file).toLowerCase() === '.pdf' ? PDF_MAX_EXTRACT_SIZE : RICH_CONTAINER_MAX_BYTES
        const info = statSync(file)
        if (!info.isFile()) throw new Error(`${file}: not a regular file.`)
        if (info.size > max) throw new Error(`${file}: exceeds the ${max / 1024 / 1024} MiB document limit. Split the document and read one part at a time.`)
        const bytes = readFileSync(file)
        if (bytes.length > max) throw new Error(`${file}: exceeds the ${max / 1024 / 1024} MiB document limit.`)
        if (/^\.(?:docx|xlsx|pptx|odt|ods|odp|epub)$/i.test(extname(file))) {
          if (findEocdOffset(bytes) === -1) throw new Error(`${file}: truncated ZIP; central directory is missing.`)
          let total = 0
          for (const entry of readZipEntries(bytes, file)) {
            total += entry.uncompressedSize
            if (entry.uncompressedSize > RICH_ENTRY_MAX_BYTES) throw new Error(`${file}: archive entry ${entry.name} exceeds the 4 MiB entry limit.`)
            if (total > RICH_CONTAINER_MAX_BYTES) throw new Error(`${file}: document contents exceed the 16 MiB extraction limit.`)
            extractZipEntryBuffer(bytes, entry)
          }
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
  extractSearchText(data: unknown) {
    const out = data as { op?: unknown; road?: unknown; detail?: unknown; files?: Array<{ path?: unknown }> } | null
    return [out?.op, out?.road, out?.detail, ...(out?.files ?? []).map(file => file?.path)].filter((part): part is string => typeof part === 'string' && part !== '').join(' ')
  },
  mapToolResultToToolResultBlockParam(data: unknown, toolUseId: string) { return { type: 'tool_result' as const, tool_use_id: toolUseId, content: JSON.stringify(data, null, 2) } },
})
