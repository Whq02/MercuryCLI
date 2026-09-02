// ============================================================================
//  SetTier — the autopilot self-serve tier control (stamp-only).
//
//  Joins the pool ONLY while the session mode is 'autopilot' (the pool gate in
//  utils/toolPool.ts — the plan-mode narrowing pattern) and refuses at call
//  time if the mode moved on (the pool is a visibility optimization, the
//  live-state check here is the authority). Main-session thread only —
//  subagents inherit the bypass POSTURE of autopilot, never the tier controls.
//
//  Mechanics live in utils/autopilot/tierState.ts (closed key table, operator
//  allowlist, effort clamped to the target model's ceiling, cooldown, session
//  cap). scope:'session' writes the SAME AppState fields the /model picker
//  owns (mainLoopModel + effortValue) so the pickers always show the truth
//  and always override; scope:'turn' lands in the thread-keyed override slot
//  the query loop applies and reverts (tierTurnEnded in query()'s finally).
//
//  Deviation note (recorded): the design sketch named an evolution-ledger row
//  per switch; the ledger's validated outcome vocabulary (baseline/improved/…
//  + the evidence gate) is improvement-program semantics — an event row would
//  misfit its written contract. The switch is surfaced twice instead: the ⇅
//  transcript line (persisted in the session JSONL) + the modeBand readout.
// ============================================================================

