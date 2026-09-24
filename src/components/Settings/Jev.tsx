import * as React from 'react'
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import {
  JEV_MAX_CALL_USD,
  JEV_SUBAGENT_CALL_BUDGET,
  JEV_USD_PER_INPUT_TOKEN,
  type JevStatus,
  jevClockLabel,
  jevUsdLabel,
} from '../../services/jev/jevContract.js'
import { JEV_KEY_ENV, type JevKeyPresence, jevKeyPresence, jevKeySourceWords, storeJevApiKey } from '../../services/jev/jevKey.js'
import { type JevLedgerSnapshot, jevLedgerSnapshot } from '../../services/jev/jevLedger.js'
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
  setJevPacePerMinute,
  setJevRequestCeiling,
  setJevSubagents,
} from '../../services/jev/jevSetting.js'
import { JEV_STATUS_HEADWORDS, jevStatusLine, resolveJevStatus } from '../../services/jev/jevStatus.js'
import { getGlobalConfigCacheStamp, subscribeGlobalConfigCache } from '../../utils/config/globalConfig.js'
import { providerSecretsPathForDisplay } from '../../utils/router/providerSecrets.js'
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
const LABEL_CELLS = 18

export type JevRowId = 'switch' | 'key' | 'spend' | 'allowance' | 'pace' | 'ceiling' | 'subagents'
export const JEV_ROWS: readonly JevRowId[] = ['switch', 'key', 'spend', 'allowance', 'pace', 'ceiling', 'subagents']
export const JEV_ROW_LABELS: Readonly<Record<JevRowId, string>> = {
  switch: 'Switch',
  key: 'Key',
  spend: 'Spend',
  allowance: 'Allowance',
  pace: 'Pace',
  ceiling: 'Request ceiling',
  subagents: 'Sub-agents',
}

export type JevFacts = { settings: JevSettings; key: JevKeyPresence; ledger: JevLedgerSnapshot; status: JevStatus }

export function jevFacts(now: number = Date.now()): JevFacts {
  const settings = readJevSettings()
  const key = jevKeyPresence()
  const ledger = jevLedgerSnapshot(now)
  return { settings, key, ledger, status: resolveJevStatus({ settings, key, ledger, now }) }
}

export function jevSpendWords(ledger: JevLedgerSnapshot): string {
  return `spend so far: ${jevUsdLabel(ledger.spendUsd)} · ${ledger.calls} call${ledger.calls === 1 ? '' : 's'} · ${ledger.unconfirmedCharges} unconfirmed`
}

