import { realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import picomatch from 'picomatch'
import { z } from 'zod/v4'

import { buildTool, type ToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { anchorPatchEnabled } from '../../services/changeTransaction/anchorPatch.js'
import { staleEditRecoveryEnabled } from '../../services/changeTransaction/stalePatchRecovery.js'
import { fileGeneration, recordSeenLines } from '../../services/changeTransaction/seenLines.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { discoveryPoolWidth, mapWithConcurrency } from '../../utils/concurrency.js'
import {
  LEFT_DOUBLE_CURLY_QUOTE,
  LEFT_SINGLE_CURLY_QUOTE,
  RIGHT_DOUBLE_CURLY_QUOTE,
  RIGHT_SINGLE_CURLY_QUOTE,
} from '../../utils/curlyQuotes.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import { globSearchDepth, splitGrepGlobField } from '../../utils/globPattern.js'
import {
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  suggestPathUnderCwd,
} from '../../utils/file.js'
import { NUL_PATH_MESSAGE, expandPath, hasNulByte, toRelativePath } from '../../utils/path.js'
import {
  envFileReadAsk,
  envFileTargetsInGlob,
  getFileReadIgnorePatterns,
  isProjectEnvFileName,
  normalizePatternsToPath,
} from '../../utils/permissions/filesystem.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import { modeBypassesPermissions } from '../../utils/permissions/PermissionMode.js'
import { windowsPathNeedsPermission } from '../../utils/permissions/windowsPath.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { ripGrepAnswer, RipgrepUsageError, type RipgrepAnswer } from '../../utils/ripgrep.js'
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
    'Context lines printed before each hit (rg -B; "content" mode only).',
  ),
  '-A': semanticNumber(z.number().optional()).describe(
    'Context lines printed after each hit (rg -A; "content" mode only).',
  ),
  '-C': semanticNumber(z.number().optional()).describe(
    'Context lines printed both sides of each hit (rg -C; "content" mode only).',
  ),
  context: semanticNumber(z.number().optional()).describe(
    'Same as -C: surrounding context lines per hit ("content" mode only).',
  ),
  '-n': semanticBoolean(z.boolean().optional()).describe(
    'Prefix output with line numbers (rg -n; "content" mode only). On by default.',
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
  literal: semanticBoolean(z.boolean().optional()).describe(
    'Match the pattern as exact text, not a regex (rg -F) — for code with regex characters such as foo(bar[0]), $VAR or a.b, nothing escaped. Off by default.',
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
  engine?: string
  withheld?: string
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
  engine: z.string().optional(),
  withheld: z.string().optional(),
})

type OutputMode = NonNullable<Output['mode']>

function envFileTargetsInGlobField(glob: string | undefined): string[] {
  return glob ? splitGrepGlobField(glob).flatMap(envFileTargetsInGlob) : []
}

function envFilesWithheld(input: Input, permission: ToolPermissionContext, givenRoot: string): boolean {
  if (modeBypassesPermissions(permission.mode)) return false
  return !isProjectEnvFileName(givenRoot)
}

function envFileCoverage(glob: string | undefined, searchRoot: string): (file: string) => boolean {
  const tokens = glob ? splitGrepGlobField(glob).filter(token => envFileTargetsInGlob(token).length > 0) : []
  if (tokens.length === 0) return () => false
  const named = picomatch(tokens.map(token => token.replace(/^(?:\.\/|\/)+/, '')), { dot: true, basename: true })
  return file => {
    const under = relative(searchRoot, file).replaceAll('\\', '/')
    return under !== '' && !under.startsWith('..') && named(under)
  }
}

function restoreSeparator(file: string, rest: string, numbered: boolean): string {
  const number = /^(\d+)([:-])/.exec(rest)
  if (!number) return `${file}:${rest}`
  return numbered ? `${file}${number[2]}${rest}` : `${file}${number[2]}${rest.slice(number[0].length)}`
}

function withholdEnvFileLines(
  lines: readonly string[],
  mode: OutputMode,
  numbered: boolean,
  permission: ToolPermissionContext,
  covered: (file: string) => boolean,
): { lines: string[]; withheld: string | undefined } {
  const kept: string[] = []
  const counts = new Map<string, number>()
  const verdicts = new Map<string, boolean>()
  const withheld = (file: string): boolean => {
    let verdict = verdicts.get(file)
    if (verdict === undefined) {
      verdict = isProjectEnvFileName(file) && !covered(file) && envFileReadAsk(file, permission) !== null
      verdicts.set(file, verdict)
    }
    return verdict
  }
  for (const raw of lines) {
    const nul = mode === 'files_with_matches' ? raw.length : raw.indexOf('\0')
    if (nul === -1) {
      if (raw !== '--' || (kept.length > 0 && kept[kept.length - 1] !== '--')) kept.push(raw)
      continue
    }
    const file = raw.slice(0, nul)
    if (withheld(file)) {
      counts.set(file, (counts.get(file) ?? 0) + 1)
      continue
    }
    kept.push(mode === 'files_with_matches' ? raw : restoreSeparator(file, raw.slice(nul + 1), numbered))
  }
  if (kept[kept.length - 1] === '--') kept.pop()
  if (counts.size === 0) return { lines: kept, withheld: undefined }
  const named = [...counts].map(([file, count]) =>
    mode === 'files_with_matches' ? toRelativePath(file) : `${toRelativePath(file)} (${count} ${plural(count, 'line')})`,
  )
  return {
    lines: kept,
    withheld: `Withheld: ${named.join(', ')} — Mercury asks before reading a .env file; search it by name (path or glob) to be asked.`,
  }
}

function effectiveLimit(headLimit: number | undefined): number | undefined {
  if (headLimit === 0) return undefined
  return headLimit ?? DEFAULT_HEAD_LIMIT
}

function paginate<T>(
  entries: T[],
  headLimit: number | undefined,
  offset: number,
): { slice: T[]; start: number; appliedLimit?: number; appliedOffset?: number } {
  const limit = effectiveLimit(headLimit)
  const afterOffset = offset > 0 ? entries.slice(offset) : entries
  const start = entries.length - afterOffset.length
  if (limit === undefined || afterOffset.length <= limit) {
    return { slice: afterOffset, start, ...(offset > 0 ? { appliedOffset: offset } : {}) }
  }
  return {
    slice: afterOffset.slice(0, limit),
    start,
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

function sharedPrefix(first: string, second: string): string {
  const limit = Math.min(first.length, second.length)
  let end = 0
  while (end < limit && first.charCodeAt(end) === second.charCodeAt(end)) end++
  return first.slice(0, end)
}

function relativizeContentLines(lines: readonly string[], from: number, count: number): string[] {
  const relativized: string[] = []
  let shared = ''
  let groupEnd = from
  for (let at = from; at < from + count; at++) {
    const line = lines[at]!
    if (line === '--') {
      relativized.push(line)
      continue
    }
    if (at >= groupEnd) {
      let groupStart = at
      while (groupStart > 0 && lines[groupStart - 1] !== '--') groupStart--
      groupEnd = at + 1
      while (groupEnd < lines.length && lines[groupEnd] !== '--') groupEnd++
      shared = lines[groupStart]!
      for (let index = groupStart + 1; index < groupEnd; index++) shared = sharedPrefix(shared, lines[index]!)
    }
    const isContext = shared !== '' && line.startsWith(shared) && line.charAt(shared.length) === '-'
    relativized.push(isContext ? `${toRelativePath(shared)}${line.slice(shared.length)}` : relativizePrefixed(line, 'first'))
  }
  return relativized
}

const SINGLE_QUOTE_CLASS = `['${LEFT_SINGLE_CURLY_QUOTE}${RIGHT_SINGLE_CURLY_QUOTE}]`
const DOUBLE_QUOTE_CLASS = `["${LEFT_DOUBLE_CURLY_QUOTE}${RIGHT_DOUBLE_CURLY_QUOTE}]`

export function quoteTolerantPattern(pattern: string): string {
  if (!pattern.includes("'") && !pattern.includes('"')) return pattern
  let out = ''
  let depth = 0
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '\\') {
      out += char + (pattern[i + 1] ?? '')
      i++
      continue
    }
    if (depth > 0) {
      if (char === '[') depth++
      else if (char === ']') depth--
      out += char
      continue
    }
    if (char === '[') {
      depth = 1
      out += char
      if (pattern[i + 1] === '^') {
        out += '^'
        i++
      }
      if (pattern[i + 1] === ']') {
        out += ']'
        i++
      }
      continue
    }
    out += char === "'" ? SINGLE_QUOTE_CLASS : char === '"' ? DOUBLE_QUOTE_CLASS : char
  }
  return out
}

export function realSearchRoot(root: string): string {
  try {
    return realpathSync(root)
  } catch {
    return root
  }
}

function respellRoot(line: string, real: string, given: string): string {
  if (!line.startsWith(real)) return line
  const next = line.charAt(real.length)
  return next === '' || next === '/' || next === '\\' || next === ':' || next === '-' ? `${given}${line.slice(real.length)}` : line
}

async function buildArgs(input: Input, context: ToolUseContext, searchRoot: string, withholdEnvFiles: boolean): Promise<string[]> {
  const mode = input.output_mode ?? 'files_with_matches'
  const args: string[] = ['--hidden']
  for (const dir of VCS_EXCLUDED_DIRECTORIES) {
    args.push('--glob', `!${dir}`)
  }
  args.push('--max-columns', '500')

  if (input.multiline) args.push('-U', '--multiline-dotall')
  if (input.literal) args.push('-F')
  if (input['-i']) args.push('-i')
  if (mode === 'files_with_matches') args.push('-l')
  if (mode === 'count') args.push('-c')
  if (withholdEnvFiles && mode !== 'files_with_matches') args.push('--null')
  if (((input['-n'] ?? true) || withholdEnvFiles) && mode === 'content') args.push('-n')
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
  const pattern = input.literal ? input.pattern : quoteTolerantPattern(input.pattern)
  if (pattern.startsWith('-')) {
    args.push('-e', pattern)
  } else {
    args.push(pattern)
  }
  if (input.type) args.push('--type', input.type)
  if (input.glob) {
    const patterns = splitGrepGlobField(input.glob)
    const anchored = patterns.every(value => value.startsWith('!') || value.includes('/'))
    const depth = anchored ? globSearchDepth(patterns) : undefined
    if (depth !== undefined) args.push('--max-depth', String(depth))
    for (const value of patterns) {
      args.push('--glob', value)
    }
  }
  const ignoreByRoot = getFileReadIgnorePatterns(
    context.getAppState().toolPermissionContext,
  )
  for (const pattern of normalizePatternsToPath(ignoreByRoot as never, searchRoot)) {
    args.push('--iglob', pattern.startsWith('/') ? `!${pattern}` : `!**/${pattern}`)
  }
  return args
}

type PcreOnlyConstruct = 'lookaround' | 'a backreference' | 'lookaround and a backreference'

export function pcreOnlyConstruct(pattern: string): PcreOnlyConstruct | null {
  let lookaround = false
  let backreference = false
  let depth = 0
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '\\') {
      const next = pattern[i + 1] ?? ''
      if (depth === 0 && next >= '1' && next <= '9') backreference = true
      i++
      continue
    }
    if (depth > 0) {
      if (char === '[') depth++
      else if (char === ']') depth--
      continue
    }
    if (char === '[') {
      depth = 1
      if (pattern[i + 1] === '^') i++
      if (pattern[i + 1] === ']') i++
      continue
    }
    if (char !== '(' || pattern[i + 1] !== '?') continue
    const third = pattern[i + 2]
    if (third === '=' || third === '!') lookaround = true
    else if (third === '<' && (pattern[i + 3] === '=' || pattern[i + 3] === '!')) lookaround = true
  }
  if (lookaround && backreference) return 'lookaround and a backreference'
  if (lookaround) return 'lookaround'
  if (backreference) return 'a backreference'
  return null
}

