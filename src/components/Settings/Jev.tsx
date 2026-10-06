import * as React from 'react'
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput, wrapText } from '../../ink.js'
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
import { GLYPH } from '../mercury-ui/glyphs.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { useOpenEventGate } from '../mercury-ui/useOpenEventGate.js'
import TextInput from '../TextInput.js'

export const JEV_POPUP_WIDTH = 120
export const JEV_POPUP_HINT = '↑↓ select · ←→ change · ↵ act · ⌫ default · esc or click outside closes'
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
      return '↵ or ←/→ selects official · OpenRouter, without changing the switch; each road keeps its own key, spend and cap. /jev on selects official; /jev or on selects OpenRouter. No automatic fallback.'
    case 'key':
      if (road === 'openrouter') return 'OpenRouter uses the existing sign-in or pasted key from /logins; OPENROUTER_API_KEY outranks the store. Manage it at /logins; this card never stores an OpenRouter key as a TypeSafe key.'
      return `↵ pastes a TypeSafe API key (masked; the value never enters the transcript, receipts or logs) · ⌫ clears the stored key · ${JEV_KEY_ENV} in the environment outranks the store · Mercury ships no key`
    case 'spend':
      return `${jevSpendLabel(road)} · credits: ${jevCreditsWords(road)} — published rate (${RATE_WORDS}); an unconfirmed charge is a call whose answer Mercury did not read (a timeout or an unreadable reply), counted at the most a call can cost (${jevUsdLabel(maxCall)}) · resets with the cost ledger on /clear`
    case 'allowance':
      return `a runaway stop, not a budget — one call costs at most ${jevUsdLabel(maxCall)}; the pace and the request ceiling do the real work · ←/→ walk ${JEV_ALLOWANCE_RUNGS.map(usd => jevUsdLabel(usd)).join(' · ')} · ↵ types a dollar amount · ⌫ returns to ${jevUsdLabel(JEV_DEFAULT_ALLOWANCE_USD)}`
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
  const envShadow = Boolean(process.env[JEV_KEY_ENV]?.trim())
  return `TypeSafe API key stored (auth-scoped, mode 600)${envShadow ? ` — ${JEV_KEY_ENV} outranks the store` : ''} · ⌫ on the Key row clears it`
}

export function jevKeyClearedReceipt(hadKey: boolean): string {
  const envShadow = Boolean(process.env[JEV_KEY_ENV]?.trim())
  const tail = envShadow ? ` · ${JEV_KEY_ENV} in the environment still supplies a key this session` : ''
  return hadKey ? `stored TypeSafe API key cleared (auth-scoped)${tail}` : `no stored TypeSafe API key — nothing to clear${tail}`
}

export const JEV_KEY_ENTRY_PROMPT = 'Paste the TypeSafe API key — input is masked (the last 6 characters stay visible so you can confirm the paste); the value never enters the transcript, receipts or logs. ↵ saves to the auth-scoped secret store; esc cancels.'

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

