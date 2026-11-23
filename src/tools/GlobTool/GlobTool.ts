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

function splitRemotePrefix(pattern: string): { within: string; remainder: string } {
  const parts = normalizeGlobPattern(pattern).split('/')
  let count = 0
  while (count < parts.length - 1) {
    const part = parts[count]!
    if (part === '' || part === '.' || part === '..' || /[*?[\]{}\\]/.test(part)) break
    count++
  }
  return {
    within: parts.slice(0, count).join('/'),
    remainder: parts.slice(count).join('/'),
  }
}

export const GlobTool = buildTool({
  name: GLOB_TOOL_NAME,
  maxResultSizeChars: 100_000,
  straightQuoteInputs: ['pattern', 'path'],
  inputSchema,
  outputSchema,
  userFacingName,
  getToolUseSummary,
  isResultTruncated,
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),
  getPath(input?: Partial<Input>) {
    const remote = remoteSearchRoot(input?.path, input?.pattern ?? '')
    if (remote !== null) return remote.root
    return searchRootFor(input?.path, input?.pattern)
  },
  async checkPermissions(input: Input, context: ToolUseContext) {
    const remote = remoteSearchRoot(input.path, input.pattern)
    if (remote !== null) {
      const { remotePermission } = await import('../../services/remoteFiles/bridge.js')
      return remotePermission(GLOB_TOOL_NAME, remote.root, null, input, context, 'read')
    }
    const permissionContext = context.getAppState().toolPermissionContext
    if (input.path) {
      const pathUnc = checkUncPathPermission(input.path, permissionContext)
      if (pathUnc && pathUnc.behavior !== 'allow') return pathUnc
    }
    const patternUnc = checkUncPathPermission(input.pattern, permissionContext)
    if (patternUnc && patternUnc.behavior !== 'allow') return patternUnc
    const base = input.path ? expandPath(input.path) : getCwd()
    const literalTarget = expandPath(input.pattern, base)
    const literalDecision = checkReadPermissionForTool(
      { name: GLOB_TOOL_NAME, getPath: () => literalTarget },
      input,
      permissionContext,
    )
    if (literalDecision.behavior === 'deny') return literalDecision
    return checkReadPermissionForTool(globToolItself(), input, permissionContext)
  },
  async validateInput(input: Input, context: ToolUseContext) {
    if (hasNulByte(input.pattern)) {
      return { result: false, message: NUL_PATH_MESSAGE, errorCode: 1 }
    }
    const remote = remoteSearchRoot(input.path, input.pattern)
    if (remote !== null) {
      const control = controlCharacterPathRefusal(remote.root)
      if (control !== null) {
        return { result: false, message: control, errorCode: 1 }
      }
      const { remoteValidation } = await import('../../services/remoteFiles/bridge.js')
      return remoteValidation(remote.root, null, 'read', 'Searching', context)
    }
    if (!input.path) {
      return { result: true }
    }
    const control = controlCharacterPathRefusal(input.path)
    if (control !== null) {
      return { result: false, message: control, errorCode: 1 }
    }
    if (windowsPathNeedsPermission(input.path)) {
      return { result: true }
    }
    const expanded = expandPath(input.path)
    try {
      const info = await stat(expanded)
      if (!info.isDirectory()) {
        return {
          result: false,
          message: `Path is not a directory: ${input.path}`,
          errorCode: 2,
        }
      }
    } catch (error) {
      if (isENOENT(error)) {
        let suggestion: string | undefined
        try {
          suggestion = await suggestPathUnderCwd(input.path)
        } catch {
          suggestion = undefined
        }
        const hint = suggestion ? ` Did you mean ${suggestion}?` : ''
        return {
          result: false,
          message: `Directory does not exist: ${input.path}. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.${hint}`,
          errorCode: 1,
        }
      }
      throw error
    }
    return { result: true }
  },
  async call(
    input: Input,
    context: ToolUseContext,
    canUseTool?: CanUseToolFn,
    parentMessage?: AssistantMessage,
  ): Promise<{ data: Output }> {
    const start = Date.now()
    const limit = context.globLimits?.maxResults ?? DEFAULT_RESULT_LIMIT
    const remote = remoteSearchRoot(input.path, input.pattern)
    if (remote !== null) {
      const { within, remainder } = splitRemotePrefix(remote.pattern)
      const bridge = await import('../../services/remoteFiles/bridge.js')
      const names = bridge.remoteSearchNames([remainder])
      const depth = names === null ? 0 : (globSearchDepth([remainder]) ?? 0)
      const mirror = await bridge.remoteMirror(
        GLOB_TOOL_NAME,
        remote.root,
        context,
        typeof canUseTool === 'function' && parentMessage !== undefined
          ? path =>
              canUseTool(
                globToolItself(),
                { pattern: remote.pattern, path },
                context,
                parentMessage,
                `${context.toolUseId ?? 'glob'}-resolved`,
              )
          : null,
        depth,
        names,
        within,
      )
      try {
        const walked = await glob(
          mirror.deeper ? remainder : remote.pattern,
          mirror.dir,
          { limit, offset: 0 },
          context.abortController.signal,
          mirror.rules,
        )
        const data: Output = mirror.rename({
          durationMs: Date.now() - start,
          numFiles: walked.files.length,
          filenames: walked.files,
          truncated: walked.truncated,
          ...(walked.ignored > 0 ? { ignored: walked.ignored } : {}),
          ...(walked.incomplete !== undefined ? { incomplete: walked.incomplete } : {}),
        })
        return { data }
      } finally {
        mirror.close()
      }
    }
    const root = searchRootFor(input.path, input.pattern)
    const { files, truncated, ignored, incomplete } = await glob(
      input.pattern,
      root,
      { limit, offset: 0 },
      context.abortController.signal,
      context.getAppState().toolPermissionContext,
    )
    const filenames = files.map(file => toRelativePath(file))
    const data: Output = {
      durationMs: Date.now() - start,
      numFiles: filenames.length,
      filenames,
      truncated,
      ...(ignored > 0 ? { ignored } : {}),
      ...(incomplete !== undefined ? { incomplete } : {}),
    }
    return { data }
  },
  extractSearchText(output: Output) {
    return output.filenames.join('\n')
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    let content =
      output.filenames.length === 0
        ? 'No files found'
        : output.filenames.join('\n') +
          (output.truncated
            ? '\n(Results are truncated to a sample spread across top-level folders, each newest first. Consider using a more specific path or pattern.)'
            : '')
    if (output.ignored && output.ignored > 0) {
      content += `\n${ignoredPathsLine(output.ignored)}`
    }
    if (output.incomplete !== undefined) {
      content += `\n(INCOMPLETE SEARCH — ${output.incomplete})`
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content,
    }
  },
})
