import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import {
  splitCommand_DEPRECATED,
  splitListSegments,
  tryParseShellCommand,
  extractOutputRedirections,
} from '../../utils/permissions/decision/commandAnalysis.js'
import { LISTED_WORDS, formRuleFor, walkFlags, walkedRuleFor } from '../../utils/shell/readOnlyCommandValidation.js'
import { bashCommandIsSafe_DEPRECATED } from './bashSecurity.js'
import { isNormalizedGitCommand } from './bashPermissions.js'
import { PATH_EXTRACTORS, COMMAND_OPERATION_TYPE, type PathCommand } from './pathValidation.js'
import { isCurrentDirectoryBareGitRepo } from '../../utils/git.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { getCwd } from '../../utils/cwd.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getPlatform } from '../../utils/platform.js'
import { uncPathRisk, uncPathMessage } from '../../utils/permissions/uncPath.js'
import { containsWindowsDevicePath, WINDOWS_DEVICE_PATH_MESSAGE } from '../../utils/permissions/windowsPath.js'

const STDERR_TO_STDOUT = ' 2>&1'
const EXPANSION_FOLLOW = /[A-Za-z0-9_@*#?!$-]/
const GIT_ESCAPE = /\s(?:-c|--exec-path|--config-env)(?:\s|=)/

function wordsOf(tokens: readonly unknown[]): string[] | null {
  const words: string[] = []
  for (const token of tokens) {
    if (typeof token === 'string') words.push(token)
    else if (typeof token === 'object' && token !== null && (token as { op?: string }).op === 'glob') words.push((token as { pattern: string }).pattern)
    else return null
  }
  return words
}

function hasUnquotedExpansion(text: string): boolean {
  let quote: 'none' | 'single' | 'double' = 'none'
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (quote !== 'single' && ch === '\\') {
      i++
      continue
    }
    if (ch === "'" && quote !== 'double') {
      quote = quote === 'single' ? 'none' : 'single'
      continue
    }
    if (ch === '"' && quote !== 'single') {
      quote = quote === 'double' ? 'none' : 'double'
      continue
    }
    if (quote !== 'single' && ch === '$') {
      const next = text[i + 1]
      if (next !== undefined && next !== '{' && next !== '(' && EXPANSION_FOLLOW.test(next)) return true
    }
    if (quote === 'none' && (ch === '?' || ch === '*' || ch === '[' || ch === ']')) return true
  }
  return false
}

function walkedReadsOnly(text: string): boolean {
  const parse = tryParseShellCommand(text)
  if (!parse.success) return false
  const tokens = wordsOf(parse.tokens)
  if (tokens === null || tokens.length === 0) return false
  const rule = walkedRuleFor(tokens)
  if (rule === undefined || (rule.unixOnly && getPlatform() === 'windows')) return false
  const operands = tokens.slice(rule.words.length)
  if (operands.some(token => token.includes('$') || (token.includes('{') && (token.includes(',') || token.includes('..'))))) return false
  if (!walkFlags(tokens, rule.words.length, rule)) return false
  if (rule.whole !== undefined) {
    if (!rule.whole.test(text)) return false
  } else {
    if (text.includes('`')) return false
    if (rule.noNewline && /[\r\n]/.test(text)) return false
  }
  return rule.readsOnly === undefined || rule.readsOnly(operands, text)
}

function formReadsOnly(text: string): boolean {
  const rule = formRuleFor(text.split(/\s+/)[0] ?? '')
  if (rule?.form === undefined || !rule.form(text)) return false
  return !(/git/.test(text) && GIT_ESCAPE.test(text))
}

function partReadsOnly(part: string): boolean {
  let text = part.trim()
  if (text.endsWith(STDERR_TO_STDOUT)) text = text.slice(0, -STDERR_TO_STDOUT.length).trim()
  if (uncPathRisk(text).risky || containsWindowsDevicePath(text)) return false
  if (hasUnquotedExpansion(text)) return false
  return walkedReadsOnly(text) || formReadsOnly(text)
}

function listedWord(word: string): boolean {
  if (!LISTED_WORDS.has(word)) return false
  const rule = walkedRuleFor([word])
  return !(rule?.unixOnly && getPlatform() === 'windows')
}

