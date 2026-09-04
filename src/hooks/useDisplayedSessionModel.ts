import { useMemo, useSyncExternalStore } from 'react'
import {
  focusedSessionModelFacts,
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import { renderModelChip } from '../utils/model/model.js'


export type DisplayedSessionModel = {
  label: string
  compact: string
  pendingNext: string | null
}

export function resolveDisplayedSessionModel(
  mainModel: string,
  pendingSwitch?: { setting: string | null } | null,
): DisplayedSessionModel {
  const pendingNext =
    pendingSwitch === undefined || pendingSwitch === null
      ? null
      : pendingSwitch.setting === null
        ? 'Default'
        : renderModelChip(pendingSwitch.setting)
  const name = renderModelChip(mainModel)
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

const getFocusedServedEffort = (): string => focusedSessionModelFacts()?.effort ?? ''

export function useFocusedServedEffort(): string | null {
  const effort = useSyncExternalStore(subscribeFocusedModel, getFocusedServedEffort, getFocusedServedEffort)
  return effort === '' ? null : effort
}

export function useDisplayedSessionModel(): DisplayedSessionModel {
  const mainModel = useSyncExternalStore(subscribeFocusedModel, getFocusedMainModel, getFocusedMainModel)
  const pendingParked = useSyncExternalStore(subscribeFocusedModel, getFocusedPendingParked, getFocusedPendingParked)
  const pendingSetting = useSyncExternalStore(subscribeFocusedModel, getFocusedPendingSetting, getFocusedPendingSetting)
  const pendingSwitch = useMemo(
    () => (pendingParked ? { setting: pendingSetting } : null),
    [pendingParked, pendingSetting],
  )
  return resolveDisplayedSessionModel(mainModel, pendingSwitch)
}
