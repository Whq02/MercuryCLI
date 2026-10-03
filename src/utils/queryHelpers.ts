import { readFileSync } from 'node:fs'

import type { Message } from '../types/message.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME, FILE_UNCHANGED_STUB } from '../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { createFileStateCacheWithSizeLimit, type FileStateCache } from './fileStateCache.js'
import { getFileModificationTime, stripLineNumberPrefix } from './file.js'
import { isENOENT } from './errors.js'
import { expandPath } from './path.js'


const DEFAULT_EXTRACT_CACHE_SIZE = 10
const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/g

type ToolUseRecord = { path: string; content?: string }

export function extractReadFilesFromMessages(
  messages: Message[],
  cwd: string,
  maxSize: number = DEFAULT_EXTRACT_CACHE_SIZE,
): FileStateCache {
  const cache = createFileStateCacheWithSizeLimit(maxSize)
  const reads = new Map<string, ToolUseRecord>()
  const writes = new Map<string, ToolUseRecord>()
  const edits = new Map<string, ToolUseRecord>()

  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const toolUse = block as { type?: string; id?: string; name?: string; input?: Record<string, unknown> }
      if (toolUse.type !== 'tool_use' || !toolUse.id || !toolUse.input) continue
      const filePath = toolUse.input.file_path
      if (typeof filePath !== 'string' || filePath === '') continue
      const absolute = expandPath(filePath, cwd)
      if (toolUse.name === FILE_READ_TOOL_NAME) {
        if (toolUse.input.offset === undefined && toolUse.input.limit === undefined) {
          reads.set(toolUse.id, { path: absolute })
        }
      } else if (toolUse.name === FILE_WRITE_TOOL_NAME) {
        const written = toolUse.input.content
        if (typeof written === 'string' && written !== '') {
          writes.set(toolUse.id, { path: absolute, content: written })
        }
      } else if (toolUse.name === FILE_EDIT_TOOL_NAME) {
        edits.set(toolUse.id, { path: absolute })
      }
    }
  }

  for (const message of messages) {
    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    const timestamp = (message as { timestamp?: string }).timestamp
    for (const block of content) {
      const result = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
      if (result.type !== 'tool_result' || !result.tool_use_id) continue
      const read = reads.get(result.tool_use_id)
      if (read) {
        if (typeof result.content !== 'string') continue
        if (result.content.startsWith(FILE_UNCHANGED_STUB)) continue
        if (!timestamp) continue
        const cleaned = result.content
          .replace(SYSTEM_REMINDER_PATTERN, '')
          .split('\n')
          .map(line => stripLineNumberPrefix(line))
          .join('\n')
          .trim()
        cache.set(read.path, { content: cleaned, timestamp: Date.parse(timestamp), offset: undefined, limit: undefined })
        continue
      }
      const write = writes.get(result.tool_use_id)
      if (write && write.content !== undefined) {
        if (!timestamp) continue
        cache.set(write.path, { content: write.content, timestamp: Date.parse(timestamp), offset: undefined, limit: undefined })
        continue
      }
      const edit = edits.get(result.tool_use_id)
      if (edit && result.is_error !== true) {
        try {
          const diskContent = readFileSync(edit.path, 'utf8')
          const mtime = getFileModificationTime(edit.path)
          cache.set(edit.path, { content: diskContent, timestamp: mtime, offset: undefined, limit: undefined })
        } catch (err) {
          if (!isENOENT(err) && !(err instanceof Error && (err as NodeJS.ErrnoException).code === 'EACCES')) throw err
        }
      }
    }
  }
  return cache
}
