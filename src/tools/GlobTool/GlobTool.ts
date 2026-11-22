import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { z } from 'zod/v4'

import { buildTool, type CanUseToolFn, type Tool, type ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import { remoteSearchRoot } from '../../utils/remoteFiles/target.js'
import { checkReadPermissionForTool, checkUncPathPermission } from '../../utils/permissions/filesystem.js'
import { windowsPathNeedsPermission } from '../../utils/permissions/windowsPath.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import { FILE_NOT_FOUND_CWD_NOTE } from '../../utils/file.js'
import { glob, extractGlobBaseDirectory } from '../../utils/glob.js'
import { globSearchDepth, normalizeGlobPattern } from '../../utils/globPattern.js'
import { NUL_PATH_MESSAGE, controlCharacterPathRefusal, expandPath, hasNulByte, toRelativePath } from '../../utils/path.js'
import { suggestPathUnderCwd } from '../../utils/file.js'
import { DESCRIPTION, GLOB_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  isResultTruncated,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'


const DEFAULT_RESULT_LIMIT = 100

export function ignoredPathsLine(ignored: number): string {
  return `· ${ignored.toLocaleString('en-US')} ${ignored === 1 ? 'path' : 'paths'} under ignore rules not listed`
}

const inputSchema = z.strictObject({
  pattern: z.string().describe('The glob expression files must match'),
  path: z
    .string()
    .optional()
    .describe(
      'The directory to search; the current working directory when omitted.',
    ),
})

type Input = z.infer<typeof inputSchema>

export type Output = {
  durationMs: number
  numFiles: number
  filenames: string[]
  truncated: boolean
  ignored?: number
  incomplete?: string
}

const outputSchema = z.object({
  durationMs: z.number(),
  numFiles: z.number(),
  filenames: z.array(z.string()),
  truncated: z.boolean(),
  ignored: z.number().optional(),
  incomplete: z.string().optional(),
})

function searchRootFor(path?: string, pattern?: string): string {
  if (path) return expandPath(path)
  if (pattern && isAbsolute(pattern)) {
    const { baseDir } = extractGlobBaseDirectory(pattern)
    if (baseDir) return baseDir
  }
  return getCwd()
}

function globToolItself(): Tool {
  return GlobTool
}

export const GlobTool: Unbuilt = unbuilt('src/tools/GlobTool/GlobTool.ts:78')
