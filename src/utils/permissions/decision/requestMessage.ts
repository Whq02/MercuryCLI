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

type ReasonWords = { words: string }
type ReasonLine = { line: (toolName: string, reason: never) => string }
type ReasonEntry = ReasonWords | ReasonLine

const REASON_TABLE: { [K in PermissionDecisionReason['type']]?: ReasonEntry } = {
  hook: {
    line: (toolName, r) => {
      const hook = r as Extract<PermissionDecisionReason, { type: 'hook' }>
      return hook.reason
        ? `Hook '${hook.hookName}' blocked this action: ${hook.reason}`
        : `Hook '${hook.hookName}' requires approval for this ${toolName} command`
    },
  },
  rule: {
    line: (toolName, r) => {
      const ruleReason = r as Extract<PermissionDecisionReason, { type: 'rule' }>
      return ruleSentence(`This ${toolName} call`, 'ask', ruleReason.rule)
    },
  },
  subcommandResults: {
    line: (toolName, r) => {
      const sub = r as Extract<PermissionDecisionReason, { type: 'subcommandResults' }>
      const parts = subcommandPartsNeedingApproval(toolName, sub.reasons)
      if (parts.length > 0) {
        const n = parts.length
        return `This ${toolName} command contains multiple operations. The following ${plural(n, 'part')} ${plural(n, 'requires', 'require')} approval: ${parts.join(', ')}`
      }
      return `This ${toolName} command contains multiple operations that require approval`
    },
  },
  permissionPromptTool: {
    line: (toolName, r) => {
      const prompt = r as Extract<PermissionDecisionReason, { type: 'permissionPromptTool' }>
      return `Tool '${prompt.permissionPromptToolName}' requires approval for this ${toolName} command`
    },
  },
  sandboxOverride: { words: 'Run outside of the sandbox' },
  workingDir: {
    line: (_toolName, r) => (r as Extract<PermissionDecisionReason, { type: 'workingDir' }>).reason,
  },
  safetyCheck: {
    line: (_toolName, r) => (r as Extract<PermissionDecisionReason, { type: 'safetyCheck' }>).reason,
  },
  other: {
    line: (_toolName, r) => (r as Extract<PermissionDecisionReason, { type: 'other' }>).reason,
  },
  mode: {
    line: (toolName, r) => {
      const modeReason = r as Extract<PermissionDecisionReason, { type: 'mode' }>
      return `Current permission mode (${permissionModeTitle(modeReason.mode)}) requires approval for this ${toolName} command`
    },
  },
  asyncAgent: {
    line: (_toolName, r) => (r as Extract<PermissionDecisionReason, { type: 'asyncAgent' }>).reason,
  },
  bypassedAsk: {
    line: (toolName, r) => {
      const bypassed = r as Extract<PermissionDecisionReason, { type: 'bypassedAsk' }>
      return createPermissionRequestMessage(toolName, bypassed.reason)
    },
  },
}

export function createPermissionRequestMessage(
  toolName: string,
  decisionReason?: PermissionDecisionReason,
): string {
  if (decisionReason) {
    const entry = REASON_TABLE[decisionReason.type]
    if (entry !== undefined) {
      return 'words' in entry ? entry.words : entry.line(toolName, decisionReason as never)
    }
  }
  return `Mercury requested permissions to use ${toolName}, but you haven't granted it yet.`
}
