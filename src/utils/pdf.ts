import { randomUUID } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { PDF_MAX_EXTRACT_SIZE, PDF_TARGET_RAW_SIZE } from '../constants/apiLimits.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { formatFileSize } from './format.js'
import { getFsImplementation } from './fsOperations.js'
import { getToolResultsDir } from './toolResultStorage.js'

/**
 * PDF ingestion: inline read with validation, page count and page-image
 * extraction through the poppler tools.
 */

export type PDFError = {
  reason: 'empty' | 'too_large' | 'password_protected' | 'corrupted' | 'unknown' | 'unavailable'
  message: string
}

export type PDFResult<T> = { success: true; data: T } | { success: false; error: PDFError }

export type PDFExtractPagesResult = {
  type: 'parts'
  file: { filePath: string; originalSize: number; count: number; outputDir: string }
}

const PDF_MAGIC = '%PDF-'
const PDFINFO_TIMEOUT_MS = 10_000
const PDFTOPPM_PROBE_TIMEOUT_MS = 5_000
const PDFTOPPM_RENDER_TIMEOUT_MS = 120_000

function fail<T>(reason: PDFError['reason'], message: string): PDFResult<T> {
  return { success: false, error: { reason, message } }
}

/**
 * The five-byte header check is about blast radius: a document block is
 * validated by the provider on every request that carries it and stays in
 * history, so one mislabelled file would fail every turn from then on.
 */
export async function readPDF(
  filePath: string,
): Promise<PDFResult<{ type: 'pdf'; file: { filePath: string; base64: string; originalSize: number } }>> {
  try {
    const stats = await stat(filePath)
    if (stats.size === 0) return fail('empty', `The PDF file is empty: ${filePath}`)
    if (stats.size > PDF_TARGET_RAW_SIZE) {
      return fail('too_large', `The PDF file exceeds the ${formatFileSize(PDF_TARGET_RAW_SIZE)} limit for inline reading.`)
    }
    const bytes = await readFile(filePath)
    if (bytes.subarray(0, PDF_MAGIC.length).toString('ascii') !== PDF_MAGIC) {
      return fail('corrupted', `The file is not a valid PDF (missing the %PDF- header): ${filePath}`)
    }
    return { success: true, data: { type: 'pdf', file: { filePath, base64: bytes.toString('base64'), originalSize: stats.size } } }
  } catch (err) {
    return fail('unknown', err instanceof Error ? err.message : String(err))
  }
}

/** `pdfinfo` with a ten-second timeout, not inheriting the working directory; nothing on any failure. */
export async function getPDFPageCount(filePath: string): Promise<number | null> {
  const result = await execFileNoThrow('pdfinfo', [filePath], { timeout: PDFINFO_TIMEOUT_MS, useCwd: false })
  if (result.code !== 0) return null
  const match = /^Pages:\s+(\d+)/m.exec(result.stdout)
  if (!match) return null
  const count = parseInt(match[1] as string, 10)
  return Number.isFinite(count) ? count : null
}

let pdftoppmAvailable: Promise<boolean> | null = null

/** Available on exit zero OR anything on standard error (some versions banner there and exit non-zero). Cached for the process. */
export function isPdftoppmAvailable(): Promise<boolean> {
  if (!pdftoppmAvailable) {
    pdftoppmAvailable = execFileNoThrow('pdftoppm', ['-v'], { timeout: PDFTOPPM_PROBE_TIMEOUT_MS, useCwd: false }).then(
      result => result.code === 0 || result.stderr.length > 0,
      () => false,
    )
  }
  return pdftoppmAvailable
}

export async function extractPDFPages(
  filePath: string,
  options: { firstPage?: number; lastPage?: number } = {},
): Promise<PDFResult<PDFExtractPagesResult>> {
  try {
    const stats = await stat(filePath)
    if (stats.size === 0) return fail('empty', `The PDF file is empty: ${filePath}`)
    if (stats.size > PDF_MAX_EXTRACT_SIZE) {
      return fail('too_large', `The PDF file exceeds the ${formatFileSize(PDF_MAX_EXTRACT_SIZE)} limit for page extraction.`)
    }
    if (!(await isPdftoppmAvailable())) {
      return fail(
        'unavailable',
        'The pdftoppm utility is not installed. Install the poppler tool suite (macOS: `brew install poppler`; Debian/Ubuntu: `sudo apt-get install poppler-utils`) to read large PDFs page by page.',
      )
    }
    const outputDir = join(getToolResultsDir(), `pdf-${randomUUID()}`)
    getFsImplementation().mkdirSync(outputDir)
    const args = ['-jpeg', '-r', '100']
    if (options.firstPage) args.push('-f', String(options.firstPage))
    if (options.lastPage && Number.isFinite(options.lastPage)) args.push('-l', String(options.lastPage))
    args.push(filePath, join(outputDir, 'page'))
    const render = await execFileNoThrow('pdftoppm', args, { timeout: PDFTOPPM_RENDER_TIMEOUT_MS, useCwd: false })
    if (render.code !== 0) {
      const stderr = render.stderr
      if (/password/i.test(stderr)) {
        return fail('password_protected', 'The PDF is password protected. Provide an unprotected copy.')
      }
      if (/damaged|corrupt|invalid/i.test(stderr)) return fail('corrupted', `The PDF appears to be corrupted: ${stderr.trim()}`)
      return fail('unknown', stderr.trim() || 'pdftoppm failed')
    }
    const pages = (await readdir(outputDir)).filter(name => name.endsWith('.jpg')).sort()
    if (pages.length === 0) {
      return fail('corrupted', 'The PDF renderer produced no page images; the file may be malformed.')
    }
    return {
      success: true,
      data: { type: 'parts', file: { filePath, originalSize: stats.size, count: pages.length, outputDir } },
    }
  } catch (err) {
    return fail('unknown', err instanceof Error ? err.message : String(err))
  }
}