const LOOKAROUND_REWRITE = 'use \\b word boundaries instead of lookaround ((?<![A-Za-z])system(?![A-Za-z]) becomes \\bsystem\\b)'
const BACKREFERENCE_REWRITE =
  'spell the repeated text out instead of a backreference ((foo)\\1 becomes foofoo), or search for the group alone and check the repeat in the lines it returns'

function rewriteWithoutPcre2(construct: PcreOnlyConstruct): string {
  if (construct === 'lookaround') return LOOKAROUND_REWRITE
  if (construct === 'a backreference') return BACKREFERENCE_REWRITE
  return `${LOOKAROUND_REWRITE}; ${BACKREFERENCE_REWRITE}`
}

function pcre2Refused(original: RipgrepUsageError, construct: PcreOnlyConstruct, refusal: string): RipgrepUsageError {
  if (!/PCRE2 is not available/i.test(refusal)) return new RipgrepUsageError(refusal)
  return new RipgrepUsageError(
    `${original.diagnostic} — this ripgrep build has no PCRE2, so ${construct} cannot run: ${rewriteWithoutPcre2(construct)}`,
  )
}

async function answerWithPcre2Fallback(
  pattern: string,
  args: string[],
  searchRoot: string,
  signal: AbortSignal,
): Promise<{ answer: RipgrepAnswer; engine?: string }> {
  const cwd = (await stat(searchRoot)).isDirectory() ? searchRoot : dirname(searchRoot)
  try {
    return { answer: await ripGrepAnswer(args, searchRoot, signal, { cwd }) }
  } catch (error) {
    if (!(error instanceof RipgrepUsageError) || !/regex parse error/i.test(error.diagnostic)) throw error
    const construct = pcreOnlyConstruct(pattern)
    if (construct === null) throw error
    try {
      const answer = await ripGrepAnswer(['--pcre2', ...args], searchRoot, signal, { cwd })
      return { answer, engine: `matched with PCRE2: the pattern uses ${construct}` }
    } catch (retryError) {
      if (retryError instanceof RipgrepUsageError) throw pcre2Refused(error, construct, retryError.diagnostic)
      throw retryError
    }
  }
}

