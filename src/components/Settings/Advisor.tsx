import React from 'react'
import { Text } from '../../ink.js'
import {
  ADVISOR_DOORS,
  ADVISOR_SEATS_LADDER,
  advisorIntervalWords,
  advisorReceiptWords,
  advisorValueWords,
  readAdvisorSettings,
  resolveAdvisorModel,
  type AdvisorSettings,
} from '../../services/advisor/advisorSettings.js'

export const ADVISOR_SEARCH = 'advisor second model advises working model note cadence interval turns submodels ask crewmates'
export const ADVISOR_ROW_IDS = ['advisor', 'advisorCrewmates', 'advisorInterval'] as const

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
  const ladder = ADVISOR_SEATS_LADDER
  const at = ladder.indexOf(current)
  if (at >= 0) return ladder[Math.min(ladder.length - 1, Math.max(0, at + direction))] ?? current
  const above = ladder.findIndex(step => step > current)
  if (direction === 1) return above >= 0 ? (ladder[above] ?? current) : (ladder[ladder.length - 1] ?? current)
  return above > 0 ? (ladder[above - 1] ?? current) : above === 0 ? (ladder[0] ?? current) : (ladder[ladder.length - 1] ?? current)
}

export function advisorCrewmatesValueWords(settings: Pick<AdvisorSettings, 'enabled' | 'crewmates'>): string {
  if (!settings.crewmates) return 'off'
  return settings.enabled ? 'on · may result in high spend' : 'on · Advisor is off · may result in high spend'
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
  onCrewmates: (next: boolean, words: string) => void
  onInterval: (next: number, words: string) => void
}): AdvisorConfigItem[] {
  const { tokens, onToggle, onCrewmates, onInterval } = args
  const settings = args.settings ?? readAdvisorSettings()
  const modelWords = advisorModelWords()
  return [
    {
      id: 'advisor',
      label: 'Advisor',
      searchText: ADVISOR_SEARCH,
      kind: 'boolean',
      value: <Text color={settings.enabled ? tokens.success : tokens.textSecondary}>{advisorValueWords(settings)}</Text>,
      warning: `a second model reads this conversation ${advisorIntervalWords(settings.seats)} and writes the agent one note, addressed to the agent, never to you; the agent can ask it between notes · crewmates opt in separately; never workflow agents · ${modelWords} · off by default · doors: ${ADVISOR_DOORS}`,
      setByYou: settings.enabled,
      change: () => {
        const next = !settings.enabled
        onToggle(next, `set the advisor to ${advisorValueWords({ ...settings, enabled: next })}`)
      },
    },
    {
      id: 'advisorCrewmates',
      label: 'Advisor for crewmates',
      searchText: `${ADVISOR_SEARCH} opt in separate`,
      kind: 'boolean',
      value: <Text color={settings.enabled && settings.crewmates ? tokens.success : tokens.textSecondary}>{advisorCrewmatesValueWords(settings)}</Text>,
      warning: 'a separate opt-in for crewmates: both this switch and Advisor must be on for notes or AskAdvisor · off by default · workflow agents never receive advice',
      setByYou: settings.crewmates,
      change: () => {
        const next = !settings.crewmates
        onCrewmates(next, `set the advisor for crewmates to ${next ? 'on' : 'off'}`)
      },
    },
    {
      id: 'advisorInterval',
      label: 'Advisor interval',
      searchText: `${ADVISOR_SEARCH} every`,
      kind: 'enum',
      value: <Text color={settings.enabled ? undefined : tokens.textSecondary}>{`${settings.seats} turns`}</Text>,
      warning: `how many of the agent's turns pass between notes · ${ADVISOR_SEATS_LADDER.join(' · ')} · ${advisorReceiptWords(settings)}`,
      setByYou: settings.seats !== 10,
      change: direction => {
        const next = nextAdvisorInterval(settings.seats, direction)
        if (next === settings.seats) return
        onInterval(next, `set the advisor interval to ${advisorIntervalWords(next)}`)
      },
    },
  ]
}
