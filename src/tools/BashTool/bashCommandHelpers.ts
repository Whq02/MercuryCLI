import type { PermissionResult, PermissionDecisionReason } from '../../utils/permissions/PermissionResult.js'
import { createPermissionRequestMessage } from '../../utils/permissions/decision/requestMessage.js'
import {
  buildParsedCommandFromRoot,
  ParsedCommand,
  PARSE_ABORTED,
  pinnedCommandAnalysis,
  preparedSecurityParse,
} from '../../utils/permissions/decision/commandAnalysis.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type CommandIdentityCheckers = Unbuilt

export const MULTIPLE_CD_REASON =
  'A command that changes the working directory more than once needs approval — its net effect on the working directory is not obvious to a reader.'

export const CD_GIT_BARE_REPO_REASON =
  'A compound command pairing cd with git needs approval — the cd could land the git call inside a hostile bare repository'

type SegmentPermissionFn<I> = (input: I) => Promise<PermissionResult>

type CompoundReason = { kind: 'unparseable' } | { kind: 'comment' } | { kind: 'operator'; operator: string; target?: string }

export async function checkCommandOperatorPermissions<I extends { command: string }>(
  input: I,
  permissionFn: SegmentPermissionFn<I>,
  checkers: CommandIdentityCheckers,
  astRoot: unknown,
): Promise<PermissionResult> {
  return notBuilt('src/tools/BashTool/bashCommandHelpers.ts:42')
}
