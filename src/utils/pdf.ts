import { randomUUID } from 'node:crypto'
import { readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PDF_MAX_EXTRACT_SIZE, PDF_TARGET_RAW_SIZE } from '../constants/apiLimits.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { formatFileSize } from './format.js'
import { getFsImplementation } from './fsOperations.js'
import { readRegularFile } from './regularFile.js'
import { passedOverAs } from './passedOver.js'
import { notBuilt } from '../pi/holes.js'


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
  return notBuilt('src/utils/pdf.ts:35')
}

export async function getPDFPageCount(filePath: string): Promise<number | null> {
  return notBuilt('src/utils/pdf.ts:54')
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
  return notBuilt('src/utils/pdf.ts:83')
}
