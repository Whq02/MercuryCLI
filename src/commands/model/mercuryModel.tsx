import * as React from 'react'
import { hostEndpointChoice, hostRunModelRows, modelDoorRoad, removeHostEndpoint, retryHostEndpoint } from '../../services/host/door.js'
import { runHostedModel } from '../../services/host/index.js'
import { llmHostPopupRequest } from '../llmhost/llmhost.js'
import { openSettingsPopup } from '../../utils/cockpit/settingsPopup.js'
import type { CommandResultDisplay } from '../../commands.js'
import { MercuryModelPicker, type ModelChoice } from '../../components/MercuryModelPicker.js'
import { ModelPickerPopupLease } from '../../components/ModelPickerPopupSlot.js'
import { claimModelPickerPopup } from '../../utils/cockpit/modelPickerPopup.js'
import { MercuryModelLandingGate } from './modelPickerLandingGate.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import { useAppState, useSetAppState, useSetAppStateMaybe, useAppStateStore } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { contextFillView } from '../../utils/contextFill.js'
import { getDefaultEngineModel, getEngineModel, parseUserSpecifiedModel, renderModelName } from '../../utils/model/model.js'
import { crossProviderNote, providerFamilyOfSetting, seatWithFold, settleModelSelection, type SeatReceiptState } from '../../utils/model/modelTransition.js'
import { focusedSessionModelFacts, getFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js'
import { previewDaemonModelSelection } from './model.js'
import {
  previewForSelection,
  reconfirmTransitionPlan,
  transitionPlanSummary,
} from '../../services/providers/transitionPreview.js'
import { TransitionPreviewCard } from '../../components/TransitionPreviewCard.js'
import { usabilityForRoute } from '../../services/providers/providerUsability.js'
import type { TransitionPlan } from '../../utils/model/modelTransition.js'
import { ANTHROPIC_CONNECT_OPTION_VALUE, ANTHROPIC_MODEL_GROUP, getGptSeatAvailability, getModelOptions, GPT_CONNECT_OPTION_VALUE, isCatalogueDoorRow, isProviderActionRow, parseKeyConnectValue, signInFamilyOfRow } from '../../utils/model/modelOptions.js'
import { nextBirthModel } from '../../services/switchboard/bootBirthFacts.js'
import { OPENROUTER_CONNECT_OPTION_VALUE } from '../../services/providers/openrouter/openrouterCatalogue.js'
import { NOUS_CONNECT_OPTION_VALUE, getNousAvailability, refreshNousCatalogue } from '../../services/providers/nous/nousCatalogue.js'
import { GEMINI_CONNECT_OPTION_VALUE } from '../../services/providers/gemini/geminiCatalogue.js'
import { HUGGINGFACE_CONNECT_OPTION_VALUE, getHuggingfaceAvailability } from '../../services/providers/huggingface/huggingfaceCatalogue.js'
import type { TensorFoldAct } from '../../components/tensorfold/tensorfoldRows.js'
import { pairTensorFoldHost, tensorFoldCapableMachine } from '../../components/tensorfold/tensorfoldFacts.js'
import { useModelTensorFoldFacts } from '../../components/tensorfold/tensorfoldModelFacts.js'
import { requestCommandDispatch } from '../../utils/cockpit/helmFocus.js'
import { readModelUseLedger } from '../../utils/model/modelUseLedger.js'
import {
  type EffortLevel,
  type EffortValue,
  getDisplayedEffortLabel,
  getEffortEnvOverride,
  getInitialEffortSetting,
  modelSupportsEffort,
  parseEffortValue,
  resolveStampedEffortTruth,
  selectableEffortLevels,
  toPersistableEffort,
  unpinAllLaunchEffort,
} from '../../utils/effort.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { useCatalogueEpoch } from '../../hooks/useCatalogueEpoch.js'
import { persistEffortChoice, persistModelChoice } from './persistModelChoice.js'
import { matchReachableModelName, modelNameAskWords } from '../../utils/model/modelNameRoad.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import { GPT_ROAD, OPENROUTER_ROAD, GEMINI_ROAD, ANTHROPIC_SUBSCRIPTION_ROAD, ANTHROPIC_KEY_ROAD, ANTHROPIC_BEARER_ROAD, NOUS_ROAD, HUGGINGFACE_ROAD, MOONSHOT_ROAD, DEEPSEEK_ROAD, ZAI_ROAD, XAI_ROAD, META_ROAD, MINIMAX_ROAD, TOGETHER_ROAD, COHERE_ROAD, GROQ_ROAD, MELIOUS_ROAD, CEREBRAS_ROAD, FIREWORKS_ROAD, QWEN_ROAD, MISTRAL_ROAD, LOCAL_ROAD, useCatalogueRefreshOnOpen } from './picker/roads.js'
import { familyOfModelGroup, providerHeadingsOf } from './picker/headings.js'
import { resolveCurrentRowId, subscribeFocusedModelFeed, getFocusedModelKey, modelChoiceOf, expandRowsOf, pickLabelOf, slotSwitchOf, seatGroupOf, orderedModelChoices, servedByTensorFold, tensorFoldPodEndpoints, runModelTensorFoldAct, noteModelUse, retryNamedCompatRow } from './picker/rows.js'

export { familyOfModelGroup } from './picker/headings.js'
export { servedByTensorFold, tensorFoldPodEndpoints, modelChoiceLabel, modelChoiceRow } from './picker/rows.js'

type PickRoad = { flip: boolean; door?: string }

type ModelNameAsk = { notice: string; filter: string }

function MercuryModelWrapper({
  messages,
  onDone,
  ask,
}: {
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
  const servedModel = focusedSeat !== null ? focusedSeat.effective : (engineModelForSession ?? getEngineModel())

  const liveModel = servedModel
  const efforts = modelSupportsEffort(liveModel) ? [...selectableEffortLevels(liveModel)] : []
  const seatEffort = focusedSeat?.effort != null ? parseEffortValue(focusedSeat.effort) : undefined
  const initialEffort =
    seatEffort !== undefined
      ? resolveStampedEffortTruth(liveModel, seatEffort).label
      : getDisplayedEffortLabel(liveModel, effortValue)
  const [effort, setEffort] = React.useState<string>(initialEffort)

  function handleEffort(mode: string): void {
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

  const options = getModelOptions()
  const current = focusedSeat?.effective ?? engineModelForSession ?? engineModel ?? getEngineModel()
  const tensorFold = useModelTensorFoldFacts(current, words => {
    if (pickerOpen.current) setNotice(words)
  })
  const tensorfold = tensorFold?.picker
  const tensorFoldPods = React.useMemo(() => tensorFoldPodEndpoints(tensorfold?.pods ?? []), [tensorfold])
  const listedModels: ModelChoice[] = options.flatMap(opt => hostEndpointChoice(modelChoiceOf(opt, betas))).filter(choice => !servedByTensorFold(choice, tensorFoldPods))
  const pickerOpen = React.useRef(true)
  React.useEffect(() => () => { pickerOpen.current = false }, [])
  const uses = readModelUseLedger()
  const recentAt = (group: string): number | undefined => {
    const family = familyOfModelGroup(group)
    return family === undefined ? undefined : uses[family]?.at
  }
  const expandRows = (group: string): ModelChoice[] => expandRowsOf(group, betas)
  const labelOf = (id: string): string => pickLabelOf(options, id)
  const currentRowId = resolveCurrentRowId(listedModels, current)
  const models = [...orderedModelChoices(listedModels, currentRowId), ...hostRunModelRows()]
  const topGroup = seatGroupOf(listedModels, currentRowId)
  const pendingSwitch = useAppState(s => s.pendingModelSwitch)
  const pendingNext =
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
  function handleSelect(id: string, door?: string): void {
    if (id.startsWith('host-retry:')) {
      setNotice('Checking this server…')
      void retryHostEndpoint(id.slice('host-retry:'.length)).then(setNotice)
      return
    }
    if (id.startsWith('host-remove:')) {
      void removeHostEndpoint(id.slice('host-remove:'.length)).then(setNotice)
      return
    }
    if (id.startsWith('host-run:')) {
      const title = id.slice('host-run:'.length)
      onDone('Opening ' + title + ' in /llmhost', { display: 'system' })
      openSettingsPopup(llmHostPopupRequest(modelDoorRoad(runHostedModel, title)))
      return
    }
    if (isCatalogueDoorRow(id)) return
    const otherDoor = door !== undefined && !isProviderActionRow(id) && headings[ANTHROPIC_MODEL_GROUP]?.doors.some(candidate => candidate.door === door && candidate.active !== true)
    const pick: PickRoad = { flip: otherDoor === true, ...(door !== undefined ? { door } : {}) }
    const value = id
    if (id === ANTHROPIC_CONNECT_OPTION_VALUE) {
      onDone('Claude sign-in — running /logins (the picker re-opens when it settles)', {
        nextInput: '/logins anthropic --return=/model',
        submitNextInput: true,
      })
      return
    }
    if (id === GPT_CONNECT_OPTION_VALUE) {
      const availability = getGptSeatAvailability()
      const why = availability.state === 'disabled' ? availability.why : undefined
      if (why === 'catalogue-pending' || why === 'catalogue-error') {
        void (async () => {
          const { refreshOpenaiCatalogue } = await import(
            '../../services/providers/openai/openaiCatalogue.js'
          )
          const { resolveOpenaiAccount } = await import(
            '../../services/providers/openai/openaiAccounts.js'
          )
          const account = resolveOpenaiAccount()
          if (!account) {
            onDone('GPT sign-in — running /logins (the picker re-opens when it settles)', {
              nextInput: '/logins openai --return=/model',
              submitNextInput: true,
            })
            return
          }
          setNotice(`GPT — refreshing the live catalogue from the ${account.label}…`)
          const snapshot = await refreshOpenaiCatalogue(account.kind, { force: true }).catch(() => null)
          setNotice(
            snapshot && snapshot.models.length > 0 && !snapshot.lastError
              ? `GPT catalogue landed: ${snapshot.models.length} model(s) from the ${account.label} — pick one above`
              : `GPT catalogue unavailable — ↵ retries · /logins shows readiness${snapshot?.lastError ? ` (${snapshot.lastError})` : ''}`,
          )
        })()
        return
      }
      onDone('GPT sign-in — running /logins (the picker re-opens when it settles)', {
        nextInput: '/logins openai --return=/model',
        submitNextInput: true,
      })
      return
    }
    if (id === OPENROUTER_CONNECT_OPTION_VALUE) {
      void (async () => {
        const { getOpenrouterAvailability, refreshOpenrouterCatalogue } = await import(
          '../../services/providers/openrouter/openrouterCatalogue.js'
        )
        const availability = getOpenrouterAvailability()
        if (
          availability.state === 'ready' ||
          availability.why === 'catalogue-pending' ||
          availability.why === 'catalogue-error'
        ) {
          const { resolveOpenrouterRequestAuth } = await import(
            '../../services/providers/openrouter/openrouterAccounts.js'
          )
          const auth = resolveOpenrouterRequestAuth()
          if (auth) {
            setNotice('OpenRouter — refreshing the live catalogue…')
            const snapshot = await refreshOpenrouterCatalogue(auth.account.keySource, { force: true }).catch(() => null)
            setNotice(
              snapshot && snapshot.models.length > 0 && !snapshot.lastError
                ? `OpenRouter catalogue landed: ${snapshot.models.length} model(s) — pick one above`
                : `OpenRouter catalogue unavailable — ↵ retries${snapshot?.lastError ? ` (${snapshot.lastError})` : ''}`,
            )
            return
          }
        }
        onDone('OpenRouter sign-in — running /logins (the picker re-opens when it settles)', {
          nextInput: '/logins openrouter --return=/model',
          submitNextInput: true,
        })
      })()
      return
    }
    if (id === NOUS_CONNECT_OPTION_VALUE) {
      void (async () => {
        const availability = getNousAvailability()
        if (availability.state === 'ready' || availability.why === 'catalogue-pending' || availability.why === 'catalogue-error') {
          setNotice('Nous Portal — refreshing the live catalogue…')
          const snapshot = await refreshNousCatalogue({ force: true }).catch(() => null)
          setNotice(
            snapshot && snapshot.models.length > 0 && !snapshot.lastError
              ? `Nous Portal catalogue landed: ${snapshot.models.length} model(s) — pick one above`
              : `Nous Portal catalogue unavailable — ↵ retries${snapshot?.lastError ? ` (${snapshot.lastError})` : ''}`,
          )
          return
        }
        onDone('Nous Portal key — running /logins nous (the picker re-opens when it settles)', {
          nextInput: '/logins nous --return=/model',
          submitNextInput: true,
        })
      })()
      return
    }
    if (id === GEMINI_CONNECT_OPTION_VALUE) {
      void (async () => {
        const { getGeminiAvailability, refreshGeminiCatalogue } = await import(
          '../../services/providers/gemini/geminiCatalogue.js'
        )
        const availability = getGeminiAvailability()
        if (
          availability.state === 'ready' ||
          availability.why === 'catalogue-pending' ||
          availability.why === 'catalogue-error'
        ) {
          const { resolveGeminiAccount } = await import(
            '../../services/providers/gemini/geminiAccounts.js'
          )
          const account = resolveGeminiAccount()
          if (account) {
            const sourceKind = account.kind
            setNotice('Gemini — refreshing the live catalogue…')
            const snapshot = await refreshGeminiCatalogue(sourceKind, { force: true }).catch(() => null)
            setNotice(
              snapshot && snapshot.models.length > 0 && !snapshot.lastError
                ? `Gemini catalogue landed: ${snapshot.models.length} model(s) — pick one above`
                : `Gemini catalogue unavailable — ↵ retries${snapshot?.lastError ? ` (${snapshot.lastError})` : ''}`,
            )
            return
          }
        }
        onDone('Gemini sign-in — running /logins (the picker re-opens when it settles)', {
          nextInput: '/logins gemini --return=/model',
          submitNextInput: true,
        })
      })()
      return
    }
    if (id === HUGGINGFACE_CONNECT_OPTION_VALUE) {
      void (async () => {
        const { refreshHuggingfaceCatalogue } = await import(
          '../../services/providers/huggingface/huggingfaceCatalogue.js'
        )
        const availability = getHuggingfaceAvailability()
        if (availability.state === 'ready') {
          setNotice('Hugging Face — refreshing the live catalogue…')
          const snapshot = await refreshHuggingfaceCatalogue({ force: true }).catch(() => null)
          setNotice(
            snapshot && snapshot.models.length > 0 && !snapshot.lastError
              ? `Hugging Face catalogue landed: ${snapshot.models.length} model(s) — pick one above (any listed id types as huggingface/<org>/<model>)`
              : `Hugging Face catalogue unavailable — ↵ retries; the dated pins dispatch directly${snapshot?.lastError ? ` (${snapshot.lastError})` : ''}`,
          )
          return
        }
        requestCommandDispatch('/logins')
        onDone('Hugging Face sign-in — running /logins (the rows go live once a credential connects; HF_TOKEN works too)')
      })()
      return
    }
    {
      const keyLane = parseKeyConnectValue(id)
      if (keyLane !== undefined) {
        if (keyLane === 'compat') {
          onDone(
            'Custom endpoint: set MERCURY_COMPAT_BASE_URL (+ MERCURY_COMPAT_MODELS, optional MERCURY_COMPAT_API_KEY) — the rows go live next /model open',
          )
          return
        }
        if (keyLane.startsWith('compat/')) {
          if (retryNamedCompatRow(id, setNotice)) return
          const name = keyLane.slice('compat/'.length)
          onDone(`Custom endpoint '${name}' — running /logins ${keyLane}; the picker re-opens afterwards`, { nextInput: `/logins ${keyLane} --return=/model`, submitNextInput: true })
          return
        }
        if (keyLane === 'moonshot') {
          void (async () => {
            const { resolveMoonshotAccount } = await import('../../services/providers/moonshot/moonshotAccounts.js')
            const account = resolveMoonshotAccount()
            if (account) {
              const { moonshotCatalogueRows, refreshMoonshotCatalogue } = await import('../../services/providers/moonshot/moonshotCatalogue.js')
              setNotice(`Moonshot — reading the model list of the ${account.label}…`)
              await refreshMoonshotCatalogue({ force: true }).catch(() => null)
              const { source } = moonshotCatalogueRows()
              setNotice(
                source.kind === 'live'
                  ? `Moonshot model list landed: ${source.count} model(s) from the ${account.label} — pick one above`
                  : `Moonshot model list unavailable — ↵ retries${source.kind === 'unread' && source.error !== undefined ? ` (${source.error})` : ''}`,
              )
              return
            }
            onDone('Kimi (Moonshot) sign-in — running /logins moonshot; the picker re-opens when it settles', { nextInput: '/logins moonshot --return=/model', submitNextInput: true })
          })()
          return
        }
        const keyLaneLabels: Record<Exclude<typeof keyLane, 'compat' | 'moonshot' | `compat/${string}`>, string> = { zai: 'GLM (Z.AI)', deepseek: 'DeepSeek', xai: 'xAI', meta: 'Meta', mistral: 'Mistral', zen: 'OpenCode Zen', minimax: 'MiniMax', together: 'Together AI', cohere: 'Cohere', groq: 'Groq', orcarouter: 'OrcaRouter', melious: 'Melious AI', cerebras: 'Cerebras', fireworks: 'Fireworks', qwen: 'Qwen' }
        onDone(
          `${keyLaneLabels[keyLane as keyof typeof keyLaneLabels] ?? keyLane} sign-in — running /logins ${keyLane}; the picker re-opens when it settles`,
          { nextInput: `/logins ${keyLane} --return=/model`, submitNextInput: true },
        )
        return
      }
    }
    const daemonPreview = previewDaemonModelSelection(value)
    if (daemonPreview !== null && 'reason' in daemonPreview) {
      onDone(daemonPreview.reason, { display: 'system' })
      return
    }
    let gatePlan = daemonPreview?.plan
    if (daemonPreview === null) {
      const probeState = store.getState()
      const probe = settleModelSelection(probeState, value, {
        turnActive: probeState.foregroundTurnActive || probeState.pendingModelSwitch !== null,
      })
      if (probe.kind === 'queued' || probe.kind === 'applied') {
        gatePlan = previewForSelection(messages, probeState.engineModelForSession ?? probeState.engineModel, value)
      }
    }
    if (gatePlan?.needsChoice) {
      setTransitionConfirm({ value, id, plan: gatePlan, refreshed: false, pick })
      return
    }
    applySelection(value, id, pick)
  }

  function applySelection(value: string, id: string, pick: PickRoad = { flip: false }, seated?: (state: SeatReceiptState) => void): void {
    const focused = getFocusedSessionConnector()
    if (focused.carrier === 'daemon') {
      const label = labelOf(id)
      const factsBefore = focused.modelFacts()
      const messagesBefore = [...focused.records()]
      const choice = persistModelChoice(value)
      void focused.setModel(value).then(receipt => {
        if (receipt.state === 'refused') {
          choice.restore()
          onDone(`The model switch was refused: ${receipt.detail}`)
          return
        }
        const slotNote = flipDoorNote(pick)
        const saved = choice.sentence
        if (receipt.state === 'no-op') {
          onDone(saved === '' && slotNote === '' ? `Already on ${label} — nothing to change` : `Already on ${label}${saved}${slotNote}`)
          seated?.(receipt.state)
          return
        }
        noteModelUse(value, pick.door)
        const doorCross = providerFamilyOfSetting(factsBefore.effective) !== providerFamilyOfSetting(value) ? crossProviderNote(value) : ''
        const plan = previewForSelection(messagesBefore, factsBefore.effective, value)
        const lossNote = transitionPlanSummary(plan)
        onDone(
          receipt.state === 'queued'
            ? `Model switch queued: ${label}${saved} — applies when this session's turn settles (the running turn keeps its model)${doorCross}${lossNote}${slotNote}`
            : `Set model to ${label}${saved} — this session's next message runs it${receipt.note !== undefined ? ` (${receipt.note})` : ''}${doorCross}${lossNote}${slotNote}`,
        )
        seated?.(receipt.state)
      })
      return
    }
    const label = labelOf(id)
    const stateNow = store.getState()
    const settled = settleModelSelection(stateNow, value, {
      turnActive: stateNow.foregroundTurnActive || stateNow.pendingModelSwitch !== null,
    })
    const slotNote = flipDoorNote(pick)
    const saved = persistModelChoice(value).sentence
    if (settled.kind === 'no-op') {
      onDone(saved === '' && slotNote === '' ? `Already on ${label} — nothing to change` : `Already on ${label}${saved}${slotNote}`)
      return
    }
    noteModelUse(value, pick.door)
    if (settled.kind === 'cancelled-pending') {
      setAppState(prev => ({ ...prev, ...settled.patch }))
      onDone(`Already on ${label} — queued switch cancelled${saved}${slotNote}`)
      return
    }
    const effectiveFrom = stateNow.engineModelForSession ?? stateNow.engineModel
    const plan = previewForSelection(messages, effectiveFrom, value)
    const lossNote = transitionPlanSummary(plan)
    if (settled.kind === 'queued') {
      setAppState(prev => ({ ...prev, ...settled.patch }))
      onDone(
        `Model switch queued: ${label}${saved} — applies when the current turn settles (the running turn keeps its model)${settled.crossProvider ? crossProviderNote(value) : ''}${lossNote}${slotNote}`,
      )
      return
    }
    setAppState(prev => ({ ...prev, ...settled.patch }))
    onDone(
      `Set model to ${label}${saved}${settled.receipt.crossProvider ? crossProviderNote(value) : ''}${lossNote}${slotNote}`,
    )
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
      void pairTensorFoldHost(act.host, act.code)
        .then(words => {
          if (words !== undefined && pickerOpen.current) setNotice(words)
          return tensorFold.read()
        })
        .catch(() => undefined)
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
      ctxPct={ctxPct}
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
          focusedSeat === null && engineModelForSession
            ? `Kept model as ${renderModelName(engineModelForSession)} (session override)`
            : `Kept model as ${renderModelName(servedModel)}`,
          { display: 'system' },
        )
      }
    />
  )
}


export function MercuryModelDefaultPicker({ onDone, onSignIn }: { onDone: () => void; onSignIn?: (family: string | undefined) => void }): React.ReactNode {
  const setAppState = useSetAppStateMaybe()
  useCatalogueEpoch()
  const betas = getSdkBetas()
  const model = nextBirthModel() ?? getEngineModel()
  const efforts = modelSupportsEffort(model) ? [...selectableEffortLevels(model)] : []
  const [effort, setEffort] = React.useState<string>(() => getDisplayedEffortLabel(model, getInitialEffortSetting()))
  const [slotVersion] = React.useState(0)
  const [notice, setNotice] = React.useState<string | undefined>(undefined)
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
  const options = getModelOptions()
  const listedModels: ModelChoice[] = options.map(opt => modelChoiceOf(opt, betas))
  const currentRowId = resolveCurrentRowId(listedModels, model)
  const models = orderedModelChoices(listedModels, currentRowId)
  const topGroup = seatGroupOf(listedModels, currentRowId)
  function handleEffort(mode: string): void {
    const persistable = toPersistableEffort(mode as EffortValue)
    if (persistable === undefined) return
    const { error } = updateSettingsForSource('userSettings', { engine: { effort: persistable } })
    if (error) {
      setNotice(`Could not save the effort level: ${error.message}`)
      return
    }
    unpinAllLaunchEffort()
    setEffort(mode)
    const override = getEffortEnvOverride()
    setNotice(override !== undefined && override !== persistable
      ? `Saved ${persistable} as your default, but MERCURY_EFFORT_LEVEL=${flagEnv('MERCURY_EFFORT_LEVEL') ?? ''} overrides this session — clear it to let ${persistable} take over.`
      : undefined)
    setAppState?.(prev => ({ ...prev, effortValue: persistable }))
  }
  function handleSelect(id: string, door?: string): void {
    if (isCatalogueDoorRow(id)) return
    if (isProviderActionRow(id)) {
      if (!retryNamedCompatRow(id, setNotice)) onSignIn?.(signInFamilyOfRow(id))
      return
    }
    const saved = persistModelChoice(id)
    if (saved.outcome !== 'saved' && saved.outcome !== 'session') {
      setNotice(saved.sentence)
      return
    }
    noteModelUse(id, door)
    if (setAppState !== null) {
      setAppState(prev => {
        const settled = settleModelSelection(prev, id, {
          turnActive: prev.foregroundTurnActive || prev.pendingModelSwitch !== null,
        })
        return settled.patch === null ? prev : { ...prev, ...settled.patch }
      })
    }
    onDone()
  }
  return (
    <MercuryModelPicker
      models={models}
      current={currentRowId}
      ctxPct={null}
      efforts={efforts}
      effort={effort}
      onEffort={handleEffort}
      notice={notice}
      headings={providerHeadingsOf(slotVersion)}
      {...(topGroup !== undefined ? { topGroup } : {})}
      expandRows={group => expandRowsOf(group, betas)}
      onSelect={handleSelect}
      onClose={onDone}
    />
  )
}

export function MercurySessionModelPicker({
  currentModel,
  currentEffort,
  onSelect,
  onEffort,
  onDone,
  onSignIn,
}: {
  currentModel: string | undefined
  currentEffort: string | undefined
  onSelect: (modelId: string, displayName: string) => void
  onEffort: (effort: string) => void
  onDone: () => void
  onSignIn?: (family: string | undefined) => void
}): React.ReactNode {
  useCatalogueEpoch()
  const betas = getSdkBetas()
  const model = currentModel ?? nextBirthModel() ?? getEngineModel()
  const efforts = modelSupportsEffort(model) ? [...selectableEffortLevels(model)] : []
  const effort = currentEffort ?? 'default'
  const [slotVersion] = React.useState(0)
  const [notice, setNotice] = React.useState<string | undefined>(undefined)
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
  const options = getModelOptions()
  const listedModels: ModelChoice[] = options.map(opt => modelChoiceOf(opt, betas))
  const currentRowId = resolveCurrentRowId(listedModels, model)
  const models = orderedModelChoices(listedModels, currentRowId)
  const topGroup = seatGroupOf(listedModels, currentRowId)
  function handleEffort(mode: string): void {
    onEffort(mode)
  }
  function handleSelect(id: string, door?: string): void {
    if (isCatalogueDoorRow(id)) return
    if (isProviderActionRow(id)) {
      if (!retryNamedCompatRow(id, setNotice)) onSignIn?.(signInFamilyOfRow(id))
      return
    }
    noteModelUse(id, door)
    onSelect(id, models.find(m => m.id === id)?.name ?? id)
    onDone()
  }
  return (
    <MercuryModelPicker
      models={models}
      current={currentRowId}
      ctxPct={null}
      efforts={efforts}
      effort={effort}
      onEffort={handleEffort}
      notice={notice}
      headings={providerHeadingsOf(slotVersion)}
      {...(topGroup !== undefined ? { topGroup } : {})}
      expandRows={group => expandRowsOf(group, betas)}
      onSelect={handleSelect}
      onClose={onDone}
    />
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const typed = args?.trim() ?? ''
  let ask: ModelNameAsk | undefined
  if (typed !== '') {
    const lowered = typed.toLowerCase()
    const matched = COMMON_INFO_ARGS.includes(lowered) || COMMON_HELP_ARGS.includes(lowered) ? null : matchReachableModelName(typed)
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
      <MercuryModelLandingGate>
        <MercuryModelWrapper messages={context.messages ?? []} onDone={onDone} {...(ask !== undefined ? { ask } : {})} />
      </MercuryModelLandingGate>
    </ModelPickerPopupLease>
  )
}

export function MercuryModelChoicePicker({ leading, current, onSelect, onSignIn, onClose, line, hint, ctxPct = null }: {
  leading?: ModelChoice[]
  current: string
  onSelect: (id: string) => void
  onSignIn?: (id: string) => void
  onClose: () => void
  line?: string
  hint?: string
  ctxPct?: number | null
}): React.ReactNode {
  useCatalogueEpoch()
  const [notice, setNotice] = React.useState<string | undefined>(undefined)
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
  const betas = getSdkBetas()
  const options = getModelOptions().filter(opt => onSignIn !== undefined || !isProviderActionRow(opt.value) || isCatalogueDoorRow(opt.value))
  const catalogue = options.map(opt => modelChoiceOf(opt, betas))
  const models: ModelChoice[] = [...(leading ?? []), ...orderedModelChoices(catalogue, current)]
  const topGroup = seatGroupOf(models, current)
  return (
    <MercuryModelPicker
      models={models}
      current={current}
      ctxPct={ctxPct}
      notice={notice ?? line}
      headings={providerHeadingsOf(0)}
      {...(topGroup !== undefined ? { topGroup } : {})}
      {...(hint !== undefined ? { hint } : {})}
      expandRows={group => expandRowsOf(group, betas)}
      onSelect={id => {
        if (isCatalogueDoorRow(id)) return
        if (isProviderActionRow(id)) {
          if (!retryNamedCompatRow(id, setNotice)) onSignIn?.(id)
          return
        }
        onSelect(id)
      }}
      onClose={onClose}
    />
  )
}
