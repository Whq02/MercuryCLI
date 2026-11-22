import { readFileSync } from 'node:fs'

import type { Message } from '../types/message.js'
import { FILE_EDIT_TOOL_NAME } from '../constants/tools/fileEdit.js'
import { REPEATED_RESULT_TAG } from '../constants/toolLimits.js'
import { FILE_READ_TOOL_NAME, FILE_UNCHANGED_STUB } from '../constants/tools/fileRead.js'
import { FILE_WRITE_TOOL_NAME } from '../constants/tools/fileWrite.js'
import { createFileStateCacheWithSizeLimit, type FileStateCache } from './fileStateCache.js'
import { getFileModificationTime, stripLineNumberPrefix } from './file.js'
import { isENOENT } from './errors.js'
import { expandPath } from './path.js'
import { notBuilt } from '../pi/holes.js'


const DEFAULT_EXTRACT_CACHE_SIZE = 10
const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/g

type ToolUseRecord = { path: string; content?: string }

export function extractReadFilesFromMessages(
  messages: Message[],
  cwd: string,
  maxSize?: number,
): FileStateCache {
  return notBuilt('src/utils/queryHelpers.ts:19')
}
