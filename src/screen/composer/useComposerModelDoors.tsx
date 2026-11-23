import React, { useRef, useState, useSyncExternalStore } from 'react'
import { usePublish } from '../effects/effects.js'
import { appendFileSync } from 'node:fs'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import type { Message } from '../../engine/message-shapes/message.js'
import type { AppState } from '../app-state/AppState.js'
import type { AppStateStore } from '../app-state/AppStateStore.js'
import type { Notification } from '../notifications/notifications.js'
import { settleModelSelection, type SeatReceiptState, type TransitionPlan } from '../../models/catalogue/modelTransition.js'
import {
  previewForSelection,
} from '../../models/roads/transitionPreview.js'
import { usabilityForRoute } from '../../models/roads/providerUsability.js'
import { declaredRouteOf, type CallModelRoute } from '../../models/roads/callModelRouter.js'
import { ANTHROPIC_CONNECT_OPTION_VALUE, GPT_CONNECT_OPTION_VALUE, parseKeyConnectValue } from '../../models/catalogue/modelOptions.js'
import { OPENROUTER_CONNECT_OPTION_VALUE } from '../../models/roads/openrouter/openrouterCatalogue.js'
import { HUGGINGFACE_CONNECT_OPTION_VALUE } from '../../models/roads/huggingface/huggingfaceCatalogue.js'
import { GEMINI_CONNECT_OPTION_VALUE } from '../../models/roads/gemini/geminiCatalogue.js'
import { requestCommandDispatch } from '../cockpit/helmFocus.js'
import { renderModelName } from '../../models/catalogue/engineModel.js'
import {
  capFailoverLaneOf,
  capHandoffState,
  capLaneLineCut,
  capLaneLineKey,
  capLaneLineUntil,
  capLaneLineWords,
  capOfferAnswered,
  decideCapAction,
  decideCapReturn,
  decideSlotWallAction,
  getCapHandoffVersion,
  liveCapFailoverCandidates,
  liveCapFailoverTarget,
  noteCapHandoff,
  type CapFailoverListedFamily,
  type CapHandoffNote,
  noteCapOfferAnswered,
  noteCapReturn,
  noteCapWindowObserved,
  noteOfferAutoDone,
  noteSlotWallObserved,
  observedFamilyWindow,
  offerAutoDone,
  offerDismissed,
  resolveCapPosture,
  slotWallKey,
  subscribeCapHandoff,
} from '../../models/roads/capFailover.js'
import { providerDisplayName } from '../../models/roads/routeLaw.js'
import { usageCarryWords, usageForProvider } from '../../models/roads/providerUsage.js'
import { slotSeatView, slotSwitchTransient, switchActiveSlot } from '../../models/roads/slotSwitch.js'
import { paintSlotSwitchReceipt } from '../../models/roads/slotSwitchReceipt.js'
import { getOpenaiObservedVersion, openaiLimitWindow, subscribeOpenaiObserved } from '../../models/roads/openai/openaiLimitState.js'
import { anthropicWindowClosed, getUsageRecordVersion, subscribeUsageRecord } from '../../models/roads/anthropic/anthropicLimits.js'
import { useAnthropicLimits } from './anthropicLimitsHook.js'
import { formatResetTime } from '../../platform/text/format.js'
import { useNowTick } from '../widgets/components.js'
import type { OverlaySurface } from './composerOverlay.js'
import { applyModelSelectionOf, modelDoorsSurfaceOf } from './composerModelDoorsParts.js'
import { passedOver } from '../../platform/errors/passedOver.js'

function traceCapHandoff(ev: string, fields: Record<string, unknown>): void {
  const path = flagEnv('MERCURY_CONNECTOR_TRACE')
  if (!path) return
  try {
    appendFileSync(path, `${JSON.stringify({ t: Date.now(), ev, ...fields })}\n`)
  } catch (error) { passedOver(error) }
}

type ComposerModelDoorsInput = {
  overlay: OverlaySurface
  setOverlay: React.Dispatch<React.SetStateAction<OverlaySurface>>
  messages: Message[]
  modalOverlayUp: boolean
  engineModel: string | null
  engineModelForSession: string | null
  focusedMainModel: string
  focusedEffectiveModel: string
  isCompact: boolean
  columns: number
  appStateStore: AppStateStore
  setAppState: (f: (prev: AppState) => AppState) => void
  addNotification: (notification: Notification) => void
}

