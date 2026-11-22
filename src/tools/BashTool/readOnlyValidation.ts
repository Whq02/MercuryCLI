import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import {
  parseForSecurity,
  extractShellCScript,
  prepareShellCScripts,
  shellCCommands,
  SHELL_C_MAX_DEPTH,
  withBashParseScope,
  retainPreparedCommand,
  preparedSecurityParse,
  checkSemantics,
  shellCommandText,
  WILDCARD_REASON,
  type ParseForSecurityResult,
  type SimpleCommand,
} from '../../utils/permissions/decision/commandAnalysis.js'
import { LISTED_WORDS, formRuleFor, walkFlags, walkedRuleFor } from '../../utils/shell/readOnlyCommandValidation.js'
import { PATH_EXTRACTORS, COMMAND_OPERATION_TYPE, type PathCommand } from './pathValidation.js'
import { isCurrentDirectoryBareGitRepo } from '../../utils/git.js'
import { resolveShellCwd } from '../../utils/Shell.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getPlatform } from '../../utils/platform.js'
import { uncPathRisk, uncPathMessage } from '../../utils/permissions/uncPath.js'
import { containsWindowsDevicePath, WINDOWS_DEVICE_PATH_MESSAGE } from '../../utils/permissions/windowsPath.js'
import { notBuilt } from '../../pi/holes.js'

const GIT_INTERNAL_CREATORS = new Set<PathCommand>(['mkdir', 'touch', 'mv', 'cp', 'tee', 'dd'])
const OUTPUT_OPERATORS = new Set(['>', '>>', '>|', '&>', '&>>', '>&'])

export type NotReadOnly = {
  kind: 'unparseable' | 'simulated-edit' | 'not-on-list' | 'form' | 'writes' | 'screen' | 'git-guard'
  part: string
  word?: string
  target?: string
  detail?: string
}

type ReadOnlyVerdict = PermissionResult & { notReadOnly?: NotReadOnly }
const PART_WIDTH = 120
type PreparedRead = { root: unknown; command: string; cwd: string; originalCwd: string; platform: string; bare: ReturnType<typeof isCurrentDirectoryBareGitRepo>; verdict: ReadOnlyVerdict; children: PreparedRead[] }
const preparedReads = new Map<string, WeakRef<PreparedRead>>()
const inputReads = new WeakMap<object, PreparedRead>()
const reclaimedReads = new FinalizationRegistry<{ command: string; reference: WeakRef<PreparedRead> }>(({ command, reference }) => {
  if (preparedReads.get(command) === reference) preparedReads.delete(command)
})

export async function prepareBashReadOnly(input: { command: string; cwd?: string }): Promise<void> {
  return notBuilt('src/tools/BashTool/readOnlyValidation.ts:46')
}

export function preparedBashReadsOnly(input: { command: string; cwd?: string }): boolean {
  const prepared = inputReads.get(input) ?? preparedReads.get(input.command)?.deref()
  const cwd = resolveShellCwd(input.cwd)
  return prepared !== undefined && prepared.command === input.command && prepared.cwd === cwd && prepared.originalCwd === getOriginalCwd() && prepared.platform === getPlatform() && prepared.bare === isCurrentDirectoryBareGitRepo(cwd) && prepared.verdict.behavior === 'allow'
}

export function cutPart(text: string): string {
  const firstLine = text.split('\n')[0] ?? ''
  const line = firstLine.length > PART_WIDTH ? firstLine.slice(0, PART_WIDTH) : firstLine
  return line.length < text.length ? `${line}…` : line
}

export function notReadOnlyClause(reason: NotReadOnly): string {
  switch (reason.kind) {
    case 'not-on-list': return `\`${reason.word}\` is not a command Mercury can verify as read-only`
    case 'form': return `it is not a read-only form of \`${reason.word}\``
    case 'writes': return `it writes to \`${reason.target}\``
    case 'screen': return `the command could not be verified as read-only — ${reason.detail ?? ''}`
    case 'git-guard': return reason.detail ?? ''
    case 'simulated-edit': return 'it carries a simulated sed edit'
    case 'unparseable': return reason.detail ?? 'the command could not be parsed, so it cannot be verified as read-only'
  }
}

function refuse(reason: NotReadOnly, message?: string): ReadOnlyVerdict {
  return { behavior: 'passthrough', message: message ?? notReadOnlyClause(reason), notReadOnly: reason }
}

function isOutput(redirect: SimpleCommand['redirects'][number]): boolean {
  return OUTPUT_OPERATORS.has(redirect.op) && !(redirect.op === '>&' && /^[0-9]+$/.test(redirect.target))
}

function isGitInternalPath(path: string): boolean {
  const bare = path.replace(/^\.?\//, '')
  return bare === 'HEAD' || /^(?:objects|refs|hooks)(?:\/|$)/.test(bare)
}

function writesToGitInternalPath(commands: SimpleCommand[]): boolean {
  return notBuilt('src/tools/BashTool/readOnlyValidation.ts:103')
}

function gitGuard(commands: SimpleCommand[], compoundHasCd: boolean, cwd: string): string | null {
  if (!commands.some(command => command.argv[0] === 'git')) return null
  if (compoundHasCd) return 'A cd combined with git is not auto-allowed.'
  if (isCurrentDirectoryBareGitRepo(cwd)) return 'This directory has bare-repository structure, so git commands here go through the permission gate'
  if (writesToGitInternalPath(commands)) return 'A git command combined with a git-internal write is not auto-allowed.'
  return null
}

function listedWord(word: string): boolean {
  if (!LISTED_WORDS.has(word)) return false
  return !(walkedRuleFor([word])?.unixOnly && getPlatform() === 'windows')
}

function readOnlyFromParse(input: { command: string; cwd?: string }, compoundHasCd: boolean, parsed: ParseForSecurityResult, depth?: number): ReadOnlyVerdict {
  return notBuilt('src/tools/BashTool/readOnlyValidation.ts:142')
}

export function checkPreparedReadOnlyConstraints(input: { command: string; cwd?: string }, compoundHasCd = false, command?: SimpleCommand, depth = 0): ReadOnlyVerdict {
  return readOnlyFromParse(input, compoundHasCd, command ? { kind: 'simple', commands: [command] } : preparedSecurityParse(input.command), depth)
}

export async function checkReadOnlyConstraints(input: { command: string; cwd?: string }, compoundHasCd: boolean): Promise<ReadOnlyVerdict> {
  return withBashParseScope(async () => {
    const parsed = await parseForSecurity(input.command)
    await prepareShellCScripts(parsed)
    return readOnlyFromParse(input, compoundHasCd, parsed)
  })
}

export async function describeBashNotReadOnly(command: string): Promise<NotReadOnly | null> {
  return (await checkReadOnlyConstraints({ command }, false)).notReadOnly ?? null
}
