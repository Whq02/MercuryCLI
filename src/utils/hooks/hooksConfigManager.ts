import type { AppState } from '../../state/AppState.js'
import {
  HOOK_EVENTS,
  hookEventTable,
  hookKindsOf,
  hookMatchValues,
  type HookAnswerField,
  type HookEvent,
  type HookKind,
  type HookRoad,
} from './contract.js'
import { hookSourceRank, listHooks, type HookRow } from './hooksSettings.js'

export type HookEventCard = {
  event: HookEvent
  moment: string
  roads: readonly HookRoad[]
  match?: string
  matchValues?: readonly string[]
  answers: readonly HookAnswerField[]
  kinds: readonly HookKind[]
}

export function hookEventCard(event: HookEvent, toolNames: readonly string[] = []): HookEventCard {
  const row = hookEventTable[event]
  const values = row.match === 'tool' ? [...toolNames] : hookMatchValues(event)
  return {
    event,
    moment: row.moment,
    roads: row.roads,
    ...(row.match !== undefined ? { match: row.match } : {}),
    ...(values !== undefined && values.length > 0 ? { matchValues: values } : {}),
    answers: row.answers,
    kinds: hookKindsOf(event),
  }
}

export function hookEventCards(toolNames: readonly string[] = []): Record<HookEvent, HookEventCard> {
  return Object.fromEntries(HOOK_EVENTS.map(event => [event, hookEventCard(event, toolNames)])) as Record<HookEvent, HookEventCard>
}

export function eventHasMatch(event: HookEvent): boolean {
  return hookEventTable[event].match !== undefined
}

export type HooksByEventAndMatch = Record<HookEvent, Record<string, HookRow[]>>

export function groupHooksByEventAndMatch(appState: AppState): HooksByEventAndMatch {
  const grouped = Object.fromEntries(HOOK_EVENTS.map(event => [event, {}])) as HooksByEventAndMatch
  for (const row of listHooks(appState)) {
    const byMatch = grouped[row.event]
    const key = eventHasMatch(row.event) ? row.match : ''
    ;(byMatch[key] ??= []).push(row)
  }
  return grouped
}

export function sortedMatchesForEvent(grouped: HooksByEventAndMatch, event: HookEvent): string[] {
  const byMatch = grouped[event] ?? {}
  const rank = (match: string): number => Math.min(...(byMatch[match] ?? []).map(row => hookSourceRank(row.source)))
  return Object.keys(byMatch).sort((a, b) => {
    const difference = rank(a) - rank(b)
    if (difference !== 0 && Number.isFinite(difference)) return difference
    return a.localeCompare(b)
  })
}

export function hooksForMatch(grouped: HooksByEventAndMatch, event: HookEvent, match: string | null): HookRow[] {
  return grouped[event]?.[match ?? ''] ?? []
}

export function answerWords(field: HookAnswerField): string {
  switch (field) {
    case 'block':
      return 'block the moment'
    case 'stop':
      return 'stop the turn'
    case 'context':
      return 'add words the model reads'
    case 'notice':
      return 'add a line the operator reads'
    case 'permission':
      return 'settle the permission'
    case 'input':
      return "rewrite the tool's input"
    case 'output':
      return "rewrite the tool's result"
    case 'rules':
      return 'apply permission rules'
    case 'instructions':
      return 'guide the summariser'
    case 'prompt':
      return "set the session's first prompt"
    case 'watch':
      return 'name the files to watch'
  }
}
