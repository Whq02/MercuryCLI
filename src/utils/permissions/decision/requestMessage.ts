import { plural } from '../../stringUtils.js'
import { pinnedCommandAnalysis } from './commandAnalysis.js'
import { permissionModeTitle } from '../PermissionMode.js'
import type { PermissionDecisionReason } from '../PermissionResult.js'
import { ruleSentence } from '../ruleReason.js'

const extractOutputRedirections: typeof pinnedCommandAnalysis.extractOutputRedirections =
  (...a) => pinnedCommandAnalysis.extractOutputRedirections(...a)

export const ORG_ASK_REASON = 'Your organization requires approval for this tool'

function subcommandPartsNeedingApproval(toolName: string, reasons: ReadonlyMap<string, { behavior?: string }>): string[] {
  const needsApproval: string[] = []
  for (const [cmd, result] of reasons) {
    if (result.behavior === 'ask' || result.behavior === 'passthrough') {
      if (toolName === 'Bash') {
        const { commandWithoutRedirections, redirections } = extractOutputRedirections(cmd)
        const displayCmd = redirections.length > 0 ? commandWithoutRedirections : cmd
        needsApproval.push(displayCmd)
      } else {
        needsApproval.push(cmd)
      }
    }
  }
  return needsApproval
}

const ungrantedLine = (toolName: string): string => `Mercury requested permissions to use ${toolName}, but you haven't granted it yet.`

type ReasonByType = { [K in PermissionDecisionReason['type']]: Extract<PermissionDecisionReason, { type: K }> }
type ReasonLines<T> = { [K in keyof T]: (toolName: string, reason: T[K]) => string }

function reasonLine<T, K extends keyof T>(lines: ReasonLines<T>, toolName: string, type: K, reason: T[K]): string {
  const line: ReasonLines<T>[K] | undefined = lines[type]
  return line === undefined ? ungrantedLine(toolName) : line(toolName, reason)
}

const REASON_TABLE: ReasonLines<ReasonByType> = {
  hook: (toolName, hook) =>
    hook.reason
      ? `Hook '${hook.hookName}' blocked this action: ${hook.reason}`
      : `Hook '${hook.hookName}' requires approval for this ${toolName} command`,
  rule: (toolName, ruleReason) => ruleSentence(`This ${toolName} call`, 'ask', ruleReason.rule),
  subcommandResults: (toolName, sub) => {
    const parts = subcommandPartsNeedingApproval(toolName, sub.reasons)
    if (parts.length > 0) {
      const n = parts.length
      return `This ${toolName} command contains multiple operations. The following ${plural(n, 'part')} ${plural(n, 'requires', 'require')} approval: ${parts.join(', ')}`
    }
    return `This ${toolName} command contains multiple operations that require approval`
  },
  permissionPromptTool: (toolName, prompt) => `Tool '${prompt.permissionPromptToolName}' requires approval for this ${toolName} command`,
  sandboxOverride: () => 'Run outside of the sandbox',
  workingDir: (_toolName, reason) => reason.reason,
  safetyCheck: (_toolName, reason) => reason.reason,
  other: (_toolName, reason) => reason.reason,
  mode: (toolName, modeReason) => `Current permission mode (${permissionModeTitle(modeReason.mode)}) requires approval for this ${toolName} command`,
  asyncAgent: (_toolName, reason) => reason.reason,
  classifier: toolName => ungrantedLine(toolName),
  bypassedAsk: (toolName, bypassed) => createPermissionRequestMessage(toolName, bypassed.reason),
}

export function createPermissionRequestMessage(
  toolName: string,
  decisionReason?: PermissionDecisionReason,
): string {
  if (!decisionReason) return ungrantedLine(toolName)
  return reasonLine(REASON_TABLE, toolName, decisionReason.type, decisionReason)
}
