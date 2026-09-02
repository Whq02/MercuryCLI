import { useMemo, useSyncExternalStore } from 'react'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import { renderModelChip } from '../utils/model/model.js'
import { resolveSeatSlot } from '../utils/model/seatSlots.js'
import {
  getScribeModeVersion,
  isScribeModeOn,
  subscribeScribeMode,
} from '../utils/scribeMode.js'


export type DisplayedSessionModel = {
  scribeRouter: boolean
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
  const queued = (base: string): string =>
    pendingNext === null ? base : `${base} → ${pendingNext}`
  const queuedLabel = (base: string): string =>
    pendingNext === null ? base : `${base} → ${pendingNext} (queued)`
  const queuedScribe = (base: string): string =>
    pendingNext === null ? base : `${base} · queued switch → ${pendingNext}`
  if (!isScribeModeOn()) {
    const name = renderModelChip(mainModel)
    return {
      scribeRouter: false,
      label: queuedLabel(name),
      compact: queued(name),
      pendingNext,
    }
  }
  const applied = renderModelChip(mainModel)
  const scribe = renderModelChip(resolveSeatSlot('scribe').model)
  const implementer = renderModelChip(resolveSeatSlot('implementer').model)
  if (applied !== scribe) {
    return {
      scribeRouter: true,
      label: queuedScribe(`Scribe router — ${applied} (seat ${scribe} not applied) → ${implementer}`),
      compact: queuedScribe(`Scribe · ${applied}`),
      pendingNext,
    }
  }
  return {
    scribeRouter: true,
    label: queuedScribe(`Scribe router — ${scribe} → ${implementer}`),
    compact: queuedScribe(`Scribe · ${scribe}`),
    pendingNext,
  }
}

const subscribeFocusedModel = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const getFocusedMainModel = (): string => getFocusedSessionConnector().modelFacts().main
const getFocusedPendingParked = (): boolean => getFocusedSessionConnector().modelFacts().pendingSwitch !== null
const getFocusedPendingSetting = (): string | null =>
  getFocusedSessionConnector().modelFacts().pendingSwitch?.setting ?? null

export function useDisplayedSessionModel(): DisplayedSessionModel {
  const mainModel = useSyncExternalStore(subscribeFocusedModel, getFocusedMainModel, getFocusedMainModel)
  useSyncExternalStore(subscribeScribeMode, getScribeModeVersion, getScribeModeVersion)
  const pendingParked = useSyncExternalStore(subscribeFocusedModel, getFocusedPendingParked, getFocusedPendingParked)
  const pendingSetting = useSyncExternalStore(subscribeFocusedModel, getFocusedPendingSetting, getFocusedPendingSetting)
  const pendingSwitch = useMemo(
    () => (pendingParked ? { setting: pendingSetting } : null),
    [pendingParked, pendingSetting],
  )
  return resolveDisplayedSessionModel(mainModel, pendingSwitch)
}
