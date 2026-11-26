import * as React from 'react'
import { PickerSeatScope, type CrewmatePickerSeat } from '../../screen/composer/crewmateCommands.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { hostEndpointChoice, hostRunModelRows } from '../../models/hosting/door.js'
import type { CommandResultDisplay } from '../catalogue/commands.js'
import { MercuryModelPicker, type ModelChoice } from './picker/MercuryModelPicker.js'
import { ModelPickerPopupLease } from '../../screen/overlays/ModelPickerPopupSlot.js'
import { claimModelPickerPopup } from '../../screen/cockpit/modelPickerPopup.js'
import { MercuryModelLandingGate } from './modelPickerLandingGate.js'
import { getSdkBetas } from '../../boot/process-state/processState.js'
import { useAppState, useSetAppState, useAppStateStore } from '../../screen/app-state/AppState.js'
import type { LocalJSXCommandCall } from '../catalogue/command.js'
import type { Message } from '../../engine/message-shapes/message.js'
import { contextFillView } from '../../engine/context-window/contextFill.js'
import { getDefaultEngineModel, getEngineModel, parseUserSpecifiedModel, renderModelName } from '../../models/catalogue/engineModel.js'
import { seatWithFold, type SeatReceiptState } from '../../models/catalogue/modelTransition.js'
import { focusedSessionModelFacts, getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import { reconfirmTransitionPlan } from '../../models/roads/transitionPreview.js'
import { TransitionPreviewCard } from './TransitionPreviewCard.js'
import { usabilityForRoute } from '../../models/roads/providerUsability.js'
import type { TransitionPlan } from '../../models/catalogue/modelTransition.js'
import { ANTHROPIC_CONNECT_OPTION_VALUE, ANTHROPIC_MODEL_GROUP, getModelOptions, GPT_CONNECT_OPTION_VALUE, isCatalogueDoorRow, isProviderActionRow, parseKeyConnectValue } from '../../models/catalogue/modelOptions.js'
import { OPENROUTER_CONNECT_OPTION_VALUE } from '../../models/roads/openrouter/openrouterCatalogue.js'
import { NOUS_CONNECT_OPTION_VALUE } from '../../models/roads/nous/nousCatalogue.js'
import { GEMINI_CONNECT_OPTION_VALUE } from '../../models/roads/gemini/geminiCatalogue.js'
import { HUGGINGFACE_CONNECT_OPTION_VALUE } from '../../models/roads/huggingface/huggingfaceCatalogue.js'
import type { TensorFoldAct } from '../../screen/tensorfold/tensorfoldRows.js'
import { pairTensorFoldHost, tensorFoldCapableMachine } from '../../screen/tensorfold/tensorfoldFacts.js'
import { useModelTensorFoldFacts } from '../../screen/tensorfold/tensorfoldModelFacts.js'
import { requestCommandDispatch } from '../../screen/cockpit/helmFocus.js'
import { readModelUseLedger } from '../../models/facts/modelUseLedger.js'
import { type EffortLevel, type EffortValue, getDisplayedEffortLabel, modelSupportsEffort, parseEffortValue, resolveStampedEffortTruth, selectableEffortLevels, toPersistableEffort, unpinAllLaunchEffort } from '../../models/effort/effort.js'
import { useCatalogueEpoch } from '../../screen/model-picker/useCatalogueEpoch.js'
import { useClaim } from '../../screen/effects/effects.js'
import { persistEffortChoice } from './persistModelChoice.js'
import { matchReachableModelName, modelNameAskWords } from '../../models/catalogue/modelNameRoad.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../engine/message-shapes/messageTags.js'
import { GPT_ROAD, OPENROUTER_ROAD, GEMINI_ROAD, ANTHROPIC_SUBSCRIPTION_ROAD, ANTHROPIC_KEY_ROAD, ANTHROPIC_BEARER_ROAD, NOUS_ROAD, HUGGINGFACE_ROAD, MOONSHOT_ROAD, DEEPSEEK_ROAD, ZAI_ROAD, XAI_ROAD, META_ROAD, MINIMAX_ROAD, TOGETHER_ROAD, COHERE_ROAD, GROQ_ROAD, MELIOUS_ROAD, CEREBRAS_ROAD, FIREWORKS_ROAD, QWEN_ROAD, MISTRAL_ROAD, LOCAL_ROAD, useCatalogueRefreshOnOpen } from './picker/roads.js'
import { familyOfModelGroup, providerHeadingsOf } from './picker/headings.js'
import { resolveCurrentRowId, subscribeFocusedModelFeed, getFocusedModelKey, modelChoiceOf, expandRowsOf, pickLabelOf, slotSwitchOf, seatGroupOf, orderedModelChoices, servedByTensorFold, tensorFoldPodEndpoints, runModelTensorFoldAct } from './picker/rows.js'
import { type PickRoad, type PickContext, selectHostRow, connectClaude, connectGpt, connectOpenrouter, connectNous, connectGemini, connectHuggingface, selectKeyLane, selectThroughGate } from './picker/select.js'
import { applyOnSeat, applyLocally } from './picker/apply.js'

export { familyOfModelGroup } from './picker/headings.js'
export { servedByTensorFold, tensorFoldPodEndpoints, modelChoiceLabel, modelChoiceRow } from './picker/rows.js'
export { MercuryModelDefaultPicker } from './picker/DefaultPicker.js'
export { MercurySessionModelPicker } from './picker/SessionPicker.js'
export { MercuryModelChoicePicker } from './picker/ChoicePicker.js'

type ModelNameAsk = { notice: string; filter: string }

export function runModelTensorFoldPair(
  act: Extract<TensorFoldAct, { kind: 'pair' }>,
  io: {
    pair?: typeof pairTensorFoldHost
    read: () => Promise<unknown>
    setNotice: (words: string) => void
    isOpen: () => boolean
  },
): Promise<unknown> {
  return (io.pair ?? pairTensorFoldHost)(act.host, act.code)
    .then(words => {
      if (words !== undefined && io.isOpen()) io.setNotice(words)
      return io.read()
    })
    .catch(error => {
      if (io.isOpen()) io.setNotice(error instanceof Error ? error.message : String(error))
    })
}

function MercuryModelWrapper({
  messages,
  onDone,
  ask,
  seat,
}: {
  seat?: CrewmatePickerSeat
  messages: Message[]
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay; nextInput?: string; submitNextInput?: boolean },
  ) => void
  ask?: ModelNameAsk
}): React.ReactNode {
  const engineModel = useAppState(s => s.engineModel)
  const engineModelForSession = useAppState(s => s.engineModelForSession)
  const effortValue = useAppState(s => s.effortValue)
  const setAppState = useSetAppState()
  const store = useAppStateStore()
  const betas = getSdkBetas()
  useCatalogueEpoch()
  const focusedModelKey = React.useSyncExternalStore(subscribeFocusedModelFeed, getFocusedModelKey, getFocusedModelKey)
  const focusedSeat = focusedSessionModelFacts()
  void focusedModelKey
  const servedModel = seat?.model ?? focusedSeat?.effective ?? engineModelForSession ?? getEngineModel()

  const liveModel = servedModel
  const efforts = modelSupportsEffort(liveModel) ? [...selectableEffortLevels(liveModel)] : []
  const word = seat === undefined ? focusedSeat?.effort : seat.effort
  const seatEffort = word != null ? parseEffortValue(word) : undefined
  const initialEffort =
    seatEffort !== undefined
      ? resolveStampedEffortTruth(liveModel, seatEffort).label
      : getDisplayedEffortLabel(liveModel, seat === undefined ? effortValue : undefined)
  const [effort, setEffort] = React.useState<string>(initialEffort)

  function handleEffort(mode: string): void {
    if (seat !== undefined) {
      void seat.setEffort(mode).then(words => { setEffort(mode); setNotice(words) }, error => setNotice(errorMessage(error)))
      return
    }
    setEffort(mode)
    unpinAllLaunchEffort()
    const persistable = toPersistableEffort(mode as EffortValue)
    if (persistable !== undefined) {
      const kept = persistEffortChoice(persistable)
      if (settleOnSeat(persistable, kept.sentence, () => setAppState(prev => ({ ...prev, effortValue: persistable })))) return
      setNotice(`Effort set to ${persistable}${kept.sentence}`)
    }
    setAppState(prev => ({
      ...prev,
      effortValue: mode as EffortValue,
    }))
  }

  function settleOnSeat(level: EffortLevel, standing: string, mirror: () => void): boolean {
    const focused = getFocusedSessionConnector()
    if (focused.carrier !== 'daemon') return false
    void focused.setEffort(level).then(receipt => {
      if (receipt.state === 'refused') {
        setEffort(initialEffort)
        setNotice(`The effort switch was refused: ${receipt.detail}`)
        return
      }
      mirror()
      setNotice(
        receipt.state === 'queued'
          ? `Effort switch queued: ${level} applies when this session's turn settles`
          : receipt.state === 'no-op'
            ? `Already on ${level}`
            : `Effort set to ${level} — this session's next request runs it${standing}`,
      )
    })
    return true
  }

  const options = getModelOptions().filter(option => seat === undefined || !isProviderActionRow(option.value) || isCatalogueDoorRow(option.value))
  const current = seat?.model ?? focusedSeat?.effective ?? engineModelForSession ?? engineModel ?? getEngineModel()
  const tensorFold = useModelTensorFoldFacts(current, words => {
    if (pickerOpen.current) setNotice(words)
  })
  const tensorfold = seat === undefined ? tensorFold?.picker : undefined
  const tensorFoldPods = React.useMemo(() => tensorFoldPodEndpoints(tensorfold?.pods ?? []), [tensorfold])
  const listedModels: ModelChoice[] = options.flatMap(opt => hostEndpointChoice(modelChoiceOf(opt, betas))).filter(choice => !servedByTensorFold(choice, tensorFoldPods))
  const pickerOpen = React.useRef(true)
  useClaim(() => () => { pickerOpen.current = false }, [])
  const uses = readModelUseLedger()
  const recentAt = (group: string): number | undefined => {
    const family = familyOfModelGroup(group)
    return family === undefined ? undefined : uses[family]?.at
  }
  const expandRows = (group: string): ModelChoice[] => expandRowsOf(group, betas)
  const labelOf = (id: string): string => pickLabelOf(options, id)
  const currentRowId = resolveCurrentRowId(listedModels, current)
  const models = [...orderedModelChoices(listedModels, currentRowId), ...(seat === undefined ? hostRunModelRows() : [])]
  const topGroup = seatGroupOf(listedModels, currentRowId)
  const pendingSwitch = useAppState(s => s.pendingModelSwitch)
  const pendingNext = seat !== undefined ? undefined :
    focusedSeat !== null
      ? focusedSeat.pendingSwitch
        ? resolveCurrentRowId(models, parseUserSpecifiedModel(focusedSeat.pendingSwitch.setting ?? getDefaultEngineModel()))
        : undefined
      : pendingSwitch
        ? resolveCurrentRowId(models, parseUserSpecifiedModel(pendingSwitch.setting ?? getDefaultEngineModel()))
        : undefined

  let ctxPct: number | null = null
  try {
    const { usedPct } = contextFillView(messages, servedModel)
    if (usedPct != null) ctxPct = Math.round(usedPct)
  } catch {
    ctxPct = null
  }

  const [notice, setNotice] = React.useState<string | undefined>(ask?.notice)
  const [transitionConfirm, setTransitionConfirm] = React.useState<{
    value: string
    id: string
    plan: TransitionPlan
    refreshed: boolean
    pick: PickRoad
  } | null>(null)
  const [slotVersion, setSlotVersion] = React.useState(0)
  void slotVersion
  useCatalogueRefreshOnOpen(GPT_ROAD, setNotice)
  useCatalogueRefreshOnOpen(OPENROUTER_ROAD, setNotice)
  useCatalogueRefreshOnOpen(GEMINI_ROAD, setNotice)
  useCatalogueRefreshOnOpen(HUGGINGFACE_ROAD, setNotice)
  useCatalogueRefreshOnOpen(NOUS_ROAD, setNotice)
  useCatalogueRefreshOnOpen(MOONSHOT_ROAD, setNotice)
  useCatalogueRefreshOnOpen(DEEPSEEK_ROAD, setNotice)
  useCatalogueRefreshOnOpen(ZAI_ROAD, setNotice)
  useCatalogueRefreshOnOpen(XAI_ROAD, setNotice)
  useCatalogueRefreshOnOpen(META_ROAD, setNotice)
  useCatalogueRefreshOnOpen(MISTRAL_ROAD, setNotice)
  useCatalogueRefreshOnOpen(MINIMAX_ROAD, setNotice)
  useCatalogueRefreshOnOpen(TOGETHER_ROAD, setNotice)
  useCatalogueRefreshOnOpen(COHERE_ROAD, setNotice)
  useCatalogueRefreshOnOpen(GROQ_ROAD, setNotice)
  useCatalogueRefreshOnOpen(MELIOUS_ROAD, setNotice)
  useCatalogueRefreshOnOpen(CEREBRAS_ROAD, setNotice)
  useCatalogueRefreshOnOpen(FIREWORKS_ROAD, setNotice)
  useCatalogueRefreshOnOpen(QWEN_ROAD, setNotice)
  useCatalogueRefreshOnOpen(LOCAL_ROAD, setNotice)
  useCatalogueRefreshOnOpen(ANTHROPIC_SUBSCRIPTION_ROAD, setNotice)
  useCatalogueRefreshOnOpen(ANTHROPIC_KEY_ROAD, setNotice)
  useCatalogueRefreshOnOpen(ANTHROPIC_BEARER_ROAD, setNotice)
  const handleSlotSwitch = (group: string): string | null => slotSwitchOf(group, () => setSlotVersion(v => v + 1))
  const headings = providerHeadingsOf(slotVersion)
  const flipDoorNote = (pick: PickRoad): string => {
    if (!pick.flip) return ''
    const receipt = handleSlotSwitch(ANTHROPIC_MODEL_GROUP)
    return receipt === null ? '' : ` · ${receipt}`
  }
  const pickCtx: PickContext = { messages, onDone, store, setAppState, setNotice, setTransitionConfirm, applySelection, labelOf, flipDoorNote }
  function handleSelect(id: string, door?: string): void {
    if (isCatalogueDoorRow(id)) return
    if (seat !== undefined) {
      void seat.setModel(id).then(words => onDone(words), error => setNotice(errorMessage(error)))
      return
    }
    if (selectHostRow(pickCtx, id)) return
    const otherDoor = door !== undefined && !isProviderActionRow(id) && headings[ANTHROPIC_MODEL_GROUP]?.doors.some(candidate => candidate.door === door && candidate.active !== true)
    const pick: PickRoad = { flip: otherDoor === true, ...(door !== undefined ? { door } : {}) }
    const value = id
    if (id === ANTHROPIC_CONNECT_OPTION_VALUE) {
      connectClaude(pickCtx)
      return
    }
    if (id === GPT_CONNECT_OPTION_VALUE) {
      connectGpt(pickCtx)
      return
    }
    if (id === OPENROUTER_CONNECT_OPTION_VALUE) {
      connectOpenrouter(pickCtx)
      return
    }
    if (id === NOUS_CONNECT_OPTION_VALUE) {
      connectNous(pickCtx)
      return
    }
    if (id === GEMINI_CONNECT_OPTION_VALUE) {
      connectGemini(pickCtx)
      return
    }
    if (id === HUGGINGFACE_CONNECT_OPTION_VALUE) {
      connectHuggingface(pickCtx)
      return
    }
    {
      const keyLane = parseKeyConnectValue(id)
      if (keyLane !== undefined) {
        selectKeyLane(pickCtx, id, keyLane)
        return
      }
    }
    selectThroughGate(pickCtx, value, id, pick)
  }

  function applySelection(value: string, id: string, pick: PickRoad = { flip: false }, seated?: (state: SeatReceiptState) => void): void {
    const focused = getFocusedSessionConnector()
    if (focused.carrier === 'daemon') {
      applyOnSeat(pickCtx, focused, value, id, pick, seated)
      return
    }
    applyLocally(pickCtx, value, id, pick)
  }

  if (transitionConfirm) {
    const held = transitionConfirm
    return (
      <TransitionPreviewCard
        plan={held.plan}
        targetUsability={usabilityForRoute(held.plan.targetRoute)}
        fromLabel={renderModelName(servedModel)}
        toLabel={renderModelName(held.value)}
        refreshed={held.refreshed}
        onConfirm={() => {
          const focused = getFocusedSessionConnector()
          const confirmMessages = focused.carrier === 'daemon' ? [...focused.records()] : messages
          const verdict = reconfirmTransitionPlan(held.plan, confirmMessages)
          if (!verdict.ok) {
            setTransitionConfirm({ ...held, plan: verdict.freshPlan, refreshed: true })
            return
          }
          setTransitionConfirm(null)
          if (held.plan.window?.fits === false) {
            seatWithFold(getFocusedSessionConnector(), held.plan.targetRoute, seated => applySelection(held.value, held.id, held.pick, seated), requestCommandDispatch)
            return
          }
          applySelection(held.value, held.id, held.pick)
        }}
        onCancel={() => {
          setTransitionConfirm(null)
          onDone(
            `Kept model as ${renderModelName(servedModel)} — switch cancelled at the preview`,
          )
        }}
      />
    )
  }

  const onTensorFold = (act: TensorFoldAct): void => {
    if (tensorFold === undefined) return
    if (act.kind === 'pair') {
      void runModelTensorFoldPair(act, {
        read: () => tensorFold.read(),
        setNotice,
        isOpen: () => pickerOpen.current,
      })
      return
    }
    void runModelTensorFoldAct(act, tensorFold, { setAppState }, { close: words => onDone(words, { display: 'system' }), read: async () => void (await tensorFold.read(true)) }).catch(error => {
      if (pickerOpen.current) setNotice(error instanceof Error ? error.message : String(error))
    })
  }

  return (
    <MercuryModelPicker
      models={models}
      current={currentRowId}
      ctxPct={seat === undefined ? ctxPct : seat.contextPercent}
      efforts={efforts}
      effort={effort}
      onEffort={handleEffort}
      notice={notice}
      headings={headings}
      {...(topGroup !== undefined ? { topGroup } : {})}
      expandRows={expandRows}
      {...(pendingNext !== undefined ? { pendingNext } : {})}
      {...(ask !== undefined && ask.filter !== '' ? { initialFilter: ask.filter } : {})}
      {...(tensorfold !== undefined ? { tensorfold } : {})}
      onTensorFold={onTensorFold}
      recentAt={recentAt}
      tensorFoldFirst={Object.keys(uses).length === 0 && tensorFoldCapableMachine()}
      onSelect={handleSelect}
      onClose={() =>
        onDone(
          seat === undefined && focusedSeat === null && engineModelForSession
            ? `Kept model as ${renderModelName(engineModelForSession)} (session override)`
            : `Kept model as ${renderModelName(servedModel)}`,
          { display: 'system' },
        )
      }
    />
  )
}



