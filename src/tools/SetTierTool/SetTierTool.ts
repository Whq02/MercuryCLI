
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
    return (
      isAutopilotEnabled() &&
      !getIsNonInteractiveSession()
    )
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  async validateInput(input, context) {
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
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call(input, context) {
    const rails = autopilotRailsSnapshot()
    const base = {
      switchesUsed: rails.switches,
      switchCap: MAX_SWITCHES_PER_SESSION,
    }
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
