import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { MCPResultType } from '../services/mcp/client.js'
import { toError } from './errors.js'
import { formatFileSize } from './format.js'
import { logError } from './log.js'
import { ensureToolResultsDir, getToolResultsDir } from './toolResultStorage.js'


export function getFormatDescription(type: MCPResultType, schema?: unknown): string {
  switch (type) {
    case 'toolResult':
      return 'plain text'
    case 'structuredContent':
      return schema === undefined ? 'JSON' : `JSON matching the schema ${JSON.stringify(schema)}`
    case 'contentArray':
      return schema === undefined ? 'a JSON array' : `a JSON array matching the schema ${JSON.stringify(schema)}`
  }
}

export function getLargeOutputInstructions(
  rawOutputPath: string,
  contentLength: number,
  formatDescription: string,
  maxReadLength?: number,
): string {
  const truncationClause =
    maxReadLength !== undefined
      ? ` When you see a truncation warning of the form "[... output truncated ...]" (the shell output cap is ${maxReadLength.toLocaleString()} characters), reduce the chunk size until you can read everything without truncation — **do not proceed until you have**.`
      : ' If you encounter truncation warnings, reduce the chunk size until you can read everything without truncation — **do not proceed until you have**.'
  return (
    `Error: the MCP tool result (${contentLength.toLocaleString()} characters) exceeds the maximum allowed tokens. ` +
    `The output has been saved to ${rawOutputPath}.\n\n` +
    `The saved content is ${formatDescription}.\n\n` +
    `Use the offset and limit parameters to read portions of the file, search within the file, and use a structured-query tool for structured data.\n\n` +
    `Requirements for summarisation, analysis or review:\n` +
    `1. Read the file at ${rawOutputPath} in sequential chunks until 100% of the content has been read.` +
    `${truncationClause}\n` +
    `2. Before producing any summary or analysis, explicitly describe what portion of the file you read; ` +
    `if you did not read everything, **state this explicitly**.`
  )
}

const MIME_EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/json': 'json',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/markdown': 'md',
  'application/zip': 'zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

function normalizeMime(mimeType: string | undefined): string {
  if (!mimeType) return ''
  return (mimeType.split(';')[0] ?? '').trim().toLowerCase()
}

export function extensionForMimeType(mimeType: string | undefined): string {
  return MIME_EXTENSIONS[normalizeMime(mimeType)] ?? 'bin'
}

export function isBinaryContentType(contentType: string): boolean {
  const type = normalizeMime(contentType)
  if (type === '') return false
  if (type.startsWith('text/')) return false
  if (type === 'application/json' || type.endsWith('+json')) return false
  if (type === 'application/xml' || type.endsWith('+xml')) return false
  if (type.startsWith('application/javascript')) return false
  if (type === 'application/x-www-form-urlencoded') return false
  return true
}

export type PersistBinaryResult = { filepath: string; size: number; ext: string } | { error: string }

export async function persistBinaryContent(
  bytes: Buffer,
  mimeType: string | undefined,
  persistId: string,
): Promise<PersistBinaryResult> {
  await ensureToolResultsDir()
  const ext = extensionForMimeType(mimeType)
  const filepath = join(getToolResultsDir(), `${persistId}.${ext}`)
  try {
    await writeFile(filepath, bytes)
    return { filepath, size: bytes.length, ext }
  } catch (err) {
    const error = toError(err)
    logError(error)
    return { error: error.message }
  }
}

export function getBinaryBlobSavedMessage(
  filepath: string,
  mimeType: string | undefined,
  size: number,
  sourceDescription: string,
): string {
  return `${sourceDescription}: binary content (${mimeType || 'unknown type'}, ${formatFileSize(size)}) saved to ${filepath}`
}
