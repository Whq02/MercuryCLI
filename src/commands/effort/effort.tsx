import * as React from 'react'
import { paintStatusRowReceipt } from '../../components/SwitchboardTagBar.js'
import { LOCAL_COMMAND_STDOUT_TAG } from '../../constants/xml.js'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  EFFORT_LEVELS,
  getDisplayedEffortLabel,
  getEffortEnvOverride,
  getEffortLevelDescription,
  getEffortValueDescription,
  modelSupportsEffort,
  normalizeEffortLevelString,
  parseEffortValue,
  resolveEffortTruth,
  resolveStampedEffortTruth,
  toPersistableEffort,
  unpinAllLaunchEffort,
  type EffortLevel,
  type EffortValue,
} from '../../utils/effort.js'
import { createCommandInputMessage, createUserMessage } from '../../utils/messages.js'
import { renderModelName } from '../../utils/model/model.js'
import { formatCommandLoadingMetadata } from '../../utils/processUserInput/processSlashCommand.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import { CommandPopupLease } from '../../components/CommandPopupSlot.js'
import { claimCommandPopup } from '../../utils/cockpit/commandPopup.js'
import { EffortApplyContext, EffortPopup, effortPopupShape } from './EffortPopup.js'

const OPTION_LIST = `${EFFORT_LEVELS.join('|')}|auto`

const EFFORT_ENV_VAR = 'MERCURY_EFFORT_LEVEL'

export type EffortCommandResult = {
  message: string

  effortUpdate?: { value: EffortValue | undefined }
}

