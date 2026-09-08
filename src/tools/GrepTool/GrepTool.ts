import { stat } from 'node:fs/promises'

import { z } from 'zod/v4'

import { buildTool, type ToolUseContext } from '../../Tool.js'
import { anchorPatchEnabled } from '../../services/changeTransaction/anchorPatch.js'
import { staleEditRecoveryEnabled } from '../../services/changeTransaction/stalePatchRecovery.js'
import { fileGeneration, recordSeenLines } from '../../services/changeTransaction/seenLines.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { discoveryPoolWidth, mapWithConcurrency } from '../../utils/concurrency.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import { splitGrepGlobField } from '../../utils/globPattern.js'
import {
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  suggestPathUnderCwd,
} from '../../utils/file.js'
import { expandPath, toRelativePath } from '../../utils/path.js'
import {
  getFileReadIgnorePatterns,
  normalizePatternsToPath,
} from '../../utils/permissions/filesystem.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { ripGrepAnswer } from '../../utils/ripgrep.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { plural } from '../../utils/stringUtils.js'
import { getDescription, GREP_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  isResultTruncated,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
} from './UI.js'


const DEFAULT_HEAD_LIMIT = 250

const VCS_EXCLUDED_DIRECTORIES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']

const inputSchema = z.strictObject({
  pattern: z.string().describe('The regex to hunt for inside file contents'),
  path: z
    .string()
    .optional()
    .describe(
      'Where to search — a file or directory (rg PATH); the current working directory when omitted.',
    ),
  glob: z
    .string()
    .optional()
    .describe('Restrict the search to files matching this glob (rg --glob), e.g. "*.js" or "*.{ts,tsx}"'),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .describe(
      'What comes back: "files_with_matches" (the default) lists hit paths, "content" prints the matching lines, "count" tallies matches.',
    ),
  '-B': semanticNumber(z.number().optional()).describe(
    'Context lines printed before each hit (rg -B); only meaningful with output_mode "content", ignored otherwise.',
  ),
  '-A': semanticNumber(z.number().optional()).describe(
    'Context lines printed after each hit (rg -A); only meaningful with output_mode "content", ignored otherwise.',
  ),
  '-C': semanticNumber(z.number().optional()).describe(
    'Context lines printed both sides of each hit (rg -C); only meaningful with output_mode "content", ignored otherwise.',
  ),
  context: semanticNumber(z.number().optional()).describe(
    'Same as -C: surrounding context lines per hit. Needs output_mode "content".',
  ),
  '-n': semanticBoolean(z.boolean().optional()).describe(
    'Prefix output with line numbers (rg -n); "content" mode only, ignored otherwise. On by default.',
  ),
  '-i': semanticBoolean(z.boolean().optional()).describe('Match case-insensitively (rg -i)'),
  type: z
    .string()
    .optional()
    .describe(
      'Search only one file type (rg --type) — js, py, rust, go, java and the like; cheaper than a glob for standard types.',
    ),
  head_limit: semanticNumber(z.number().optional()).describe(
    `Cap the output at the first N lines/entries (default ${DEFAULT_HEAD_LIMIT}); applies in every output mode; 0 lifts the cap.`,
  ),
  offset: semanticNumber(z.number().optional()).describe(
    'Skip this many lines/entries before the head_limit window applies (paging). Default 0.',
  ),
  multiline: semanticBoolean(z.boolean().optional()).describe(
    'Let patterns span line boundaries, with . matching newlines (rg -U --multiline-dotall). Off by default.',
  ),
})

type Input = z.infer<typeof inputSchema>

type Output = {
  mode?: 'content' | 'files_with_matches' | 'count'
  numFiles: number
  filenames: string[]
  content?: string
  numLines?: number
  numMatches?: number
  appliedLimit?: number
  appliedOffset?: number
  incomplete?: string
}

const outputSchema = z.object({
  mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
  numFiles: z.number(),
  filenames: z.array(z.string()),
  content: z.string().optional(),
  numLines: z.number().optional(),
  numMatches: z.number().optional(),
  appliedLimit: z.number().optional(),
  appliedOffset: z.number().optional(),
  incomplete: z.string().optional(),
})

function effectiveLimit(headLimit: number | undefined): number | undefined {
  if (headLimit === 0) return undefined
  return headLimit ?? DEFAULT_HEAD_LIMIT
}

function paginate<T>(
  entries: T[],
  headLimit: number | undefined,
  offset: number,
): { slice: T[]; appliedLimit?: number; appliedOffset?: number } {
  const limit = effectiveLimit(headLimit)
  const afterOffset = offset > 0 ? entries.slice(offset) : entries
  if (limit === undefined || afterOffset.length <= limit) {
    return { slice: afterOffset, ...(offset > 0 ? { appliedOffset: offset } : {}) }
  }
  return {
    slice: afterOffset.slice(0, limit),
    appliedLimit: limit,
    ...(offset > 0 ? { appliedOffset: offset } : {}),
  }
}

