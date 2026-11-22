import * as React from 'react'
import { useState, useSyncExternalStore } from 'react'
import { useClaim, useLayoutPublish } from '../../hooks/effects.js'
import { Box, Text, useInput, wrapText } from '../../ink.js'
import { PopupForm } from '../PopupForm.js'
import { usePopupListPaging } from '../CustomSelect/popup-list.js'
import {
  jevMaxCallUsd,
  jevRoadWords,
  type JevRoad,
  JEV_SUBAGENT_CALL_BUDGET,
  JEV_SUBAGENT_PACE_PER_MINUTE,
  JEV_USD_PER_INPUT_TOKEN,
  type JevStatus,
  jevClockLabel,
  jevUsdLabel,
} from '../../services/jev/jevContract.js'
import { JEV_KEY_ENV, type JevKeyPresence, jevKeyPresence, jevKeySourceWords, storeJevApiKey } from '../../services/jev/jevKey.js'
import { type JevSessionFacts, jevSessionAbsenceShortWords, jevSessionAbsenceWords, jevSessionFacts, jevSessionFactsStamp, jevSessionStatus, subscribeJevSessionFacts } from '../../services/jev/jevSessionFacts.js'
import {
  JEV_DEFAULT_ALLOWANCE_USD,
  JEV_DEFAULT_PACE_PER_MINUTE,
  type JevSettings,
  jevReceiptWords,
  jevSettingLines,
  jevValueWords,
  readJevSettings,
  setJevAllowanceUsd,
  setJevEnabled,
  setJevRoad,
  setJevPacePerMinute,
  setJevRequestCeiling,
  setJevSubagents,
} from '../../services/jev/jevSetting.js'
import { JEV_STATUS_HEADWORDS, jevStatusLine } from '../../services/jev/jevStatus.js'
import { openrouterObservedKeyUsage } from '../../services/providers/openrouter/openrouterUsageState.js'
import type { JevFactsV1 } from '../../services/engine-connector/types.js'
import { getGlobalConfigCacheStamp, subscribeGlobalConfigCache } from '../../utils/config/globalConfig.js'
import { GLYPH } from '../../utils/glyphs.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { useOpenEventGate } from '../mercury-ui/useOpenEventGate.js'
import TextInput from '../TextInput.js'
import { hostEnv } from '../../utils/hostEnv.js'
import { notBuilt } from '../../pi/holes.js'

export const JEV_POPUP_WIDTH = 120
export const JEV_POPUP_HINT = '↑↓ select · pgup/pgdn page · ←→ change · ↵ act · ⌫ default · esc or click outside closes'
export const JEV_SPEND_LABEL = "Mercury's count — the provider publishes no balance"
export const JEV_ALLOWANCE_RUNGS: readonly number[] = [1, 2, 5, 10, 20, 50, 100, 200]
export const JEV_CEILING_RUNGS: readonly number[] = [10, 20, 50, 100, 200, 500]
export const JEV_ROW_MARK = GLYPH.chevronRight
export const JEV_COMPACT_BELOW = 20
const LABEL_CELLS = 18

export interface JevCardDemand {
  rowBudget: number
  controlRows: number
  statusRows: number
  noteRows: number
  receiptRows: number | null
  promptRows: number | null
}

export interface JevCardPlan {
  compact: boolean
  status: boolean
  note: boolean
  receipt: boolean
  prompt: boolean
  input: boolean
}

export function jevTextRows(text: string, width: number): number {
  return width <= 0 ? 1 : wrapText(text, width, 'wrap').split('\n').length
}

