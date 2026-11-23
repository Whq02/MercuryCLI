import { readFileSync } from 'node:fs'

import type { Message } from '../types/message.js'
import type { ToolResultBlockParam } from '../types/wire.js'
import { FILE_EDIT_TOOL_NAME } from '../constants/tools/fileEdit.js'
import { REPEATED_RESULT_TAG } from '../constants/toolLimits.js'
import { FILE_READ_TOOL_NAME, FILE_UNCHANGED_STUB } from '../constants/tools/fileRead.js'
import { FILE_WRITE_TOOL_NAME } from '../constants/tools/fileWrite.js'
import { createFileStateCacheWithSizeLimit, type FileStateCache } from './fileStateCache.js'
import { getFileModificationTime, stripLineNumberPrefix } from './file.js'
import { isENOENT } from './errors.js'
import { expandPath } from './path.js'

const DEFAULT_EXTRACT_CACHE_SIZE = 10
const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/g

type ToolUseRecord = {
  path: string
  content?: string
  offset?: number
  limit?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseTimestamp(timestamp: string | undefined): number {
  if (!timestamp) return 0
  const parsed = Date.parse(timestamp)
  return Number.isNaN(parsed) ? 0 : parsed
}

function extractResultText(content: ToolResultBlockParam['content']): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const item of content) {
    if (item.type === 'text') {
      parts.push(item.text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : null
}

export function extractReadFilesFromMessages(
  messages: Message[],
  cwd: string,
  maxSize: number = DEFAULT_EXTRACT_CACHE_SIZE,
): FileStateCache {
  const cache = createFileStateCacheWithSizeLimit(maxSize)
  const readUses = new Map<string, ToolUseRecord>()
  const writeUses = new Map<string, ToolUseRecord>()
  const editUses = new Map<string, ToolUseRecord>()

  for (const msg of messages) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type !== 'tool_use') continue
        if (!isRecord(block.input)) continue
        const rawPath = block.input['file_path']
        if (typeof rawPath !== 'string' || rawPath.length === 0) continue
        const resolvedPath = expandPath(rawPath, cwd)

        if (block.name === FILE_READ_TOOL_NAME) {
          const offset = typeof block.input['offset'] === 'number' ? block.input['offset'] : undefined
          const limit = typeof block.input['limit'] === 'number' ? block.input['limit'] : undefined
          readUses.set(block.id, { path: resolvedPath, offset, limit })
        } else if (block.name === FILE_WRITE_TOOL_NAME) {
          const fileContent = block.input['content']
          if (typeof fileContent === 'string') {
            writeUses.set(block.id, { path: resolvedPath, content: fileContent })
          }
        } else if (block.name === FILE_EDIT_TOOL_NAME) {
          editUses.set(block.id, { path: resolvedPath })
        }
      }
      continue
    }

    if (msg.type !== 'user') continue
    const content = msg.message.content
    if (!Array.isArray(content)) continue
    const msgTimestamp = parseTimestamp(msg.timestamp)

    for (const block of content) {
      if (block.type !== 'tool_result' || block.is_error === true) continue
      const toolUseId = block.tool_use_id

      const readRecord = readUses.get(toolUseId)
      if (readRecord !== undefined) {
        const rawText = extractResultText(block.content)
        if (rawText === null) continue
        const cleaned = rawText.replace(SYSTEM_REMINDER_PATTERN, '').trim()
        if (
          cleaned.startsWith(FILE_UNCHANGED_STUB) ||
          cleaned.startsWith(REPEATED_RESULT_TAG)
        ) {
          continue
        }
        const stripped = cleaned.split('\n').map(stripLineNumberPrefix).join('\n')
        const timestamp = msgTimestamp || getFileModificationTime(readRecord.path)
        const isPartialView = readRecord.offset !== undefined || readRecord.limit !== undefined
        cache.set(readRecord.path, {
          content: stripped,
          timestamp,
          offset: readRecord.offset,
          limit: readRecord.limit,
          ...(isPartialView ? { isPartialView: true } : {}),
        })
        continue
      }

      const writeRecord = writeUses.get(toolUseId)
      if (writeRecord !== undefined && writeRecord.content !== undefined) {
        const timestamp = msgTimestamp || getFileModificationTime(writeRecord.path)
        cache.set(writeRecord.path, {
          content: writeRecord.content,
          timestamp,
          offset: undefined,
          limit: undefined,
        })
        continue
      }

      const editRecord = editUses.get(toolUseId)
      if (editRecord !== undefined) {
        try {
          const diskContent = readFileSync(editRecord.path, 'utf8')
          const timestamp = getFileModificationTime(editRecord.path) || msgTimestamp
          cache.set(editRecord.path, {
            content: diskContent,
            timestamp,
            offset: undefined,
            limit: undefined,
          })
        } catch (error) {
          if (isENOENT(error)) {
            cache.delete(editRecord.path)
          }
        }
      }
    }
  }

  return cache
}
