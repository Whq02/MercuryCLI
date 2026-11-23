import type { PermissionResult, PermissionDecisionReason } from '../../utils/permissions/PermissionResult.js'
import { createPermissionRequestMessage } from '../../utils/permissions/decision/requestMessage.js'
import {
  buildParsedCommandFromRoot,
  ParsedCommand,
  PARSE_ABORTED,
  pinnedCommandAnalysis,
  preparedSecurityParse,
} from '../../utils/permissions/decision/commandAnalysis.js'

export type CommandIdentityCheckers = {
  isGitCommand: (command: string) => boolean
  isDirectoryChange: (command: string) => boolean
}

export const MULTIPLE_CD_REASON =
  'A command that changes the working directory more than once needs approval — its net effect on the working directory is not obvious to a reader.'

export const CD_GIT_BARE_REPO_REASON =
  'A compound command pairing cd with git needs approval — the cd could land the git call inside a hostile bare repository'

type SegmentPermissionFn<I> = (input: I) => Promise<PermissionResult>

type CompoundReason = { kind: 'unparseable' } | { kind: 'comment' } | { kind: 'operator'; operator: string; target?: string }

function compoundMessage(reason: CompoundReason): string {
  switch (reason.kind) {
    case 'unparseable':
      return 'This command could not be split into simple commands, so it needs approval.'
    case 'comment':
      return 'This command uses shell operators that require approval.'
    case 'operator':
      return reason.target
        ? `This command uses the shell operator \`${reason.operator}\` with a target the shell expands (\`${reason.target}\`), which needs approval.`
        : `This command uses the shell operator \`${reason.operator}\`, which needs approval.`
  }
}

function askCompound(reason: CompoundReason): PermissionResult {
  const message = compoundMessage(reason)
  return { behavior: 'ask', message, decisionReason: { type: 'other', reason: message } }
}

export async function checkCommandOperatorPermissions<I extends { command: string }>(
  input: I,
  permissionFn: SegmentPermissionFn<I>,
  checkers: CommandIdentityCheckers,
  astRoot: unknown,
): Promise<PermissionResult> {
  const parsed =
    astRoot !== undefined && astRoot !== null && astRoot !== PARSE_ABORTED
      ? buildParsedCommandFromRoot(input.command, astRoot)
      : await ParsedCommand.parse(input.command)
  if (!parsed) {
    return { behavior: 'passthrough', message: 'Command could not be parsed for operator handling.' }
  }

  const analysis = parsed.getTreeSitterAnalysis()
  if (!analysis) {
    return askCompound({ kind: 'unparseable' })
  }
  if (analysis.compoundStructure.hasCommandGroup && preparedSecurityParse(input.command).kind !== 'simple') {
    return askCompound({ kind: 'operator', operator: '{' })
  }

  const rawSegments = parsed.getPipeSegments()
  if (rawSegments.length <= 1) {
    return { behavior: 'passthrough', message: 'Not a segmented command.' }
  }

  const segments: string[] = []
  for (const raw of rawSegments) {
    let segment = raw.trim()
    if (segment.includes('>')) {
      const segParsed = await ParsedCommand.parse(segment)
      if (segParsed) segment = segParsed.withoutOutputRedirections().trim()
    }
    if (segment.length > 0) segments.push(segment)
  }
  if (segments.length === 0) {
    return { behavior: 'passthrough', message: 'Not a segmented command.' }
  }

  let cdCount = 0
  for (const segment of segments) {
    if (checkers.isDirectoryChange(segment)) cdCount++
  }
  if (cdCount > 1) {
    return {
      behavior: 'ask',
      message: MULTIPLE_CD_REASON,
      decisionReason: { type: 'other', reason: MULTIPLE_CD_REASON },
    }
  }

  let hasCd = false
  let hasGit = false
  for (const segment of segments) {
    for (const sub of pinnedCommandAnalysis.splitCommand(segment)) {
      if (checkers.isDirectoryChange(sub)) hasCd = true
      if (checkers.isGitCommand(sub)) hasGit = true
    }
  }
  if (hasCd && hasGit) {
    return {
      behavior: 'ask',
      message: CD_GIT_BARE_REPO_REASON,
      decisionReason: { type: 'other', reason: CD_GIT_BARE_REPO_REASON },
    }
  }

  const reasons = new Map<string, PermissionResult>()
  for (const segment of segments) {
    const result = await permissionFn({ ...input, command: segment })
    reasons.set(segment, result)
  }

  const decisionReason: PermissionDecisionReason = { type: 'subcommandResults', reasons }
  for (const [segment, result] of reasons) {
    if (result.behavior === 'deny') {
      return {
        behavior: 'deny',
        message: result.message || `The command segment "${segment}" was denied.`,
        decisionReason,
      }
    }
  }

  const allAllowed = [...reasons.values()].every(result => result.behavior === 'allow')
  if (allAllowed) {
    const updatedInput: Record<string, unknown> = Object.fromEntries(Object.entries(input))
    return { behavior: 'allow', updatedInput, decisionReason }
  }

  const suggestions = [...reasons.values()].flatMap(result =>
    result.behavior === 'ask' || result.behavior === 'passthrough' ? (result.suggestions ?? []) : [],
  )
  const anyAsk = [...reasons.values()].some(result => result.behavior === 'ask')
  const message = createPermissionRequestMessage('Bash', decisionReason)
  const offered = suggestions.length > 0 ? { suggestions } : {}
  if (anyAsk) {
    return { behavior: 'ask', message, decisionReason, ...offered }
  }
  return { behavior: 'passthrough', message, decisionReason, ...offered }
}
