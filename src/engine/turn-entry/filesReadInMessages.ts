import { readFileSync } from 'node:fs'

import type { Message } from '../message-shapes/message.js'
import { EDIT_TOOL_NAME } from '../../tools/kit/names/fileEdit.js'
import { REPEATED_RESULT_TAG } from '../../tools/kit/toolLimits.js'
import { READ_TOOL_NAME, FILE_UNCHANGED_STUB } from '../../tools/kit/names/fileRead.js'
import { WRITE_TOOL_NAME } from '../../tools/kit/names/fileWrite.js'
import { createFileStateCacheWithSizeLimit, type FileStateCache } from '../../platform/files/fileStateCache.js'
import { getFileModificationTime, stripLineNumberPrefix } from '../../platform/files/file.js'
import { isENOENT } from '../../platform/errors/errors.js'
import { getErrnoCode } from '../../platform/errors/errors.js'
import { expandPath } from '../../platform/files/path.js'

const DEFAULT_EXTRACT_CACHE_SIZE = 10
const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/g

type WriteRecord = {
  path: string
  content: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseTimestamp(timestamp: string | undefined): number | null {
  if (!timestamp) return null
  const parsed = Date.parse(timestamp)
  return Number.isNaN(parsed) ? null : parsed
}

function isStubReadResult(text: string): boolean {
  const start = text.trimStart()
  return start.startsWith(FILE_UNCHANGED_STUB) || start.startsWith(REPEATED_RESULT_TAG)
}

export function extractReadFilesFromMessages(
  messages: Message[],
  cwd: string,
  maxSize: number = DEFAULT_EXTRACT_CACHE_SIZE,
): FileStateCache {
  const cache = createFileStateCacheWithSizeLimit(maxSize)
  const readUses = new Map<string, string>()
  const writeUses = new Map<string, WriteRecord>()
  const editUses = new Map<string, string>()

  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    for (const block of msg.message.content) {
      if (block.type !== 'tool_use') continue
      if (!isRecord(block.input)) continue
      const rawPath = block.input['file_path']
      if (typeof rawPath !== 'string' || rawPath.length === 0) continue
      const resolvedPath = expandPath(rawPath, cwd)

      if (block.name === READ_TOOL_NAME) {
        if (block.input['offset'] == null && block.input['limit'] == null) {
          readUses.set(block.id, resolvedPath)
        }
      } else if (block.name === WRITE_TOOL_NAME) {
        const fileContent = block.input['content']
        if (typeof fileContent === 'string' && fileContent.length > 0) {
          writeUses.set(block.id, { path: resolvedPath, content: fileContent })
        }
      } else if (block.name === EDIT_TOOL_NAME) {
        editUses.set(block.id, resolvedPath)
      }
    }
  }

  for (const msg of messages) {
    if (msg.type !== 'user') continue
    const content = msg.message.content
    if (!Array.isArray(content)) continue
    const msgTimestamp = parseTimestamp(msg.timestamp)

    for (const block of content) {
      if (block.type !== 'tool_result' || block.is_error === true) continue
      const toolUseId = block.tool_use_id

      const readPath = readUses.get(toolUseId)
      if (readPath !== undefined) {
        if (typeof block.content !== 'string' || msgTimestamp === null) continue
        if (isStubReadResult(block.content)) continue
        const withoutReminders = block.content.replace(SYSTEM_REMINDER_PATTERN, '')
        if (isStubReadResult(withoutReminders)) continue
        const stripped = withoutReminders
          .split(/\r?\n/)
          .map(stripLineNumberPrefix)
          .join('\n')
          .trim()
        cache.set(readPath, {
          content: stripped,
          timestamp: msgTimestamp,
          offset: undefined,
          limit: undefined,
        })
        continue
      }

      const writeRecord = writeUses.get(toolUseId)
      if (writeRecord !== undefined) {
        if (msgTimestamp === null) continue
        cache.set(writeRecord.path, {
          content: writeRecord.content,
          timestamp: msgTimestamp,
          offset: undefined,
          limit: undefined,
        })
        continue
      }

      const editPath = editUses.get(toolUseId)
      if (editPath !== undefined) {
        try {
          const diskContent = readFileSync(editPath, 'utf8')
          cache.set(editPath, {
            content: diskContent,
            timestamp: getFileModificationTime(editPath),
            offset: undefined,
            limit: undefined,
          })
        } catch (error) {
          if (isENOENT(error) || getErrnoCode(error) === 'EACCES') continue
          throw error
        }
      }
    }
  }

  return cache
}
