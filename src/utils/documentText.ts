import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { renderDocumentBytes } from '../tools/FileReadTool/readRichFormats.js'
import { extractPdfText, renderPdfText } from './pdfText.js'
import { recognisePdfPage, renderOcr } from './ocr.js'
import { ensureToolResultsDir, getToolResultsDir } from './toolResultStorage.js'

export const SEARCHABLE_DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp', 'epub', 'rtf'] as const
export function isSearchableDocument(path: string): boolean {
  return (SEARCHABLE_DOCUMENT_EXTENSIONS as readonly string[]).includes(extname(path).slice(1).toLowerCase())
}
export async function extractDocumentText(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const ext = extname(path).slice(1).toLowerCase()
  if (ext === 'pdf') {
    const document = await extractPdfText(path, { signal })
    const pages = document.pages.map(page => ({ ...page }))
    if (pages.some(page => !page.hasTextLayer)) {
      const bytes = await readFile(path, { signal })
      for (const page of pages) {
        if (page.hasTextLayer) continue
        const ocr = await recognisePdfPage(path, bytes, page.pageNumber, signal)
        if (!ocr.ok) throw new Error(ocr.message)
        page.text = renderOcr(ocr)
      }
    }
    return renderPdfText({ ...document, pages })
  }
  const info = await stat(path)
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('The document is not a regular file within the 16 MiB container limit.')
  const bytes = await readFile(path, { signal })
  const digest = createHash('sha256').update(bytes).update(ext).digest('hex')
  const cached = join(getToolResultsDir(), `document-text-v1-${digest}.txt`)
  try { return await readFile(cached, 'utf8') } catch {}
  const text = renderDocumentBytes(bytes, ext, path)
  await ensureToolResultsDir()
  const stage = `${cached}.${randomUUID()}`
  await writeFile(stage, text, { mode: 0o600 })
  await rename(stage, cached)
  return text
}
