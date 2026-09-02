/**
 * Mode wrapper — the second band of the permission decision path.
 *
 * The engine chain (decision/engine.ts) answers from rules and tool verdicts
 * alone; this band then reads the PERMISSION MODE and finishes the job.
 * decideToolPermissionWithModes owns five outcomes:
 *   • an engine allow rides through (in auto mode it also clears any running
 *     denial streak on the way);
 *   • an ask under dontAsk becomes a deny, unconditionally;
 *   • an ask under auto (or under plan while auto is engaged) is answered by
 *     machinery instead of a prompt — but only after a series of floors that
 *     reserve certain asks for humans, and two fast-paths that make the
 *     cheap cases skip the classifier entirely;
 *   • a classifier block in a session that can show a consent card returns
 *     to the operator AS that card (the same card as default mode, carrying
 *     the verdict's reason); a session without a card gets the deny, and
 *     nothing here ever turns a block into an allow;
 *   • an ask in a context that cannot prompt is offered to PermissionRequest
 *     hooks, and denied when none of them answers.
 *
 * Every stage consulted lands in a WrapperTrace. Because stages are gated by
 * mode, a given trace is an ordered subsequence of WRAPPER_STAGE_ORDER with
 * holes — unlike the engine band, whose trace is a strict prefix (trace.ts).
 * Side effects and policy reads hide behind WrapperPorts; tests inject their
 * own, production uses defaultWrapperPorts.
 */
import { APIUserAbortError } from '../../../services/api/sdkErrors.js'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../../Tool.js'
import { AGENT_TOOL_NAME } from '../../../tools/AgentTool/constants.js'
import { POWERSHELL_TOOL_NAME } from '../../../tools/PowerShellTool/toolName.js'
import { REPL_TOOL_NAME } from '../../../tools/REPLTool/constants.js'
import type { AssistantMessage } from '../../../types/message.js'
import { logForDebugging } from '../../debug.js'
import { AbortError, toError } from '../../errors.js'
import { logError } from '../../log.js'

// require(), not import, for these two: the auto-mode state and the
// classifier allowlist are consulted from inside the hot decision path and
// loading them lazily keeps the module graph acyclic under the bundler.
const classifierDecisionModule =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('../classifierDecision.js') as typeof import('../classifierDecision.js'))
const autoModeStateModule =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('../autoModeState.js') as typeof import('../autoModeState.js'))
// The Workflow tool imports permission helpers from permissions.ts, which in
// turn loads this module — a static import here would close that cycle. The
// two symbols we need (the tool's name and its dynamic-enablement probe) are
// pulled through require so the cycle stays broken at build level.
const workflowModule = {
  WORKFLOW_TOOL_NAME: (
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../../tools/WorkflowTool/constants.js') as typeof import('../../../tools/WorkflowTool/constants.js')
  ).WORKFLOW_TOOL_NAME,
  dynamicWorkflowsEnabled: (
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../../tools/WorkflowTool/workflowEnablement.js') as typeof import('../../../tools/WorkflowTool/workflowEnablement.js')
  ).dynamicWorkflowsEnabled,
}
// The fast-path danger filter leans on the shared danger classifier trio and
// the permission-rule parser. permissionSetup sits upstream of modules that
// reach back into this decision band, so both ride the same lazy-require
// convention to keep the module graph acyclic.
const permissionSetupModule =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('../permissionSetup.js') as typeof import('../permissionSetup.js'))
const permissionRuleParserModule =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('../permissionRuleParser.js') as typeof import('../permissionRuleParser.js'))

import { addToTurnClassifierDuration } from '../../../bootstrap/state.js'
import { getFeatureValue_CACHED_WITH_REFRESH } from '../../../services/analytics/featureGates.js'
import {
  clearClassifierChecking,
  setClassifierChecking,
} from '../../classifierApprovals.js'
import { executePermissionRequestHooks } from '../../hooks.js'
import {
  AUTO_REJECT_MESSAGE,
  buildClassifierUnavailableMessage,
  buildFlowBlockDeclinedMessage,
  buildYoloRejectionMessage,
  DONT_ASK_REJECT_MESSAGE,
} from '../../messages.js'
import {
  createDenialTrackingState,
  DENIAL_LIMITS,
  type DenialTrackingState,
  recordDenial,
  recordSuccess,
  shouldFallbackToPrompting,
} from '../denialTracking.js'
import {
  operatorDeclinedFlowBlockThisTurn,
  writeDenialState,
} from '../flowBlockReview.js'
import type {
  PermissionAskDecision,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionResult,
} from '../PermissionResult.js'
import {
  applyPermissionUpdates,
  persistPermissionUpdates,
} from '../PermissionUpdate.js'
import type { PermissionUpdate } from '../PermissionUpdateSchema.js'
import {
  classifyYoloActionWithFallback,
  formatActionForClassifier,
  type TranscriptEntry,
} from '../yoloClassifier.js'
import { decideRuleBasedPermissions, decideToolPermission } from './engine.js'
import type {
  DecisionTrace,
  WrapperStageId,
  WrapperStageRecord,
  WrapperTrace,
} from './trace.js'