export function Jev({
  width,
  rowBudget,
  onLine,
  onOwnsEscape,
}: {
  width: number
  rowBudget: number
  onLine?: (line: string) => void
  onOwnsEscape?: (owns: boolean) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const pastOpenEvent = useOpenEventGate()
  useSyncExternalStore(subscribeGlobalConfigCache, getGlobalConfigCacheStamp, getGlobalConfigCacheStamp)
  useSyncExternalStore(subscribeJevSessionFacts, jevSessionFactsStamp, jevSessionFactsStamp)
  const [version, setVersion] = useState(0)
  void version
  const bump = (): void => setVersion(v => v + 1)
  const [selected, setSelected] = useState(0)
  const [entry, setEntry] = useState<JevEntry | null>(null)
  const [receipt, setReceipt] = useState<JevReceipt | null>(null)
  const facts = jevFacts()
  const line = jevPopupLine(facts)
  useLayoutEffect(() => {
    onLine?.(line)
  }, [line, onLine])
  const entryOpen = entry !== null
  useEffect(() => {
    onOwnsEscape?.(entryOpen)
    return () => onOwnsEscape?.(false)
  }, [entryOpen, onOwnsEscape])

  const settle = (write: () => string, typed = ''): void => {
    try {
      setReceipt({ words: write(), refused: false })
    } catch (error) {
      setReceipt({ words: refusalWords(error, typed), refused: true })
    }
    bump()
  }
  const moveTo = (next: number): void => setSelected(Math.max(0, Math.min(next, JEV_ROWS.length - 1)))
  const openEntry = (kind: JevEntryKind): void => setEntry({ kind, value: '', cursor: 0 })
  const toggleSwitch = (): void => settle(() => jevReceiptWords(setJevEnabled(!facts.settings.enabled)))
  const toggleSubagents = (): void => settle(() => `crewmates ${jevRowValues(setJevSubagents(!facts.settings.subagents)).subagents}`)
  const toggleRoad = (): void => settle(() => {
    const settings = setJevRoad(facts.settings.road === 'official' ? 'openrouter' : 'official')
    return `${jevRoadWords(settings.road)} road selected — ${settings.enabled ? 'on' : 'off'}; its own key, spend and allowance; no fallback`
  })
  const routerKeyReceipt = (): void => setReceipt({ words: 'Manage the OpenRouter sign-in or pasted key at /logins; no key written here', refused: false })

  const activate = (index: number): void => {
    const id = JEV_ROWS[index]
    if (id === 'switch') toggleSwitch()
    else if (id === 'road') toggleRoad()
    else if (id === 'key' && facts.settings.road === 'openrouter') routerKeyReceipt()
    else if (id === 'subagents') toggleSubagents()
    else if (id === 'key' || id === 'allowance' || id === 'pace' || id === 'ceiling') openEntry(id)
  }
  const step = (index: number, direction: 1 | -1): void => {
    const id = JEV_ROWS[index]
    if (id === 'switch') toggleSwitch()
    else if (id === 'road') toggleRoad()
    else if (id === 'key' && facts.settings.road === 'openrouter') routerKeyReceipt()
    else if (id === 'subagents') toggleSubagents()
    else if (id === 'allowance') settle(() => jevSettingLines(setJevAllowanceUsd(nextRung(JEV_ALLOWANCE_RUNGS, facts.settings.allowanceUsd, direction)))[0] ?? '')
    else if (id === 'pace') settle(() => jevSettingLines(setJevPacePerMinute(Math.max(1, facts.settings.pacePerMinute + direction)))[1] ?? '')
    else if (id === 'ceiling') settle(() => jevSettingLines(setJevRequestCeiling(nextCeiling(facts.settings.requestCeiling, direction)))[2] ?? '')
  }
  const reset = (index: number): void => {
    const id = JEV_ROWS[index]
    if (id === 'switch') settle(() => jevReceiptWords(setJevEnabled(false)))
    else if (id === 'road') settle(() => `${jevValueWords(setJevRoad('official'))} — official road selected`)
    else if (id === 'key' && facts.settings.road === 'openrouter') routerKeyReceipt()
    else if (id === 'key') {
      const hadKey = facts.key.present && facts.key.source === 'stored'
      settle(() => {
        storeJevApiKey(null)
        return jevKeyClearedReceipt(hadKey)
      })
    } else if (id === 'spend') setReceipt({ words: 'the spend count resets with the cost ledger on /clear — nothing written', refused: false })
    else if (id === 'allowance') settle(() => jevSettingLines(setJevAllowanceUsd(JEV_DEFAULT_ALLOWANCE_USD))[0] ?? '')
    else if (id === 'pace') settle(() => jevSettingLines(setJevPacePerMinute(JEV_DEFAULT_PACE_PER_MINUTE))[1] ?? '')
    else if (id === 'ceiling') settle(() => jevSettingLines(setJevRequestCeiling(null))[2] ?? '')
    else if (id === 'subagents') settle(() => `crewmates ${jevRowValues(setJevSubagents(true)).subagents}`)
  }

  const cancelEntry = (): void => {
    if (entry === null) return
    setEntry(null)
    setReceipt({ words: `${JEV_ROW_LABELS[entry.kind]} entry cancelled — nothing written`, refused: false })
  }
  const submitEntry = (raw: string): void => {
    if (entry === null) return
    const typed = raw.trim()
    setEntry(null)
    if (typed === '') {
      setReceipt({ words: `${JEV_ROW_LABELS[entry.kind]} entry cancelled — empty input, nothing written`, refused: false })
      return
    }
    if (entry.kind === 'key') {
      settle(() => {
        storeJevApiKey(typed)
        return jevKeyStoredReceipt()
      })
      return
    }
    if (entry.kind === 'allowance') settle(() => jevSettingLines(setJevAllowanceUsd(Number(typed.replace(/^\$/, ''))))[0] ?? '', typed)
    else if (entry.kind === 'pace') settle(() => jevSettingLines(setJevPacePerMinute(Number(typed)))[1] ?? '', typed)
    else if (typed.toLowerCase() === 'off') settle(() => jevSettingLines(setJevRequestCeiling(null))[2] ?? '', typed)
    else settle(() => jevSettingLines(setJevRequestCeiling(Number(typed)))[2] ?? '', typed)
  }

  useInput(
    (input, key, event) => {
      if (key.escape) return
      if (key.upArrow || input === 'k') {
        event.stopImmediatePropagation()
        moveTo(selected - 1)
        return
      }
      if (key.downArrow || input === 'j') {
        event.stopImmediatePropagation()
        moveTo(selected + 1)
        return
      }
      if (key.return || input === ' ') {
        event.stopImmediatePropagation()
        if (!pastOpenEvent()) return
        activate(selected)
        return
      }
      if (key.leftArrow || key.rightArrow || key.tab) {
        event.stopImmediatePropagation()
        if (!pastOpenEvent()) return
        step(selected, key.leftArrow ? -1 : 1)
        return
      }
      if (key.backspace || key.delete) {
        event.stopImmediatePropagation()
        if (!pastOpenEvent()) return
        reset(selected)
      }
    },
    { isActive: entry === null },
  )

  const statusColor = facts.status.kind === 'ready' ? tokens.success : facts.status.kind === 'off' ? tokens.textSecondary : tokens.warning
  const band = width + 2
  const doors = jevRowValues(facts.settings).doors
  const statusLine = jevStatusLine(facts.status)
  const lastWords = facts.session.state === 'reported' ? jevLastAnswerWords(facts.session.facts) : null
  const creditsLine = facts.settings.road === 'openrouter' ? `credits: ${jevCreditsWords(facts.settings.road)}` : null
  const noteLine = `  ${jevRowNote(JEV_ROWS[selected] ?? 'switch')}`
  const receiptLine = receipt === null ? null : `  ${receipt.words}`
  const promptLine = entry === null ? null : entryPrompt(entry.kind, facts)
  const plan = jevCardPlan({
    rowBudget,
    controlRows: JEV_ROWS.length + 1 + (lastWords === null ? 0 : jevTextRows(lastWords, width)) + (creditsLine === null ? 0 : jevTextRows(creditsLine, width)),
    statusRows: jevTextRows(statusLine, width),
    noteRows: jevTextRows(noteLine, width),
    receiptRows: receiptLine === null ? null : jevTextRows(receiptLine, width),
    promptRows: promptLine === null ? null : jevTextRows(promptLine, width),
  })
  const compact = plan.compact
  const whole = (text: string, color: string, bold = false): React.ReactNode => (
    <Box flexShrink={0}>
      <Text color={color} bold={bold} wrap={compact ? 'truncate-end' : 'wrap'}>{text}</Text>
    </Box>
  )
  return (
    <Box flexDirection="column" width={width} flexShrink={0} maxHeight={Math.max(1, rowBudget)} overflow="hidden">
      {plan.status ? whole(statusLine, statusColor, true) : null}
      {plan.status && !compact ? <Box height={1} /> : null}
      {JEV_ROWS.map((id, index) => {
        const isSelected = index === selected
        const words = jevRowWords(id, facts)
        const valueColor = id === 'switch' || id === 'subagents' ? (words === 'off' ? tokens.textSecondary : tokens.success) : id === 'key' ? (facts.key.present ? tokens.success : tokens.textSecondary) : tokens.textPrimary
        return (
          <Box key={id} flexDirection="column" flexShrink={0}>
            <Box width={band} marginLeft={-1} marginRight={-1} flexShrink={0}>
              <InteractiveRow
                id={`jev:row:${id}`}
                selected={isSelected}
                onSelect={() => moveTo(index)}
                onActivate={() => activate(index)}
                width={band}
                height={1}
                flexShrink={0}
              >
                <Box width={1} flexShrink={0} />
                <Box width={LABEL_CELLS} flexShrink={0}>
                  <Text bold={isSelected} color={isSelected ? tokens.textPrimary : tokens.textSecondary} wrap="truncate-end">
                    {isSelected ? `${JEV_ROW_MARK} ` : '  '}
                    {JEV_ROW_LABELS[id]}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1} minWidth={0} height={1} overflow="hidden">
                  <Text color={valueColor} wrap="truncate-end">{words}</Text>
                </Box>
                <Box width={1} flexShrink={0} />
              </InteractiveRow>
            </Box>
            {id === 'spend' ? (
              <Box flexDirection="column" flexShrink={0}>
                <Text color={tokens.textMuted} wrap="truncate-end">{' '.repeat(LABEL_CELLS)}{jevSpendLabel(facts.settings.road)}</Text>
                {lastWords !== null ? <Text color={tokens.textSecondary} wrap="wrap">{lastWords}</Text> : null}
                {creditsLine !== null ? <Text color={tokens.textMuted} wrap="wrap">{creditsLine}</Text> : null}
              </Box>
            ) : null}
          </Box>
        )
      })}
      {!compact ? <><Text color={tokens.textMuted} wrap="truncate-end">{'  '}{doors}</Text><Box height={1} /></> : null}
      {entry !== null ? (
        <Box flexDirection="column" flexShrink={0}>
          {plan.prompt && promptLine !== null ? whole(promptLine, tokens.textSecondary) : null}
          <Box flexShrink={0} height={1}>
            <Text color={tokens.textMuted}>{JEV_ROW_LABELS[entry.kind]}: </Text>
            <TextInput
              value={entry.value}
              onChange={value => setEntry(current => (current === null ? current : { ...current, value }))}
              onSubmit={submitEntry}
              onEscape={cancelEntry}
              cursorOffset={entry.cursor}
              onChangeCursorOffset={cursor => setEntry(current => (current === null ? current : { ...current, cursor }))}
              columns={Math.max(20, width - LABEL_CELLS - 4)}
              multiline={false}
              {...(entry.kind === 'key' ? { mask: '*' } : {})}
            />
          </Box>
        </Box>
      ) : null}
      {plan.note ? whole(noteLine, tokens.textSecondary) : null}
      {plan.receipt && receipt !== null && receiptLine !== null ? whole(receiptLine, receipt.refused ? tokens.warning : tokens.success) : null}
    </Box>
  )
}
