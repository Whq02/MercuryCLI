/**
 * The owned permission decision engine.
 *
 * ONE ordered stage chain, two entries:
 *   • decideToolPermission    — the full chain behind hasPermissionsToUseTool
 *   • decideRuleBasedPermissions — the bypass-immune rule band behind
 *     checkRuleBasedPermissions (the hook-allow guard path), which returns
 *     null when no rule objects so the mode layer can decide later
 *
 * The two entries share one chain body, so the rule band can never drift
 * between them (pre-cutover they were duplicated code). Every run returns a
 * DecisionTrace alongside the decision — the ordered record of which stages
 * were consulted and which one decided.
 *
 * The contract is the frozen matrix (scripts/decisions/prove-decision-matrix.ts):
 * kill-switch → tool-level deny/ask rules → tool verdict resolution → the
 * bypass-immunity band (tool deny · requiresUserInteraction · content
 * ask-rules · MCP org ask-ceiling · safetyCheck) → the bypass-posture band →
 * tool-level allow rules → passthrough→ask. Verdict-resolution failures
 * degrade to passthrough (⇒ ask), never allow; aborts always rethrow.
 *
 * Effects and policy live behind DecisionPorts (kill-switch store read,
 * sandbox policy, tool verdict resolution); the chain itself is pure over its
 * inputs. The mode wrapper (dontAsk conversion, auto-mode floors and
 * classifier, headless hook fallback) remains in permissions.ts — a later
 * Phase 3 cut.
 */
import { APIUserAbortError } from '../../../services/api/sdkErrors.js'
import type { Tool, ToolUseContext } from '../../../Tool.js'
import { shouldUseSandbox } from '../../../tools/BashTool/shouldUseSandbox.js'
import { BASH_TOOL_NAME } from '../../../tools/BashTool/toolName.js'
import { AbortError } from '../../errors.js'
import { logForDebugging } from '../../debug.js'
import { logError } from '../../log.js'
import { SandboxManager } from '../../sandbox/sandbox-adapter.js'
import { jsonStringify } from '../../slowOperations.js'
import { isToolKilled } from '../capabilityGate.js'
import { modeBypassesPermissions } from '../PermissionMode.js'
import type {
  PermissionAskDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionResult,
} from '../PermissionResult.js'
import { createPermissionRequestMessage, ORG_ASK_REASON } from './requestMessage.js'
import {
  getAskRuleForTool,
  getDenyRuleForTool,
  toolAlwaysAllowedRule,
} from './rules.js'
import type {
  DecisionEntry,
  DecisionStageId,
  DecisionStageRecord,
  DecisionTrace,
} from './trace.js'

/** Effect/policy ports the chain consults. Injected for tests; production
 *  uses defaultDecisionPorts. */
export interface DecisionPorts {
  /** Stage 0 — the operator capability kill-switch (store read). */
  isToolKilled(tool: Tool, agentType: string | undefined): boolean
  /** Stage 1b escape — sandbox policy that lets a to-be-sandboxed Bash
   *  command fall through a tool-level ask rule to command-specific rules. */
  sandboxAutoAllows(tool: Tool, input: Record<string, unknown>): boolean
  /** Stage 1c — the tool's own verdict: schema parse + checkPermissions.
   *  Throws propagate to the chain (aborts rethrow; anything else degrades
   *  to passthrough, never allow). */
  resolveToolVerdict(
    tool: Tool,
    input: Record<string, unknown>,
    context: ToolUseContext,
  ): Promise<PermissionResult>
}

export const defaultDecisionPorts: DecisionPorts = {
  isToolKilled: (tool, agentType) => isToolKilled(tool, agentType),
  sandboxAutoAllows: (tool, input) =>
    tool.name === BASH_TOOL_NAME &&
    SandboxManager.isSandboxingEnabled() &&
    SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
    shouldUseSandbox(input),
  resolveToolVerdict: async (tool, input, context) =>
    tool.checkPermissions(tool.inputSchema.parse(input), context),
}

export interface DecisionOutcome<D> {
  decision: D
  trace: DecisionTrace
}

/**
 * The full ordered chain (stages 0 → 3). Always yields a decision; the mode
 * wrapper in permissions.ts applies dontAsk/auto/headless transforms on top.
 */
export async function decideToolPermission(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  ports: DecisionPorts = defaultDecisionPorts,
): Promise<DecisionOutcome<PermissionDecision>> {
  const { decision, trace } = await runDecisionChain(
    'full',
    tool,
    input,
    context,
    ports,
  )
  // The full chain always terminates in a decision (stage 3 converts
  // passthrough to ask); null is structurally impossible here.
  return { decision: decision as PermissionDecision, trace }
}

/**
 * The bypass-immune rule band only (stages 1a → 1g, minus 1e which the caller
 * pre-checks). Returns a deny/ask decision if a rule objects, else null —
 * unlike the full chain this never consults modes, allow rules, or the
 * kill-switch (enforced by the full chain + the toolExecution.ts gate).
 */