/** How long a cached fail-closed-posture read stays fresh before re-fetch. */
const IRON_GATE_REFRESH_MS = 30 * 60 * 1000 // 30 minutes

//
// Reason probes — the auto-mode floors that force a human prompt BEFORE the
// classifier can run. Each is a boundary the classifier must not override.
//

/**
 * Whether an explicit ASK rule hides anywhere inside this decision reason.
 * The search is recursive because compound shell invocations report one
 * nested result per subcommand — and a single asking subcommand must pin the
 * whole invocation to a human.
 */
function reasonCarriesAskRule(
  reason: PermissionDecisionReason | undefined,
): boolean {
  if (reason === undefined) return false
  if (reason.type === 'rule') return reason.rule.ruleBehavior === 'ask'
  if (reason.type !== 'subcommandResults') return false
  for (const sub of reason.reasons.values()) {
    if (sub.behavior === 'ask' && reasonCarriesAskRule(sub.decisionReason)) {
      return true
    }
  }
  return false
}

/** True when the ask came from the strategy-mode floor itself. */
function reasonIsPlanFloor(
  reason: PermissionDecisionReason | undefined,
): boolean {
  return reason?.type === 'mode' && reason.mode === 'strategy'
}

/**
 * Whether this invocation is a dynamic Workflow whose usage still needs a
 * human's yes. Dynamic workflows carry their own script glue into the local
 * VM — and if the wrapper is looking at an 'ask' for one, no allow rule
 * matched it (rule allows decide back in the engine band). Nothing automated
 * gets to green-light that combination; not the allowlist, not the
 * classifier.
 */
function workflowRequiresConsent(toolName: string): boolean {
  return (
    workflowModule != null &&
    toolName === workflowModule.WORKFLOW_TOOL_NAME &&
    workflowModule.dynamicWorkflowsEnabled()
  )
}

//
// Hook-allow guard.
//

/**
 * The anti-laundering check on hook allows. A PermissionRequest hook may
 * answer 'allow' AND swap in a different input — and that swapped input has
 * never been past the rules. Left unchecked, that is a full bypass: wrap a
 * forbidden action inside a permissive hook and it sails through. So the
 * caller re-runs the rule subset over the rewritten input and feeds the
 * verdict here: any deny or ask verdict is returned (and logged) to OVERRIDE
 * the hook; null means the rules had no objection and the allow may stand.
 */
export function guardHookUpdatedInput(
  recheckedDecision:
    | PermissionAskDecision
    | PermissionDenyDecision
    | PermissionDecision
    | null,
  toolName: string,
): PermissionAskDecision | PermissionDenyDecision | null {
  if (
    recheckedDecision?.behavior === 'deny' ||
    recheckedDecision?.behavior === 'ask'
  ) {
    logError(
      new Error(
        `PermissionRequest hook allowed ${toolName} with updatedInput, but a ${recheckedDecision.behavior} rule overrides: ${recheckedDecision.message}`,
      ),
    )
    return recheckedDecision
  }
  return null
}

//
// Prompt-less (headless) PermissionRequest hooks.
//

/**
 * Where no prompt can be shown, hooks are the last voice before the
 * auto-deny: iterate the PermissionRequest hooks and return the first real
 * verdict. Null means every hook stayed silent and the caller should fall
 * through to its deny.
 */