type ComposerModelDoors = {
  handleModelSelect: (value: string, persist?: boolean) => void
  capLaneLine: string | null
  capLaneCut: ReturnType<typeof capLaneLineCut>
  surface: React.ReactNode | null
}

export function useComposerModelDoors({
  overlay,
  setOverlay,
  messages,
  modalOverlayUp,
  engineModel,
  engineModelForSession,
  focusedMainModel,
  focusedEffectiveModel,
  isCompact,
  columns,
  appStateStore,
  setAppState,
  addNotification,
}: ComposerModelDoorsInput): ComposerModelDoors {
  const [transitionConfirm, setTransitionConfirm] = useState<{
    value: string
    plan: TransitionPlan
    refreshed: boolean
    persist: boolean
  } | null>(null)
  const [capOffer, setCapOffer] = useState<{
    trigger: 'rejected' | 'reset'
    direction: 'handoff' | 'return'
    windowName: string | null
    resetText: string | null
    targetModel: string
    targetRoute: CallModelRoute
    rows: CapFailoverListedFamily[]
    homeRoute: CallModelRoute
    awayRoute: CallModelRoute
  } | null>(null)
  const [slotOffer, setSlotOffer] = useState<{
    key: string
    family: 'anthropic' | 'openai'
    fromLabel: string
    toLabel: string
    headroomObserved: boolean
    resetText: string | null
    carryWords: string | null
  } | null>(null)
  const limits = useAnthropicLimits()
  const capHandoffIntentRef = useRef<CapHandoffNote | null>(null)
  const settleCapHandoffIntent = (landed: boolean): void => {
    const intent = capHandoffIntentRef.current
    capHandoffIntentRef.current = null
    if (intent !== null && landed) noteCapHandoff(intent.homeModel, intent.homeFamily)
    if (intent !== null && landed) traceCapHandoff('cap-handoff-noted', { ...intent })
  }
  useSyncExternalStore(subscribeUsageRecord, getUsageRecordVersion, getUsageRecordVersion)
  useSyncExternalStore(subscribeOpenaiObserved, getOpenaiObservedVersion, getOpenaiObservedVersion)
  useSyncExternalStore(subscribeCapHandoff, getCapHandoffVersion, getCapHandoffVersion)

  const applyModelSelection = (value: string | null, persist = false, seated?: (state: SeatReceiptState) => void): void => applyModelSelectionOf({ setOverlay, messages, appStateStore, setAppState, addNotification, settleCapHandoffIntent }, value, persist, seated)

  const handleModelSelect = (value: string, persist = false): void => {
    if (value === ANTHROPIC_CONNECT_OPTION_VALUE) {
      setOverlay(null)
      requestCommandDispatch('/logins anthropic')
      return
    }
    if (
      value === GPT_CONNECT_OPTION_VALUE ||
      value === OPENROUTER_CONNECT_OPTION_VALUE ||
      value === GEMINI_CONNECT_OPTION_VALUE ||
      value === HUGGINGFACE_CONNECT_OPTION_VALUE
    ) {
      setOverlay(null)
      requestCommandDispatch('/logins')
      return
    }
    {
      const keyLane = parseKeyConnectValue(value)
      if (keyLane !== undefined) {
        setOverlay(null)
        if (keyLane === 'compat') {
          addNotification({
            key: 'compat-configure',
            text: 'Custom endpoint: set MERCURY_COMPAT_BASE_URL (+ MERCURY_COMPAT_MODELS, optional MERCURY_COMPAT_API_KEY) — the rows go live next /model open',
            priority: 'high',
            timeoutMs: 6000,
          })
          return
        }
        requestCommandDispatch(`/logins ${keyLane}`)
        return
      }
    }
    const probeState = appStateStore.getState()
    const probe = settleModelSelection(probeState, value, {
      turnActive:
        probeState.foregroundTurnActive || probeState.pendingModelSwitch !== null,
    })
    if (probe.kind === 'queued' || probe.kind === 'applied') {
      const gatePlan = previewForSelection(
        messages,
        probeState.engineModelForSession ?? probeState.engineModel,
        value,
      )
      if (gatePlan.needsChoice) {
        setTransitionConfirm({ value, plan: gatePlan, refreshed: false, persist })
        setOverlay('model-transition-preview')
        return
      }
    }
    applyModelSelection(value, persist)
  }

  usePublish(() => {
    const posture = resolveCapPosture()
    {
      const factsNow = getFocusedSessionConnector().modelFacts()
      const effectiveModel = factsNow.sessionPin ?? factsNow.setting ?? factsNow.main
      const family = declaredRouteOf(effectiveModel)
      if (family === 'anthropic' || family === 'openai') {
        const view = slotSeatView(family)
        const activeWall = ((): { walled: boolean; resetsAtMs?: number } => {
          if (family === 'anthropic') {
            return anthropicWindowClosed(limits)
              ? { walled: true, ...(limits.resetsAt !== undefined ? { resetsAtMs: limits.resetsAt * 1000 } : {}) }
              : { walled: false }
          }
          if (view.active === undefined) return { walled: false }
          const window = openaiLimitWindow(view.active === 'api-key' ? 'api-key' : 'chatgpt-subscription')
          return window.state === 'limited' ? { walled: true, resetsAtMs: window.resetsAtMs } : { walled: false }
        })()
        const action = decideSlotWallAction(posture, {
          activeWalled: activeWall.walled,
          otherSignedIn: view.other !== undefined,
          otherWalled: view.other?.walled === true,
        })
        if (action.kind !== 'none' && view.other !== undefined && view.activeLabel !== undefined) {
          const slotKey = slotWallKey(family, view.active ?? '')
          noteSlotWallObserved(family, view.active ?? '', activeWall.walled)
          if (action.kind === 'offer') {
            const turnInFlightNow = appStateStore.getState().foregroundTurnActive
            if (turnInFlightNow) return
            if (!offerDismissed(slotKey) && !modalOverlayUp) {
              setSlotOffer({
                key: slotKey,
                family,
                fromLabel: view.activeLabel,
                toLabel: view.other.label,
                headroomObserved: view.other.wallKnown,
                resetText:
                  activeWall.resetsAtMs !== undefined
                    ? (formatResetTime(activeWall.resetsAtMs / 1000) ?? null)
                    : null,
                carryWords: usageCarryWords(usageForProvider(family).carry) ?? null,
              })
              setOverlay('slot-offer')
              return
            }
          } else if (!offerAutoDone(slotKey)) {
            noteOfferAutoDone(slotKey)
            const outcome = switchActiveSlot(family)
            const durable = paintSlotSwitchReceipt(outcome)
            addNotification({
              key: 'slot-failover',
              text: durable ? slotSwitchTransient(outcome.receipt) : outcome.receipt,
              priority: 'high',
              timeoutMs: 8000,
            })
            return
          }
        }
      }
    }
    if (posture === 'off') return
    const modelFactsNow = getFocusedSessionConnector().modelFacts()
    const effective =
      modelFactsNow.sessionPin ?? modelFactsNow.setting ?? modelFactsNow.main
    const liveRoute = declaredRouteOf(effective)
    const noted = capHandoffState()
    if (noted !== null && liveRoute === noted.homeFamily && modelFactsNow.pendingSwitch === null && appStateStore.getState().pendingModelSwitch === null) {
      traceCapHandoff('cap-handoff-self-heal', { ...noted, effective, pendingSwitch: modelFactsNow.pendingSwitch })
      noteCapReturn()
      return
    }
    const onFailoverLane = noted !== null && liveRoute !== noted.homeFamily
    const homeFamily: string | null = noted !== null && onFailoverLane ? noted.homeFamily : liveRoute
    if (homeFamily === null) return
    const homeUsability = onFailoverLane ? usabilityForRoute(homeFamily as CallModelRoute) : null
    if (homeUsability !== null && homeUsability.credential === 'none') {
      noteCapReturn()
      return
    }
    const window = observedFamilyWindow(homeFamily, undefined, {
      model: onFailoverLane ? (noted?.homeModel ?? null) : effective,
    })
    noteCapWindowObserved(homeFamily, window.state)
    const action =
      onFailoverLane && homeUsability !== null
        ? decideCapReturn(posture, { window: window.state, credentialUsable: homeUsability.usable }, true)
        : decideCapAction(posture, window.state)
    if (action.kind === 'none') return
    const direction: 'handoff' | 'return' = onFailoverLane ? 'return' : 'handoff'
    const windowName = window.windowName ?? null
    const resetText =
      window.resetsAtMs !== undefined ? (formatResetTime(window.resetsAtMs / 1000) ?? null) : null
    const homeName = providerDisplayName(homeFamily)
    if (action.kind === 'offer') {
      if (capOfferAnswered(direction, homeFamily)) return
      if (modalOverlayUp) return
      let target: string | null
      let rows: CapFailoverListedFamily[] = []
      if (direction === 'return') {
        target = noted?.homeModel ?? getFocusedSessionConnector().modelFacts().main
      } else {
        const set = liveCapFailoverCandidates(homeFamily)
        target = set.candidates[0]?.model ?? null
        rows = set.listed
      }
      if (target === null) return
      const targetRoute = declaredRouteOf(target)
      if (targetRoute === null) return
      const awayRouteResolved = direction === 'return' ? liveRoute : targetRoute
      if (awayRouteResolved === null) return
      setCapOffer({
        trigger: action.trigger,
        direction,
        windowName,
        resetText,
        targetModel: target,
        targetRoute,
        rows,
        homeRoute: homeFamily as CallModelRoute,
        awayRoute: awayRouteResolved,
      })
      setOverlay('cap-offer')
      return
    }
    if (capOfferAnswered(direction, homeFamily)) return
    noteCapOfferAnswered(direction, homeFamily)
    if (direction === 'handoff') {
      const target = liveCapFailoverTarget(homeFamily)?.model
      if (target === undefined) return
      capHandoffIntentRef.current = { homeModel: effective, homeFamily }
      applyModelSelection(target)
      const homeCarry = usageCarryWords(usageForProvider(homeFamily as CallModelRoute).carry)
      addNotification({
        key: 'cap-failover',
        text: `Usage handoff: ${renderModelName(target)} — the ${homeName} ${windowName ?? 'usage'} window is reached${resetText !== null ? ` · resets ${resetText}` : ''}${homeCarry !== undefined ? ` · ${homeCarry}` : ''}`,
        priority: 'high',
        timeoutMs: 8000,
      })
      return
    }
    const home = noted?.homeModel ?? null
    noteCapReturn()
    applyModelSelection(home)
    addNotification({
      key: 'cap-failover',
      text: `Returned home: ${home === null ? 'Default' : renderModelName(home)} — the ${homeName} lane`,
      priority: 'high',
      timeoutMs: 8000,
    })
  })

  const capEffectiveModel = focusedEffectiveModel !== '' ? focusedEffectiveModel : (engineModelForSession ?? engineModel ?? focusedMainModel)
  const capLane = capFailoverLaneOf(declaredRouteOf(capEffectiveModel))
  const capNote = capHandoffState()
  const capHomeWindow = capLane !== null && capNote !== null ? observedFamilyWindow(capNote.homeFamily) : null
  const capLaneFacts =
    capLane !== null && capNote !== null
      ? {
          lane: capLane,
          modelName: renderModelName(capEffectiveModel),
          homeName: providerDisplayName(capNote.homeFamily),
          homeWindow: capHomeWindow,
          resetText:
            capHomeWindow !== null && capHomeWindow.resetsAtMs !== undefined
              ? formatResetTime(capHomeWindow.resetsAtMs / 1000)
              : undefined,
        }
      : null
  const capLaneUntil = capLaneLineUntil(capLaneFacts === null ? null : capLaneLineKey(capLaneFacts), Date.now())
  const capLaneStanding = capLaneUntil !== null && Date.now() < capLaneUntil
  useNowTick(capLaneStanding ? 1000 : null)
  const capLaneLine = capLaneStanding && capLaneFacts !== null ? capLaneLineWords(capLaneFacts) : null
  const capLaneCut = capLaneLine !== null && isCompact ? capLaneLineCut(capLaneLine, columns - 1) : null


  const surface = modelDoorsSurfaceOf({ overlay, transitionConfirm, setTransitionConfirm, engineModelForSession, engineModel, focusedMainModel, messages, applyModelSelection, capHandoffIntentRef, setOverlay, addNotification, handleModelSelect, capOffer, setCapOffer, slotOffer, setSlotOffer })

  return { handleModelSelect, capLaneLine, capLaneCut, surface }
}