export function jevLastAnswerWords(ledger: JevLedgerSnapshot): string | null {
  if (ledger.lastAnsweredAt === null) return null
  return `last answered ${jevClockLabel(ledger.lastAnsweredAt)}${ledger.lastModel !== null ? ` · ${ledger.lastModel}` : ''}`
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
      return jevValueWords(facts.settings)
    case 'key':
      return jevKeySourceWords(facts.key)
    case 'spend': {
      const last = jevLastAnswerWords(facts.ledger)
      return `${jevSpendWords(facts.ledger)}${last === null ? '' : ` · ${last}`}`
    }
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

export function jevRowNote(id: JevRowId): string {
  switch (id) {
    case 'switch':
      return '↵, space or ←/→ flip the one switch — the same switch as the JEV row of /config and the JEV row of the Boot Menu; JevEval joins or leaves the roster at the next turn boundary and never answers a permission request'
    case 'key':
      return `↵ pastes a TypeSafe API key (masked; the value never enters the transcript, receipts or logs) · ⌫ clears the stored key · ${JEV_KEY_ENV} in the environment outranks the store · Mercury ships no key`
    case 'spend':
      return `${JEV_SPEND_LABEL} — counted at the published rate (${RATE_WORDS}); an unconfirmed charge is a call whose answer Mercury did not read (a timeout or an unreadable reply), counted at the most a call can cost (${jevUsdLabel(JEV_MAX_CALL_USD)}) · resets with the cost ledger on /clear`
    case 'allowance':
      return `a runaway stop, not a budget — one call costs at most ${jevUsdLabel(JEV_MAX_CALL_USD)}; the pace and the request ceiling do the real work · ←/→ walk ${JEV_ALLOWANCE_RUNGS.map(usd => jevUsdLabel(usd)).join(' · ')} · ↵ types a dollar amount · ⌫ returns to ${jevUsdLabel(JEV_DEFAULT_ALLOWANCE_USD)}`
    case 'pace':
      return `requests admitted a minute; past it a request is refused with the wait until the minute turns · ←/→ move by one · ↵ types a count · ⌫ returns to ${JEV_DEFAULT_PACE_PER_MINUTE}`
    case 'ceiling':
      return `an optional cap on requests a session, off by default; the count resets with the cost ledger on /clear · ←/→ walk off · ${JEV_CEILING_RUNGS.join(' · ')} · ↵ types a count or off · ⌫ returns to off`
    case 'subagents':
      return `off: JevEval is not offered to sub-agents · on: each sub-agent may make ${JEV_SUBAGENT_CALL_BUDGET} calls, one batched request each, counted on the same allowance · ↵, space or ←/→ flip it`
  }
}

export function jevKeyShortWords(key: JevKeyPresence): string {
  if (!key.present) return 'no key'
  return key.source === 'env' ? `key from ${JEV_KEY_ENV}` : 'key stored'
}

export function jevPopupLine(facts: JevFacts = jevFacts()): string {
  return `switch ${jevValueWords(facts.settings)} · ${jevKeyShortWords(facts.key)} · spend ${jevUsdLabel(facts.ledger.spendUsd)} of ${jevUsdLabel(facts.settings.allowanceUsd)} · ${JEV_STATUS_HEADWORDS[facts.status.kind]}`
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
  return `TypeSafe API key stored (auth-scoped, mode 600): ${providerSecretsPathForDisplay()}${envShadow ? ` — NOTE: ${JEV_KEY_ENV} is set in the environment and outranks the store this session` : ''} · ⌫ on the Key row clears it`
}

export function jevKeyClearedReceipt(hadKey: boolean): string {
  const envShadow = Boolean(process.env[JEV_KEY_ENV]?.trim())
  const tail = envShadow ? ` · ${JEV_KEY_ENV} in the environment still supplies a key this session` : ''
  return hadKey ? `stored TypeSafe API key cleared from ${providerSecretsPathForDisplay()}${tail}` : `no stored TypeSafe API key — nothing to clear${tail}`
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
  const toggleSubagents = (): void => settle(() => `sub-agents ${jevRowValues(setJevSubagents(!facts.settings.subagents)).subagents}`)

  const activate = (index: number): void => {
    const id = JEV_ROWS[index]
    if (id === 'switch') toggleSwitch()
    else if (id === 'subagents') toggleSubagents()
    else if (id === 'key' || id === 'allowance' || id === 'pace' || id === 'ceiling') openEntry(id)
  }
  const step = (index: number, direction: 1 | -1): void => {
    const id = JEV_ROWS[index]
    if (id === 'switch') toggleSwitch()
    else if (id === 'subagents') toggleSubagents()
    else if (id === 'allowance') settle(() => jevSettingLines(setJevAllowanceUsd(nextRung(JEV_ALLOWANCE_RUNGS, facts.settings.allowanceUsd, direction)))[0] ?? '')
    else if (id === 'pace') settle(() => jevSettingLines(setJevPacePerMinute(Math.max(1, facts.settings.pacePerMinute + direction)))[1] ?? '')
    else if (id === 'ceiling') settle(() => jevSettingLines(setJevRequestCeiling(nextCeiling(facts.settings.requestCeiling, direction)))[2] ?? '')
  }
  const reset = (index: number): void => {
    const id = JEV_ROWS[index]
    if (id === 'switch') settle(() => jevReceiptWords(setJevEnabled(false)))
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
    else if (id === 'subagents') settle(() => `sub-agents ${jevRowValues(setJevSubagents(false)).subagents}`)
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
  return (
    <Box flexDirection="column" width={width} flexShrink={0} maxHeight={Math.max(1, rowBudget)} overflow="hidden">
      <Text color={statusColor} bold={true}>{jevStatusLine(facts.status)}</Text>
      <Box height={1} />
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
              <Text color={tokens.textMuted} wrap="truncate-end">{' '.repeat(LABEL_CELLS)}{JEV_SPEND_LABEL}</Text>
            ) : null}
          </Box>
        )
      })}
      <Text color={tokens.textMuted} wrap="truncate-end">{'  '}{doors}</Text>
      <Box height={1} />
      {entry !== null ? (
        <Box flexDirection="column" flexShrink={0}>
          <Text color={tokens.textSecondary}>{entryPrompt(entry.kind, facts)}</Text>
          <Box>
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
      ) : (
        <Text color={tokens.textSecondary} wrap="wrap">{'  '}{jevRowNote(JEV_ROWS[selected] ?? 'switch')}</Text>
      )}
      {receipt !== null ? (
        <Text color={receipt.refused ? tokens.warning : tokens.success} wrap="wrap">{'  '}{receipt.words}</Text>
      ) : null}
    </Box>
  )
}