async function consultHeadlessPermissionHooks(
  tool: Tool,
  input: { [key: string]: unknown },
  toolUseID: string,
  context: ToolUseContext,
  permissionMode: string | undefined,
  suggestions: PermissionUpdate[] | undefined,
): Promise<PermissionDecision | null> {
  try {
    for await (const hookResult of executePermissionRequestHooks(
      tool.name,
      toolUseID,
      input,
      context,
      permissionMode,
      suggestions,
      context.abortController.signal,
    )) {
      const verdict = hookResult.permissionRequestResult
      if (verdict === undefined) continue

      if (verdict.behavior === 'deny') {
        if (verdict.interrupt) {
          logForDebugging(
            `Hook interrupt: tool=${tool.name} hookMessage=${verdict.message}`,
          )
          context.abortController.abort()
        }
        return {
          behavior: 'deny',
          message: verdict.message || 'A PermissionRequest hook denied this action',
          decisionReason: {
            type: 'hook',
            hookName: 'PermissionRequest',
            reason: verdict.message,
          },
        }
      }

      if (verdict.behavior !== 'allow') continue

      const finalInput = verdict.updatedInput ?? input

      // Rewritten input goes back through the rules before the allow counts
      // — the anti-laundering check (guardHookUpdatedInput).
      if (verdict.updatedInput) {
        const recheck = await decideRuleBasedPermissions(tool, finalInput, context)
        const override = guardHookUpdatedInput(recheck.decision, tool.name)
        if (override) {
          // There is nobody to ask in this context — an 'ask' objection can
          // only land as a deny.
          if (override.behavior === 'ask') {
            return {
              behavior: 'deny',
              message: override.message,
              decisionReason: override.decisionReason ?? {
                type: 'other',
                reason: 'ask rule on hook-rewritten input',
              },
            }
          }
          return override
        }
      }

      if (verdict.updatedPermissions?.length) {
        persistPermissionUpdates(verdict.updatedPermissions)
        context.setAppState(prev => ({
          ...prev,
          toolPermissionContext: applyPermissionUpdates(
            prev.toolPermissionContext,
            verdict.updatedPermissions!,
          ),
        }))
      }
      return {
        behavior: 'allow',
        updatedInput: finalInput,
        decisionReason: {
          type: 'hook',
          hookName: 'PermissionRequest',
        },
      }
    }
  } catch (error) {
    // Hook machinery failures read as silence — the decision path itself
    // must survive any hook.
    logError(
      new Error('PermissionRequest hook machinery failed in a prompt-less session', {
        cause: toError(error),
      }),
    )
  }
  return null
}

//
// Denial tracking.
//

/** The review line for a ledger at (or past) a limit. Read before any write:
 *  for subagent-local ledgers the settle below mutates this very object. */
function ledgerReviewWarning(denialState: DenialTrackingState): string {
  const hitTotalLimit = denialState.totalDenials >= DENIAL_LIMITS.maxTotal
  return hitTotalLimit
    ? `${denialState.totalDenials} actions were blocked this session — review the transcript before continuing.`
    : `${denialState.consecutiveDenials} consecutive actions were blocked — review the transcript before continuing.`
}

/** The total-limit trip zeroes the ledger (a whole-session review is about
 *  to happen); tripping only the consecutive limit leaves the running total
 *  in place. */
function settleLedgerAtLimit(
  denialState: DenialTrackingState,
  context: ToolUseContext,
): void {
  if (denialState.totalDenials >= DENIAL_LIMITS.maxTotal) {
    writeDenialState(context, {
      ...denialState,
      totalDenials: 0,
      consecutiveDenials: 0,
    })
  }
}

/**
 * The ledger's review note for a consent card. Null while the ledger is
 * under both limits; at a limit, the warning the operator reads on the card
 * beside the classifier's reason — and the ledger settles.
 */
function denialLedgerReview(
  denialState: DenialTrackingState,
  context: ToolUseContext,
): string | null {
  if (!shouldFallbackToPrompting(denialState)) return null
  const warning = ledgerReviewWarning(denialState)
  settleLedgerAtLimit(denialState, context)
  return warning
}

/**
 * Post-block ledger check for a session with no consent card. Enough
 * classifier blocks — consecutive or total — and machine denial stops being
 * useful; this converts the freshest block into an 'ask' whose message asks
 * for review. Null when the ledger is still under both limits. A context
 * with no human aborts instead: it can neither review nor break the loop.
 */
function denialCapFallback(
  denialState: DenialTrackingState,
  appState: {
    toolPermissionContext: { shouldAvoidPermissionPrompts?: boolean }
  },
  blockedReason: string,
  engineAsk: PermissionDecision,
  context: ToolUseContext,
): PermissionDecision | null {
  if (!shouldFallbackToPrompting(denialState)) {
    return null
  }

  if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
    throw new AbortError(
      'Run aborted: flow-classifier denial limit reached with no prompt available',
    )
  }

  const warning = ledgerReviewWarning(denialState)
  logForDebugging(
    `Flow-classifier denial limit tripped — handing the next decision to the operator: ${warning}`,
    { level: 'warn' },
  )
  settleLedgerAtLimit(denialState, context)

  // The reason keeps whichever classifier tag produced the block; the
  // user-override analytics event downstream is keyed by that tag.
  const originalClassifier =
    engineAsk.decisionReason?.type === 'classifier'
      ? engineAsk.decisionReason.classifier
      : 'auto-mode'

  return {
    ...engineAsk,
    decisionReason: {
      type: 'classifier',
      classifier: originalClassifier,
      reason: `${warning}\n\nLatest blocked action: ${blockedReason}`,
    },
  }
}