function paginationNote(appliedLimit?: number, appliedOffset?: number): string {
  const parts: string[] = []
  if (appliedLimit !== undefined) parts.push(`first ${appliedLimit} results`)
  if (appliedOffset !== undefined && appliedOffset > 0) parts.push(`offset ${appliedOffset}`)
  if (parts.length === 0) return ''
  return ` (showing ${parts.join(', ')} — use offset to paginate)`
}

export function prefixSplitIndex(line: string, splitOn: 'first' | 'last'): number {
  const searchFrom = /^[A-Za-z]:[\\/]/.test(line) ? 2 : 0
  return splitOn === 'first' ? line.indexOf(':', searchFrom) : line.lastIndexOf(':')
}

function relativizePrefixed(line: string, splitOn: 'first' | 'last'): string {
  const index = prefixSplitIndex(line, splitOn)
  if (index === -1) return line
  const pathPart = line.slice(0, index)
  return `${toRelativePath(pathPart)}${line.slice(index)}`
}

async function buildArgs(input: Input, context: ToolUseContext, searchRoot: string): Promise<string[]> {
  const mode = input.output_mode ?? 'files_with_matches'
  const args: string[] = ['--hidden']
  for (const dir of VCS_EXCLUDED_DIRECTORIES) {
    args.push('--glob', `!${dir}`)
  }
  args.push('--max-columns', '500')

  if (input.multiline) args.push('-U', '--multiline-dotall')
  if (input['-i']) args.push('-i')
  if (mode === 'files_with_matches') args.push('-l')
  if (mode === 'count') args.push('-c')
  if ((input['-n'] ?? true) && mode === 'content') args.push('-n')
  if (mode === 'content') {
    args.push('--with-filename')
    if (input.context !== undefined) {
      args.push('-C', String(input.context))
    } else if (input['-C'] !== undefined) {
      args.push('-C', String(input['-C']))
    } else {
      if (input['-B'] !== undefined) args.push('-B', String(input['-B']))
      if (input['-A'] !== undefined) args.push('-A', String(input['-A']))
    }
  }
  if (input.pattern.startsWith('-')) {
    args.push('-e', input.pattern)
  } else {
    args.push(input.pattern)
  }
  if (input.type) args.push('--type', input.type)
  if (input.glob) {
    for (const value of splitGrepGlobField(input.glob)) {
      args.push('--glob', value)
    }
  }
  const ignoreByRoot = getFileReadIgnorePatterns(
    context.getAppState().toolPermissionContext,
  )
  for (const pattern of normalizePatternsToPath(ignoreByRoot as never, getCwd())) {
    args.push('--glob', pattern.startsWith('/') ? `!${pattern}` : `!**/${pattern}`)
  }
  return args
}

