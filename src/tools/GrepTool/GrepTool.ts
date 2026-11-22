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
import { unbuilt, type Unbuilt } from '../../pi/holes.js'


const DEFAULT_HEAD_LIMIT = 250
const DEFAULT_PER_FILE_MATCHES = 25
const RANKED_CLOCK_MS = 20_000
const RANKED_CLOCK_REASON = 'the search timed out after 20 seconds — the walk did not finish, so this ranking is PARTIAL; narrow the path or the glob'

const VCS_EXCLUDED_DIRECTORIES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']

const inputSchema: Unbuilt = unbuilt('src/tools/GrepTool/GrepTool.ts:69')

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

const outputSchema: Unbuilt = unbuilt('src/tools/GrepTool/GrepTool.ts:150')

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

export const GrepTool: Unbuilt = unbuilt('src/tools/GrepTool/GrepTool.ts:635')