//
// Fast-path danger filter.
//

/**
 * The accept-edits fast-path re-poses the question against the LIVE rule
 * sets — so a dangerous prefix-allow that the auto-mode entry stripper
 * missed (or that arrived after entry) would let the fast-path green-light
 * arbitrary code execution without the classifier ever seeing it. Before the
 * probe runs, every always-allow entry the danger classifier trio marks is
 * hidden from the view the probe receives. Only the fast-path's view is
 * filtered: the stored permission context, app state, and every other
 * consumer see the rules unchanged. Deny/ask layers are untouched — they can
 * only make the probe stricter.
 */
function hideDangerousAllowsFromView(context: ToolUseContext): {
  viewContext: ToolUseContext
  hiddenCount: number
} {
  const allowLayers = context.getAppState().toolPermissionContext.alwaysAllowRules
  if (!allowLayers) return { viewContext: context, hiddenCount: 0 }

  // An entry is hidden when ANY of the three markers claims it — the same
  // trio the auto-mode entry stripper consults.
  const isDangerousEntry = (entry: string): boolean => {
    const { toolName, ruleContent } =
      permissionRuleParserModule.permissionRuleValueFromString(entry)
    return (
      permissionSetupModule.isDangerousBashPermission(toolName, ruleContent) ||
      permissionSetupModule.isDangerousPowerShellPermission(toolName, ruleContent) ||
      permissionSetupModule.isDangerousTaskPermission(toolName, ruleContent)
    )
  }

  let hiddenCount = 0
  const trimmedLayers: {
    -readonly [K in keyof typeof allowLayers]?: (typeof allowLayers)[K]
  } = {}
  for (const source of Object.keys(allowLayers) as Array<keyof typeof allowLayers>) {
    const entries = allowLayers[source]
    if (!entries) continue
    const kept = entries.filter(entry => {
      if (!isDangerousEntry(entry)) return true
      hiddenCount++
      return false
    })
    if (kept.length !== entries.length) trimmedLayers[source] = kept
  }
  // Nothing excluded ⇒ the probe runs with the original context object — no
  // gratuitous re-wrapping.
  if (hiddenCount === 0) return { viewContext: context, hiddenCount: 0 }

  // Overlay the filtered permission context onto the context the probe port
  // receives; the port's signature does not change, so injected test ports
  // keep compiling.
  const viewContext: ToolUseContext = {
    ...context,
    getAppState: () => {
      const live = context.getAppState()
      return {
        ...live,
        toolPermissionContext: {
          ...live.toolPermissionContext,
          alwaysAllowRules: { ...allowLayers, ...trimmedLayers },
        },
      }
    },
  }
  return { viewContext, hiddenCount }
}

//
// Ports.
//

/** The classifier verdict shape the wrapper consumes (fallback-wrapped). */
export type WrapperClassifierResult = Awaited<
  ReturnType<typeof classifyYoloActionWithFallback>
>

/** Every effect and policy read the band performs, as one injectable seam. */
export interface WrapperPorts {
  /** Whether strategy mode currently has flow engaged underneath it. */
  isAutoModeActive(): boolean
  /** Membership test for the always-safe tool set (classifier not needed). */
  isAllowlistedTool(
    toolName: string,
    input: { action?: unknown; actions?: unknown } | null,
  ): boolean
  /** Ask the tool itself how it would rule under implement mode. May throw:
   *  abort classes are rethrown by the band, everything else just forfeits
   *  the shortcut. */
  resolveAcceptEditsVerdict(
    tool: Tool,
    input: Record<string, unknown>,
    context: ToolUseContext,
  ): Promise<PermissionResult>
  /** The flow-classifier call (already fallback-wrapped). */
  classify(
    context: ToolUseContext,
    action: TranscriptEntry,
    permissionContext: ToolPermissionContext,
    signal: AbortSignal,
  ): Promise<WrapperClassifierResult>
  /** Whether an unreachable classifier means deny (true) or hand-off to the
   *  human path (false). */
  ironGateClosed(): boolean
  /** Offer the decision to PermissionRequest hooks where no prompt exists. */
  runHeadlessHooks(
    tool: Tool,
    input: { [key: string]: unknown },
    toolUseID: string,
    context: ToolUseContext,
    permissionMode: string | undefined,
    suggestions: PermissionUpdate[] | undefined,
  ): Promise<PermissionDecision | null>
}

