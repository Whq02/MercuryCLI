import React from 'react'
import { Text } from '../../ink.js'
import {
  ADVISOR_DEFAULT_MINUTES,
  ADVISOR_DOORS,
  ADVISOR_MINUTES_LADDER,
  advisorIntervalWords,
  advisorReceiptWords,
  advisorValueWords,
  readAdvisorSettings,
  resolveAdvisorModel,
  type AdvisorSettings,
} from '../../services/advisor/advisorSettings.js'

export const ADVISOR_SEARCH = 'advisor second model advises working model note cadence interval minutes submodels ask'
export const ADVISOR_ROW_IDS = ['advisor', 'advisorInterval'] as const

export type AdvisorConfigItem = {
  id: string
  label: string
  searchText?: string
  kind: 'boolean' | 'enum'
  value: React.ReactNode
  change?: (direction: 1 | -1) => void
  warning?: string
  setByYou?: boolean
}

export function nextAdvisorInterval(current: number, direction: 1 | -1): number {
  const ladder = ADVISOR_MINUTES_LADDER
  const at = ladder.indexOf(current)
  if (at >= 0) return ladder[Math.min(ladder.length - 1, Math.max(0, at + direction))] ?? current
  const above = ladder.findIndex(step => step > current)
  if (direction === 1) return above >= 0 ? (ladder[above] ?? current) : (ladder[ladder.length - 1] ?? current)
  return above > 0 ? (ladder[above - 1] ?? current) : above === 0 ? (ladder[0] ?? current) : (ladder[ladder.length - 1] ?? current)
}

export function advisorIntervalValueWords(minutes: number): string {
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

export function advisorModelWords(): string {
  const model = resolveAdvisorModel()
  if (model.origin === 'unset') return 'no advisor model pinned — /submodels sets one'
  return `advisor model ${model.model}${model.origin === 'env' ? ` (pinned by ${model.envVar ?? 'the environment'})` : ''}`
}

export function advisorConfigItems(args: {
  tokens: { success: string; textSecondary: string }
  settings?: AdvisorSettings
  onToggle: (next: boolean, words: string) => void
  onInterval: (next: number, words: string) => void
}): AdvisorConfigItem[] {
  const { tokens, onToggle, onInterval } = args
  const settings = args.settings ?? readAdvisorSettings()
  const modelWords = advisorModelWords()
  return [
    {
      id: 'advisor',
      label: 'Advisor',
      searchText: ADVISOR_SEARCH,
      kind: 'boolean',
      value: <Text color={settings.enabled ? tokens.success : tokens.textSecondary}>{advisorValueWords(settings)}</Text>,
      warning: `a second model reads this conversation ${advisorIntervalWords(settings.minutes)} and writes the agent one note, addressed to the agent, never to you; the agent can ask it between notes · the main chat only, never crewmates or workflow agents · ${modelWords} · off by default · doors: ${ADVISOR_DOORS}`,
      setByYou: settings.enabled,
      change: () => {
        const next = !settings.enabled
        onToggle(next, `set the advisor to ${advisorValueWords({ ...settings, enabled: next })}`)
      },
    },
    {
      id: 'advisorInterval',
      label: 'Advisor interval',
      searchText: `${ADVISOR_SEARCH} every`,
      kind: 'enum',
      value: <Text color={settings.enabled ? undefined : tokens.textSecondary}>{advisorIntervalValueWords(settings.minutes)}</Text>,
      warning: `how many minutes pass between notes · ${ADVISOR_MINUTES_LADDER.join(' · ')} · ${advisorReceiptWords(settings)}`,
      setByYou: settings.minutes !== ADVISOR_DEFAULT_MINUTES,
      change: direction => {
        const next = nextAdvisorInterval(settings.minutes, direction)
        if (next === settings.minutes) return
        onInterval(next, `set the advisor interval to ${advisorIntervalWords(next)}`)
      },
    },
  ]
}