function rawOverrideValue(): string {
  return process.env[EFFORT_ENV_VAR] ?? ''
}

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
  if (truth.flooredBy === 'thinking-off') {
    return {
      headline: `${model} sends ${truth.wire} while thinking is off (its effort dial is its reasoning dial, and ${truth.wire} is the lowest it serves); ${level} was ${savedClause} and applies once thinking is on.`,
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

export function executeEffort(args: string, model: string): EffortCommandResult {
  const token = args.toLowerCase()

  if (token === 'auto' || token === 'unset') {
    const { error } = updateSettingsForSource('userSettings', { engine: { effort: undefined } })
    if (error) {
      return { message: `Could not clear the effort settings: ${error.message}` }
    }

    unpinAllLaunchEffort()
    const override = getEffortEnvOverride()
    const message =
      override !== undefined && override !== null
        ? `Effort settings cleared — but ${EFFORT_ENV_VAR}=${rawOverrideValue()} still controls this session.`
        : 'Effort is now automatic.'
    return {
      message,
      effortUpdate: { value: undefined },
    }
  }

  const level = normalizeEffortLevelString(token)
  if (level === undefined) {
    return { message: `Valid options: ${OPTION_LIST} — "${args}" is not an effort option.` }
  }

  const persistable = toPersistableEffort(level) !== undefined
  if (persistable) {
    const { error } = updateSettingsForSource('userSettings', { engine: { effort: toPersistableEffort(level) } })
    if (error) {
      return { message: `Could not save the effort level: ${error.message}` }
    }
  }
  unpinAllLaunchEffort()

  const override = getEffortEnvOverride()
  if (override !== undefined && override !== level) {
    const message = persistable
      ? `Saved ${level} as your default, but ${EFFORT_ENV_VAR}=${rawOverrideValue()} overrides this session — clear it to let ${level} take over.`
      : `${level} was not applied: ${EFFORT_ENV_VAR}=${rawOverrideValue()} controls this session, and ${level} is session-only, so nothing was saved.`
    return { message, effortUpdate: { value: level } }
  }

  const truth = appliedTruth(model, level, persistable)
  let message: string
  if (truth.headline) {
    message = truth.headline
  } else {

    message = persistable
      ? `Effort set to ${level} — saved as your default for future sessions.${truth.trailing ?? ''}`
      : `Effort set to ${level} for this session only (this level is not persisted).${truth.trailing ?? ''}`
  }
  return {
    message,
    effortUpdate: { value: level },
  }
}

export function showSeatEffort(word: string | null | undefined, sent: string | null | undefined, model: string): string {
  if (!modelSupportsEffort(model)) return `Effort is automatic — ${model} takes no effort setting.`
  const value = word === null || word === undefined ? undefined : parseEffortValue(word)
  if (value === undefined) {
    return `Effort is automatic — this session carries no effort word; currently ${resolveStampedEffortTruth(model, undefined).label} on ${model}.`
  }

  if (sent === undefined) {
    return `Effort is ${String(value)} (asked; the seat has not sent a request yet): ${getEffortValueDescription(value, model)}.`
  }
  const runs = sent

  const clause =
    runs === null
      ? ` (${model} runs its provider default this session)`
      : runs !== String(value)
        ? ` (it runs ${runs} on ${model})`
        : ''
  return `Effort is ${String(value)}${clause} — ${getEffortValueDescription(value, model)}.`
}

export function showCurrentEffort(
  storedEffortValue: EffortValue | undefined,
  model: string,
): EffortCommandResult {
  const override = getEffortEnvOverride()
  const effective =
    override === null ? undefined : override !== undefined ? override : storedEffortValue

  const truth = resolveEffortTruth(model, storedEffortValue)
  if (!truth.supportsEffort) {

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
  } else if (truth.flooredBy === 'thinking-off') {
    clause = ` ${model} sends ${truth.wire} while thinking is off — the lowest effort it serves.`
  } else if (truth.wire === undefined) {
    clause = ` ${model} runs its provider default this session.`
  } else if (truth.label !== String(effective)) {
    clause = ` It runs ${truth.label} on ${model}.`
  }
  return {
    message: `Effort is ${String(effective)} — ${getEffortValueDescription(effective, model)}.${clause}`,
  }
}

function helpText(): string {
  const lines = [`Usage: /effort [${OPTION_LIST}]`]
  for (const level of EFFORT_LEVELS) {
    lines.push(`  ${level.padEnd(9)} ${getEffortLevelDescription(level)}`)
  }
  lines.push("  auto      use the model's default")
  return lines.join('\n')
}

function applyEffortResult(result: EffortCommandResult, context: LocalJSXCommandContext): void {
  context.setAppState(prev => {
    let next: AppState = prev
    if (result.effortUpdate) {
      next = { ...next, effortValue: result.effortUpdate.value }
    }
    return next
  })
}

type EffortReceipt = { text: string; seat: boolean }

async function settleEffortResult(result: EffortCommandResult, context: LocalJSXCommandContext): Promise<EffortReceipt> {
  const focused = getFocusedSessionConnector()
  if (focused.carrier !== 'daemon' || result.effortUpdate === undefined) {
    applyEffortResult(result, context)
    return { text: result.message, seat: false }
  }
  const model = context.options.engineModel
  const level = toPersistableEffort(result.effortUpdate.value)
  if (level === undefined) {

    const word = focused.modelFacts().effort
    return { text: `Effort settings cleared for future sessions — this session keeps running ${word ?? 'its own word'}; pick a level to change it.`, seat: true }
  }
  const receipt = await focused.setEffort(level)
  const saved = ' Saved as your default for future sessions.'
  if (receipt.state === 'refused') {
    return { text: `${level} was not applied to this session: ${receipt.detail}.${saved}`, seat: true }
  }

  applyEffortResult(result, context)
  if (receipt.state === 'no-op') return { text: `Already on ${level} — nothing to change.`, seat: true }
  if (receipt.state === 'queued') {
    return { text: `Effort switch queued: ${level} applies when this session's turn settles — the running turn keeps its effort.${saved}`, seat: true }
  }

  if (!modelSupportsEffort(model)) {
    return { text: `${renderModelName(model)} takes no effort setting — ${level} is kept for the next model that takes one.${saved}`, seat: true }
  }
  return { text: `Effort set to ${level} for this session — its next request runs it.${saved}`, seat: true }
}

function receiptOnStatusRow(receipt: EffortReceipt): boolean {
  return receipt.seat && paintStatusRowReceipt(receipt.text)
}

function receiptInChat(receipt: EffortReceipt, args: string): boolean {
  if (!receipt.seat) return false
  const chat = getFocusedSessionConnector() as { addDisplayRow?: (row: Message) => void }
  if (typeof chat.addDisplayRow !== 'function') return false
  chat.addDisplayRow(createUserMessage({ content: formatCommandLoadingMetadata('effort', args) }))
  chat.addDisplayRow(createCommandInputMessage(`<${LOCAL_COMMAND_STDOUT_TAG}>${receipt.text}</${LOCAL_COMMAND_STDOUT_TAG}>`))
  return true
}

function deliverEffortReceipt(receipt: EffortReceipt, onDone: LocalJSXCommandOnDone, args: string): void {
  if (receiptOnStatusRow(receipt) || receiptInChat(receipt, args)) {
    onDone(undefined, { display: 'skip' })
    return
  }
  onDone(receipt.text)
}

function SessionPopup({
  context,
  onDone,
}: {
  context: LocalJSXCommandContext
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const model = context.options.engineModel
  return (
    <EffortApplyContext.Provider
      value={value => {
        const result = executeEffort(String(value), model)
        return settleEffortResult(result, context).then(receipt => (receiptOnStatusRow(receipt) || receiptInChat(receipt, String(value)) ? '' : receipt.text))
      }}
    >
      <EffortPopup onDone={message => (message === '' ? onDone(undefined, { display: 'skip' }) : onDone(message))} />
    </EffortApplyContext.Provider>
  )
}

const HELP_TOKENS = new Set(['help', '-h', '--help'])

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const trimmed = args.trim()
  const model = context.options.engineModel

  if (HELP_TOKENS.has(trimmed.toLowerCase())) {
    onDone(helpText())
    return null
  }

  if (trimmed) {
    const token = trimmed.toLowerCase()
    if (token === 'current' || token === 'status') {
      const focused = getFocusedSessionConnector()
      const seat = focused.modelFacts()
      onDone(
        focused.carrier === 'daemon'
          ? showSeatEffort(seat.effort, seat.effortSent, model)
          : showCurrentEffort(context.getAppState().effortValue, model).message,
      )
      return null
    }
    const result = executeEffort(trimmed, model)
    deliverEffortReceipt(await settleEffortResult(result, context), onDone, trimmed)
    return null
  }

  const token = claimCommandPopup(effortPopupShape(model))
  return (
    <CommandPopupLease token={token}>
      <SessionPopup context={context} onDone={onDone} />
    </CommandPopupLease>
  )
}
