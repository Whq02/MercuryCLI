import { realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'

import picomatch from 'picomatch'
import { z } from 'zod/v4'

import { buildTool, type CanUseToolFn, type Tool, type ToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import { isRemotePath } from '../../utils/remoteFiles/target.js'
import { anchorPatchEnabled } from '../../services/changeTransaction/anchorPatch.js'
import { staleEditRecoveryEnabled } from '../../services/changeTransaction/stalePatchRecovery.js'
import { fileGeneration, recordSeenLines } from '../../services/changeTransaction/seenLines.js'
import { ownerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import { discoveryPoolWidth, mapWithConcurrency } from '../../utils/concurrency.js'
import {
  LEFT_DOUBLE_CURLY_QUOTE,
  LEFT_SINGLE_CURLY_QUOTE,
  RIGHT_DOUBLE_CURLY_QUOTE,
  RIGHT_SINGLE_CURLY_QUOTE,
} from '../../utils/curlyQuotes.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import { formatFileSize } from '../../utils/format.js'
import { globSearchDepth, resolveSearchGlob, splitGrepGlobField } from '../../utils/globPattern.js'
import {
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  suggestPathUnderCwd,
} from '../../utils/file.js'
import { controlCharacterPathRefusal, expandPath, toRelativePath } from '../../utils/path.js'
import {
  envFileReadAsk,
  envFileTargetsInGlob,
  getFileReadIgnorePatterns,
  isProjectEnvFileName,
  normalizePatternsToPath,
  readDenialFilter,
} from '../../utils/permissions/filesystem.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import { modeBypassesPermissions } from '../../utils/permissions/PermissionMode.js'
import { windowsPathNeedsPermission } from '../../utils/permissions/windowsPath.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { ripGrepAnswer, RipgrepTimeoutError, RipgrepUsageError, type RipgrepAnswer } from '../../utils/ripgrep.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { plural } from '../../utils/stringUtils.js'
import { getDescription, GREP_TOOL_NAME, rankedModeEnabled } from './prompt.js'
import { discoveryArgs, documentTypeArgs, MAX_DOCUMENTS, searchDocuments } from './documentSearch.js'
import { rankedRefusal, rankedScope, rankedSearch, renderRanked, type RankedPass } from './rankedSearch.js'
import { isSearchableDocument, SEARCHABLE_DOCUMENT_EXTENSIONS } from '../shared/documentText.js'
import {
  getToolUseSummary,
  isResultTruncated,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
} from './UI.js'
import { passedOver } from '../../utils/passedOver.js'


const DEFAULT_HEAD_LIMIT = 250
const DEFAULT_PER_FILE_MATCHES = 25
const RANKED_CLOCK_MS = 20_000
const RANKED_CLOCK_REASON = 'the search timed out after 20 seconds — the walk did not finish, so this ranking is PARTIAL; narrow the path or the glob'

const VCS_EXCLUDED_DIRECTORIES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']

const inputSchema = z.strictObject({
  pattern: z
    .string()
    .describe('The ripgrep regular expression to search for; lookaround and backreferences fall back to PCRE2'),
  path: z
    .string()
    .optional()
    .describe('The file or directory to search; the current working directory when omitted.'),
  glob: z
    .string()
    .optional()
    .describe('Search only files matching this glob (rg --glob)'),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .describe(
      'What comes back: "files_with_matches" (the default) lists the paths that match, declarations and documents among them; "content" prints each matching line with its path — the mode for reading or counting call sites; "count" tallies matches per file.',
    ),
  '-B': semanticNumber(z.number().optional()).describe('Context lines printed before each hit (rg -B; "content" mode only).'),
  '-A': semanticNumber(z.number().optional()).describe('Context lines printed after each hit (rg -A; "content" mode only).'),
  '-C': semanticNumber(z.number().optional()).describe('Context lines printed both sides of each hit (rg -C; "content" mode only).'),
  context: semanticNumber(z.number().optional()).describe('Same as -C.'),
  '-n': semanticBoolean(z.boolean().optional()).describe('Prefix output with line numbers (rg -n; "content" mode only). On by default.'),
  '-i': semanticBoolean(z.boolean().optional()).describe('Match case-insensitively (rg -i)'),
  type: z.string().optional().describe('Search only one file type (rg --type): js, py, rust, go and the like.'),
  head_limit: semanticNumber(z.number().optional()).describe(
    'Cap the output at the first N lines/entries (default 250); applies in every output mode; 0 lifts the cap.',
  ),
  offset: semanticNumber(z.number().optional()).describe(
    'Skip this many lines/entries before the head_limit window applies (paging). Default 0.',
  ),
  multiline: semanticBoolean(z.boolean().optional()).describe(
    'Let patterns span line boundaries, with . matching newlines (rg -U --multiline-dotall). Off by default.',
  ),
  literal: semanticBoolean(z.boolean().optional()).describe(
    'Match the pattern as exact text, not a regex (rg -F). Off by default.',
  ),
})

const rankedInputSchema = inputSchema.extend({
  output_mode: z
    .enum(['content', 'files_with_matches', 'count', 'ranked'])
    .optional()
    .describe(
      'What comes back: "files_with_matches" (the default) lists the paths that match, declarations and documents among them; "content" prints each matching line with its path — the mode for reading or counting call sites; "count" tallies matches per file; "ranked" reads pattern as plain words, not a regex, and returns the files and line ranges that hold them most densely — the mode for finding where a behaviour is implemented before its names are known.',
    ),
})

type Input = z.infer<typeof rankedInputSchema>

type Output = {
  mode?: 'content' | 'files_with_matches' | 'count'
  numFiles: number
  filenames: string[]
  ranked?: string
  content?: string
  numLines?: number
  numMatches?: number
  appliedLimit?: number
  appliedOffset?: number
  incomplete?: string
  engine?: string
  withheld?: string
  cappedFiles?: string[]
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
  cappedFiles: z.array(z.string()).optional(),
})

const rankedOutputSchema = outputSchema.extend({ ranked: z.string().optional() })

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
  preserveNull = false,
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
    kept.push(mode === 'files_with_matches' || preserveNull ? raw : restoreSeparator(file, raw.slice(nul + 1), numbered))
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

function withoutDeniedFiles(lines: string[], mode: OutputMode, denied: (file: string) => boolean): string[] {
  const verdicts = new Map<string, boolean>()
  const kept: string[] = []
  for (const line of lines) {
    if (mode === 'content' && line === '--') {
      if (kept.length > 0 && kept[kept.length - 1] !== '--') kept.push(line)
      continue
    }
    const nul = line.indexOf('\0')
    const file = mode === 'files_with_matches' ? line : nul !== -1 ? line.slice(0, nul) : mode === 'count' && /:\d+$/.test(line) ? line.slice(0, line.lastIndexOf(':')) : null
    if (file !== null) {
      let verdict = verdicts.get(file)
      if (verdict === undefined) verdicts.set(file, (verdict = denied(file)))
      if (verdict) continue
    }
    kept.push(line)
  }
  if (mode === 'content' && kept[kept.length - 1] === '--') kept.pop()
  return kept
}

function effectiveLimit(headLimit: number | undefined): number | undefined {
  if (headLimit === 0) return undefined
  return headLimit ?? DEFAULT_HEAD_LIMIT
}

function pageWord(appliedOffset?: number): string {
  return appliedOffset !== undefined && appliedOffset > 0 ? 'This page' : 'First page'
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
  return next === '' || next === '/' || next === '\\' || next === ':' || next === '-' || next === '\0' ? `${given}${line.slice(real.length)}` : line
}

async function buildArgs(input: Input, context: ToolUseContext, searchRoot: string, withholdEnvFiles: boolean): Promise<string[]> {
  const mode = input.output_mode ?? 'files_with_matches'
  const args: string[] = ['--hidden', ...documentTypeArgs()]
  for (const dir of VCS_EXCLUDED_DIRECTORIES) {
    args.push('--glob', `!${dir}`)
  }
  args.push('--max-columns', '500')

  if (input.multiline) args.push('-U', '--multiline-dotall')
  if (input.literal) args.push('-F')
  if (input['-i']) args.push('-i')
  if (mode === 'files_with_matches') args.push('-l')
  if (mode === 'count') args.push('-c')
  if (mode === 'content' || (withholdEnvFiles && mode === 'count')) args.push('--null')
  if (mode === 'content') args.push('-n')
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
    const patterns = splitGrepGlobField(input.glob).flatMap(pattern => resolveSearchGlob(pattern, searchRoot))
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
  for (const pattern of normalizePatternsToPath(ignoreByRoot, searchRoot)) {
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

function rankedDocumentRefusal(path: string): string {
  return `output_mode "ranked" ranks text files, and ${path} is a document: search its text with a pattern in another mode.`
}

async function rankedCall(input: Input, context: ToolUseContext, searchRoot: string, givenRoot: string, withholding: boolean): Promise<Output> {
  const refusal = isSearchableDocument(searchRoot) ? rankedDocumentRefusal(input.path ?? givenRoot) : rankedRefusal(input.pattern)
  if (refusal !== null) throw new Error(refusal)
  const signal = context.abortController.signal
  const permission = context.getAppState().toolPermissionContext
  const grepArgs = await buildArgs({ ...input, pattern: 'x', output_mode: 'files_with_matches', multiline: false, literal: false, '-i': false }, context, searchRoot, withholding)
  const scope = [...rankedScope(grepArgs), ...SEARCHABLE_DOCUMENT_EXTENSIONS.flatMap(ext => ['--iglob', `!*.${ext}`])]
  const cwd = (await stat(searchRoot)).isDirectory() ? searchRoot : dirname(searchRoot)
  const deadline = Date.now() + RANKED_CLOCK_MS
  const run = async (args: string[], target: string): Promise<RankedPass> => {
    signal.throwIfAborted()
    const left = deadline - Date.now()
    if (left <= 0) return { lines: [], complete: false, reason: RANKED_CLOCK_REASON }
    try {
      const pass = await ripGrepAnswer(args, target, signal, { cwd, timeoutMs: left })
      signal.throwIfAborted()
      return pass.complete || Date.now() < deadline ? pass : { ...pass, reason: RANKED_CLOCK_REASON }
    } catch (error) {
      if (error instanceof RipgrepTimeoutError) return { lines: [], complete: false, reason: RANKED_CLOCK_REASON }
      throw error
    }
  }
  let withheld: string | undefined
  const denied = readDenialFilter(permission, searchRoot)
  const withhold = (files: string[]): string[] => {
    const readable = files.filter(file => !denied(file))
    if (!withholding) return readable
    const kept = withholdEnvFileLines(readable, 'files_with_matches', true, permission, envFileCoverage(input.glob, searchRoot))
    withheld = kept.withheld
    return kept.lines
  }
  const answer = await rankedSearch({ pattern: input.pattern, root: searchRoot, scope, run, withhold })
  const shown = renderRanked(answer, file => toRelativePath(searchRoot === givenRoot ? file : respellRoot(file, searchRoot, givenRoot)))
  return {
    numFiles: shown.rows.length,
    filenames: shown.rows,
    ranked: shown.text,
    ...(answer.incomplete !== undefined ? { incomplete: answer.incomplete } : {}),
    ...(withheld !== undefined ? { withheld } : {}),
  }
}

function grepToolItself(): Tool & { call(input: Input, context: ToolUseContext): Promise<{ data: Output }> } {
  return GrepTool
}

const readElsewhere = new WeakMap<object, string>()

async function searchElsewhere(
  input: Input,
  context: ToolUseContext,
  canUseTool?: CanUseToolFn,
  parentMessage?: AssistantMessage,
): Promise<{ data: Output }> {
  const bridge = await import('../../services/remoteFiles/bridge.js')
  const mirror = await bridge.remoteMirror(
    GREP_TOOL_NAME,
    input.path!,
    context,
    typeof canUseTool === 'function' && parentMessage !== undefined
      ? path => canUseTool(grepToolItself(), { ...input, path }, context, parentMessage, `${context.toolUseId ?? 'grep'}-resolved`)
      : null,
    0,
    input.type !== undefined || !input.glob ? null : bridge.remoteSearchNames(splitGrepGlobField(input.glob)),
  )
  try {
    const inner = { ...context, getAppState: () => ({ ...context.getAppState(), toolPermissionContext: mirror.rules }) } as ToolUseContext
    const local = { ...input, path: mirror.dir }
    const root = realSearchRoot(mirror.dir)
    const cwd = (await stat(root)).isDirectory() ? root : dirname(root)
    const pattern = input.literal ? input.pattern : quoteTolerantPattern(input.pattern)
    const listed = await ripGrepAnswer(discoveryArgs(await buildArgs(local, inner, root, false), pattern), root, context.abortController.signal, { cwd })
    const files = listed.lines.map(path => (isAbsolute(path) ? path : join(cwd, path)))
    const documents = new Set(files.filter(isSearchableDocument).sort().slice(0, MAX_DOCUMENTS))
    const matched =
      input.output_mode === 'ranked'
        ? null
        : await mirror.matching({ ignoreCase: input['-i'] === true, literal: input.literal === true, multiline: input.multiline === true }, pattern, files.filter(file => !isSearchableDocument(file)))
    const pulled = await mirror.pull(matched === null ? files : [...matched, ...documents], cwd === root ? documents : new Set([...documents, root]))
    const answer = await grepToolItself().call(local, inner)
    const data = mirror.rename(answer.data)
    const from = `read ${pulled.files} ${plural(pulled.files, 'file')}, ${formatFileSize(pulled.bytes).replace(/(\d)([KMGT]B)$/, '$1 $2')}, from ${mirror.host}`
    readElsewhere.set(data, mirror.ripgrep ? from : `${from}: it has no ripgrep; with rg installed there the search runs on the host`)
    return { data }
  } finally {
    mirror.close()
  }
}

type PageResult<T> = {
  items: T[]
  start: number
  appliedLimit?: number
  appliedOffset?: number
}

function paginate<T>(items: readonly T[], headLimit: number | undefined, offset: number | undefined): PageResult<T> {
  const limit = effectiveLimit(headLimit)
  const rawOffset = offset !== undefined && offset > 0 ? offset : 0
  const start = Math.min(rawOffset, items.length)
  const appliedOffset = rawOffset > 0 ? rawOffset : undefined
  const rest = items.slice(start)
  if (limit !== undefined && rest.length > limit) {
    return {
      items: rest.slice(0, limit),
      start,
      appliedLimit: limit,
      ...(appliedOffset !== undefined ? { appliedOffset } : {}),
    }
  }
  return {
    items: rest,
    start,
    ...(appliedOffset !== undefined ? { appliedOffset } : {}),
  }
}

function capContentMatches(
  lines: readonly string[],
  afterSpan: number,
  cap: number,
): { lines: string[]; capped: Set<string> } {
  const kept: string[] = []
  const matchesByFile = new Map<string, number>()
  const lastShownMatchLine = new Map<string, number>()
  const capped = new Set<string>()
  let pendingSeparator = false
  const push = (line: string): void => {
    if (pendingSeparator) {
      kept.push('--')
      pendingSeparator = false
    }
    kept.push(line)
  }
  for (const line of lines) {
    if (line === '--') {
      if (kept.length > 0) pendingSeparator = true
      continue
    }
    const nul = line.indexOf('\0')
    if (nul === -1) {
      push(line)
      continue
    }
    const file = line.slice(0, nul)
    const rest = line.slice(nul + 1)
    const parsed = /^(\d+)([:-])/.exec(rest)
    if (!parsed) {
      push(line)
      continue
    }
    const lineNum = Number(parsed[1])
    const kind = parsed[2]
    if (kind === ':') {
      const count = (matchesByFile.get(file) ?? 0) + 1
      matchesByFile.set(file, count)
      if (count <= cap) {
        lastShownMatchLine.set(file, lineNum)
        push(line)
      } else {
        capped.add(file)
      }
      continue
    }
    const count = matchesByFile.get(file) ?? 0
    if (count < cap) {
      push(line)
      continue
    }
    const last = lastShownMatchLine.get(file)
    if (last !== undefined && lineNum > last && lineNum <= last + afterSpan) {
      push(line)
    }
  }
  return { lines: kept, capped }
}

function recordVisibleMatches(
  pageItems: readonly string[],
  rawFiles: readonly (string | null)[],
  pageStart: number,
  context: ToolUseContext,
): void {
  try {
    const owner = ownerFromToolUseContext(context)
    const generations = new Map<string, string | null>()
    for (let index = 0; index < pageItems.length; index++) {
      const line = pageItems[index]!
      const rawFile = rawFiles[pageStart + index] ?? null
      let file: string
      let rest: string
      if (rawFile !== null && line.startsWith(`${rawFile}:`)) {
        file = rawFile
        rest = line.slice(rawFile.length)
      } else {
        const split = prefixSplitIndex(line, 'first')
        if (split <= 0) continue
        file = line.slice(0, split)
        rest = line.slice(split)
      }
      if (isSearchableDocument(file)) continue
      const match = /^:(\d+):([\s\S]*)$/.exec(rest)
      if (!match) continue
      const lineNum = Number(match[1])
      if (lineNum < 1) continue
      let generation = generations.get(file)
      if (generation === undefined) {
        generation = fileGeneration(file)
        generations.set(file, generation)
        if (generation !== null) {
          context.nestedMemoryAttachmentTriggers?.add(file)
        }
      }
      if (generation === null) continue
      const text = match[2]!
      const omitted = text === '[Omitted long matching line]' || text === '[Omitted long context line]'
      recordSeenLines(owner, file, generation, lineNum, 1, omitted ? [{ line: lineNum, visibleChars: 0 }] : undefined)
    }
  } catch (error) {
    passedOver(error)
  }
}

export const GrepTool = buildTool({
  name: GREP_TOOL_NAME,
  userFacingName: () => 'Search',
  strict: true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: 20_000,
  straightQuoteInputs: ['pattern', 'path', 'glob'],
  get inputSchema() {
    return rankedModeEnabled() ? rankedInputSchema : inputSchema
  },
  get outputSchema() {
    return rankedModeEnabled() ? rankedOutputSchema : outputSchema
  },
  isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),
  getToolUseSummary,
  isResultTruncated,
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  getActivityDescription(input?: Partial<Input>) {
    return input?.pattern ? `Searching for ${input.pattern}` : 'Searching'
  },
  getPath(input?: Partial<Input>) {
    return input?.path || getCwd()
  },
  preparePermissionMatcher(input: Input) {
    return (rulePattern: string) => matchWildcardPattern(rulePattern, input.pattern)
  },
  async description() {
    return getDescription()
  },
  async prompt(options?: { tools?: readonly Tool[] }) {
    return getDescription(options?.tools ? new Set(options.tools.map(tool => tool.name)) : null)
  },
  async checkPermissions(input: Input, context: ToolUseContext) {
    if (input.path && isRemotePath(input.path)) {
      const { remotePermission } = await import('../../services/remoteFiles/bridge.js')
      return remotePermission(GREP_TOOL_NAME, input.path, null, input, context, 'read')
    }
    const permissionContext = context.getAppState().toolPermissionContext
    const base = input.path ? expandPath(input.path) : getCwd()
    if (input.glob) {
      const literalTarget = expandPath(input.glob, base)
      const literalDecision = checkReadPermissionForTool(
        { name: GREP_TOOL_NAME, getPath: () => literalTarget },
        input,
        permissionContext,
      )
      if (literalDecision.behavior === 'deny') return literalDecision
      const envTargets = envFileTargetsInGlobField(input.glob)
      let firstNonAllow: ReturnType<typeof checkReadPermissionForTool> | null = null
      for (const target of envTargets) {
        const resolved = expandPath(target, base)
        const decision = checkReadPermissionForTool(
          { name: GREP_TOOL_NAME, getPath: () => resolved },
          input,
          permissionContext,
        )
        if (decision.behavior === 'deny') return decision
        if (decision.behavior !== 'allow' && firstNonAllow === null) {
          firstNonAllow = decision
        }
      }
      if (firstNonAllow !== null) return firstNonAllow
    }
    return checkReadPermissionForTool(grepToolItself(), input, permissionContext)
  },
  async validateInput(input: Input, context: ToolUseContext) {
    if (input.output_mode === 'ranked') {
      const targetPath = input.path ? (isRemotePath(input.path) ? input.path : expandPath(input.path)) : getCwd()
      const refusal = isSearchableDocument(targetPath)
        ? rankedDocumentRefusal(input.path ?? targetPath)
        : rankedRefusal(input.pattern)
      if (refusal !== null) {
        return { result: false, message: refusal, errorCode: 1 }
      }
    }
    if (input.path) {
      const control = controlCharacterPathRefusal(input.path)
      if (control !== null) {
        return { result: false, message: control, errorCode: 1 }
      }
      if (isRemotePath(input.path)) {
        const { remoteValidation } = await import('../../services/remoteFiles/bridge.js')
        return remoteValidation(input.path, null, 'read', 'Searching', context)
      }
      if (windowsPathNeedsPermission(input.path)) {
        return { result: true }
      }
      const expanded = expandPath(input.path)
      try {
        await stat(expanded)
      } catch (error) {
        if (isENOENT(error)) {
          let suggestion: string | undefined
          try {
            suggestion = await suggestPathUnderCwd(input.path)
          } catch {
            suggestion = undefined
          }
          if (!suggestion) {
            suggestion = findSimilarFile(expanded)
          }
          const hint = suggestion ? ` Did you mean ${suggestion}?` : ''
          return {
            result: false,
            message: `Path does not exist: ${input.path}. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.${hint}`,
            errorCode: 1,
          }
        }
        throw error
      }
    }
    return { result: true }
  },
  async call(
    input: Input,
    context: ToolUseContext,
    canUseTool?: CanUseToolFn,
    parentMessage?: AssistantMessage,
  ): Promise<{ data: Output }> {
    if (input.path && isRemotePath(input.path)) {
      return searchElsewhere(input, context, canUseTool, parentMessage)
    }
    const givenRoot = input.path ? expandPath(input.path) : getCwd()
    const searchRoot = realSearchRoot(givenRoot)
    const mode = input.output_mode ?? 'files_with_matches'
    const permission = context.getAppState().toolPermissionContext
    const withholding = envFilesWithheld(input, permission, givenRoot)
    if (mode === 'ranked') {
      return { data: await rankedCall(input, context, searchRoot, givenRoot, withholding) }
    }
    const signal = context.abortController.signal
    const args = await buildArgs(input, context, searchRoot, withholding)
    const searchPattern = input.literal ? input.pattern : quoteTolerantPattern(input.pattern)
    const directDocument = isSearchableDocument(searchRoot)
    const nativeArgs = [...args, ...SEARCHABLE_DOCUMENT_EXTENSIONS.flatMap(ext => ['--iglob', `!*.${ext}`])]
    const native = directDocument
      ? { answer: { lines: [] as string[], complete: true } as RipgrepAnswer, engine: undefined as string | undefined }
      : await answerWithPcre2Fallback(input.pattern, nativeArgs, searchRoot, signal)
    let engine = native.engine
    const docs = await searchDocuments({
      root: searchRoot,
      args,
      pattern: searchPattern,
      mode,
      permission,
      signal,
      search: async (docArgs, docPath) => {
        const result = await answerWithPcre2Fallback(input.pattern, docArgs, docPath, signal)
        if (engine === undefined && result.engine !== undefined) engine = result.engine
        return result
      },
    })
    const incomplete = native.answer.complete ? undefined : (native.answer.reason ?? 'the search did not finish')
    const combined = [...native.answer.lines, ...docs.lines]
    const denied = readDenialFilter(permission, searchRoot)
    const readable = withoutDeniedFiles(combined, mode, denied)
    const numbered = input['-n'] !== false
    let lines: string[]
    let envWithheld: string | undefined
    if (withholding) {
      const filtered = withholdEnvFileLines(
        readable,
        mode,
        numbered,
        permission,
        envFileCoverage(input.glob, searchRoot),
        mode === 'content',
      )
      lines = filtered.lines
      envWithheld = filtered.withheld
    } else {
      lines = readable
    }
    const noticeParts = [envWithheld, docs.note].filter((part): part is string => part !== undefined && part !== '')
    const withheld = noticeParts.length > 0 ? noticeParts.join(' ') : undefined
    if (searchRoot !== givenRoot) {
      lines = lines.map(line => respellRoot(line, searchRoot, givenRoot))
    }
    const tail = {
      ...(incomplete !== undefined ? { incomplete } : {}),
      ...(engine !== undefined ? { engine } : {}),
      ...(withheld !== undefined ? { withheld } : {}),
    }
    if (mode === 'content') {
      const isDirectory = (await stat(searchRoot)).isDirectory()
      const afterSpan = input.context ?? input['-C'] ?? input['-A'] ?? 0
      const cappedResult =
        input.head_limit === undefined && isDirectory
          ? capContentMatches(lines, afterSpan, DEFAULT_PER_FILE_MATCHES)
          : { lines, capped: new Set<string>() }
      const rawFiles: (string | null)[] = []
      const formattedLines: string[] = []
      for (const line of cappedResult.lines) {
        const nul = line.indexOf('\0')
        if (nul === -1) {
          rawFiles.push(null)
          formattedLines.push(line)
        } else {
          const file = line.slice(0, nul)
          rawFiles.push(file)
          formattedLines.push(restoreSeparator(file, line.slice(nul + 1), numbered))
        }
      }
      const page = paginate(formattedLines, input.head_limit, input.offset)
      const contextSpan = input.context ?? input['-C'] ?? Math.max(input['-B'] ?? 0, input['-A'] ?? 0)
      const visibleLines =
        contextSpan > 0
          ? relativizeContentLines(formattedLines, page.start, page.items.length)
          : page.items.map(line => relativizePrefixed(line, 'first'))
      const cappedFiles: string[] = []
      if (cappedResult.capped.size > 0) {
        const seen = new Set<string>()
        for (let index = page.start; index < page.start + page.items.length; index++) {
          const file = rawFiles[index]
          if (file !== null && cappedResult.capped.has(file) && !seen.has(file)) {
            seen.add(file)
            cappedFiles.push(toRelativePath(file))
          }
        }
      }
      if (numbered && (anchorPatchEnabled() || staleEditRecoveryEnabled())) {
        recordVisibleMatches(page.items, rawFiles, page.start, context)
      }
      return {
        data: {
          mode: 'content',
          numFiles: 0,
          filenames: [],
          content: visibleLines.join('\n'),
          numLines: visibleLines.length,
          ...(cappedFiles.length > 0 ? { cappedFiles } : {}),
          ...(page.appliedLimit !== undefined ? { appliedLimit: page.appliedLimit } : {}),
          ...(page.appliedOffset !== undefined ? { appliedOffset: page.appliedOffset } : {}),
          ...tail,
        },
      }
    }
    if (mode === 'count') {
      const page = paginate(lines, input.head_limit, input.offset)
      let numMatches = 0
      let numFiles = 0
      const rendered: string[] = []
      for (const line of page.items) {
        if (/^\d+$/.test(line)) {
          numMatches += Number(line)
          numFiles++
          rendered.push(line)
          continue
        }
        const split = prefixSplitIndex(line, 'last')
        if (split !== -1) {
          const countText = line.slice(split + 1)
          if (/^\d+$/.test(countText)) {
            numMatches += Number(countText)
            numFiles++
            rendered.push(`${toRelativePath(line.slice(0, split))}:${countText}`)
            continue
          }
        }
        rendered.push(line)
      }
      return {
        data: {
          mode: 'count',
          numFiles,
          filenames: [],
          content: rendered.join('\n'),
          numMatches,
          ...(page.appliedLimit !== undefined ? { appliedLimit: page.appliedLimit } : {}),
          ...(page.appliedOffset !== undefined ? { appliedOffset: page.appliedOffset } : {}),
          ...tail,
        },
      }
    }
    let sorted: string[]
    if (process.env.NODE_ENV === 'test') {
      sorted = [...lines].sort()
    } else {
      const withTimes = await mapWithConcurrency(lines, discoveryPoolWidth(), async file => {
        try {
          const info = await stat(file)
          return { file, mtimeMs: info.mtimeMs }
        } catch {
          return { file, mtimeMs: 0 }
        }
      })
      withTimes.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
      sorted = withTimes.map(entry => entry.file)
    }
    const page = paginate(sorted, input.head_limit, input.offset)
    const filenames = page.items.map(file => toRelativePath(file))
    return {
      data: {
        mode: 'files_with_matches',
        numFiles: filenames.length,
        filenames,
        ...(page.appliedLimit !== undefined ? { appliedLimit: page.appliedLimit } : {}),
        ...(page.appliedOffset !== undefined ? { appliedOffset: page.appliedOffset } : {}),
        ...tail,
      },
    }
  },
  extractSearchText(output: Output) {
    if (output.mode === 'content') return output.content ?? ''
    return output.filenames.join('\n')
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    const note = paginationNote(output.appliedLimit, output.appliedOffset)
    let text: string
    if (output.ranked !== undefined) {
      text = output.ranked
    } else if (output.mode === 'content') {
      const trimmed = note.trim()
      text = output.content ? (trimmed ? `${output.content}\n${trimmed}` : output.content) : 'No matches found'
      if (output.cappedFiles && output.cappedFiles.length > 0) {
        text += `\nMore than ${DEFAULT_PER_FILE_MATCHES} matches in ${output.cappedFiles.join(', ')}; pass path: ${JSON.stringify(output.cappedFiles[0])} to see that file, or head_limit: 0 for all matches.`
      }
    } else if (output.mode === 'count') {
      const body = output.content || 'No matches found'
      const matches = output.numMatches ?? 0
      const files = output.numFiles
      const summary = `${matches} ${plural(matches, 'match', 'matches')} across ${files} ${plural(files, 'file')}`
      const countLine =
        output.appliedLimit !== undefined
          ? `${pageWord(output.appliedOffset)}: ${summary}; more exist${note}`
          : `${summary}${note}`
      text = `${body}\n${countLine}`
    } else {
      if (output.numFiles === 0) {
        text = 'No files found'
      } else {
        const files = output.numFiles
        const header =
          output.appliedLimit !== undefined
            ? `${pageWord(output.appliedOffset)}: ${files} ${plural(files, 'file')}; more exist${note}`
            : `Found ${files} ${plural(files, 'file')}${note}`
        text = `${header}\n${output.filenames.join('\n')}`
      }
    }
    if (output.engine !== undefined) {
      text += `\n(${output.engine})`
    }
    if (output.withheld !== undefined) {
      text += `\n(${output.withheld})`
    }
    const remote = readElsewhere.get(output)
    if (remote !== undefined) {
      text += `\n(${remote})`
    }
    if (output.incomplete !== undefined) {
      text += `\n(INCOMPLETE SEARCH — ${output.incomplete})`
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: text,
    }
  },
})