export function jevCardPlan(demand: JevCardDemand): JevCardPlan {
  const budget = Math.max(1, demand.rowBudget)
  const compact = budget < JEV_COMPACT_BELOW
  const statusBlock = compact ? 1 : demand.statusRows + 1
  const noteRows = compact ? 1 : demand.noteRows
  const receiptRows = demand.receiptRows === null ? null : compact ? 1 : demand.receiptRows
  const promptRows = demand.promptRows === null ? null : compact ? 1 : demand.promptRows
  let left = budget - demand.controlRows - (compact ? 0 : 2)
  const take = (rows: number): boolean => {
    if (rows > left) return false
    left -= rows
    return true
  }
  if (promptRows !== null) {
    const input = take(1)
    const prompt = input && take(promptRows)
    return { compact, status: take(statusBlock), note: false, receipt: false, prompt, input }
  }
  const receipt = receiptRows !== null && take(receiptRows)
  let note = receiptRows === null && take(noteRows)
  const status = take(statusBlock)
  if (receiptRows !== null && !note) note = take(noteRows)
  return { compact, status, note, receipt, prompt: false, input: false }
}

export function jevSpendLabel(road: JevRoad): string {
  return road === 'openrouter' ? "OpenRouter states each call's cost; unstated costs use the token rate" : JEV_SPEND_LABEL
}

export function jevCreditsWords(road: JevRoad): string {
  if (road === 'official') return 'not reported by the provider'
  const { usage, lastError } = openrouterObservedKeyUsage()
  if (usage?.limitRemaining === undefined) return 'not yet reported'
  const amount = usage.limitRemaining === null ? 'no key cap' : `${jevUsdLabel(usage.limitRemaining)} under key cap`
  return `${amount} (read ${jevClockLabel(usage.observedAtMs)}${lastError ? ', stale' : ''})`
}

export type JevRowId = 'switch' | 'road' | 'key' | 'spend' | 'allowance' | 'pace' | 'ceiling' | 'subagents'
export const JEV_ROWS: readonly JevRowId[] = ['switch', 'road', 'key', 'spend', 'allowance', 'pace', 'ceiling', 'subagents']
export const JEV_ROW_LABELS: Readonly<Record<JevRowId, string>> = {
  switch: 'Switch',
  road: 'Road',
  key: 'Key',
  spend: 'Spend',
  allowance: 'Allowance',
  pace: 'Pace',
  ceiling: 'Request ceiling',
  subagents: 'Crewmates',
}

export type JevFacts = { settings: JevSettings; key: JevKeyPresence; session: JevSessionFacts; status: JevStatus }

export function jevFacts(session: JevSessionFacts = jevSessionFacts()): JevFacts {
  const settings = readJevSettings()
  const key = jevKeyPresence()
  return { settings, key, session, status: jevSessionStatus(session, settings, key) }
}

export function jevSpendWords(facts: JevFactsV1): string {
  return `spend so far: ${jevUsdLabel(facts.spendUsd)} · ${facts.calls} call${facts.calls === 1 ? '' : 's'} · ${facts.unconfirmedCharges} unconfirmed`
}

export function jevLastAnswerWords(facts: JevFactsV1): string | null {
  if (facts.lastFailure) return `last call: ${facts.lastFailure.status !== undefined ? `HTTP ${facts.lastFailure.status}` : 'no HTTP status'} · ${facts.lastFailure.detail}${facts.lastFailure.requestId ? ` · id ${facts.lastFailure.requestId}` : ''}`
  if (facts.lastAnsweredAtMs === null) return null
  return `last answered ${jevClockLabel(facts.lastAnsweredAtMs)}${facts.lastModel !== null ? ` · ${facts.lastModel}` : ''}${facts.lastCostUsd != null ? ` · stated $${facts.lastCostUsd}` : ''}${facts.lastRequestId ? ` · id ${facts.lastRequestId}` : ''}`
}

export function jevSessionSpendWords(session: JevSessionFacts): string {
  if (session.state !== 'reported') return jevSessionAbsenceWords(session)
  return jevSpendWords(session.facts)
}

function settingValue(line: string): string {
  const at = line.indexOf(': ')
  return at < 0 ? line : line.slice(at + 2)
}

