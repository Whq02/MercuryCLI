import * as React from 'react'
import { MercurySupercodeDivider } from '../../components/MercurySupercodeDivider.js'
import type { AppState } from '../../state/AppState.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  effortFamiliesLabel,
  getDisplayedEffortLabel,
  getEffortEnvOverride,
  getEffortLevelDescription,
  getEffortValueDescription,
  modelSupportsMaxEffort,
  normalizeEffortLevelString,
  resolveEffortTruth,
  toPersistableEffort,
  unpinAllLaunchEffort,
  type EffortLevel,
  type EffortValue,
} from '../../utils/effort.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import { EffortApplyContext, EffortSlider } from './EffortSlider.js'

/** The advertised option list (the hint's own order). */
const OPTION_LIST = 'low|medium|high|xhigh|max|supercode|auto'

/** The env override's raw spelling is user-visible (contract data). */
const EFFORT_ENV_VAR = 'MERCURY_EFFORT_LEVEL'

export type EffortCommandResult = {
  message: string
  /** Absent means "leave unchanged". */
  effortUpdate?: { value: EffortValue | undefined }
  supercodeUpdate?: { value: boolean }
}

function rawOverrideValue(): string {
  return process.env[EFFORT_ENV_VAR] ?? ''
}

/**
 * The applied-truth clause (step 5): the confirmation may name the
 * user's request as what will be applied only when the live model will in
 * fact apply exactly that; whenever the model substitutes, ignores or
 * defaults, this says so — the setting is still stored as requested and
 * follows the user to the next model.
 */
function appliedTruth(
  model: string,
  level: EffortLevel,
  persisted: boolean,
): { headline?: string; trailing?: string } {
  const truth = resolveEffortTruth(model, level)
  const savedClause = persisted ? 'saved as your default' : 'saved for this session'
  if (!truth.supportsEffort) {
    return {
      headline: `${model} takes no effort setting — your choice of ${level} was ${savedClause} and will apply to the next effort-capable model.`,
    }
  }
  if (truth.suppressedBy === 'thinking-off') {
    return {
      headline: `${model} sends no effort dial while thinking is off (its effort dial is its reasoning dial), so it runs its provider default this session; ${level} was ${savedClause} and applies once thinking is on.`,
    }
  }
  if (truth.wire === undefined) {
    return {
      headline: `${model} applies its provider default this session (no live effort vocabulary to resolve against); ${level} was ${savedClause} for effort-capable models.`,
    }
  }
  if (truth.label !== level) {
    return {
      trailing: ` (${model} runs ${truth.label}, the nearest tier in its effort vocabulary)`,
    }
  }
  return {}
}

/**
 * The pure decision core: (args, currentModel) → message + updates. The
 * argument arrives trimmed; it is lower-cased here.
 */
export function executeEffort(args: string, model: string): EffortCommandResult {
  const token = args.toLowerCase()

  if (token === 'auto' || token === 'unset') {
    const { error } = updateSettingsForSource('userSettings', {
      effortLevel: undefined,
      supercodeEffort: undefined,
    })
    if (error) {
      return { message: `Could not clear the effort settings: ${error.message}` }
    }
    // An explicit choice must never be re-overridden by a freshly launched
    // model's pin.
    unpinAllLaunchEffort()
    const override = getEffortEnvOverride()
    const message =
      override !== undefined && override !== null
        ? `Effort settings cleared — but ${EFFORT_ENV_VAR}=${rawOverrideValue()} still controls this session.`
        : 'Effort is now automatic.'
    return {
      message,
      effortUpdate: { value: undefined },
      supercodeUpdate: { value: false },
    }
  }

  if (token === 'supercode') {
    if (!modelSupportsMaxEffort(model)) {
      const families = effortFamiliesLabel(modelSupportsMaxEffort)
      const familyClause = families ? ` (${families})` : ''
      return {
        message: `${model} does not support the maximum effort tier, and supercode runs at max. Switch to a max-capable model${familyClause} first. Options: ${OPTION_LIST}.`,
      }
    }
    const { error } = updateSettingsForSource('userSettings', {
      effortLevel: 'max',
      supercodeEffort: true,
    })
    if (error) {
      return { message: `Could not save the supercode setting: ${error.message}` }
    }
    unpinAllLaunchEffort()
    return {
      message:
        'SUPERCODE is on, and persists as your default for new sessions. It means the maximum effort tier plus a standing expectation of dynamic orchestration — authoring and running subagents and fleets for substantive work — in service of the most thorough correct answer.',
      effortUpdate: { value: 'max' },
      supercodeUpdate: { value: true },
    }
  }

  const level = normalizeEffortLevelString(token)
  if (level === undefined) {
    return { message: `"${args}" is not an effort option. Valid options: ${OPTION_LIST}.` }
  }

  // setting a level.
  const persistable = toPersistableEffort(level) !== undefined
  if (persistable) {
    // Mutual exclusion with the supercode default, one settings write.
    const { error } = updateSettingsForSource('userSettings', {
      effortLevel: toPersistableEffort(level),
      supercodeEffort: undefined,
    })
    if (error) {
      return { message: `Could not save the effort level: ${error.message}` }
    }
  }
  unpinAllLaunchEffort()

  const override = getEffortEnvOverride()
  if (override !== undefined && override !== level) {
    // The early return deliberately emits NO supercode update.
    const message = persistable
      ? `Saved ${level} as your default, but ${EFFORT_ENV_VAR}=${rawOverrideValue()} overrides this session — clear it to let ${level} take over.`
      : `${level} was not applied: ${EFFORT_ENV_VAR}=${rawOverrideValue()} controls this session, and ${level} is session-only, so nothing was saved.`
    return { message, effortUpdate: { value: level } }
  }
  // Override equal to the request: say nothing about it — the outcome is
  // the same and the note would be noise.

  const truth = appliedTruth(model, level, persistable)
  let message: string
  if (truth.headline) {
    message = truth.headline
  } else {
    // Persistence is said EXPLICITLY in both directions.
    message = persistable
      ? `Effort set to ${level} — saved as your default for future sessions.${truth.trailing ?? ''}`
      : `Effort set to ${level} for this session only (this level is not persisted).${truth.trailing ?? ''}`
  }
  return {
    message,
    effortUpdate: { value: level },
    // An explicit level deactivates the mode.
    supercodeUpdate: { value: false },
  }
}

