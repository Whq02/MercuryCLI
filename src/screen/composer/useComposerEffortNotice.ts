import { useRef } from 'react'
import { usePublish } from '../effects/effects.js'
import type { Notification } from '../notifications/notifications.js'
import type { AppState } from '../app-state/AppState.js'
import { composerEffortNotice } from './composerEffortNotice.js'

export function useComposerEffortNotice({
  focusedEffectiveModel,
  engineModel,
  focusedMainModel,
  seatEffort,
  sentEffort,
  effortValue,
  bornEffort,
  addNotification,
  removeNotification,
}: {
  focusedEffectiveModel: string
  engineModel: AppState['engineModel']
  focusedMainModel: string
  seatEffort: string | null
  sentEffort: string | null | undefined
  effortValue: AppState['effortValue']
  bornEffort: string | null
  addNotification: (notification: Notification) => void
  removeNotification: (key: string) => void
}): void {
  const effortText = composerEffortNotice({
    model: focusedEffectiveModel !== '' ? focusedEffectiveModel : (engineModel ?? focusedMainModel),
    seatEffort,
    sentEffort,
    effortValue,
    bornEffort,
  })
  const effortBaselineRef = useRef<{ armed: boolean; text: string | undefined }>({
    armed: false,
    text: undefined,
  })
  usePublish(() => {
    const baseline = effortBaselineRef.current
    if (!baseline.armed) {
      effortBaselineRef.current = { armed: true, text: effortText }
      return
    }
    if (effortText === baseline.text) return
    effortBaselineRef.current = { armed: true, text: effortText }
    if (effortText === undefined) {
      removeNotification('effort-level')
      return
    }
    addNotification({
      key: 'effort-level',
      text: effortText,
      priority: 'high',
      timeoutMs: 12000,
      fold: (_accumulator, incoming) => incoming,
    })
  }, [effortText, addNotification, removeNotification])
}