export function jevRowValues(settings: JevSettings): { allowance: string; pace: string; ceiling: string; subagents: string; doors: string } {
  const [allowance, pace, ceiling, subagents, doors] = jevSettingLines(settings)
  return {
    allowance: settingValue(allowance ?? ''),
    pace: settingValue(pace ?? ''),
    ceiling: settingValue(ceiling ?? ''),
    subagents: settingValue(subagents ?? ''),
    doors: doors ?? '',
  }
}

export function jevRowWords(id: JevRowId, facts: JevFacts): string {
  const values = jevRowValues(facts.settings)
  switch (id) {
    case 'switch':
      return facts.settings.enabled ? 'on' : 'off'
    case 'road':
      return facts.settings.road === 'official' ? '[official] · OpenRouter' : 'official · [OpenRouter]'
    case 'key':
      return jevKeySourceWords(facts.key, facts.settings.road)
    case 'spend':
      return jevSessionSpendWords(facts.session)
    case 'allowance':
      return values.allowance
    case 'pace':
      return values.pace
    case 'ceiling':
      return values.ceiling
    case 'subagents':
      return values.subagents
  }
}

const RATE_WORDS = `$${(JEV_USD_PER_INPUT_TOKEN * 1_000_000).toFixed(3)} a million input tokens, output free`

export function jevRowNote(id: JevRowId, road: JevRoad = readJevSettings().road): string {
  const maxCall = jevMaxCallUsd(road)
  switch (id) {
    case 'switch':
      return '↵, space or ←/→ flip the one switch — the same switch as the JEV row of /config and the JEV row of the Boot Menu; JevEval joins or leaves the roster at the next turn boundary and never answers a permission request'
    case 'road':
      return '↵ or ←/→ selects official · OpenRouter, without changing the switch; each keeps its own key, spend and cap. /jev on selects official; /jev or on selects OpenRouter. No automatic fallback.'
    case 'key':
      if (road === 'openrouter') return 'OpenRouter uses the existing sign-in or pasted key from /logins; OPENROUTER_API_KEY outranks the store. Manage it at /logins; this card never stores an OpenRouter key as a TypeSafe key.'
      return `↵ pastes a TypeSafe API key (masked; the value never enters the transcript, receipts or logs) · ⌫ clears the stored key · ${JEV_KEY_ENV} in the environment outranks the store · Mercury ships no key`
    case 'spend':
      return `${jevSpendLabel(road)} · credits: ${jevCreditsWords(road)} — published rate (${RATE_WORDS}); an unconfirmed charge is a call whose answer Mercury did not read (a timeout or an unreadable reply), counted at the most a call can cost (${jevUsdLabel(maxCall)}) · resets with the cost ledger on /clear`
    case 'allowance':
      return `a runaway stop, not a budget (one call costs at most ${jevUsdLabel(maxCall)}; the pace and the request ceiling do the real work) · ←/→ walk ${JEV_ALLOWANCE_RUNGS.map(usd => jevUsdLabel(usd)).join(' · ')} · ↵ types a dollar amount · ⌫ returns to ${jevUsdLabel(JEV_DEFAULT_ALLOWANCE_USD)}`
    case 'pace':
      return `main-model requests admitted a minute; past it a request is refused with the wait until the minute turns · ←/→ move by one · ↵ types a count · ⌫ returns to ${JEV_DEFAULT_PACE_PER_MINUTE}`
    case 'ceiling':
      return `an optional cap on requests a session, off by default; the count resets with the cost ledger on /clear · ←/→ walk off · ${JEV_CEILING_RUNGS.join(' · ')} · ↵ types a count or off · ⌫ returns to off`
    case 'subagents':
      return `on by default, off by choice: JevEval is offered to crewmates unless you turn this row off · on: each crewmate may make ${JEV_SUBAGENT_CALL_BUDGET} calls; all crewmates share ${JEV_SUBAGENT_PACE_PER_MINUTE} a minute per session, separate from the main pace, counted on the same allowance · ↵, space or ←/→ flip it`
  }
}