export const GrepTool = buildTool({
  name: GREP_TOOL_NAME,
  strict: true,
  maxResultSizeChars: 20_000,
  inputSchema,
  outputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async checkPermissions(input, context): Promise<ReturnType<typeof checkReadPermissionForTool>> {
    return checkReadPermissionForTool(GrepTool, input, context.getAppState().toolPermissionContext)
  },
  isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),
  userFacingName: () => 'Search',
  getToolUseSummary,
  getActivityDescription(input: Partial<Input> | undefined): string {
    return input?.pattern ? `Searching for ${input.pattern}` : 'Searching'
  },
  toAutoClassifierInput(input: Input): string {
    return input.path ? `${input.pattern} in ${input.path}` : input.pattern
  },
  getPath(input: Partial<Input> | undefined): string {
    return input?.path || getCwd()
  },
  preparePermissionMatcher(input: Input) {
    const pattern = input.pattern
    return (rulePattern: string): boolean =>
      matchWildcardPattern(rulePattern, pattern)
  },
  async description(): Promise<string> {
    return getDescription()
  },
  async prompt(): Promise<string> {
    return getDescription()
  },
  async validateInput(input: Input) {
    if (input.path !== undefined) {
      const expanded = expandPath(input.path)
      if (input.path.startsWith('\\\\') || input.path.startsWith('//')) {
        return { result: true as const }
      }
      try {
        await stat(expanded)
      } catch (err) {
        if (!isENOENT(err)) throw err
        let suggestion: string | undefined
        try {
          suggestion = await suggestPathUnderCwd(expanded)
        } catch {
          suggestion = undefined
        }
        if (suggestion === undefined) suggestion = findSimilarFile(expanded)
        return {
          result: false as const,
          message: `Path does not exist: ${input.path}. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.${suggestion ? ` Did you mean ${suggestion}?` : ''}`,
          errorCode: 1,
        }
      }
    }
    return { result: true as const }
  },
  async call(input: Input, context: ToolUseContext) {
    const mode = input.output_mode ?? 'files_with_matches'
    const searchRoot = input.path !== undefined ? expandPath(input.path) : getCwd()
    const args = await buildArgs(input, context, searchRoot)
    const offset = input.offset ?? 0

    const answer = await ripGrepAnswer(args, searchRoot, context.abortController.signal)
    const lines = answer.lines
    const incomplete = answer.complete ? undefined : (answer.reason ?? 'the search did not finish')

    if (mode === 'content') {
      const { slice, appliedLimit, appliedOffset } = paginate(lines, input.head_limit, offset)
      if ((anchorPatchEnabled() || staleEditRecoveryEnabled()) && (input['-n'] ?? true)) {
        try {
          const owner = ownerFromToolUseContext(context)
          const generations = new Map<string, string | null>()
          for (const line of slice) {
            const m = /^(.+?):(\d+):/.exec(line)
            if (!m) continue
            const file = m[1]!
            if (!generations.has(file)) generations.set(file, fileGeneration(file))
            const generation = generations.get(file)
            if (generation == null) continue
            recordSeenLines(owner, file, generation, Number(m[2]), 1)
          }
        } catch {
        }
      }
      const relativized = slice.map(line => relativizePrefixed(line, 'first'))
      return {
        data: {
          mode,
          numFiles: 0,
          filenames: [],
          content: relativized.join('\n'),
          numLines: relativized.length,
          ...(appliedLimit !== undefined ? { appliedLimit } : {}),
          ...(appliedOffset !== undefined ? { appliedOffset } : {}),
          ...(incomplete !== undefined ? { incomplete } : {}),
        } satisfies Output,
      }
    }

    if (mode === 'count') {
      const { slice, appliedLimit, appliedOffset } = paginate(lines, input.head_limit, offset)
      let numMatches = 0
      let numFiles = 0
      const rendered: string[] = []
      for (const line of slice) {
        if (/^\d+$/.test(line)) {
          numMatches += parseInt(line, 10)
          numFiles++
          rendered.push(line)
          continue
        }
        const index = line.lastIndexOf(':')
        if (index === -1) {
          rendered.push(line)
          continue
        }
        const count = parseInt(line.slice(index + 1), 10)
        if (Number.isNaN(count)) {
          rendered.push(line)
          continue
        }
        numMatches += count
        numFiles++
        rendered.push(relativizePrefixed(line, 'last'))
      }
      return {
        data: {
          mode,
          numFiles,
          filenames: [],
          content: rendered.join('\n'),
          numMatches,
          ...(appliedLimit !== undefined ? { appliedLimit } : {}),
          ...(appliedOffset !== undefined ? { appliedOffset } : {}),
          ...(incomplete !== undefined ? { incomplete } : {}),
        } satisfies Output,
      }
    }

    const statted = await mapWithConcurrency(lines, discoveryPoolWidth(), async file => {
      try {
        const stats = await stat(file)
        return { file, mtimeMs: stats.mtimeMs }
      } catch {
        return { file, mtimeMs: 0 }
      }
    })
    if (process.env.NODE_ENV === 'test') {
      statted.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    } else {
      statted.sort(
        (a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
      )
    }
    const { slice, appliedLimit, appliedOffset } = paginate(statted, input.head_limit, offset)
    const filenames = slice.map(entry => toRelativePath(entry.file))
    return {
      data: {
        mode,
        numFiles: filenames.length,
        filenames,
        ...(appliedLimit !== undefined ? { appliedLimit } : {}),
        ...(appliedOffset !== undefined ? { appliedOffset } : {}),
        ...(incomplete !== undefined ? { incomplete } : {}),
      } satisfies Output,
    }
  },
  mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
    const note = paginationNote(data.appliedLimit, data.appliedOffset)
    const incompleteNote = data.incomplete !== undefined ? `\n(INCOMPLETE SEARCH — ${data.incomplete})` : ''
    let text: string
    switch (data.mode) {
      case 'content':
        text = data.content ? `${data.content}${note ? `\n${note.trim()}` : ''}` : 'No matches found'
        break
      case 'count': {
        const body = data.content ? data.content : 'No matches found'
        const matches = data.numMatches ?? 0
        text = `${body}\n${matches} ${plural(matches, 'match', 'matches')} across ${data.numFiles} ${plural(data.numFiles, 'file')}${note}`
        break
      }
      default:
        text =
          data.numFiles === 0
            ? 'No files found'
            : `Found ${data.numFiles} ${plural(data.numFiles, 'file')}${note}\n${data.filenames.join('\n')}`
    }
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: text + incompleteNote }
  },
  extractSearchText(data: Output): string {
    if (data.mode === 'content') return data.content ?? ''
    return data.filenames.join('\n')
  },
  isResultTruncated,
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseErrorMessage,
})