import { z } from 'zod/v4'
import { buildTool, type Tool, type ToolDef } from '../../Tool.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import {
  AUTOPILOT_TIER_KEYS,
  isAutopilotEnabled,
} from '../../utils/autopilot/autopilotGates.js'
import {
  autopilotRailsSnapshot,
  MAX_SWITCHES_PER_SESSION,
  recordSwitch,
  setTurnOverride,
  validateTierChange,
} from '../../utils/autopilot/tierState.js'
import { EFFORT_LEVELS, type EffortLevel } from '../../utils/effort.js'
import { settleModelSelection } from '../../utils/model/modelTransition.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { SET_TIER_TOOL_NAME } from './constants.js'
import { SET_TIER_TOOL_DESCRIPTION, SET_TIER_TOOL_PROMPT } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    model: z
      .enum(AUTOPILOT_TIER_KEYS)
      .optional()
      .describe(
        'Tier key — resolves to the family default model, preserving the session 1M-context posture. Subject to the operator allowlist.',
      ),
    effort: z
      .enum(EFFORT_LEVELS)
      .optional()
      .describe(
        "Reasoning effort — clamped to the target model's ceiling; the deepthink floor and MERCURY_EFFORT_LEVEL still win.",
      ),
    scope: z
      .enum(['turn', 'session'])
      .describe(
        "'turn' reverts at the end of the current turn; 'session' persists (operator can retune via /model).",
      ),
    reason: z
      .string()
      .describe(
        'One line, surfaced to the operator verbatim — why this tier fits the next stretch of work.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

export interface Output {
  ok: boolean
  line?: string
  refused?: string
  appliedModel?: string
  appliedEffort?: EffortLevel
  scope?: 'turn' | 'session'
  switchesUsed: number
  switchCap: number
}

export const SetTierTool: Tool<InputSchema, Output> = buildTool({
  name: SET_TIER_TOOL_NAME,
  searchHint:
    'retune own model/effort tier (autopilot mode only): opus/sonnet, effort low..max, turn or session scope',
  maxResultSizeChars: 20_000,
  async description() {
    return SET_TIER_TOOL_DESCRIPTION
  },
  async prompt() {
    return SET_TIER_TOOL_PROMPT
  },
  userFacingName,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isEnabled() {
    // Fork + opt-in flag + interactive. The MODE gate lives in the pool
    // (toolPool.ts) and in validateInput below — isEnabled() is nullary and
    // must stay mode-blind so getTools() stays pure of app-state reads.
    return (
      isAutopilotEnabled() &&
      !getIsNonInteractiveSession()
    )
  },
  isConcurrencySafe() {
    return false // serializes against itself — tier state is shared
  },
  isReadOnly() {
    return false
  },
  async validateInput(input, context) {
    // Main-session thread only. Subagents inherit autopilot's bypass POSTURE
    // (runAgent keeps the parent mode) but never the tier controls.
    if (context.agentId) {
      return {
        result: false as const,
        message: 'SetTier is main-session only — subagents cannot retune tiers.',
        errorCode: 1,
      }
    }
    const mode = context.getAppState().toolPermissionContext.mode
    if (mode !== 'autopilot') {
      return {
        result: false as const,
        message:
          'SetTier is only available in autopilot mode. The operator controls the tier everywhere else (/model).',
        errorCode: 1,
      }
    }
    if (!input.model && !input.effort) {
      return {
        result: false as const,
        message: 'Nothing to change — pass model and/or effort.',
        errorCode: 1,
      }
    }
    return { result: true as const }
  },
  async checkPermissions(input) {
    // Autopilot IS a bypass-posture mode — the main permission flow
    // auto-allows every call in it; the rails + surfacing are the control.
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call(input, context) {
    const rails = autopilotRailsSnapshot()
    const base = {
      switchesUsed: rails.switches,
      switchCap: MAX_SWITCHES_PER_SESSION,
    }
    // Re-check the mode at execution time — the pool gate and validateInput
    // ran earlier; the operator may have cycled away since (shift+tab races).
    const appState = context.getAppState()
    if (appState.toolPermissionContext.mode !== 'autopilot') {
      return {
        data: {
          ok: false,
          refused: 'the session left autopilot mode before this call executed',
          ...base,
        },
      }
    }
    // The live session model: AppState when the picker set one, else the
    // resolved runtime model this query is running on.
    const currentModel =
      appState.mainLoopModel ?? context.options.mainLoopModel
    const verdict = validateTierChange(
      {
        model: input.model,
        effort: input.effort,
        scope: input.scope,
        reason: input.reason,
      },
      currentModel,
      appState.effortValue,
    )
    if (!verdict.ok) {
      return { data: { ok: false, refused: verdict.refused, ...base } }
    }
    if (input.scope === 'session') {
      // the model half settles through the ONE owner
      // (settleModelSelection) — the same patch + exactly-once receipt every
      // other apply path mints. W1 ruling: autopilot applies between
      // model calls (a tool call separates two requests — a legal boundary),
      // so turnActive is false here and the boundary is 'autopilot-tool'.
      // The owner's applied patch also clears a parked pendingModelSwitch
      // (last-chosen wins — the switch-epoch law; the receipt keeps
      // it visible, never silent). Settlement is computed INSIDE the
      // functional update (the REPL race-safe apply pattern). Effort-only
      // changes stay a plain effortValue write: no model re-choice, no
      // receipt, a parked switch stays parked.
      context.setAppState(prev => {
        const settled =
          verdict.applied.model !== undefined
            ? settleModelSelection(prev, verdict.applied.model, {
                turnActive: false,
                boundary: 'autopilot-tool',
              })
            : null
        return {
          ...prev,
          ...(settled?.patch ?? {}),
          ...(verdict.applied.effort !== undefined && {
            effortValue: verdict.applied.effort,
          }),
        }
      })
    } else {
      setTurnOverride(context.agentId, verdict.applied)
    }
    recordSwitch()
    const after = autopilotRailsSnapshot()
    return {
      data: {
        ok: true,
        line: verdict.line,
        appliedModel: verdict.applied.model,
        appliedEffort: verdict.applied.effort,
        scope: input.scope,
        switchesUsed: after.switches,
        switchCap: MAX_SWITCHES_PER_SESSION,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseId: string) {
    if (!output.ok) {
      return {
        tool_use_id: toolUseId,
        type: 'tool_result' as const,
        content: `Tier change refused: ${output.refused}. Continue on the current tier — do not retry the same request. (${output.switchesUsed}/${output.switchCap} switches used.)`,
      }
    }
    const scopeNote =
      output.scope === 'turn'
        ? 'Reverts automatically at the end of this turn.'
        : 'Persists for the session; the operator can retune via /model.'
    return {
      tool_use_id: toolUseId,
      type: 'tool_result' as const,
      content: `Tier changed: ${[
        output.appliedModel,
        output.appliedEffort && `@${output.appliedEffort}`,
      ]
        .filter(Boolean)
        .join(' ')} (${output.scope}). ${scopeNote} Switches used: ${output.switchesUsed}/${output.switchCap}. The change takes effect on the next API call.`,
    }
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output>)
