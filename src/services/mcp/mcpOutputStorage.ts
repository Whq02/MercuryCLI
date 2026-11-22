import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { MCPResultType } from './client.js'
import { toError } from '../../utils/errors.js'
import { formatFileSize } from '../../utils/format.js'
import { logError } from '../../utils/log.js'
import { ensureToolResultsDir, getToolResultsDir } from '../../utils/toolResultStorage.js'
import { notBuilt } from '../../pi/holes.js'


export function getFormatDescription(type: MCPResultType, schema?: unknown): string {
  return notBuilt('src/services/mcp/mcpOutputStorage.ts:11')
}

export function getLargeOutputInstructions(
  rawOutputPath: string,
  contentLength: number,
  formatDescription: string,
  maxReadLength?: number,
): string {
  return notBuilt('src/services/mcp/mcpOutputStorage.ts:22')
}

const MIME_EXTENSIONS: ReadonlyMap<string, string> = new Map(
  (
    [
      ['pdf', 'application/pdf'], ['json', 'application/json'], ['zip', 'application/zip'],
      ['csv', 'text/csv'], ['txt', 'text/plain'], ['html', 'text/html'], ['md', 'text/markdown'],
      ['css', 'text/css'], ['js', 'application/javascript', 'text/javascript', 'application/x-javascript'],
      ['ts', 'application/typescript', 'text/typescript', 'text/x-typescript'],
      ['xml', 'application/xml', 'text/xml'], ['yaml', 'application/yaml', 'application/x-yaml', 'text/yaml', 'text/x-yaml'],
      ['toml', 'application/toml', 'text/x-toml'], ['py', 'text/x-python', 'application/x-python', 'text/x-script.python'],
      ['sh', 'text/x-shellscript', 'application/x-sh', 'application/x-shellscript'], ['sql', 'application/sql', 'text/x-sql'],
      ['jsonl', 'application/jsonl', 'application/x-ndjson'], ['rtf', 'application/rtf', 'text/rtf'],
      ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      ['doc', 'application/msword'], ['xls', 'application/vnd.ms-excel'],
      ['mp3', 'audio/mpeg'], ['wav', 'audio/wav'], ['ogg', 'audio/ogg'],
      ['mp4', 'video/mp4'], ['webm', 'video/webm'],
      ['png', 'image/png'], ['jpg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp'], ['svg', 'image/svg+xml'],
      ['bmp', 'image/bmp', 'image/x-ms-bmp'], ['tiff', 'image/tiff'], ['heic', 'image/heic'], ['heif', 'image/heif'], ['avif', 'image/avif'],
      ['ico', 'image/x-icon', 'image/vnd.microsoft.icon'],
    ] as const
  ).flatMap(([extension, ...mimes]) => mimes.map(mime => [mime, extension] as const)),
)

function normalizeMime(mimeType: string | undefined): string {
  if (!mimeType) return ''
  return (mimeType.split(';')[0] ?? '').trim().toLowerCase()
}

export function isBinaryContentType(contentType: string): boolean {
  return notBuilt('src/services/mcp/mcpOutputStorage.ts:84')
}

type PersistBinaryResult = { filepath: string; size: number; ext: string } | { error: string }

export async function persistBinaryContent(
  bytes: Buffer,
  mimeType: string | undefined,
  persistId: string,
): Promise<PersistBinaryResult> {
  return notBuilt('src/services/mcp/mcpOutputStorage.ts:97')
}

export function getBinaryBlobSavedMessage(
  filepath: string,
  mimeType: string | undefined,
  size: number,
  sourceDescription: string,
): string {
  return notBuilt('src/services/mcp/mcpOutputStorage.ts:120')
}
