import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { logForDebugging } from './debug.js'
import { PDF_MAX_EXTRACT_SIZE } from '../constants/apiLimits.js'
import { normaliseForMatch } from './text/normaliseForMatch.js'
import { ensureToolResultsDir, getToolResultsDir } from './toolResultStorage.js'

export interface PdfTextPage {
  pageNumber: number
  text: string
  rawText?: string
  hasTextLayer: boolean
  hasImages: boolean
}
export interface PdfTextDocument {
  pageCount: number
  pages: PdfTextPage[]
  metadata: Record<string, string>
}

export async function parsePdfText(bytes: Uint8Array, maxBytes = PDF_MAX_EXTRACT_SIZE): Promise<PdfTextDocument> {
  if (bytes.byteLength > maxBytes) throw new Error(`The PDF file exceeds the ${maxBytes}-byte limit for text extraction.`)
  if (Buffer.from(bytes.subarray(0, 5)).toString('ascii') !== '%PDF-') throw new Error('The file is not a valid PDF (missing the %PDF- header).')
  if (!/%%EOF\s*$/.test(Buffer.from(bytes.subarray(Math.max(0, bytes.length - 1024))).toString('latin1'))) throw new Error('The PDF is truncated: its end marker is missing.')
  const here = dirname(fileURLToPath(import.meta.url))
  const root = [join(here, 'vendor/pdfjs'), resolve(here, '../../vendor/pdfjs/extracted')].find(dir => existsSync(join(dir, 'legacy/build/pdf.mjs')))
  if (!root) throw new Error('PDF text extraction is unavailable: the PDF.js pack is missing. Run bun scripts/vendor/fetch-pdfjs.ts and rebuild.')
  const workerPath = existsSync(join(here, 'pdfTextWorker.mjs')) ? join(here, 'pdfTextWorker.mjs') : join(root, 'pdfTextWorker.mjs')
  return new Promise((accept, reject) => {
    const worker = new Worker(workerPath, { workerData: { root, bytes: Uint8Array.from(bytes) }, stdout: true, stderr: true })
    worker.stdout?.resume()
    worker.stderr?.resume()
    let settled = false
    worker.once('message', (message: { result?: PdfTextDocument; error?: string; diagnostics?: string[] }) => {
      for (const diagnostic of message.diagnostics ?? []) logForDebugging(diagnostic)
      settled = true
      if (message.result) accept({ ...message.result, pages: message.result.pages.map(page => ({ ...page, rawText: page.rawText ?? page.text, text: normaliseForMatch(page.text) })) })
      else reject(new Error(message.error ?? 'PDF text extraction failed.'))
      void worker.terminate()
    })
    worker.once('error', reject)
    worker.once('exit', code => { if (!settled) reject(new Error(`PDF text extraction stopped (exit ${code}).`)) })
  })
}

const pending = new Map<string, Promise<PdfTextDocument>>()
export async function extractPdfText(filePath: string, options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<PdfTextDocument> {
  options.signal?.throwIfAborted()
  const max = options.maxBytes ?? PDF_MAX_EXTRACT_SIZE
  const info = await stat(filePath)
  if (!info.isFile()) throw new Error(`Not a regular file: ${filePath}`)
  if (info.size > max) throw new Error(`The PDF file exceeds the ${max}-byte limit for text extraction.`)
  const bytes = await readFile(filePath, { signal: options.signal })
  const digest = createHash('sha256').update(bytes).digest('hex')
  const path = join(getToolResultsDir(), `pdf-text-6.4.299-v3-${digest}.json`)
  try {
    const cached = JSON.parse(await readFile(path, 'utf8')) as PdfTextDocument
    if (cached.pages.length === cached.pageCount && cached.pages.every(p => typeof p.text === 'string' && typeof p.hasTextLayer === 'boolean')) return cached
  } catch {}
  let job = pending.get(path)
  if (!job) {
    job = (async () => {
      const result = await parsePdfText(bytes, max).catch(error => { throw new Error(`${filePath}: ${error instanceof Error ? error.message : 'PDF text extraction failed.'}`) })
      await ensureToolResultsDir()
      const stage = `${path}.${randomUUID()}`
      await writeFile(stage, JSON.stringify(result), { mode: 0o600 })
      await rename(stage, path)
      return result
    })().finally(() => pending.delete(path))
    pending.set(path, job)
  }
  const result = await job
  options.signal?.throwIfAborted()
  return result
}
export function renderPdfText(document: PdfTextDocument, first = 1, last = document.pageCount): string {
  return document.pages.filter(p => p.pageNumber >= first && p.pageNumber <= last).map(page => `--- page ${page.pageNumber} ---\n${page.text}${page.hasImages ? `${page.text ? '\n' : ''}[Figure or image region.]` : ''}`).join('\n\n')
}