export async function decideRuleBasedPermissions(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  ports: DecisionPorts = defaultDecisionPorts,
): Promise<
  DecisionOutcome<PermissionAskDecision | PermissionDenyDecision | null>
> {
  const { decision, trace } = await runDecisionChain(
    'ruleSubset',
    tool,
    input,
    context,
    ports,
  )
  // The rule band only ever decides deny or ask (allow/passthrough fall
  // through to the null no-objection outcome).
  return {
    decision: decision as PermissionAskDecision | PermissionDenyDecision | null,
    trace,
  }
}

async function runDecisionChain(
  entry: DecisionEntry,
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  ports: DecisionPorts,
): Promise<{ decision: PermissionDecision | null; trace: DecisionTrace }> {
  const appState = context.getAppState()
  const entryMode = appState.toolPermissionContext.mode
  const stages: DecisionStageRecord[] = []
  const pass = (stage: DecisionStageId, note?: string): void => {
    stages.push(note ? { stage, outcome: 'pass', note } : { stage, outcome: 'pass' })
  }
  const decided = (
    stage: DecisionStageId,
    decision: PermissionDecision,
    note?: string,
  ): { decision: PermissionDecision; trace: DecisionTrace } => {
    stages.push(
      note ? { stage, outcome: 'decided', note } : { stage, outcome: 'decided' },
    )
    return {
      decision,
      trace: { entry, toolName: tool.name, mode: entryMode, stages, decidedBy: stage },
    }
  }

  if (entry === 'full') {
    // Abort totality: a pre-aborted signal throws, never a silent verdict.
    // (The rule subset never checked the signal — pinned as-is.)
    if (context.abortController.signal.aborted) {
      throw new AbortError()
    }

    // 0. Capability kill-switch — early, clean permission-path deny for
    // non-headless modes (the universal guarantee is the execution gate in
    // toolExecution.ts, which also catches headless/sovereign). Empty
    // store = no-op. The per-call agent type (undefined ⇒ main thread, falls
    // back via the gate default) scopes an `agent:Tool` kill to the actual
    // subagent, not the main thread.
    if (ports.isToolKilled(tool, context.agentType)) {
      return decided('killSwitch', {
        behavior: 'deny',
        decisionReason: {
          type: 'other',
          reason: `Capability '${tool.name}' has been switched off for this agent by the operator.`,
        },
        message: `Permission to use ${tool.name} has been denied: capability switched off by operator.`,
      })
    }
    pass('killSwitch')
  }

  const permissionContext = appState.toolPermissionContext

  // 1a. A whole-tool deny rule covers this tool (bypass-immune).
  const denyRule = getDenyRuleForTool(permissionContext, tool)
  if (denyRule) {
    return decided('toolDenyRule', {
      behavior: 'deny',
      decisionReason: { type: 'rule', rule: denyRule },
      message: `Permission to use ${tool.name} has been denied.`,
    })
  }
  pass('toolDenyRule')

  // 1b. A whole-tool ask rule covers this tool — bypass-immune, and it
  // outranks any allow. One escape: under sandbox auto-allow policy, a Bash
  // command that will actually run sandboxed falls through to its own
  // command-scoped rules; a command escaping the sandbox still prompts.
  const askRule = getAskRuleForTool(permissionContext, tool)
  if (askRule) {
    if (!ports.sandboxAutoAllows(tool, input)) {
      return decided('toolAskRule', {
        behavior: 'ask',
        decisionReason: { type: 'rule', rule: askRule },
        message: createPermissionRequestMessage(tool.name),
      })
    }
    pass('toolAskRule', 'sandbox-auto-allow fallthrough')
  } else {
    pass('toolAskRule')
  }

  // 1c. Resolve the tool's own verdict. Failures (schema parse or a throwing
  // checkPermissions) degrade to passthrough — never allow; aborts rethrow.
  let toolVerdict: PermissionResult = {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(tool.name),
  }
  let verdictFailed = false
  try {
    toolVerdict = await ports.resolveToolVerdict(tool, input, context)
  } catch (e) {
    if (e instanceof AbortError || e instanceof APIUserAbortError) {
      throw e
    }
    logError(e)
    verdictFailed = true
  }
  pass(
    'toolVerdict',
    verdictFailed
      ? 'resolution failed — degraded to passthrough'
      : `verdict: ${toolVerdict?.behavior}`,
  )

  // 1d. The tool's own verdict is deny — bypass-immune. Behavior alone is
  // enough: a bash subcommand deny arrives as a deny-shaped verdict too, so
  // no decisionReason inspection is needed.
  if (toolVerdict?.behavior === 'deny') {
    return decided('toolVerdictDeny', toolVerdict)
  }
  pass('toolVerdictDeny')

  // 1e. Interaction-mandatory tools: when a tool declares it cannot run
  // without a human and its verdict says ask, no posture may silence the
  // prompt. Full chain only — the rule-subset caller pre-checks
  // requiresUserInteraction itself.
  if (entry === 'full') {
    if (tool.requiresUserInteraction?.() && toolVerdict?.behavior === 'ask') {
      return decided('userInteractionAsk', toolVerdict)
    }
    pass('userInteractionAsk')
  }

  // 1f. Content-specific ask RULES from the tool verdict take precedence over
  // sovereign mode: an explicitly configured content ask rule (e.g.
  // Bash(npm publish:*)) is respected even in bypass, like deny rules at 1d.
  if (
    toolVerdict?.behavior === 'ask' &&
    toolVerdict.decisionReason?.type === 'rule' &&
    toolVerdict.decisionReason.rule.ruleBehavior === 'ask'
  ) {
    return decided('contentAskRule', toolVerdict)
  }
  pass('contentAskRule')

  // 1f'. Org/MCP-policy ask ceiling — bypass-immune. An MCP tool pinned to
  // 'ask' in its server's toolPermissions must prompt even in bypass mode.
  // (Inert unless a server config declares it.)
  if (tool.mcpInfo?.effectiveMaxPermission === 'ask') {
    const reason: PermissionDecisionReason = {
      type: 'other',
      reason: ORG_ASK_REASON,
    }
    return decided('orgAskCeiling', {
      behavior: 'ask',
      message: createPermissionRequestMessage(tool.name, reason),
      decisionReason: reason,
    })
  }
  pass('orgAskCeiling')

  // 1g. Path-safety asks are bypass-immune: edits touching sensitive homes
  // (.git/, instruction/config directories, shell rc files) prompt even in
  // sovereign mode. checkPathSafetyForAutoEdit marks these verdicts with
  // {type:'safetyCheck'}.
  if (
    toolVerdict?.behavior === 'ask' &&
    toolVerdict.decisionReason?.type === 'safetyCheck'
  ) {
    return decided('safetyCheckAsk', toolVerdict)
  }
  pass('safetyCheckAsk')

  if (entry === 'ruleSubset') {
    // No rule-based objection — the mode layer decides later.
    return {
      decision: null,
      trace: { entry, toolName: tool.name, mode: entryMode, stages, decidedBy: 'none' },
    }
  }

  // 2a. Bypass-posture band. Re-read app state — the mode may have changed
  // while the tool verdict resolved. Bypasses when:
  // - a bypass-posture mode is active (sovereign, or Mercury's autopilot —
  //   ONE shared predicate so the two can never drift; autopilot entry
  //   already required the full bypass eligibility), or
  // - strategy mode when the session originally started with bypass
  //   available (isBypassPermissionsModeAvailable).
  const latestContext = context.getAppState().toolPermissionContext
  const shouldBypassPermissions =
    modeBypassesPermissions(latestContext.mode) ||
    (latestContext.mode === 'strategy' &&
      latestContext.isBypassPermissionsModeAvailable)
  if (shouldBypassPermissions) {
    return decided(
      'bypassPosture',
      {
        behavior: 'allow',
        updatedInput: getUpdatedInputOrFallback(toolVerdict, input),
        decisionReason: { type: 'mode', mode: latestContext.mode },
      },
      `mode: ${latestContext.mode}`,
    )
  }
  pass('bypassPosture')

  // 2b. A whole-tool allow rule covers this tool.
  const alwaysAllowedRule = toolAlwaysAllowedRule(latestContext, tool)
  if (alwaysAllowedRule) {
    return decided('toolAllowRule', {
      behavior: 'allow',
      updatedInput: getUpdatedInputOrFallback(toolVerdict, input),
      decisionReason: { type: 'rule', rule: alwaysAllowedRule },
    })
  }
  pass('toolAllowRule')

  // 3. Resolution: a passthrough verdict converts to ask; any other verdict
  // (a plain tool ask, or a tool allow with its updatedInput) stands.
  const resolved: PermissionDecision =
    toolVerdict.behavior === 'passthrough'
      ? {
          ...toolVerdict,
          behavior: 'ask' as const,
          message: createPermissionRequestMessage(
            tool.name,
            toolVerdict.decisionReason,
          ),
        }
      : toolVerdict

  if (resolved.behavior === 'ask' && resolved.suggestions) {
    logForDebugging(
      `Permission suggestions for ${tool.name}: ${jsonStringify(resolved.suggestions, null, 2)}`,
    )
  }

  return decided('resolution', resolved, `verdict: ${toolVerdict.behavior}`)
}

/**
 * The input an allow decision should carry forward: the verdict's
 * updatedInput when that variant carries one, otherwise the call's original
 * input unchanged.
 */
function getUpdatedInputOrFallback(
  permissionResult: PermissionResult,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  return (
    ('updatedInput' in permissionResult
      ? permissionResult.updatedInput
      : undefined) ?? fallback
  )
}