/** The `current`/`status` readout. */
export function showCurrentEffort(
  storedEffortValue: EffortValue | undefined,
  model: string,
): EffortCommandResult {
  const override = getEffortEnvOverride()
  const effective =
    override === null ? undefined : override !== undefined ? override : storedEffortValue
  // Observed detail reproduced knowingly: the applied-truth resolution runs
  // against the STORED value, not the effective one (item 11).
  const truth = resolveEffortTruth(model, storedEffortValue)
  if (!truth.supportsEffort) {
    // Honest absence — the readout used to print the first-party default
    // word as if the model ran it ("currently high on hf/…").
    return {
      message:
        effective === undefined
          ? `Effort is automatic — ${model} takes no effort setting.`
          : `Effort is ${String(effective)} — ${model} takes no effort setting, so nothing is sent; the setting applies to the next effort-capable model.`,
    }
  }
  if (effective === undefined) {
    return {
      message: `Effort is automatic — currently ${getDisplayedEffortLabel(model, undefined)} on ${model}.`,
    }
  }
  let clause = ''
  if (truth.suppressedBy === 'thinking-off') {
    clause = ` ${model} sends no effort dial while thinking is off — it runs its provider default this session.`
  } else if (truth.wire === undefined) {
    clause = ` ${model} runs its provider default this session.`
  } else if (truth.label !== String(effective)) {
    clause = ` It runs ${truth.label} on ${model}.`
  }
  return {
    message: `Effort is ${String(effective)} — ${getEffortValueDescription(effective, model)}.${clause}`,
  }
}

/** Help, in the fixed order (xhigh after max). */
function helpText(): string {
  const lines = [`Usage: /effort [${OPTION_LIST}]`]
  const order: EffortLevel[] = ['low', 'medium', 'high', 'max', 'xhigh']
  for (const level of order) {
    lines.push(`  ${level.padEnd(9)} ${getEffortLevelDescription(level)}`)
  }
  lines.push(
    '  supercode max effort plus standing dynamic-orchestration doctrine — session-scoped in effect, mutually exclusive with a co-set level',
  )
  lines.push("  auto      use the model's default")
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Apply-side effects (both apply paths)
// ---------------------------------------------------------------------------

function applyEffortResult(result: EffortCommandResult, context: LocalJSXCommandContext): void {
  const wasSupercodeOn = context.getAppState().supercode === true
  context.setAppState(prev => {
    let next: AppState = prev
    if (result.effortUpdate) {
      next = { ...next, effortValue: result.effortUpdate.value }
    }
    if (result.supercodeUpdate) {
      next = { ...next, supercode: result.supercodeUpdate.value }
    }
    return next
  })
  if (result.supercodeUpdate?.value === true && !wasSupercodeOn) {
    // One-shot, auto-clearing divider marking the activation.
    context.addNotification?.({
      key: 'supercode-mode',
      jsx: <MercurySupercodeDivider />,
      priority: 'immediate',
      timeoutMs: 6000,
    })
  }
}

// ---------------------------------------------------------------------------
// Interactive
// ---------------------------------------------------------------------------

function SessionSlider({
  context,
  onDone,
}: {
  context: LocalJSXCommandContext
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const model = context.options.mainLoopModel
  return (
    <EffortApplyContext.Provider
      value={value => {
        const result =
          value === 'supercode'
            ? executeEffort('supercode', model)
            : executeEffort(String(value), model)
        applyEffortResult(result, context)
        return result.message
      }}
    >
      <EffortSlider onDone={message => onDone(message)} />
    </EffortApplyContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const HELP_TOKENS = new Set(['help', '-h', '--help'])

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const trimmed = args.trim()
  const model = context.options.mainLoopModel

  if (HELP_TOKENS.has(trimmed.toLowerCase())) {
    onDone(helpText())
    return null
  }

  if (trimmed) {
    const token = trimmed.toLowerCase()
    if (token === 'current' || token === 'status') {
      onDone(showCurrentEffort(context.getAppState().effortValue, model).message)
      return null
    }
    const result = executeEffort(trimmed, model)
    applyEffortResult(result, context)
    onDone(result.message)
    return null
  }

  return <SessionSlider context={context} onDone={onDone} />
}
