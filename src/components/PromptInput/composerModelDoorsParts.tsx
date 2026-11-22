import React from 'react'
import { getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import type { Message } from '../../types/message.js'
import type { AppState } from '../../state/AppState.js'
import type { AppStateStore } from '../../state/AppStateStore.js'
import type { Notification } from '../../context/notifications.js'
import { crossProviderNote, providerFamilyOfSetting, seatWithFold, settleModelSelection, type SeatReceiptState, type TransitionPlan } from '../../services/model/modelTransition.js'
import {
  previewForSelection,
  reconfirmTransitionPlan,
  transitionPlanSummary,
} from '../../services/providers/transitionPreview.js'
import { usabilityForRoute } from '../../services/providers/providerUsability.js'
import type { CallModelRoute } from '../../services/providers/callModelRouter.js'
import { requestCommandDispatch } from '../../utils/cockpit/helmFocus.js'
import { renderModelName } from '../../services/model/model.js'
import { persistModelChoice } from '../../commands/model/persistModelChoice.js'
import {
  noteCapOfferAnswered,
  noteOfferDismissal,
  type CapFailoverListedFamily,
  type CapHandoffNote,
} from '../../services/capFailover.js'
import { usageCarryWords, usageForProvider } from '../../services/providers/providerUsage.js'
import { slotSwitchTransient, switchActiveSlot } from '../../services/providers/slotSwitch.js'
import { paintSlotSwitchReceipt } from '../../services/providers/slotSwitchReceipt.js'
import { familyDisplayName } from '../../services/providers/accountSlots.js'
import ModelPicker from '../ModelPicker.js'
import { TransitionPreviewCard } from '../TransitionPreviewCard.js'
import { CapOfferCard } from '../CapOfferCard.js'
import { SlotOfferCard } from '../SlotOfferCard.js'
import type { OverlaySurface } from './composerOverlay.js'
import { notBuilt } from '../../pi/holes.js'

type TransitionConfirm = {
  value: string
  plan: TransitionPlan
  refreshed: boolean
  persist: boolean
} | null

type CapOffer = {
  trigger: 'rejected' | 'reset'
  direction: 'handoff' | 'return'
  windowName: string | null
  resetText: string | null
  targetModel: string
  targetRoute: CallModelRoute
  rows: CapFailoverListedFamily[]
  homeRoute: CallModelRoute
  awayRoute: CallModelRoute
} | null

type SlotOffer = {
  key: string
  family: 'anthropic' | 'openai'
  fromLabel: string
  toLabel: string
  headroomObserved: boolean
  resetText: string | null
  carryWords: string | null
} | null

export function applyModelSelectionOf(
  {
    setOverlay,
    messages,
    appStateStore,
    setAppState,
    addNotification,
    settleCapHandoffIntent,
  }: {
    setOverlay: React.Dispatch<React.SetStateAction<OverlaySurface>>
    messages: Message[]
    appStateStore: AppStateStore
    setAppState: (f: (prev: AppState) => AppState) => void
    addNotification: (notification: Notification) => void
    settleCapHandoffIntent: (landed: boolean) => void
  },
  value: string | null,
  persist: boolean,
  seated?: (state: SeatReceiptState) => void,
): void {
    const focused = getFocusedSessionConnector()
    if (focused.carrier === 'daemon') {
      const label = value === null ? 'Default' : renderModelName(value)
      setOverlay(null)
      const effectiveBefore = focused.modelFacts().effective
      const choice = persist ? persistModelChoice(value) : null
      void focused.setModel(value, undefined, choice?.replacedDefault ?? undefined).then(receipt => {
        settleCapHandoffIntent(receipt.state === 'applied' || receipt.state === 'queued')
        if (receipt.state === 'refused') {
          choice?.restore()
          addNotification({ key: 'model-switched', text: `The model switch was refused: ${receipt.detail}`, priority: 'high', timeoutMs: 5000 })
          return
        }
        const saved = choice?.sentence ?? ''
        if (receipt.state === 'no-op') {
          addNotification({ key: 'model-switched', text: saved === '' ? `Already on ${label} — nothing to change` : `Already on ${label}${saved}`, priority: 'high', timeoutMs: 3000 })
          seated?.(receipt.state)
          return
        }
        const doorCross = providerFamilyOfSetting(effectiveBefore) !== providerFamilyOfSetting(value) ? crossProviderNote(value) : ''
        const doorPlan = previewForSelection(messages, effectiveBefore, value)
        const doorLossNote = transitionPlanSummary(doorPlan)
        addNotification(
          receipt.state === 'queued'
            ? {
                key: 'model-switched',
                invalidates: ['model-transition-applied'],
                text: `Model switch queued: ${label}${saved === '' ? '' : `${saved} —`} applies when this session's turn settles (the running turn keeps its model)${doorCross}${doorLossNote}`,
                priority: 'high',
                timeoutMs: 5000,
              }
            : {
                key: 'model-switched',
                text: `Set model to ${label}${saved} — this session's next message runs it${receipt.note !== undefined ? ` (${receipt.note})` : ''}${doorCross}${doorLossNote}`,
                priority: 'high',
                timeoutMs: 3000,
              },
        )
        seated?.(receipt.state)
      })
      return
    }
    const stateNow = appStateStore.getState()
    const settled = settleModelSelection(stateNow, value, {
      turnActive:
        stateNow.foregroundTurnActive || stateNow.pendingModelSwitch !== null,
    })
    settleCapHandoffIntent(settled.kind === 'applied' || settled.kind === 'queued')
    const label = value === null ? 'Default' : renderModelName(value)
    setOverlay(null)
    const saved = persist ? persistModelChoice(value).sentence : ''
    if (settled.kind === 'no-op') {
      addNotification({ key: 'model-switched', text: saved === '' ? `Already on ${label} — nothing to change` : `Already on ${label}${saved}`, priority: 'high', timeoutMs: 3000 })
      return
    }
    if (settled.kind === 'cancelled-pending') {
      setAppState(prev => ({ ...prev, ...settled.patch }))
      addNotification({ key: 'model-switched', text: `Already on ${label} — queued switch cancelled${saved}`, priority: 'high', timeoutMs: 3000 })
      return
    }
    const effectiveFrom = stateNow.engineModelForSession ?? stateNow.engineModel
    const lossNote = transitionPlanSummary(previewForSelection(messages, effectiveFrom, value))
    if (settled.kind === 'queued') {
      setAppState(prev => ({ ...prev, ...settled.patch }))
      addNotification({
        key: 'model-switched',
        invalidates: ['model-transition-applied'],
        text: `Model switch queued: ${label}${saved === '' ? '' : `${saved} —`} applies when the current turn settles (the running turn keeps its model)${settled.crossProvider ? crossProviderNote(value) : ''}${lossNote}`,
        priority: 'high',
        timeoutMs: 5000,
      })
      return
    }
    setAppState(prev => ({ ...prev, ...settled.patch }))
    addNotification({
      key: 'model-switched',
      text: `Set model to ${label}${saved}${settled.receipt.crossProvider ? crossProviderNote(value) : ''}${lossNote}`,
      priority: 'high',
      timeoutMs: 3000,
    })
}

export function modelDoorsSurfaceOf(arg0: {
  overlay: OverlaySurface
  transitionConfirm: TransitionConfirm
  setTransitionConfirm: React.Dispatch<React.SetStateAction<TransitionConfirm>>
  engineModelForSession: string | null
  engineModel: string | null
  focusedMainModel: string
  messages: Message[]
  applyModelSelection: (value: string | null, persist?: boolean, seated?: (state: SeatReceiptState) => void) => void
  capHandoffIntentRef: React.MutableRefObject<CapHandoffNote | null>
  setOverlay: React.Dispatch<React.SetStateAction<OverlaySurface>>
  addNotification: (notification: Notification) => void
  handleModelSelect: (value: string, persist?: boolean) => void
  capOffer: CapOffer
  setCapOffer: React.Dispatch<React.SetStateAction<CapOffer>>
  slotOffer: SlotOffer
  setSlotOffer: React.Dispatch<React.SetStateAction<SlotOffer>>
}): React.ReactNode | null {
  return notBuilt('src/components/PromptInput/composerModelDoorsParts.tsx:165')
}