const GIT_INTERNAL_CREATORS = new Set<PathCommand>(['mkdir', 'touch', 'mv', 'cp', 'tee', 'dd'])

function isGitInternalPath(path: string): boolean {
  const bare = path.replace(/^\.?\//, '')
  return bare === 'HEAD' || /^(?:objects|refs|hooks)(?:\/|$)/.test(bare)
}

function writesToGitInternalPath(command: string): boolean {
  for (const raw of splitCommand_DEPRECATED(command)) {
    const part = raw.trim()
    const parse = tryParseShellCommand(part)
    if (!parse.success) continue
    const tokens = parse.tokens.filter((token): token is string => typeof token === 'string')
    if (tokens.length === 0) continue
    const word = tokens[0] as string
    const paths: string[] = []
    if (word in COMMAND_OPERATION_TYPE) {
      const creator = word as PathCommand
      const operation = COMMAND_OPERATION_TYPE[creator]
      if ((operation === 'write' || operation === 'create') && GIT_INTERNAL_CREATORS.has(creator)) paths.push(...PATH_EXTRACTORS[creator](tokens.slice(1)))
    }
    paths.push(...extractOutputRedirections(part).redirections.map(redirection => redirection.target))
    if (paths.some(isGitInternalPath)) return true
  }
  return false
}

const BARE_REPO_GIT_GUARD_MESSAGE = 'This directory has bare-repository structure, so git commands here go through the permission gate'
const CD_GIT_GUARD_MESSAGE = 'A cd combined with git is not auto-allowed.'
const GIT_INTERNAL_WRITE_GUARD_MESSAGE = 'A git command combined with a git-internal write is not auto-allowed.'
const SANDBOXED_GIT_GUARD_MESSAGE = 'A sandboxed git command outside the original directory is not auto-allowed.'

function gitGuardMessage(command: string, parts: readonly string[], compoundCommandHasCd: boolean): string | null {
  if (!parts.some(part => isNormalizedGitCommand(part.trim()))) return null
  if (compoundCommandHasCd) return CD_GIT_GUARD_MESSAGE
  if (isCurrentDirectoryBareGitRepo()) return BARE_REPO_GIT_GUARD_MESSAGE
  if (writesToGitInternalPath(command)) return GIT_INTERNAL_WRITE_GUARD_MESSAGE
  if (SandboxManager.isSandboxingEnabled() && getCwd() !== getOriginalCwd()) return SANDBOXED_GIT_GUARD_MESSAGE
  return null
}

export type NotReadOnly = {
  kind: 'unparseable' | 'sandbox' | 'not-on-list' | 'form' | 'writes' | 'screen' | 'git-guard'
  part: string
  word?: string
  target?: string
  detail?: string
}

export type ReadOnlyVerdict = PermissionResult & { notReadOnly?: NotReadOnly }

const PART_WIDTH = 120

export function cutPart(text: string): string {
  const firstLine = text.split('\n')[0] ?? ''
  const line = firstLine.length > PART_WIDTH ? firstLine.slice(0, PART_WIDTH) : firstLine
  return line.length < text.length ? `${line}…` : line
}

function commandWordOf(part: string): string {
  const parse = tryParseShellCommand(part)
  const tokens = parse.success ? parse.tokens.filter((token): token is string => typeof token === 'string') : part.trim().split(/\s+/)
  return tokens.find(token => token !== '' && !/^[A-Za-z_]\w*=/.test(token)) ?? tokens[0] ?? ''
}

function describeNotReadOnly(command: string, compoundCommandHasCd: boolean, verdictMessage: string): NotReadOnly {
  if (!tryParseShellCommand(command).success) return { kind: 'unparseable', part: cutPart(command) }
  const parts = splitCommand_DEPRECATED(command).map(part => part.trim()).filter(part => part !== '')
  const written = splitListSegments(command)
  const partOf = (index: number, word: string): string => {
    const asWritten = written.length === parts.length ? written[index] : written.find(segment => commandWordOf(segment) === word)
    return cutPart(asWritten ?? (parts[index] as string))
  }
  const words = parts.map(commandWordOf)
  for (const [index, word] of words.entries()) {
    if (!listedWord(word)) return { kind: 'not-on-list', part: partOf(index, word), word }
  }
  for (const [index, part] of parts.entries()) {
    if (!partReadsOnly(part)) return { kind: 'form', part: partOf(index, words[index] as string), word: words[index] as string }
  }
  const target = extractOutputRedirections(command).redirections.find(redirection => redirection.target !== '/dev/null')?.target
  if (target !== undefined) return { kind: 'writes', part: cutPart(command), target }
  const screened = bashCommandIsSafe_DEPRECATED(command)
  if (screened.behavior === 'ask') return { kind: 'screen', part: cutPart(command), detail: screened.message }
  for (const [index, part] of parts.entries()) {
    const screenedPart = bashCommandIsSafe_DEPRECATED(part)
    if (screenedPart.behavior === 'ask') return { kind: 'screen', part: partOf(index, words[index] as string), detail: screenedPart.message }
  }
  const guard = gitGuardMessage(command, parts, compoundCommandHasCd)
  if (guard !== null) return { kind: 'git-guard', part: cutPart(command), detail: guard }
  return { kind: 'screen', part: cutPart(command), detail: verdictMessage }
}

export function notReadOnlyClause(reason: NotReadOnly): string {
  switch (reason.kind) {
    case 'not-on-list':
      return `\`${reason.word}\` is not a command Mercury can verify as read-only`
    case 'form':
      return `it is not a read-only form of \`${reason.word}\``
    case 'writes':
      return `it writes to \`${reason.target}\``
    case 'screen':
      return `the command could not be verified as read-only — ${reason.detail ?? ''}`
    case 'git-guard':
      return reason.detail ?? ''
    case 'sandbox':
      return 'it leaves the sandbox or carries a simulated sed edit'
    case 'unparseable':
      return 'the command could not be parsed, so it cannot be verified as read-only'
  }
}

function commandChangesDirectory(command: string): boolean {
  return splitCommand_DEPRECATED(command).some(part => /^\s*(?:cd|pushd|popd)\b/.test(part))
}

export function describeBashNotReadOnly(command: string): NotReadOnly | null {
  return checkReadOnlyConstraints({ command }, commandChangesDirectory(command)).notReadOnly ?? null
}

export function checkReadOnlyConstraints(input: { command: string }, compoundCommandHasCd: boolean): ReadOnlyVerdict {
  const verdict = readOnlyVerdict(input, compoundCommandHasCd)
  if (verdict.behavior === 'allow') return verdict
  return { ...verdict, notReadOnly: describeNotReadOnly(input.command, compoundCommandHasCd, verdict.message) }
}

function partsRefusal(parts: readonly string[]): PermissionResult | null {
  for (const raw of parts) {
    const part = raw.trim()
    if (bashCommandIsSafe_DEPRECATED(part).behavior !== 'passthrough') return { behavior: 'passthrough', message: 'A subcommand was flagged by the security screen.' }
    if (!partReadsOnly(part)) return { behavior: 'passthrough', message: 'A subcommand is not provably read-only.' }
  }
  return null
}

function readOnlyVerdict(input: { command: string }, compoundCommandHasCd: boolean): PermissionResult {
  const command = input.command
  if (!tryParseShellCommand(command).success) return { behavior: 'passthrough', message: 'The command cannot be parsed; it needs further checks.' }
  if (bashCommandIsSafe_DEPRECATED(command).behavior !== 'passthrough') return { behavior: 'passthrough', message: 'The security screen flagged the command.' }
  const remote = uncPathRisk(command)
  if (remote.risky) return { behavior: 'ask', message: uncPathMessage(command, remote) }
  if (containsWindowsDevicePath(command)) return { behavior: 'ask', message: WINDOWS_DEVICE_PATH_MESSAGE }
  const parts = splitCommand_DEPRECATED(command)
  const guard = gitGuardMessage(command, parts, compoundCommandHasCd)
  if (guard !== null) return { behavior: 'passthrough', message: guard }
  return partsRefusal(parts) ?? { behavior: 'allow', updatedInput: input }
}
