/**
 * Renders a PermissionDecisionReason as the one-line explanation the
 * operator sees when a tool call stops for approval — on the consent card,
 * in headless denial output, and in decision traces. Pure formatting over
 * the reason union; the decision itself was already made. permissions.ts
 * re-exports createPermissionRequestMessage (the frozen compatibility
 * surface).
 */
import { plural } from '../../stringUtils.js'
import { pinnedCommandAnalysis } from './commandAnalysis.js'
import { permissionModeTitle } from '../PermissionMode.js'
import type { PermissionDecisionReason } from '../PermissionResult.js'
import { permissionRuleValueToString } from '../permissionRuleParser.js'
import { permissionRuleSourceDisplayString } from './rules.js'

// Lazily bound (the provider's bash lane reaches the API layer via the
// prefix extractor — cyclic with the tool registry; TDZ-safe at call time).
const extractOutputRedirections: typeof pinnedCommandAnalysis.extractOutputRedirections =
  (...a) => pinnedCommandAnalysis.extractOutputRedirections(...a)

/**
 * Reason surfaced when an MCP/org `toolPermissions` ask-ceiling forces a tool
 * to a human prompt (effectiveMaxPermission === 'ask').
 */
export const ORG_ASK_REASON = 'Your organization requires approval for this tool'

/**
 * One line saying why this tool call needs the operator's word. Every arm of
 * the reason union gets a specific sentence; no reason at all falls through
 * to the generic not-yet-granted line.
 */
export function createPermissionRequestMessage(
  toolName: string,
  decisionReason?: PermissionDecisionReason,
): string {
  if (decisionReason) {
    switch (decisionReason.type) {
      case 'hook': {
        const hookMessage = decisionReason.reason
          ? `Hook '${decisionReason.hookName}' blocked this action: ${decisionReason.reason}`
          : `Hook '${decisionReason.hookName}' requires approval for this ${toolName} command`
        return hookMessage
      }
      case 'rule': {
        const ruleString = permissionRuleValueToString(
          decisionReason.rule.ruleValue,
        )
        const sourceString = permissionRuleSourceDisplayString(
          decisionReason.rule.source,
        )
        return `Permission rule '${ruleString}' from ${sourceString} requires approval for this ${toolName} command`
      }
      case 'subcommandResults': {
        // A compound command decided part-by-part: name exactly the parts
        // that still need the operator, not the whole command line.
        const needsApproval: string[] = []
        for (const [cmd, result] of decisionReason.reasons) {
          if (result.behavior === 'ask' || result.behavior === 'passthrough') {
            if (toolName === 'Bash') {
              // Bash only: show the command without its output redirections,
              // so a target filename never masquerades as the command that
              // needs approving. Redirection-free commands pass unchanged.
              const { commandWithoutRedirections, redirections } =
                extractOutputRedirections(cmd)
              const displayCmd =
                redirections.length > 0 ? commandWithoutRedirections : cmd
              needsApproval.push(displayCmd)
            } else {
              needsApproval.push(cmd)
            }
          }
        }
        if (needsApproval.length > 0) {
          const n = needsApproval.length
          return `This ${toolName} command contains multiple operations. The following ${plural(n, 'part')} ${plural(n, 'requires', 'require')} approval: ${needsApproval.join(', ')}`
        }
        return `This ${toolName} command contains multiple operations that require approval`
      }
      case 'permissionPromptTool':
        return `Tool '${decisionReason.permissionPromptToolName}' requires approval for this ${toolName} command`
      case 'sandboxOverride':
        return 'Run outside of the sandbox'
      case 'workingDir':
        return decisionReason.reason
      case 'safetyCheck':
      case 'other':
        return decisionReason.reason
      case 'mode': {
        const modeTitle = permissionModeTitle(decisionReason.mode)
        return `Current permission mode (${modeTitle}) requires approval for this ${toolName} command`
      }
      case 'asyncAgent':
        return decisionReason.reason
    }
  }

  // No structured reason: the tool simply has no grant yet.
  return `Mercury requested permissions to use ${toolName}, but you haven't granted it yet.`
}