export function jevKeyShortWords(key: JevKeyPresence, road: JevRoad = readJevSettings().road): string {
  if (!key.present) return 'no key'
  if (road === 'openrouter') return key.source === 'env' ? 'key from env' : key.source === 'oauth' ? 'signed in' : 'key stored'
  return key.source === 'env' ? `key from ${JEV_KEY_ENV}` : 'key stored'
}

export function jevPopupLine(facts: JevFacts = jevFacts()): string {
  const spend = facts.session.state === 'reported' ? `spend ${jevUsdLabel(facts.session.facts.spendUsd)} / ${jevUsdLabel(facts.settings.allowanceUsd)}` : `${jevSessionAbsenceShortWords(facts.session)} · cap ${jevUsdLabel(facts.settings.allowanceUsd)}`
  return `${jevValueWords(facts.settings)} · ${jevKeyShortWords(facts.key, facts.settings.road)} · ${spend} · ${JEV_STATUS_HEADWORDS[facts.status.kind]}`
}

export function nextRung(rungs: readonly number[], current: number, direction: 1 | -1): number {
  if (direction === 1) return rungs.find(rung => rung > current) ?? current
  for (let i = rungs.length - 1; i >= 0; i--) {
    const rung = rungs[i] as number
    if (rung < current) return rung
  }
  return current
}

export function nextCeiling(current: number | null, direction: 1 | -1): number | null {
  if (current === null) return direction === 1 ? (JEV_CEILING_RUNGS[0] as number) : null
  if (direction === -1 && current <= (JEV_CEILING_RUNGS[0] as number)) return null
  return nextRung(JEV_CEILING_RUNGS, current, direction)
}

export function jevKeyStoredReceipt(): string {
  const envShadow = Boolean(hostEnv()[JEV_KEY_ENV]?.trim())
  return `TypeSafe API key stored (auth-scoped, mode 600)${envShadow ? ` — ${JEV_KEY_ENV} outranks the store` : ''} · ⌫ on the Key row clears it`
}

export function jevKeyClearedReceipt(hadKey: boolean): string {
  const envShadow = Boolean(hostEnv()[JEV_KEY_ENV]?.trim())
  const tail = envShadow ? ` · ${JEV_KEY_ENV} in the environment still supplies a key this session` : ''
  return hadKey ? `stored TypeSafe API key cleared (auth-scoped)${tail}` : `no stored TypeSafe API key — nothing to clear${tail}`
}

export const JEV_KEY_ENTRY_PROMPT = 'Paste the TypeSafe API key — input is masked (the last 6 characters stay visible so you can confirm the paste); the value never enters the transcript, receipts or logs. ↵ saves the key; esc cancels.'

type JevEntryKind = 'key' | 'allowance' | 'pace' | 'ceiling'
type JevEntry = { kind: JevEntryKind; value: string; cursor: number }
type JevReceipt = { words: string; refused: boolean }

function entryPrompt(kind: JevEntryKind, facts: JevFacts): string {
  switch (kind) {
    case 'key':
      return JEV_KEY_ENTRY_PROMPT
    case 'allowance':
      return `Type the session allowance in dollars (now ${jevUsdLabel(facts.settings.allowanceUsd)}); ↵ saves, esc cancels.`
    case 'pace':
      return `Type the requests admitted a minute (now ${facts.settings.pacePerMinute}); ↵ saves, esc cancels.`
    case 'ceiling':
      return `Type the request ceiling for a session, or off (now ${jevRowValues(facts.settings).ceiling}); ↵ saves, esc cancels.`
  }
}

function refusalWords(error: unknown, typed: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/not NaN$/, `not ${JSON.stringify(typed)}`)
}

export function Jev(arg0: {
  width: number
  rowBudget: number
  onLine?: (line: string) => void
  onOwnsEscape?: (owns: boolean) => void
}): React.ReactNode {
  return notBuilt('src/components/Settings/Jev.tsx:274')
}
