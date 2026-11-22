import { readFileSync, statSync } from 'node:fs'
import { PDF_MAX_EXTRACT_SIZE } from '../../constants/apiLimits.js'
import { extname } from 'node:path'
import { findEocdOffset, readZipEntries, extractZipEntryBuffer, RICH_CONTAINER_MAX_BYTES, RICH_ENTRY_MAX_BYTES } from '../FileReadTool/readRichFormats.js'
import { ownerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import { buildTool, type ToolUseContext } from '../../Tool.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import { documentSchema, type DocumentInput, type DocumentProduct } from './schema.js'
import { captureDestinations, commitDocuments, digest, documentPath, documentPaths, documentPermission } from './files.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

export const DOCUMENT_TOOL_NAME = 'Document'
const DOCUMENT_WIRE = 'Create and handle local research documents. Ops: create, convert, merge, split, inspect, cite. output selects the format; source names an input. Writes use file permissions; replacing an output needs its expectedSha256 from inspect. DOI resolution contacts Crossref only when dois is supplied.'
const DOCUMENT_MANUAL = `Inputs, templates and images use read permissions; destinations use write permissions. Replacing an existing file requires expectedSha256 keyed by absolute path from inspect; changed destinations refuse.

create: output (.docx, .pdf, .pptx, .xlsx, .html, .md) with markdown or blocks (local PNG/JPEG images; [^id] footnotes). csv, json or sheets create XLSX. titlePage, header, footer, metadata, paper, margin and pageNumbers configure paged outputs. template + replacements fills {{key}} in a DOCX preserving styles (never combine with blocks).

convert: source + output. Converts among DOCX, PDF, HTML and Markdown; PPTX → PDF; XLSX to CSV and back. PDF → PDF with pages extracts ranges in order (omitted keeps all); rotate turns selected pages clockwise. append:true appends markdown/blocks to source DOCX; metadata sets title/author; use a distinct output to keep source unchanged.

merge: ordered PDF sources → PDF output. split: PDF source → parts:[{pages,output}]. All destinations are checked before writing.

inspect: source only. Returns page count (where known), outline, table dimensions, image counts, metadata, word count, sha256 and per-page PDF text-layer/image presence — not body text (DOCX pagination is layout-dependent; PDF tables are not inferred from positioned text).

cite: bibtex, references or dois; returns reference list and in-text keys (optional .md/.html/.docx output; basic article/book formats, Chicago author-date). Only dois contacts api.crossref.org (no redirects or retries; abstracts unused).

Renderers: PDF create uses bundled browser (renderer:"browser") or plain pdf-lib ("plain", limited script coverage). convert uses installed LibreOffice or pandoc in a temporary profile when suitable ("libreoffice"|"pandoc"), keeping external links/fields/embedded programs off external converters; JS fallback reflows content without slide layout. Results report the road and warnings. Check the exported pages before handing over a report.`

export type DocumentIO = { read: (path: string) => Promise<Buffer>; signal: AbortSignal; owner?: import('../../utils/run/ownerKey.js').OwnerKey }
async function renderDocument(input: DocumentInput, io: DocumentIO): Promise<DocumentProduct> {
  if (input.op === 'create') return (await import('./create.js')).createDocument(input, io)
  if (input.op === 'convert') return (await import('./convert.js')).convertDocument(input, io)
  if (input.op === 'merge' || input.op === 'split') return (await import('./convert.js')).handlePdf(input, io)
  if (input.op === 'cite') return (await import('./cite.js')).citeDocument(input, io)
  if (input.op === 'inspect') return (await import('./inspect.js')).inspectDocument(input, io)
  throw new Error(`Document ${input.op} needs a supported input and output format`)
}

export const DocumentTool: Unbuilt = unbuilt('src/tools/DocumentTool/DocumentTool.ts:37')