export const GrepTool = buildTool({
  name: GREP_TOOL_NAME,
  strict: true,
  straightQuoteInputs: ['pattern', 'path', 'glob'],
  maxResultSizeChars: 20_000,
  inputSchema,
  outputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async checkPermissions(input, context): Promise<ReturnType<typeof checkReadPermissionForTool>> {
    const permission = context.getAppState().toolPermissionContext
    if (input.glob) {
      const root = input.path ? expandPath(input.path) : getCwd()
      const literal = checkReadPermissionForTool({ name: 'Grep', getPath: () => expandPath(input.glob!, root) }, input, permission)
      if (literal.behavior === 'deny') return literal
      const verdicts = envFileTargetsInGlobField(input.glob).map(target =>
        checkReadPermissionForTool({ name: GREP_TOOL_NAME, getPath: () => join(root, target) }, input, permission))
      const refused = verdicts.find(verdict => verdict.behavior === 'deny') ?? verdicts.find(verdict => verdict.behavior !== 'allow')
      if (refused) return refused
    }
    return checkReadPermissionForTool(GrepTool, input, permission)
  },
  isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),
  userFacingName: () => 'Search',
  getToolUseSummary,
  getActivityDescription(input: Partial<Input> | undefined): string {
    return input?.pattern ? `Searching for ${input.pattern}` : 'Searching'
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
  async prompt({ tools }): Promise<string> {
    return getDescription(new Set(tools.map(tool => tool.name)))
  },
  async validateInput(input: Input) {
    if (input.path !== undefined) {
      if (hasNulByte(input.path)) {
        return { result: false as const, message: NUL_PATH_MESSAGE, errorCode: 1 }
      }
      if (windowsPathNeedsPermission(input.path)) return { result: true as const }
      const expanded = expandPath(input.path)
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
    const givenRoot = input.path !== undefined ? expandPath(input.path) : getCwd()
    const searchRoot = realSearchRoot(givenRoot)
    const permission = context.getAppState().toolPermissionContext
    const withholding = envFilesWithheld(input, permission, givenRoot)
    const args = await buildArgs(input, context, searchRoot, withholding)
    const offset = input.offset ?? 0

    const { answer, engine } = await answerWithPcre2Fallback(input.pattern, args, searchRoot, context.abortController.signal)
    const kept = withholding ? withholdEnvFileLines(answer.lines, mode, input['-n'] ?? true, permission, envFileCoverage(input.glob, searchRoot)) : { lines: answer.lines, withheld: undefined }
    const withheld = kept.withheld
    const lines = searchRoot === givenRoot ? kept.lines : kept.lines.map(line => respellRoot(line, searchRoot, givenRoot))
    const incomplete = answer.complete ? undefined : (answer.reason ?? 'the search did not finish')

    if (mode === 'content') {
      const { slice, start, appliedLimit, appliedOffset } = paginate(lines, input.head_limit, offset)
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
            const number = Number(m[2])
            const omitted = /^\[Omitted long (?:matching|context) line\]$/.test(line.slice(m[0].length))
            recordSeenLines(owner, file, generation, number, 1, omitted ? [{ line: number, visibleChars: 0 }] : [])
          }
          for (const [file, generation] of generations) if (generation !== null) context.nestedMemoryAttachmentTriggers?.add(file)
        } catch {
        }
      }
      const withContext = (input.context ?? input['-C'] ?? Math.max(input['-B'] ?? 0, input['-A'] ?? 0)) > 0
      const relativized = withContext
        ? relativizeContentLines(lines, start, slice.length)
        : slice.map(line => relativizePrefixed(line, 'first'))
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
          ...(engine !== undefined ? { engine } : {}),
          ...(withheld !== undefined ? { withheld } : {}),
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
          ...(engine !== undefined ? { engine } : {}),
          ...(withheld !== undefined ? { withheld } : {}),
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
        ...(engine !== undefined ? { engine } : {}),
        ...(withheld !== undefined ? { withheld } : {}),
      } satisfies Output,
    }
  },
  mapToolResultToToolResultBlockParam(data: Output, toolUseID: string) {
    const note = paginationNote(data.appliedLimit, data.appliedOffset)
    const incompleteNote = data.incomplete !== undefined ? `\n(INCOMPLETE SEARCH — ${data.incomplete})` : ''
    const engineNote = (data.engine !== undefined ? `\n(${data.engine})` : '') + (data.withheld !== undefined ? `\n(${data.withheld})` : '')
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
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: text + engineNote + incompleteNote }
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