export const defaultWrapperPorts: WrapperPorts = {
  isAutoModeActive: () => autoModeStateModule?.isAutoModeActive() ?? false,
  isAllowlistedTool: (toolName, input) =>
    classifierDecisionModule!.isAutoModeAllowlistedTool(toolName, input),
  resolveAcceptEditsVerdict: async (tool, input, context) => {
    const parsedInput = tool.inputSchema.parse(input)
    // The probe context overlays implement mode on a FRESH state read per
    // call; everything else about the context is preserved.
    const probeContext: ToolUseContext = {
      ...context,
      getAppState: () => {
        const live = context.getAppState()
        return {
          ...live,
          toolPermissionContext: {
            ...live.toolPermissionContext,
            mode: 'implement' as const,
          },
        }
      },
    }
    return tool.checkPermissions(parsedInput, probeContext)
  },
  // The fallback wrapper matters here: when the main-loop model is metered
  // or degraded, safety checks in auto mode would otherwise all fail with
  // it. Unavailable-class errors walk a chain of healthy models before any
  // fail-closed answer is given.
  classify: (context, action, permissionContext, signal) =>
    classifyYoloActionWithFallback(
      context.messages,
      action,
      context.options.tools,
      permissionContext,
      signal,
    ),
  ironGateClosed: () =>
    getFeatureValue_CACHED_WITH_REFRESH(
      'mercury_iron_gate_closed',
      true,
      IRON_GATE_REFRESH_MS,
    ),
  runHeadlessHooks: consultHeadlessPermissionHooks,
}

export interface FullDecisionOutcome {
  decision: PermissionDecision
  engineTrace: DecisionTrace
  wrapper: WrapperTrace
}

//
// The complete decision path.
//

/**
 * The whole decision, both bands: engine chain first, mode wrapper second.
 * Interactive and prompt-less callers alike come through here (via the
 * hasPermissionsToUseTool adapter), so the two session kinds can never
 * drift apart.
 */