export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const typed = args?.trim() ?? ''
  const seat = await context.crewmateSeat?.('model')
  let ask: ModelNameAsk | undefined
  if (typed !== '') {
    const lowered = typed.toLowerCase()
    if (seat !== undefined && COMMON_INFO_ARGS.includes(lowered)) {
      onDone(seat.modelStatus())
      return null
    }
    const matched = COMMON_INFO_ARGS.includes(lowered) || COMMON_HELP_ARGS.includes(lowered) ? null : matchReachableModelName(typed)
    if (seat !== undefined && !COMMON_HELP_ARGS.includes(lowered) && (matched === null || matched.kind === 'exact' || matched.kind === 'match')) {
      onDone(await seat.setModel(matched?.id ?? typed))
      return null
    }
    if (matched === null || matched.kind === 'exact') {
      const base = await import('./model.js')
      return base.call(onDone, context, matched === null ? typed : matched.id, typed)
    }
    if (matched.kind === 'match') {
      const base = await import('./model.js')
      return base.call((result, options) => onDone(result === undefined ? undefined : `${matched.said}\n${result}`, options), context, matched.id, typed)
    }
    const options = getModelOptions()
    ask = { notice: modelNameAskWords(matched, id => pickLabelOf(options, id)), filter: typed }
  }
  claimModelPickerPopup()
  return (
    <ModelPickerPopupLease>
      <PickerSeatScope seat={seat} onDone={onDone}>
        <MercuryModelLandingGate>
          <MercuryModelWrapper seat={seat} messages={context.messages ?? []} onDone={onDone} {...(ask !== undefined ? { ask } : {})} />
        </MercuryModelLandingGate>
      </PickerSeatScope>
    </ModelPickerPopupLease>
  )
}
