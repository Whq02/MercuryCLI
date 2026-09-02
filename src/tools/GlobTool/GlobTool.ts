import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { z } from 'zod/v4'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import { FILE_NOT_FOUND_CWD_NOTE } from '../../utils/file.js'
import { glob, extractGlobBaseDirectory } from '../../utils/glob.js'
import { expandPath, toRelativePath } from '../../utils/path.js'
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


const DEFAULT_RESULT_LIMIT = 100

const inputSchema = z.strictObject({
  pattern: z.string().describe('The glob expression files must match'),
  path: z
    .string()
    .optional()
    .describe(
      'Directory the search runs in; leaving the field out entirely selects the current working directory. IMPORTANT: omission IS the default — never write "undefined" or "null" here. When given, it must be a real directory path.',
    ),
})

type Input = z.infer<typeof inputSchema>

export type Output = {
  durationMs: number
  numFiles: number
  filenames: string[]
  truncated: boolean
  incomplete?: string
}

const outputSchema = z.object({
  durationMs: z.number(),
  numFiles: z.number(),
  filenames: z.array(z.string()),
  truncated: z.boolean(),
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

export const GlobTool = buildTool({
  name: GLOB_TOOL_NAME,
  maxResultSizeChars: 100_000,
  inputSchema,
  outputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async checkPermissions(input, context): Promise<ReturnType<typeof checkReadPermissionForTool>> {
    return checkReadPermissionForTool(GlobTool, input, context.getAppState().toolPermissionContext)
  },
  isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),
  userFacingName,
  getToolUseSummary,
  getPath({ path, pattern }) {
    return searchRootFor(path, pattern)
  },
  async description(): Promise<string> {
    let text = DESCRIPTION
    try {
      const { searchSteeringLine } =
        require('../../services/projectIntel/steering.js') as typeof import('../../services/projectIntel/steering.js')
      const line = searchSteeringLine()
      if (line) text += `\n${line}`
    } catch {
    }
    return text
  },
  async prompt(): Promise<string> {
    return DESCRIPTION
  },
  async validateInput(input: Input) {
    if (input.path !== undefined) {
      if (input.path.startsWith('\\\\') || input.path.startsWith('//')) {
        return { result: true as const }
      }
      const expanded = expandPath(input.path)
      let stats
      try {
        stats = await stat(expanded)
      } catch (err) {
        if (!isENOENT(err)) throw err
        let suggestion: string | undefined
        try {
          suggestion = await suggestPathUnderCwd(expanded)
        } catch {
          suggestion = undefined
        }
        return {
          result: false as const,
          message: `Directory does not exist: ${input.path}. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.${suggestion ? ` Did you mean ${suggestion}?` : ''}`,
          errorCode: 1,
        }
      }
      if (!stats.isDirectory()) {
        return {
          result: false as const,
          message: `Path is not a directory: ${input.path}`,
          errorCode: 2,
        }
      }
    }
    return { result: true as const }
  },
  async call(input: Input, context: ToolUseContext) {
    const started = Date.now()
    const root = searchRootFor(input.path, input.pattern)
    const limit = context.globLimits?.maxResults ?? DEFAULT_RESULT_LIMIT
    const { files, truncated, incomplete } = await glob(
      input.pattern,
      root,
      { limit, offset: 0 },
      context.abortController.signal,
      context.getAppState().toolPermissionContext,
    )
    const durationMs = Date.now() - started
    return {
      data: {
        durationMs,
        numFiles: files.length,
        filenames: files.map(toRelativePath),
        truncated,
        ...(incomplete !== undefined ? { incomplete } : {}),
      } satisfies Output,
    }
  },
  mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
    const incompleteNote = data.incomplete !== undefined ? `\n(INCOMPLETE SEARCH — ${data.incomplete})` : ''
    if (data.numFiles === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `No files found${incompleteNote}`,
      }
    }
    let content = data.filenames.join('\n')
    if (data.truncated) {
      content +=
        '\n(Results are truncated. Consider using a more specific path or pattern.)'
    }
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: content + incompleteNote }
  },
  extractSearchText(data: Output): string {
    return data.filenames.join('\n')
  },
  isResultTruncated,
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseErrorMessage,
})