export async function decideToolPermissionWithModes(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
  ports: WrapperPorts = defaultWrapperPorts,
): Promise<FullDecisionOutcome> {
  void assistantMessage // call-shape compatibility; the wrapper never reads it
  const engineOutcome = await decideToolPermission(tool, input, context)
  const engineDecision = engineOutcome.decision
  const engineTrace = engineOutcome.trace

  // Trace bookkeeping. `recordPass` logs a consulted stage that let the
  // decision move on; `decide` logs the deciding stage and assembles the
  // outcome; `passThrough` hands an untouched engine decision on.
  const stageLog: WrapperStageRecord[] = []
  const recordPass = (stage: WrapperStageId, note?: string): void => {
    stageLog.push(
      note ? { stage, outcome: 'pass', note } : { stage, outcome: 'pass' },
    )
  }
  const decide = (
    stage: WrapperStageId,
    decision: PermissionDecision,
    note?: string,
  ): FullDecisionOutcome => {
    stageLog.push(
      note ? { stage, outcome: 'decided', note } : { stage, outcome: 'decided' },
    )
    return { decision, engineTrace, wrapper: { stages: stageLog, decidedBy: stage } }
  }
  const passThrough = (decision: PermissionDecision): FullDecisionOutcome => ({
    decision,
    engineTrace,
    wrapper: { stages: stageLog, decidedBy: 'engine' },
  })

  // In flow, any allow ends a running streak of consecutive denials —
  // rule-produced allows count too, not only classifier verdicts.
  if (engineDecision.behavior === 'allow') {
    const appState = context.getAppState()
    const currentDenialState =
      context.localDenialTracking ?? appState.denialTracking
    if (
      appState.toolPermissionContext.mode === 'flow' &&
      currentDenialState &&
      currentDenialState.consecutiveDenials > 0
    ) {
      writeDenialState(context, recordSuccess(currentDenialState))
      recordPass('allowDenialReset', 'denial streak reset on allow')
    }
    return passThrough(engineDecision)
  }

  if (engineDecision.behavior === 'ask') {
    const appState = context.getAppState()

    // Under dontAsk there are no questions, only answers: ask ⇒ deny.
    // Sitting after the engine keeps this rule un-sidesteppable.
    if (appState.toolPermissionContext.mode === 'dontAsk') {
      return decide('dontAskConversion', {
        behavior: 'deny',
        decisionReason: {
          type: 'mode',
          mode: 'dontAsk',
        },
        message: DONT_ASK_REJECT_MESSAGE(tool.name),
      })
    }

    // Flow (or strategy running with flow engaged): machinery answers the
    // ask. This branch deliberately precedes the prompt-less band — a
    // headless session in flow gets the classifier, not the blanket deny.
    if (
      appState.toolPermissionContext.mode === 'flow' ||
      (appState.toolPermissionContext.mode === 'strategy' &&
        ports.isAutoModeActive())
    ) {
      const headless =
        appState.toolPermissionContext.shouldAvoidPermissionPrompts
      // Whether this session can put a consent card in front of the
      // operator: neither a prompt-less agent nor a non-interactive (print)
      // run. Those two keep the deny path for a classifier block.
      const cardAvailable =
        !headless && context.options.isNonInteractiveSession !== true

      // Floor 1 — a safety check flagged non-approvable is off limits to
      // every automated yes in this band: no probe, no allowlist, no
      // classifier. The approvable kind (sensitive-file detections) does
      // continue on toward the classifier, and can't sneak out through a
      // fast-path — the tool's own re-resolution still says 'ask'.
      if (
        engineDecision.decisionReason?.type === 'safetyCheck' &&
        !engineDecision.decisionReason.classifierApprovable
      ) {
        if (headless) {
          return decide(
            'autoSafetyImmunity',
            {
              behavior: 'deny',
              message: engineDecision.message,
              decisionReason: {
                type: 'asyncAgent',
                reason:
                  'This safety check needs interactive approval, and this session cannot present a prompt',
              },
            },
            'headless — structured deny',
          )
        }
        return decide('autoSafetyImmunity', engineDecision, 'human ask stands')
      }
      recordPass('autoSafetyImmunity')

      // Floor 2 — tools that declare themselves human-in-the-loop keep
      // their ask.
      if (tool.requiresUserInteraction?.()) {
        return decide('autoUserInteraction', engineDecision)
      }
      recordPass('autoUserInteraction')

      // Floor 3 — four reasons an ask belongs to the human even in auto
      // mode, each checked before the fast-paths as much as before the
      // classifier:
      //   • somebody wrote an ask RULE that matched (possibly on a nested
      //     subcommand);
      //   • org/MCP policy caps this tool at ask — a ceiling automation may
      //     not raise;
      //   • the ask is plan mode's own floor;
      //   • the tool is a dynamic Workflow still owed a usage-consent
      //     prompt for its local VM glue.
      const floorTags: string[] = []
      if (reasonCarriesAskRule(engineDecision.decisionReason)) {
        floorTags.push('ask-rule')
      }
      if (tool.mcpInfo?.effectiveMaxPermission === 'ask') {
        floorTags.push('org-ceiling')
      }
      if (reasonIsPlanFloor(engineDecision.decisionReason)) {
        floorTags.push('plan-floor')
      }
      if (workflowRequiresConsent(tool.name)) {
        floorTags.push('workflow-consent')
      }
      if (floorTags.length > 0) {
        if (headless) {
          return decide(
            'autoFloors',
            {
              behavior: 'deny',
              message: engineDecision.message,
              decisionReason: {
                type: 'asyncAgent',
                reason:
                  'This action needs interactive approval, and this session cannot present a prompt',
              },
            },
            'headless — structured deny',
          )
        }
        return decide('autoFloors', engineDecision, floorTags.join('+'))
      }
      recordPass('autoFloors')

      // The denial ledger used by everything below. Subagent-local when the
      // context carries one, app state otherwise, fresh when neither.
      const denialState =
        context.localDenialTracking ??
        appState.denialTracking ??
        createDenialTrackingState()

      // Floor 4 — PowerShell asks stay with the human; the classifier does
      // not hear them. (Its one-liner fetch-and-run idioms are exactly the
      // shape machine review gets wrong.) Rule-based allows for PowerShell
      // still worked earlier in the engine band; sanitizing over-broad or
      // dangerous PowerShell rules is permission-setup's job, not this
      // band's.
      if (tool.name === POWERSHELL_TOOL_NAME) {
        if (headless) {
          return decide(
            'powershellGuard',
            {
              behavior: 'deny',
              message: 'PowerShell runs only with interactive approval',
              decisionReason: {
                type: 'asyncAgent',
                reason:
                  'PowerShell runs only with interactive approval, and this session cannot present a prompt',
              },
            },
            'headless — structured deny',
          )
        }
        logForDebugging(
          `Flow classifier not consulted for ${tool.name}: its asks are reserved for the operator`,
        )
        return decide('powershellGuard', engineDecision, 'human ask stands')
      }
      recordPass('powershellGuard')

      // Fast-path 1 — re-pose the question as if the mode were implement.
      // A yes there (a workspace-local edit, typically) makes the classifier
      // round-trip pure cost. Two tools are barred from this shortcut: Agent
      // and REPL both answer yes under implement mode wholesale, and the
      // REPL's script glue is precisely the content that must not skip review.
      if (tool.name !== AGENT_TOOL_NAME && tool.name !== REPL_TOOL_NAME) {
        // The danger filter runs first: dangerous prefix-allows are hidden
        // from the probe's view, so a poisoned allow rule cannot turn the
        // fast-path into an arbitrary-execution green light. On a filter
        // outage the iron-gate posture picks the failure mode: closed skips
        // the fast-path entirely (the safe direction), open probes the
        // unfiltered view.
        let probeContext: ToolUseContext | null = context
        try {
          const view = hideDangerousAllowsFromView(context)
          probeContext = view.viewContext
          recordPass(
            'fastPathDangerFilter',
            view.hiddenCount > 0
              ? `${view.hiddenCount} dangerous prefix-allow rule(s) hidden from fast-path view`
              : undefined,
          )
        } catch {
          if (ports.ironGateClosed()) {
            recordPass(
              'fastPathDangerFilter',
              'danger classifier outage — fail closed; fast-path skipped',
            )
            probeContext = null
          } else {
            recordPass(
              'fastPathDangerFilter',
              'danger classifier outage — fail open; unfiltered view',
            )
            probeContext = context
          }
        }

        if (probeContext !== null) {
          try {
            const acceptEditsVerdict = await ports.resolveAcceptEditsVerdict(
              tool,
              input,
              probeContext,
            )
            if (acceptEditsVerdict.behavior === 'allow') {
              writeDenialState(context, recordSuccess(denialState))
              logForDebugging(
                `Flow classifier skipped for ${tool.name}: implement mode would allow this outright`,
              )
              return decide('acceptEditsFastPath', {
                behavior: 'allow',
                updatedInput: acceptEditsVerdict.updatedInput ?? input,
                decisionReason: {
                  type: 'mode',
                  mode: 'flow',
                },
              })
            }
          } catch (e) {
            if (e instanceof AbortError || e instanceof APIUserAbortError) {
              throw e
            }
            // Probe broke ⇒ no shortcut; the classifier still decides.
          }
          recordPass('acceptEditsFastPath')
        } else {
          recordPass('acceptEditsFastPath', 'skipped — danger filter outage')
        }
      } else {
        recordPass('acceptEditsFastPath')
      }

      // Fast-path 2 — membership in the always-safe tool set.
      if (
        ports.isAllowlistedTool(
          tool.name,
          input as { action?: unknown; actions?: unknown } | null,
        )
      ) {
        writeDenialState(context, recordSuccess(denialState))
        logForDebugging(
          `Flow classifier skipped for ${tool.name}: always-safe tool set membership`,
        )
        return decide('allowlistFastPath', {
          behavior: 'allow',
          updatedInput: input,
          decisionReason: {
            type: 'mode',
            mode: 'flow',
          },
        })
      }
      recordPass('allowlistFastPath')

      // The classifier itself. The per-toolUseID marker is what the UI's
      // "checking…" affordance watches, so clearing it lives in a finally —
      // a throwing classifier must not leave the marker lit.
      const action = formatActionForClassifier(tool.name, input)
      setClassifierChecking(toolUseID)
      let classifierResult
      try {
        classifierResult = await ports.classify(
          context,
          action,
          appState.toolPermissionContext,
          context.abortController.signal,
        )
      } finally {
        clearClassifierChecking(toolUseID)
      }

      if (classifierResult.durationMs !== undefined) {
        addToTurnClassifierDuration(classifierResult.durationMs)
      }

      if (classifierResult.shouldBlock) {
        // Overflow of the classifier's context window never heals: the
        // transcript can only get longer. So no posture consult and no
        // retry — the human takes the decision, and a session with no human
        // aborts rather than spending tokens on a loop with one outcome.
        if (classifierResult.transcriptTooLong) {
          if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
            throw new AbortError(
              "Run aborted: the flow classifier's transcript outgrew its context window with no prompt available",
            )
          }
          logForDebugging(
            'Flow classifier transcript over the window — handing the ask back to the operator path',
            { level: 'warn' },
          )
          return decide(
            'classifier',
            {
              ...engineDecision,
              decisionReason: {
                type: 'other',
                reason:
                  "The flow classifier's transcript outgrew its context window — this approval returns to you",
              },
            },
            'transcript too long — manual fallback',
          )
        }

        // Unreachable even after the model-fallback chain. With a human
        // present the ask returns to THEM — the consent card, exactly like
        // the transcript-overflow branch above — never a machine-denial loop
        // the operator cannot break (the flow incident: every MCP
        // call denied with retry-spam while the operator watched). Handing
        // the decision to a human is fail-closed; fail-open stays forbidden.
        // Headless keeps the posture gate: closed denies with retry
        // guidance, open returns the ask to the permission channel.
        if (classifierResult.unavailable) {
          if (!headless) {
            logForDebugging(
              'Flow classifier unavailable, falling back to the human ask (interactive)',
              { level: 'warn' },
            )
            return decide(
              'classifier',
              {
                ...engineDecision,
                decisionReason: {
                  type: 'other',
                  reason:
                    'Flow classifier unavailable — falling back to manual approval',
                },
              },
              'unavailable — human ask',
            )
          }
          if (ports.ironGateClosed()) {
            logForDebugging(
              'Flow classifier unreachable — iron gate closed; denying with retry guidance',
              { level: 'warn' },
            )
            return decide(
              'classifier',
              {
                behavior: 'deny',
                decisionReason: {
                  type: 'classifier',
                  classifier: 'auto-mode',
                  reason: 'Classifier unavailable',
                },
                message: buildClassifierUnavailableMessage(
                  tool.name,
                  classifierResult.model,
                ),
              },
              'unavailable — fail closed',
            )
          }
          logForDebugging(
            'Flow classifier unreachable — iron gate open; the ask returns to the operator path',
            { level: 'warn' },
          )
          return decide('classifier', engineDecision, 'unavailable — fail open')
        }

        // A real block. Book it in the ledger first — the counts feed the
        // review warning and the prompt-less run's limits.
        const afterDenial = recordDenial(denialState)
        writeDenialState(context, afterDenial)

        logForDebugging(
          `Flow classifier verdict: blocked — ${classifierResult.reason}`,
          { level: 'warn' },
        )

        // No consent card in this session: the block is a deny the model is
        // told about, and the ledger's limits still end machine denial — an
        // abort where nobody can review, the review ask where somebody can.
        // Runs after classification by design — the review ask quotes the
        // block reason it just produced.
        if (!cardAvailable) {
          const capFallback = denialCapFallback(
            afterDenial,
            appState,
            classifierResult.reason,
            engineDecision,
            context,
          )
          if (capFallback) {
            recordPass('classifier', 'blocked — denial limit reached')
            return decide('denialLimit', capFallback, 'fall back to prompting')
          }

          return decide(
            'classifier',
            {
              behavior: 'deny',
              decisionReason: {
                type: 'classifier',
                classifier: 'auto-mode',
                reason: classifierResult.reason,
              },
              message: buildYoloRejectionMessage(classifierResult.reason),
            },
            'blocked — no consent card in this session',
          )
        }

        // A consent card is available: the block is the operator's decision,
        // never the machine's. The card carries the verdict and its reason;
        // the operator allows once, allows with a rule, or declines — and a
        // decline holds for the rest of the turn: the same action blocked
        // again is denied without a second card.
        if (operatorDeclinedFlowBlockThisTurn(context, tool.name, input)) {
          return decide(
            'classifier',
            {
              behavior: 'deny',
              decisionReason: {
                type: 'classifier',
                classifier: 'auto-mode',
                reason: classifierResult.reason,
              },
              message: buildFlowBlockDeclinedMessage(classifierResult.reason),
            },
            'blocked — the operator declined this action earlier this turn',
          )
        }

        const review = denialLedgerReview(afterDenial, context)
        const askForOperator: PermissionDecision = {
          ...engineDecision,
          decisionReason: {
            type: 'classifier',
            classifier: 'auto-mode',
            reason: review
              ? `${classifierResult.reason}\n\n${review}`
              : classifierResult.reason,
          },
        }
        if (review) {
          recordPass('classifier', 'blocked — denial limit reached')
          return decide(
            'denialLimit',
            askForOperator,
            'the operator is asked, with the review warning',
          )
        }
        return decide('classifier', askForOperator, 'blocked — the operator is asked')
      }

      // Approved. Success also clears any consecutive-denial streak.
      writeDenialState(context, recordSuccess(denialState))

      return decide(
        'classifier',
        {
          behavior: 'allow',
          updatedInput: input,
          decisionReason: {
            type: 'classifier',
            classifier: 'auto-mode',
            reason: classifierResult.reason,
          },
        },
        'allowed',
      )
    }

    // No prompt available and neither auto nor dontAsk applied: hooks speak
    // first, and their silence becomes the deny.
    if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
      const hookDecision = await ports.runHeadlessHooks(
        tool,
        input,
        toolUseID,
        context,
        appState.toolPermissionContext.mode,
        engineDecision.suggestions,
      )
      if (hookDecision) {
        return decide('headlessHooks', hookDecision)
      }
      recordPass('headlessHooks')
      return decide('headlessAutoDeny', {
        behavior: 'deny',
        decisionReason: {
          type: 'asyncAgent',
          reason: 'This session cannot present a permission prompt',
        },
        message: AUTO_REJECT_MESSAGE(tool.name),
      })
    }
  }

  // What remains: denies of every kind, and asks bound for a real prompt
  // (the adapter above this function renders it).
  return passThrough(engineDecision)
}
