import type { PermissionResult, PermissionDecisionReason } from '../../utils/permissions/PermissionResult.js'
import { createPermissionRequestMessage } from '../../utils/permissions/decision/requestMessage.js'
import {
  buildParsedCommandFromRoot,
  isUnsafeCompoundCommand_DEPRECATED,
  ParsedCommand,
  PARSE_ABORTED,
  pinnedCommandAnalysis,
  type Node,
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

async function stripSegmentRedirections(segment: string): Promise<string> {
  if (!segment.includes('>')) return segment
  const parsed = await ParsedCommand.parse(segment)
  if (!parsed) return segment
  return parsed.withoutOutputRedirections()
}

export async function checkCommandOperatorPermissions<I extends { command: string }>(
  input: I,
  permissionFn: SegmentPermissionFn<I>,
  checkers: CommandIdentityCheckers,
  astRoot: Node | undefined | typeof PARSE_ABORTED,
): Promise<PermissionResult> {
  const parsed =
    astRoot !== undefined && astRoot !== PARSE_ABORTED
      ? buildParsedCommandFromRoot(input.command, astRoot)
      : await ParsedCommand.parse(input.command)
  if (!parsed) {
    return { behavior: 'passthrough', message: 'Command could not be parsed for operator handling.' }
  }

  const analysis = parsed.getTreeSitterAnalysis()
  const unsafeCompound = analysis
    ? analysis.compoundStructure.hasSubshell || analysis.compoundStructure.hasCommandGroup
    : isUnsafeCompoundCommand_DEPRECATED(input.command)
  if (unsafeCompound) {
    return {
      behavior: 'ask',
      message: 'This command uses shell operators that require approval.',
    }
  }

  const segments = parsed.getPipeSegments()
  if (segments.length <= 1) {
    return { behavior: 'passthrough', message: 'Not a segmented command.' }
  }

  const strippedSegments = await Promise.all(segments.map(stripSegmentRedirections))

  const dirChangeSegments = strippedSegments.filter(seg => checkers.isDirectoryChange(seg.trim()))
  if (dirChangeSegments.length > 1) {
    return { behavior: 'ask', message: MULTIPLE_CD_REASON, decisionReason: { type: 'other', reason: MULTIPLE_CD_REASON } }
  }

  let sawDirChange = false
  let sawGit = false
  for (const seg of strippedSegments) {
    for (const raw of pinnedCommandAnalysis.splitCommand(seg)) {
      const sub = raw.trim()
      if (checkers.isDirectoryChange(sub)) sawDirChange = true
      if (checkers.isGitCommand(sub)) sawGit = true
    }
  }
  if (sawDirChange && sawGit) {
    return { behavior: 'ask', message: CD_GIT_BARE_REPO_REASON, decisionReason: { type: 'other', reason: CD_GIT_BARE_REPO_REASON } }
  }

  const results = new Map<string, PermissionResult>()
  for (const seg of strippedSegments) {
    const trimmed = seg.trim()
    if (trimmed === '') continue
    const segmentInput = { ...input, command: trimmed }
    results.set(trimmed, await permissionFn(segmentInput))
  }

  const reason: PermissionDecisionReason = {
    type: 'subcommandResults',
    reasons: results,
  }

  for (const [segment, result] of results) {
    if (result.behavior === 'deny') {
      return {
        behavior: 'deny',
        message: result.message ?? `The command segment "${segment}" was denied.`,
        decisionReason: reason,
      }
    }
  }

  if ([...results.values()].every(result => result.behavior === 'allow')) {
    return { behavior: 'allow', updatedInput: input, decisionReason: reason }
  }

  const suggestions = [...results.values()]
    .filter(result => result.behavior !== 'allow')
    .flatMap(result => ('suggestions' in result && result.suggestions) || [])
  return {
    behavior: 'ask',
    message: createPermissionRequestMessage('Bash', reason),
    decisionReason: reason,
    ...(suggestions.length > 0 ? { suggestions } : {}),
  }
}
