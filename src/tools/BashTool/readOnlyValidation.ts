import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import {
  parseForSecurity,
  preparedCommandRoot,
  type Node,
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
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { getCwd } from '../../utils/cwd.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getPlatform } from '../../utils/platform.js'
import { uncPathRisk, uncPathMessage } from '../../utils/permissions/uncPath.js'
import { containsWindowsDevicePath, WINDOWS_DEVICE_PATH_MESSAGE } from '../../utils/permissions/windowsPath.js'

const GIT_INTERNAL_CREATORS = new Set<PathCommand>(['mkdir', 'touch', 'mv', 'cp', 'tee', 'dd'])
const OUTPUT_OPERATORS = new Set(['>', '>>', '>|', '&>', '&>>', '>&'])

export type NotReadOnly = {
  kind: 'unparseable' | 'sandbox' | 'not-on-list' | 'form' | 'writes' | 'screen' | 'git-guard'
  part: string
  word?: string
  target?: string
  detail?: string
}

export type ReadOnlyVerdict = PermissionResult & { notReadOnly?: NotReadOnly }
const PART_WIDTH = 120
type PreparedRead = { root: Node | null; command: string; cwd: string; originalCwd: string; platform: string; bare: ReturnType<typeof isCurrentDirectoryBareGitRepo>; sandboxed: boolean; verdict: ReadOnlyVerdict; children: PreparedRead[] }
const preparedReads = new Map<string, WeakRef<PreparedRead>>()
const inputReads = new WeakMap<object, PreparedRead>()
const reclaimedReads = new FinalizationRegistry<{ command: string; reference: WeakRef<PreparedRead> }>(({ command, reference }) => {
  if (preparedReads.get(command) === reference) preparedReads.delete(command)
})

export async function prepareBashReadOnly(input: { command: string }): Promise<void> {
  const command = input.command
  const parsed = await parseForSecurity(command)
  const root = preparedCommandRoot(command)
  const snapshot = { root, cwd: getCwd(), originalCwd: getOriginalCwd(), platform: getPlatform(), bare: isCurrentDirectoryBareGitRepo(), sandboxed: SandboxManager.isSandboxingEnabled() }
  const remember = (text: string, verdict: ReadOnlyVerdict, children: PreparedRead[] = []): PreparedRead => {
    const prepared = { ...snapshot, command: text, verdict, children }
    const reference = new WeakRef(prepared)
    preparedReads.set(text, reference)
    reclaimedReads.register(prepared, { command: text, reference })
    return prepared
  }
  const children = parsed.kind === 'simple' ? parsed.commands.map(simple => remember(simple.text, readOnlyFromParse({ command: simple.text }, false, preparedSecurityParse(simple.text)))) : []
  inputReads.set(input, remember(command, readOnlyFromParse({ command }, false, parsed), children))
}

export function preparedBashReadsOnly(input: { command: string }): boolean {
  const prepared = inputReads.get(input) ?? preparedReads.get(input.command)?.deref()
  return prepared !== undefined && prepared.command === input.command && prepared.cwd === getCwd() && prepared.originalCwd === getOriginalCwd() && prepared.platform === getPlatform() && prepared.bare === isCurrentDirectoryBareGitRepo() && prepared.sandboxed === SandboxManager.isSandboxingEnabled() && prepared.verdict.behavior === 'allow'
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
    case 'sandbox': return 'it leaves the sandbox or carries a simulated sed edit'
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
  return commands.some(command => {
    const word = command.argv[0] as PathCommand
    const paths = command.redirects.filter(isOutput).map(redirect => redirect.target)
    if (word in COMMAND_OPERATION_TYPE && GIT_INTERNAL_CREATORS.has(word)) paths.push(...PATH_EXTRACTORS[word](command.argv.slice(1)))
    return paths.some(isGitInternalPath)
  })
}

function gitGuard(commands: SimpleCommand[], compoundHasCd: boolean): string | null {
  if (!commands.some(command => command.argv[0] === 'git')) return null
  if (compoundHasCd) return 'A cd combined with git is not auto-allowed.'
  if (isCurrentDirectoryBareGitRepo()) return 'This directory has bare-repository structure, so git commands here go through the permission gate'
  if (writesToGitInternalPath(commands)) return 'A git command combined with a git-internal write is not auto-allowed.'
  if (SandboxManager.isSandboxingEnabled() && getCwd() !== getOriginalCwd()) return 'A sandboxed git command outside the original directory is not auto-allowed.'
  return null
}

function listedWord(word: string): boolean {
  if (!LISTED_WORDS.has(word)) return false
  return !(walkedRuleFor([word])?.unixOnly && getPlatform() === 'windows')
}

function readsOnly(command: SimpleCommand): boolean {
  if (command.envVars.length > 0 || command.argv.length === 0) return false
  const { argv } = command
  const text = shellCommandText(argv)
  const rule = walkedRuleFor(argv)
  if (rule !== undefined && !(rule.unixOnly && getPlatform() === 'windows')) {
    if (walkFlags(argv, rule.words.length, rule) &&
      (rule.whole === undefined || rule.whole.test(text)) &&
      (!rule.noNewline || !/[\r\n]/.test(text)) &&
      (rule.readsOnly === undefined || rule.readsOnly(argv.slice(rule.words.length), text))) return true
  }
  const form = formRuleFor(argv[0]!)
  const formText = argv[0] === 'find' ? argv.map(word => word === '(' || word === ')' ? `\\${word}` : shellCommandText([word])).join(' ') : text
  if (form?.form === undefined || !(form.form(formText) || argv[0] === 'echo' && form.form(command.text))) return false
  return argv[0] !== 'git' || !argv.some(word => /^(?:-c|--exec-path|--config-env)(?:=|$)/.test(word))
}

function readOnlyFromParse(input: { command: string }, compoundHasCd: boolean, parsed: ParseForSecurityResult): ReadOnlyVerdict {
  const part = cutPart(input.command)
  if (parsed.kind === 'parse-unavailable') return refuse({ kind: 'unparseable', part, detail: 'the shell parser has not produced a tree; retry the command, or approve it in a session that can write' })
  if (parsed.kind === 'too-complex') return refuse({ kind: 'screen', part, detail: parsed.reason })
  if (parsed.commands.some(command => command.globOperand === true && !readsOnly(command))) return refuse({ kind: 'screen', part, detail: WILDCARD_REASON })
  const semantic = checkSemantics(parsed.commands)
  if (!semantic.ok) return refuse({ kind: 'screen', part, detail: semantic.reason })
  const remote = uncPathRisk(input.command)
  if (remote.risky) return { behavior: 'ask', message: uncPathMessage(input.command, remote), notReadOnly: { kind: 'screen', part, detail: uncPathMessage(input.command, remote) } }
  if (containsWindowsDevicePath(input.command)) return { behavior: 'ask', message: WINDOWS_DEVICE_PATH_MESSAGE, notReadOnly: { kind: 'screen', part, detail: WINDOWS_DEVICE_PATH_MESSAGE } }
  const hasCd = compoundHasCd || parsed.commands.some(command => ['cd', 'pushd', 'popd'].includes(command.argv[0] ?? ''))
  const guard = gitGuard(parsed.commands, hasCd)
  if (guard !== null) return refuse({ kind: 'git-guard', part, detail: guard }, guard)
  for (const command of parsed.commands) {
    const target = command.redirects.find(redirect => isOutput(redirect) && redirect.target !== '/dev/null')?.target
    if (target !== undefined) return refuse({ kind: 'writes', part: cutPart(command.text), target })
    if (readsOnly(command)) continue
    const word = command.argv[0] ?? ''
    if (!listedWord(word)) return refuse({ kind: 'not-on-list', part: cutPart(command.text), word })
    return refuse({ kind: 'form', part: cutPart(command.text), word })
  }
  return { behavior: 'allow', updatedInput: input }
}

export function checkPreparedReadOnlyConstraints(input: { command: string }, compoundHasCd = false, command?: SimpleCommand): ReadOnlyVerdict {
  return readOnlyFromParse(input, compoundHasCd, command ? { kind: 'simple', commands: [command] } : preparedSecurityParse(input.command))
}

export async function checkReadOnlyConstraints(input: { command: string }, compoundHasCd: boolean): Promise<ReadOnlyVerdict> {
  return readOnlyFromParse(input, compoundHasCd, await parseForSecurity(input.command))
}

export async function describeBashNotReadOnly(command: string): Promise<NotReadOnly | null> {
  return (await checkReadOnlyConstraints({ command }, false)).notReadOnly ?? null
}
