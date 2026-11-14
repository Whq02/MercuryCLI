import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { z } from 'zod/v4'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { remoteSearchRoot } from '../../services/remoteFiles/target.js'
import { checkReadPermissionForTool, checkUncPathPermission } from '../../utils/permissions/filesystem.js'
import { windowsPathNeedsPermission } from '../../utils/permissions/windowsPath.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import { FILE_NOT_FOUND_CWD_NOTE } from '../../utils/file.js'
import { glob, extractGlobBaseDirectory } from '../../utils/glob.js'
import { globSearchDepth, normalizeGlobPattern } from '../../utils/globPattern.js'
import { controlCharacterPathRefusal, expandPath, toRelativePath } from '../../utils/path.js'
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

function globToolItself(): unknown {
  return GlobTool
}

export const GlobTool = buildTool({
  name: GLOB_TOOL_NAME,
  straightQuoteInputs: ['pattern', 'path'],
  maxResultSizeChars: 100_000,
  inputSchema,
  outputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async checkPermissions(input, context): Promise<ReturnType<typeof checkReadPermissionForTool>> {
    const far = remoteSearchRoot(input.path, input.pattern)
    if (far !== null) {
      const { remotePermission } = await import('../../services/remoteFiles/bridge.js')
      return remotePermission(GLOB_TOOL_NAME, far.root, null, input, context, 'read')
    }
    for (const path of [input.path, input.pattern]) {
      const remote = path === undefined ? null : checkUncPathPermission(path, context.getAppState().toolPermissionContext)
      if (remote && remote.behavior !== 'allow') return remote
    }
    const literal = checkReadPermissionForTool({ name: 'Glob', getPath: () => expandPath(input.pattern, input.path ? expandPath(input.path) : getCwd()) }, input, context.getAppState().toolPermissionContext)
    if (literal.behavior === 'deny') return literal
    return checkReadPermissionForTool(GlobTool, input, context.getAppState().toolPermissionContext)
  },
  isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),
  userFacingName,
  getToolUseSummary,
  getPath({ path, pattern }) {
    return remoteSearchRoot(path, pattern ?? '')?.root ?? searchRootFor(path, pattern)
  },
  async description(): Promise<string> {
    return DESCRIPTION
  },
  async prompt(): Promise<string> {
    return DESCRIPTION
  },
  async validateInput(input: Input, context: ToolUseContext) {
    const far = remoteSearchRoot(input.path, input.pattern)
    if (far !== null) {
      const pathRefusal = controlCharacterPathRefusal(far.root)
      if (pathRefusal !== null) return { result: false as const, message: pathRefusal, errorCode: 1 }
      const { remoteValidation } = await import('../../services/remoteFiles/bridge.js')
      return remoteValidation(far.root, null, 'read', 'Searching', context)
    }
    if (input.path !== undefined) {
      const pathRefusal = controlCharacterPathRefusal(input.path)
      if (pathRefusal !== null) {
        return { result: false as const, message: pathRefusal, errorCode: 1 }
      }
      if (windowsPathNeedsPermission(input.path)) return { result: true as const }
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
  async call(input: Input, context: ToolUseContext, canUseTool, parentMessage) {
    const started = Date.now()
    const limit = context.globLimits?.maxResults ?? DEFAULT_RESULT_LIMIT
    const far = remoteSearchRoot(input.path, input.pattern)
    if (far !== null) {
      const bridge = await import('../../services/remoteFiles/bridge.js')
      const parts = normalizeGlobPattern(far.pattern).split('/')
      const literal = parts.slice(0, -1).findIndex(part => part === '' || part === '.' || part === '..' || /[*?[{\\]/.test(part))
      const within = parts.slice(0, literal === -1 ? parts.length - 1 : literal)
      const patterns = [parts.slice(within.length).join('/')]
      const names = bridge.remoteSearchNames(patterns)
      const mirror = await bridge.remoteMirror(
        GLOB_TOOL_NAME,
        far.root,
        context,
        typeof canUseTool === 'function' && parentMessage !== undefined
          ? path => (canUseTool as CanUseToolFn)(globToolItself() as never, { pattern: far.pattern, path }, context, parentMessage as never, `${context.toolUseId ?? 'glob'}-resolved`)
          : null,
        names === null ? 0 : (globSearchDepth(patterns) ?? 0),
        names,
        within.join('/'),
      )
      try {
        const found = await glob(mirror.deeper ? patterns[0]! : far.pattern, mirror.dir, { limit, offset: 0 }, context.abortController.signal, mirror.rules)
        return {
          data: mirror.rename({
            durationMs: Date.now() - started,
            numFiles: found.files.length,
            filenames: found.files,
            truncated: found.truncated,
            ...(found.ignored > 0 ? { ignored: found.ignored } : {}),
            ...(found.incomplete !== undefined ? { incomplete: found.incomplete } : {}),
          } satisfies Output),
        }
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
    const durationMs = Date.now() - started
    return {
      data: {
        durationMs,
        numFiles: files.length,
        filenames: files.map(toRelativePath),
        truncated,
        ...(ignored > 0 ? { ignored } : {}),
        ...(incomplete !== undefined ? { incomplete } : {}),
      } satisfies Output,
    }
  },
  mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
    const incompleteNote = data.incomplete !== undefined ? `\n(INCOMPLETE SEARCH — ${data.incomplete})` : ''
    const ignoredNote = data.ignored !== undefined && data.ignored > 0 ? `\n${ignoredPathsLine(data.ignored)}` : ''
    if (data.numFiles === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `No files found${ignoredNote}${incompleteNote}`,
      }
    }
    let content = data.filenames.join('\n')
    if (data.truncated) {
      content +=
        '\n(Results are truncated to a sample spread across top-level folders, each newest first. Consider using a more specific path or pattern.)'
    }
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: content + ignoredNote + incompleteNote }
  },
  extractSearchText(data: Output): string {
    return data.filenames.join('\n')
  },
  isResultTruncated,
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseErrorMessage,
})
