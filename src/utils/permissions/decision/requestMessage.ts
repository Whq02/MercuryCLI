import { plural } from '../../stringUtils.js'
import { pinnedCommandAnalysis } from './commandAnalysis.js'
import { permissionModeTitle } from '../PermissionMode.js'
import type { PermissionDecisionReason } from '../PermissionResult.js'
import { ruleSentence } from '../ruleReason.js'
import { notBuilt } from '../../../pi/holes.js'

const extractOutputRedirections: typeof pinnedCommandAnalysis.extractOutputRedirections =
  (...a) => pinnedCommandAnalysis.extractOutputRedirections(...a)

export const ORG_ASK_REASON = 'Your organization requires approval for this tool'

const ungrantedLine = (toolName: string): string => notBuilt('src/utils/permissions/decision/requestMessage.ts:28')

type ReasonByType = { [K in PermissionDecisionReason['type']]: Extract<PermissionDecisionReason, { type: K }> }
type ReasonLines<T> = { [K in keyof T]: (toolName: string, reason: T[K]) => string }

function reasonLine<T, K extends keyof T>(lines: ReasonLines<T>, toolName: string, type: K, reason: T[K]): string {
  const line: ReasonLines<T>[K] | undefined = lines[type]
  return line === undefined ? ungrantedLine(toolName) : line(toolName, reason)
}

export function createPermissionRequestMessage(
  toolName: string,
  decisionReason?: PermissionDecisionReason,
): string {
  return notBuilt('src/utils/permissions/decision/requestMessage.ts:62')
}
