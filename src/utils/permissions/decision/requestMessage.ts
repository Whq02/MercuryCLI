import { plural } from '../../stringUtils.js'
import { pinnedCommandAnalysis } from './commandAnalysis.js'
import { permissionModeTitle } from '../PermissionMode.js'
import type { PermissionDecisionReason } from '../PermissionResult.js'
import { ruleSentence } from '../ruleReason.js'

const extractOutputRedirections: typeof pinnedCommandAnalysis.extractOutputRedirections =
  (...a) => pinnedCommandAnalysis.extractOutputRedirections(...a)

export const ORG_ASK_REASON = 'Your organization requires approval for this tool'

const ungrantedLine = (toolName: string): string =>
  `Mercury requested permissions to use ${toolName}, but you haven't granted it yet.`

type ReasonByType = { [K in PermissionDecisionReason['type']]: Extract<PermissionDecisionReason, { type: K }> }
type ReasonLines<T> = { [K in keyof T]: (toolName: string, reason: T[K]) => string }

function reasonLine<T, K extends keyof T>(lines: ReasonLines<T>, toolName: string, type: K, reason: T[K]): string {
  const line: ReasonLines<T>[K] | undefined = lines[type]
  return line === undefined ? ungrantedLine(toolName) : line(toolName, reason)
}

const REASON_LINES: ReasonLines<ReasonByType> = {
  rule: (toolName, reason) => ruleSentence(`This ${toolName} call`, 'ask', reason.rule),
  mode: (toolName, reason) =>
    `Current permission mode (${permissionModeTitle(reason.mode)}) requires approval for this ${toolName} command`,
  subcommandResults: (toolName, reason) => {
    const parts: string[] = []
    for (const [command, result] of reason.reasons) {
      if (result.behavior !== 'ask' && result.behavior !== 'passthrough') continue
      if (toolName === 'Bash') {
        const { commandWithoutRedirections, redirections } = extractOutputRedirections(command)
        parts.push(redirections.length > 0 ? commandWithoutRedirections : command)
      } else {
        parts.push(command)
      }
    }
    const count = parts.length
    if (count === 0) return `Several parts of this ${toolName} command need approval`
    const lead = count === 1 ? 'One' : 'Several'
    return `${lead} ${plural(count, 'part')} of this ${toolName} command ${plural(count, 'needs', 'need')} approval: ${parts.join(', ')}`
  },
  permissionPromptTool: (toolName, reason) =>
    `Tool '${reason.permissionPromptToolName ?? ''}' requires approval for this ${toolName} command`,
  hook: (toolName, reason) =>
    reason.reason
      ? `Hook '${reason.hookName}' blocked this action: ${reason.reason}`
      : `Hook '${reason.hookName}' requires approval for this ${toolName} command`,
  guard: (_toolName, reason) => reason.reason,
  asyncAgent: (_toolName, reason) => reason.reason,
  workingDir: (_toolName, reason) => reason.reason,
  safetyCheck: (_toolName, reason) => reason.reason,
  other: (_toolName, reason) => reason.reason,
  bypassedAsk: (toolName, reason) => createPermissionRequestMessage(toolName, reason.reason),
}

export function createPermissionRequestMessage(
  toolName: string,
  decisionReason?: PermissionDecisionReason,
): string {
  if (!decisionReason) return ungrantedLine(toolName)
  return reasonLine(REASON_LINES, toolName, decisionReason.type, decisionReason)
}
