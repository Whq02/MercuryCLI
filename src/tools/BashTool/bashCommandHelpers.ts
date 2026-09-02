/**
 * Pipe and compound-operator permission handling.
 *
 * A command joined by pipes or other operators is decided segment by segment:
 * each segment re-enters the permission engine, and two cross-segment guards
 * run first — more than one directory change, and a directory change paired
 * with a git command in any segment. The second guard blocks a bare-repository
 * attack whose `cd` and `git` land in different pipe segments, where neither
 * would trip the single-command gate.
 */
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

/**
 * The two command-identity predicates the handler needs, passed in by the
 * caller so this module never imports the permission engine (that would close
 * an import cycle).
 */
export type CommandIdentityCheckers = {
  isGitCommand: (command: string) => boolean
  isDirectoryChange: (command: string) => boolean
}

/** Ask reason for a command that changes directory more than once. Shared with the single-command gate. */
export const MULTIPLE_CD_REASON =
  'A command that changes the working directory more than once needs approval — its net effect on the working directory is not obvious to a reader.'

/**
 * Ask reason for a directory change combined with a git command. Contract data
 * (a prover greps this literal out of the shipped artefact); shared with the
 * single-command gate.
 */
export const CD_GIT_BARE_REPO_REASON =
  'A compound command pairing cd with git needs approval — the cd could land the git call inside a hostile bare repository'

/** A segment-permission callback: it already carries the tool context in its closure. */
type SegmentPermissionFn<I> = (input: I) => Promise<PermissionResult>

/** Strip a segment's output redirections, leaving its remaining quoting intact. */
async function stripSegmentRedirections(segment: string): Promise<string> {
  // Fast path: a segment with no `>` cannot carry an output redirect, so it is
  // returned untouched (an input redirect `<` alone never needs the parse).
  if (!segment.includes('>')) return segment
  const parsed = await ParsedCommand.parse(segment)
  if (!parsed) return segment
  return parsed.withoutOutputRedirections()
}

/**
 * Decide a pipe/compound command. Returns passthrough when the command is not
 * actually segmented (the ordinary single-command flow handles it).
 */
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

  // 1. Unsafe compound structures (subshell / command group).
  const analysis = parsed.getTreeSitterAnalysis()
  const unsafeCompound = analysis
    ? analysis.compoundStructure.hasSubshell || analysis.compoundStructure.hasCommandGroup
    : isUnsafeCompoundCommand_DEPRECATED(input.command)
  if (unsafeCompound) {
    return {
      behavior: 'ask',
      message: 'This command uses shell operators that require approval.',
      // No suggestions — a rule could not allow this command anyway.
    }
  }

  // 2. Pipe segmentation.
  const segments = parsed.getPipeSegments()
  if (segments.length <= 1) {
    return { behavior: 'passthrough', message: 'Not a segmented command.' }
  }

  // 3. Strip each segment's output redirections.
  const strippedSegments = await Promise.all(segments.map(stripSegmentRedirections))

  // 4a. More than one directory-change segment.
  const dirChangeSegments = strippedSegments.filter(seg => checkers.isDirectoryChange(seg.trim()))
  if (dirChangeSegments.length > 1) {
    return { behavior: 'ask', message: MULTIPLE_CD_REASON, decisionReason: { type: 'other', reason: MULTIPLE_CD_REASON } }
  }

  // 4b. A directory change and a git command across segments.
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

  // 4c. Evaluate every non-empty segment, keyed by trimmed segment text.
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

  // A denied segment denies the whole command.
  for (const [segment, result] of results) {
    if (result.behavior === 'deny') {
      return {
        behavior: 'deny',
        message: result.message ?? `The command segment "${segment}" was denied.`,
        decisionReason: reason,
      }
    }
  }

  // All allowed (vacuously true for an all-empty pipeline) → allow.
  if ([...results.values()].every(result => result.behavior === 'allow')) {
    return { behavior: 'allow', updatedInput: input, decisionReason: reason }
  }

  // Otherwise ask, collecting every non-allow segment's suggestions.
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
