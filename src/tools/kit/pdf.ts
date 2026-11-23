import { randomUUID } from 'node:crypto'
import { readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PDF_MAX_EXTRACT_SIZE, PDF_TARGET_RAW_SIZE } from '../../models/roads/mediaLimits.js'
import { execFileNoThrow } from '../../platform/processes/execFileNoThrow.js'
import { formatFileSize } from '../../platform/text/format.js'
import { getFsImplementation } from '../../platform/files/fsOperations.js'
import { readRegularFile } from '../read/regularFile.js'
import { passedOverAs } from '../../platform/errors/passedOver.js'


type PDFError = {
  reason: 'empty' | 'too_large' | 'password_protected' | 'corrupted' | 'unknown' | 'unavailable'
  message: string
}

type PDFResult<T> = { success: true; data: T } | { success: false; error: PDFError }

type PDFExtractPagesResult = {
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

export async function readPDF(
  filePath: string,
): Promise<PDFResult<{ type: 'pdf'; file: { filePath: string; base64: string; originalSize: number } }>> {
  try {
    const info = await stat(filePath)
    if (info.size === 0) {
      return fail('empty', `The PDF file is empty: ${filePath}`)
    }
    if (info.size > PDF_TARGET_RAW_SIZE) {
      return fail(
        'too_large',
        `PDF (${formatFileSize(info.size)}) exceeds the ${formatFileSize(PDF_TARGET_RAW_SIZE)} limit for inline reading.`,
      )
    }
    const buffer = await readRegularFile(filePath, undefined, info)
    if (buffer.length === 0) {
      return fail('empty', `The PDF file is empty: ${filePath}`)
    }
    if (buffer.length > PDF_TARGET_RAW_SIZE) {
      return fail(
        'too_large',
        `PDF (${formatFileSize(buffer.length)}) exceeds the ${formatFileSize(PDF_TARGET_RAW_SIZE)} limit for inline reading.`,
      )
    }
    if (buffer.subarray(0, PDF_MAGIC.length).toString('ascii') !== PDF_MAGIC) {
      return fail('corrupted', `The file is not a valid PDF (missing the %PDF- header): ${filePath}`)
    }
    return {
      success: true,
      data: {
        type: 'pdf',
        file: {
          filePath,
          base64: buffer.toString('base64'),
          originalSize: info.size,
        },
      },
    }
  } catch (error) {
    return fail('unknown', error instanceof Error ? error.message : String(error))
  }
}

export async function getPDFPageCount(filePath: string): Promise<number | null> {
  const result = await execFileNoThrow('pdfinfo', [filePath], {
    timeout: PDFINFO_TIMEOUT_MS,
    useCwd: false,
  })
  if (result.code !== 0) return null
  const match = /^Pages:\s*(\d+)/m.exec(result.stdout)
  if (!match) return null
  const count = Number.parseInt(match[1]!, 10)
  return Number.isFinite(count) && count >= 0 ? count : null
}

let pdftoppmAvailable: Promise<boolean> | null = null

function isPdftoppmAvailable(): Promise<boolean> {
  if (!pdftoppmAvailable) {
    pdftoppmAvailable = execFileNoThrow('pdftoppm', ['-v'], { timeout: PDFTOPPM_PROBE_TIMEOUT_MS, useCwd: false }).then(
      result => result.code === 0 || result.stderr.length > 0,
      passedOverAs(false),
    )
  }
  return pdftoppmAvailable
}

export function pdfPageOutputDir(): string {
  return join(tmpdir(), `mercury-pdf-${randomUUID()}`)
}

export async function removePDFPages(outputDir: string): Promise<void> {
  await rm(outputDir, { recursive: true, force: true }).catch(passedOverAs(undefined))
}

export async function extractPDFPages(
  filePath: string,
  options?: { firstPage?: number; lastPage?: number },
): Promise<PDFResult<PDFExtractPagesResult>> {
  let outputDir: string | null = null
  try {
    const info = await stat(filePath)
    if (info.size === 0) {
      return fail('empty', `The PDF file is empty: ${filePath}`)
    }
    if (info.size > PDF_MAX_EXTRACT_SIZE) {
      return fail(
        'too_large',
        `PDF (${formatFileSize(info.size)}) exceeds the ${formatFileSize(PDF_MAX_EXTRACT_SIZE)} limit for page extraction.`,
      )
    }
    if (!(await isPdftoppmAvailable())) {
      return fail(
        'unavailable',
        'The pdftoppm utility is not installed. Install the poppler tool suite (macOS: `brew install poppler`; Debian/Ubuntu: `sudo apt-get install poppler-utils`) to read large PDFs page by page.',
      )
    }
    outputDir = pdfPageOutputDir()
    await getFsImplementation().mkdir(outputDir, { mode: 0o700 })
    const args: string[] = ['-jpeg', '-r', '100']
    if (options?.firstPage) args.push('-f', String(options.firstPage))
    if (options?.lastPage && Number.isFinite(options.lastPage)) args.push('-l', String(options.lastPage))
    args.push(filePath, join(outputDir, 'page'))
    const result = await execFileNoThrow('pdftoppm', args, {
      timeout: PDFTOPPM_RENDER_TIMEOUT_MS,
      useCwd: false,
    })
    if (result.code !== 0) {
      await removePDFPages(outputDir)
      const detail = result.stderr.trim()
      if (/password/i.test(detail)) {
        return fail('password_protected', 'The PDF is password protected. Provide an unprotected copy.')
      }
      if (/damage|corrupt|invalid/i.test(detail)) {
        return fail('corrupted', detail || `The PDF appears to be corrupted: ${filePath}`)
      }
      return fail('unknown', detail || 'pdftoppm failed')
    }
    const entries = (await readdir(outputDir)).filter(name => name.endsWith('.jpg'))
    if (entries.length === 0) {
      await removePDFPages(outputDir)
      return fail('corrupted', 'The PDF renderer produced no page images; the file may be malformed.')
    }
    return {
      success: true,
      data: {
        type: 'parts',
        file: {
          filePath,
          originalSize: info.size,
          count: entries.length,
          outputDir,
        },
      },
    }
  } catch (error) {
    if (outputDir !== null) await removePDFPages(outputDir)
    return fail('unknown', error instanceof Error ? error.message : String(error))
  }
}
