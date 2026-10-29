import { useMemo, useSyncExternalStore } from 'react'
import {
  focusedSessionModelFacts,
  getFocusedSessionConnector,
  hasFocusedSession,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import { renderModelChip } from '../utils/model/model.js'
import { geminiPlanRideWords } from '../services/providers/gemini/geminiCatalogue.js'
import { declaredRouteOf } from '../services/providers/routeLaw.js'
import { contextFillView, type ContextFillView } from '../utils/contextFill.js'
import type { Message } from '../types/message.js'


export type DisplayedSessionModel = {
  label: string
  compact: string
  pendingNext: string | null
}

export function resolveDisplayedSessionModel(
  mainModel: string,
  pendingSwitch?: { setting: string | null } | null,
  ride?: string | null,
): DisplayedSessionModel {
  const pendingNext =
    pendingSwitch === undefined || pendingSwitch === null
      ? null
      : pendingSwitch.setting === null
        ? 'Default'
        : renderModelChip(pendingSwitch.setting)
  const base = renderModelChip(mainModel)
  const name = ride === undefined || ride === null || ride === '' ? base : `${base} ▸ ${ride}`
  return {
    label: pendingNext === null ? name : `${name} → ${pendingNext} (queued)`,
    compact: pendingNext === null ? name : `${name} → ${pendingNext}`,
    pendingNext,
  }
}

const subscribeFocusedModel = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const getFocusedMainModel = (): string => getFocusedSessionConnector().modelFacts().main
const getFocusedPendingParked = (): boolean => getFocusedSessionConnector().modelFacts().pendingSwitch !== null
const getFocusedPendingSetting = (): string | null =>
  getFocusedSessionConnector().modelFacts().pendingSwitch?.setting ?? null
const getFocusedServedModel = (): string => focusedSessionModelFacts()?.effective ?? ''

export function useFocusedServedModel(): string | null {
  const served = useSyncExternalStore(subscribeFocusedModel, getFocusedServedModel, getFocusedServedModel)
  return served === '' ? null : served
}

const getFocusedContext = () => getFocusedSessionConnector().usage().context ?? null

export function useFocusedContextFill(messages: readonly Message[], model: string, focused = true): ContextFillView {
  const context = useSyncExternalStore(subscribeFocusedModel, getFocusedContext, getFocusedContext)
  return focused && context?.model === model ? context : contextFillView(messages, model)
}

const getFocusedServedEffort = (): string => focusedSessionModelFacts()?.effort ?? ''

export function useFocusedServedEffort(): string | null {
  const effort = useSyncExternalStore(subscribeFocusedModel, getFocusedServedEffort, getFocusedServedEffort)
  return effort === '' ? null : effort
}

const getFocusedBornEffort = (): string => (hasFocusedSession() ? '' : (getFocusedSessionConnector().modelFacts().effort ?? ''))

export function useFocusedBornEffort(): string | null {
  const born = useSyncExternalStore(subscribeFocusedModel, getFocusedBornEffort, getFocusedBornEffort)
  return born === '' ? null : born
}

const getFocusedSentEffort = (): string => {
  const facts = focusedSessionModelFacts()
  if (facts === null || facts.effortSent === undefined) return 'unresolved'
  if (facts.effortSent === null) return 'none'
  return `sent:${facts.effortSent}`
}

export function useFocusedSentEffort(): string | null | undefined {
  const sent = useSyncExternalStore(subscribeFocusedModel, getFocusedSentEffort, getFocusedSentEffort)
  if (sent === 'unresolved') return undefined
  if (sent === 'none') return null
  return sent.slice('sent:'.length)
}

export function useDisplayedSessionModel(): DisplayedSessionModel {
  const mainModel = useSyncExternalStore(subscribeFocusedModel, getFocusedMainModel, getFocusedMainModel)
  const pendingParked = useSyncExternalStore(subscribeFocusedModel, getFocusedPendingParked, getFocusedPendingParked)
  const pendingSetting = useSyncExternalStore(subscribeFocusedModel, getFocusedPendingSetting, getFocusedPendingSetting)
  const pendingSwitch = useMemo(
    () => (pendingParked ? { setting: pendingSetting } : null),
    [pendingParked, pendingSetting],
  )
  const effort = useSyncExternalStore(subscribeFocusedModel, getFocusedServedEffort, getFocusedServedEffort)
  const ride = useMemo(() => (declaredRouteOf(mainModel) === 'gemini' ? geminiPlanRideWords(mainModel, effort === '' ? undefined : effort) ?? null : null), [mainModel, effort])
  return resolveDisplayedSessionModel(mainModel, pendingSwitch, ride)
}
