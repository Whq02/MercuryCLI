import { useRef } from 'react'
import { usePublish } from '../../hooks/effects.js'
import type { Notification } from '../../context/notifications.js'
import type { AppState } from '../../state/AppState.js'
import { composerEffortNotice } from './composerEffortNotice.js'
import { notBuilt } from '../../pi/holes.js'

export function useComposerEffortNotice(arg0: {
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
  return notBuilt('src/components/PromptInput/useComposerEffortNotice.ts:7')
}
