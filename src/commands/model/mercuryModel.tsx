import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { MercuryModelPicker, fmtCtx as fmtCtxWindow, type ModelChoice } from '../../components/MercuryModelPicker.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import { useAppState, useSetAppState, useAppStateStore } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { contextFillView } from '../../utils/contextFill.js'
import { getMainLoopModel, parseUserSpecifiedModel, renderModelName } from '../../utils/model/model.js'
import { crossProviderNote, providerFamilyOfSetting, settleModelSelection } from '../../utils/model/modelTransition.js'
import { getFocusedSessionConnector, subscribeThroughFocused } from '../../services/engine-connector/focusedConnector.js'
import {
  previewForSelection,
  reconfirmTransitionPlan,
  transitionPlanSummary,
} from '../../services/providers/transitionPreview.js'
import { TransitionPreviewCard } from '../../components/TransitionPreviewCard.js'
import { resolveProviderUsability, usabilityForRoute } from '../../services/providers/providerUsability.js'
import type { TransitionPlan } from '../../utils/model/modelTransition.js'
import { ANTHROPIC_CONNECT_OPTION_VALUE, ANTHROPIC_MODEL_GROUP, anthropicNotSignedInReason, applyModelAllowlist, DEEPSEEK_MODEL_GROUP, focusedOptionSupports1m, getGptSeatAvailability, getModelOptions, GPT_CONNECT_OPTION_VALUE, isCatalogueDoorRow, isProviderActionRow, type ModelOption, MOONSHOT_MODEL_GROUP, OPENAI_MODEL_GROUP, parseKeyConnectValue, stripContext1m, withContext1m, ZAI_MODEL_GROUP } from '../../utils/model/modelOptions.js'
import { providerFrontierLine } from '../../utils/model/providerFrontier.js'
import {
  OPENROUTER_CONNECT_OPTION_VALUE,
  OPENROUTER_MODEL_GROUP,
  getOpenrouterAvailability,
  getOpenrouterFullModelOptions,
} from '../../services/providers/openrouter/openrouterCatalogue.js'
import { qualifiedIdSpaceOf } from '../../services/providers/idSpaces.js'
import {
  GEMINI_CONNECT_OPTION_VALUE,
  GEMINI_MODEL_GROUP,
  getGeminiAvailability,
} from '../../services/providers/gemini/geminiCatalogue.js'
import {
  HUGGINGFACE_CONNECT_OPTION_VALUE,
  HUGGINGFACE_MODEL_GROUP,
  getHuggingfaceAvailability,
  getHuggingfaceFullModelOptions,
} from '../../services/providers/huggingface/huggingfaceCatalogue.js'
import { HUGGINGFACE_UNVERIFIED_NOTE } from '../../services/providers/huggingface/huggingfaceCallModel.js'
import { LOCAL_MODEL_GROUP, localDiscoverySummary } from '../../services/providers/local/localCatalogue.js'
import { requestCommandDispatch } from '../../utils/cockpit/helmFocus.js'
import { parseGptModelId, withGptServedWindowSuffix } from '../../services/providers/openai/gptPins.js'
import { liveGptContextCeiling } from '../../services/providers/openai/openaiCatalogue.js'
import { anthropicCredentialPresence } from '../../services/providers/providerUsage.js'
import { slotSeatView, switchActiveSlot, type SwitchableFamily } from '../../services/providers/slotSwitch.js'
import { paintSlotSwitchReceipt } from '../../utils/model/slotSwitchReceipt.js'
import { has1mContext } from '../../utils/context.js'
import {
  type EffortValue,
  getDisplayedEffortLabel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  selectableEffortLevels,
  toPersistableEffort,
  unpinAllLaunchEffort,
} from '../../utils/effort.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import { useCatalogueEpoch } from '../../hooks/useCatalogueEpoch.js'

const CATALOGUE_DOORS: Record<string, () => ModelOption[]> = {
  [OPENROUTER_MODEL_GROUP]: () => getOpenrouterFullModelOptions(),
  [HUGGINGFACE_MODEL_GROUP]: () => getHuggingfaceFullModelOptions(),
}

function fmtCtx(windowSize: number): string {
  if (!windowSize) return ''
  return `${fmtCtxWindow(windowSize)} ctx`
}


const subscribeFocusedModelFeed = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
function getFocusedModelKey(): string {
  const facts = getFocusedSessionConnector().modelFacts()
  return `${facts.effective}|${facts.setting ?? ''}|${facts.pendingSwitch ? (facts.pendingSwitch.setting ?? 'default') : ''}`
}

function MercuryModelWrapper({
  messages,
  onDone,
}: {
  messages: Message[]
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay; nextInput?: string; submitNextInput?: boolean },
  ) => void
}): React.ReactNode {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)
  const effortValue = useAppState(s => s.effortValue)
  const supercode = useAppState(s => s.supercode)
  const setAppState = useSetAppState()
  const store = useAppStateStore()
  const betas = getSdkBetas()
  useCatalogueEpoch()
  const focusedModelKey = React.useSyncExternalStore(subscribeFocusedModelFeed, getFocusedModelKey, getFocusedModelKey)
  const focusedSeat = getFocusedSessionConnector().carrier === 'daemon' ? getFocusedSessionConnector().modelFacts() : null
  void focusedModelKey

  const liveModel = getMainLoopModel()
  const efforts = modelSupportsEffort(liveModel)
    ? [
        ...selectableEffortLevels(liveModel),
        ...(modelSupportsMaxEffort(liveModel) ? ['supercode'] : []),
      ]
    : []
  const initialEffort = supercode
    ? 'supercode'
    : getDisplayedEffortLabel(liveModel, effortValue)
  const [effort, setEffort] = React.useState<string>(initialEffort)

  function handleEffort(mode: string): void {
    setEffort(mode)
    if (mode === 'supercode') {
      unpinAllLaunchEffort()
      updateSettingsForSource('userSettings', { effortLevel: 'max', supercodeEffort: true })
      setAppState(prev => ({ ...prev, effortValue: 'max', supercode: true }))
      return
    }
    unpinAllLaunchEffort()
    const persistable = toPersistableEffort(mode as EffortValue)
    if (persistable !== undefined) {
      updateSettingsForSource('userSettings', { effortLevel: persistable, supercodeEffort: undefined })
    }
    setAppState(prev => ({
      ...prev,
      effortValue: mode as EffortValue,
      supercode: false,
    }))
  }

  const options = getModelOptions()
  const choiceOf = (opt: ModelOption): ModelChoice => {
    let ctx = ''
    let ctxBase = ''
    let ctx1m = ''
    if (opt.value !== null && isProviderActionRow(opt.value)) {
      const group = opt.group ?? ANTHROPIC_MODEL_GROUP
      return {
        id: opt.value,
        name: opt.label,
        tag: opt.description,
        ctx: '',
        group,
        action: true,
        ...(opt.catalogueDoor ? { expand: { group, family: opt.catalogueDoor.family, total: opt.catalogueDoor.total } } : {}),
      }
    }
    if (opt.statedContextWindow !== undefined || (typeof opt.value === 'string' && qualifiedIdSpaceOf(opt.value)?.qualifiedPrefix !== undefined)) {
      return {
        id: opt.value as string,
        name: opt.label,
        tag: opt.description,
        ctx: opt.statedContextWindow !== undefined ? fmtCtx(opt.statedContextWindow) : '',
        group: opt.group ?? ANTHROPIC_MODEL_GROUP,
        ...(opt.unavailable ? { gated: true, gatedReason: opt.unavailable } : {}),
      }
    }
    try {
      const v = (opt.value ?? getMainLoopModel()) as string
      const shown =
        focusedOptionSupports1m(v) && !has1mContext(v)
          ? withContext1m(v)
          : v
      const windowProbe = has1mContext(shown)
        ? withContext1m(parseUserSpecifiedModel(stripContext1m(shown)))
        : parseUserSpecifiedModel(shown)
      ctx = fmtCtx(getContextWindowForModel(windowProbe as never, betas))
      if (focusedOptionSupports1m(v)) {
        const pairBase = parseUserSpecifiedModel(stripContext1m(v))
        ctxBase = fmtCtx(getContextWindowForModel(pairBase as never, betas))
        ctx1m = fmtCtx(getContextWindowForModel(withContext1m(pairBase) as never, betas))
      }
      if (typeof opt.value === 'string' && parseGptModelId(opt.value) && liveGptContextCeiling(opt.value) !== undefined) {
        ctxBase = fmtCtx(getContextWindowForModel(withGptServedWindowSuffix(opt.value) as never, betas))
        ctx1m = fmtCtx(getContextWindowForModel(opt.value as never, betas))
      }
    } catch {
      ctx = ''
      ctxBase = ''
      ctx1m = ''
    }
    return {
      id: opt.value ?? 'default',
      name: opt.label,
      tag: opt.description,
      ctx,
      ...(ctxBase !== '' ? { ctxBase } : {}),
      ...(ctx1m !== '' ? { ctx1m } : {}),
      group: opt.group ?? ANTHROPIC_MODEL_GROUP,
      ...(opt.unavailable !== undefined ? { gated: true, gatedReason: opt.unavailable } : {}),
    }
  }
  const models: ModelChoice[] = options.map(choiceOf)
  const expandRows = (group: string): ModelChoice[] =>
    applyModelAllowlist(CATALOGUE_DOORS[group]?.() ?? []).map(choiceOf)
  const labelOf = (id: string): string =>
    options.find(o => (o.value ?? 'default') === id)?.label ??
    Object.values(CATALOGUE_DOORS)
      .flatMap(rows => rows())
      .find(o => o.value === id)?.label ??
    id
  const current =
    focusedSeat !== null
      ? focusedSeat.effective
      : (mainLoopModelForSession ?? mainLoopModel ?? 'default')
  const pendingSwitch = useAppState(s => s.pendingModelSwitch)
  const pendingNext =
    focusedSeat !== null
      ? focusedSeat.pendingSwitch
        ? (focusedSeat.pendingSwitch.setting ?? 'default')
        : undefined
      : pendingSwitch
        ? (pendingSwitch.setting ?? 'default')
        : undefined

  let ctxPct: number | null = null
  try {
    const windowModel = getFocusedSessionConnector().modelFacts().sessionPin ?? mainLoopModelForSession ?? mainLoopModel ?? getMainLoopModel()
    const { usedPct } = contextFillView(messages, windowModel)
    if (usedPct != null) ctxPct = Math.round(usedPct)
  } catch {
    ctxPct = null
  }

  const [notice, setNotice] = React.useState<string | undefined>(undefined)
  const [transitionConfirm, setTransitionConfirm] = React.useState<{
    value: string | null
    id: string
    plan: TransitionPlan
    refreshed: boolean
  } | null>(null)
  const gptAvailability = getGptSeatAvailability()
  const withFrontier = (detail: string, route: Parameters<typeof providerFrontierLine>[0]): string => {
    const line = providerFrontierLine(route)
    return line ? `${line} · ${detail}` : detail
  }
  const usability = resolveProviderUsability()
  const withCredential = (line: string, route: 'zai' | 'moonshot' | 'deepseek'): string => {
    const lane = usability[route]
    return lane.credential !== 'none'
      ? `${line} · ${lane.credential === 'oauth' ? 'signed in' : 'key present'}`
      : `${line} · ${lane.blockers[0] ?? 'not connected'}`
  }
  const anthropicPresence = anthropicCredentialPresence()
  const [slotVersion, setSlotVersion] = React.useState(0)
  void slotVersion
  const seatDetail = (family: SwitchableFamily): string => {
    try {
      const view = slotSeatView(family)
      if (view.other === undefined || view.activeLabel === undefined) return ''
      return ` · active slot: ${view.activeLabel} · s switches to ${view.other.label}`
    } catch {
      return ''
    }
  }
  const handleSlotSwitch = (group: string): string | null => {
    const family: SwitchableFamily | null =
      group === ANTHROPIC_MODEL_GROUP ? 'anthropic' : group === OPENAI_MODEL_GROUP ? 'openai' : null
    if (family === null) return null
    if (slotSeatView(family).other === undefined) return null
    const outcome = switchActiveSlot(family)
    paintSlotSwitchReceipt(outcome)
    setSlotVersion(v => v + 1)
    return outcome.receipt
  }
  const groupDetails: Record<string, string> = {
    [ANTHROPIC_MODEL_GROUP]: withFrontier(
      anthropicPresence.expired
        ? `${anthropicPresence.credentialLabel ?? 'Claude sign-in'} · sign-in expired — /logins reconnects`
        : anthropicPresence.credentialed
          ? `${anthropicPresence.credentialLabel} · credential present`
          : anthropicNotSignedInReason(),
      'anthropic',
    ) + seatDetail('anthropic'),
    [OPENAI_MODEL_GROUP]: withFrontier(
      gptAvailability.state === 'ready'
        ? `${gptAvailability.source} · signed in`
        : gptAvailability.reason,
      'openai',
    ) + seatDetail('openai'),
    ...(providerFrontierLine('zai') !== undefined ? { [ZAI_MODEL_GROUP]: withCredential(providerFrontierLine('zai')!, 'zai') } : {}),
    ...(providerFrontierLine('moonshot') !== undefined
      ? { [MOONSHOT_MODEL_GROUP]: withCredential(providerFrontierLine('moonshot')!, 'moonshot') }
      : {}),
    ...(providerFrontierLine('deepseek') !== undefined
      ? { [DEEPSEEK_MODEL_GROUP]: withCredential(providerFrontierLine('deepseek')!, 'deepseek') }
      : {}),
    [OPENROUTER_MODEL_GROUP]: ((): string => {
      const availability = getOpenrouterAvailability()
      return availability.state === 'ready'
        ? `signed in · ${availability.modelCount} models live · ${availability.source}`
        : availability.reason
    })(),
    [GEMINI_MODEL_GROUP]: ((): string => {
      const availability = getGeminiAvailability()
      return availability.state === 'ready'
        ? `signed in · ${availability.ids.length} chat models live · ${availability.source}`
        : availability.reason
    })(),
    [HUGGINGFACE_MODEL_GROUP]: withFrontier(
      ((): string => {
        const availability = getHuggingfaceAvailability()
        return availability.state === 'ready'
          ? `${HUGGINGFACE_UNVERIFIED_NOTE} · ${availability.source} · signed in`
          : `${HUGGINGFACE_UNVERIFIED_NOTE} · ${availability.reason}`
      })(),
      'huggingface',
    ),
    [LOCAL_MODEL_GROUP]: ((): string => {
      const summary = localDiscoverySummary()
      return summary.servers > 0
        ? `${summary.labels.join(' · ')} · ${summary.models} model${summary.models === 1 ? '' : 's'} · keyless`
        : 'no local server answered'
    })(),
  }
  function handleSelect(id: string): void {
    if (isCatalogueDoorRow(id)) return
    const value = id === 'default' ? null : id
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
              : `GPT catalogue unavailable — ↵ retries · /router engines shows readiness${snapshot?.lastError ? ` (${snapshot.lastError})` : ''}`,
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
            const sourceKind = account.kind === 'oauth' ? ('oauth' as const) : ('api-key' as const)
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
            'Custom endpoint: set MERCURY_COMPAT_BASE_URL (+ MERCURY_COMPAT_MODELS, optional MERCURY_COMPAT_API_KEY or /router key compat) — the rows go live next /model open',
          )
          return
        }
        onDone(
          `${keyLane === 'zai' ? 'GLM (Z.AI)' : keyLane === 'moonshot' ? 'Kimi (Moonshot)' : 'DeepSeek'} sign-in — running /logins ${keyLane}; the picker re-opens when it settles`,
          { nextInput: `/logins ${keyLane} --return=/model`, submitNextInput: true },
        )
        return
      }
    }
    const probeState = store.getState()
    const probe = settleModelSelection(probeState, value, {
      turnActive: probeState.foregroundTurnActive || probeState.pendingModelSwitch !== null,
    })
    if (probe.kind === 'queued' || probe.kind === 'applied') {
      const gatePlan = previewForSelection(
        messages,
        probeState.mainLoopModelForSession ?? probeState.mainLoopModel,
        value,
      )
      if (gatePlan.needsChoice) {
        setTransitionConfirm({ value, id, plan: gatePlan, refreshed: false })
        return
      }
    }
    applySelection(value, id)
  }

  function applySelection(value: string | null, id: string): void {
    const focused = getFocusedSessionConnector()
    if (focused.carrier === 'daemon') {
      const label = labelOf(id)
      const factsBefore = focused.modelFacts()
      void focused.setModel(value).then(receipt => {
        if (receipt.state === 'no-op') {
          onDone(`Already on ${label} — nothing to change`)
          return
        }
        if (receipt.state === 'refused') {
          onDone(`The model switch was refused: ${receipt.detail}`)
          return
        }
        const doorCross = providerFamilyOfSetting(factsBefore.effective) !== providerFamilyOfSetting(value) ? crossProviderNote(value) : ''
        const plan = previewForSelection(messages, factsBefore.effective, value)
        const lossNote = transitionPlanSummary(plan)
        onDone(
          receipt.state === 'queued'
            ? `Model switch queued: ${label} applies when this session's turn settles (the running turn keeps its model)${doorCross}${lossNote}`
            : `Set model to ${label} — this session's next message runs it${receipt.note !== undefined ? ` (${receipt.note})` : ''}${doorCross}${lossNote}`,
        )
      })
      return
    }
    const label = labelOf(id)
    const stateNow = store.getState()
    const settled = settleModelSelection(stateNow, value, {
      turnActive: stateNow.foregroundTurnActive || stateNow.pendingModelSwitch !== null,
    })
    if (settled.kind === 'no-op') {
      onDone(`Already on ${label} — nothing to change`)
      return
    }
    if (settled.kind === 'cancelled-pending') {
      setAppState(prev => ({ ...prev, ...settled.patch }))
      onDone(`Already on ${label} — queued switch cancelled`)
      return
    }
    const effectiveFrom = stateNow.mainLoopModelForSession ?? stateNow.mainLoopModel
    const plan = previewForSelection(messages, effectiveFrom, value)
    const lossNote = transitionPlanSummary(plan)
    if (settled.kind === 'queued') {
      setAppState(prev => ({ ...prev, ...settled.patch }))
      onDone(
        `Model switch queued: ${label} applies when the current turn settles (the running turn keeps its model)${settled.crossProvider ? crossProviderNote(value) : ''}${lossNote}`,
      )
      return
    }
    setAppState(prev => ({ ...prev, ...settled.patch }))
    onDone(
      `Set model to ${label}${settled.receipt.crossProvider ? crossProviderNote(value) : ''}${lossNote}`,
    )
  }

  if (transitionConfirm) {
    const held = transitionConfirm
    return (
      <TransitionPreviewCard
        plan={held.plan}
        targetUsability={usabilityForRoute(held.plan.targetRoute)}
        fromLabel={renderModelName(mainLoopModelForSession ?? getMainLoopModel())}
        toLabel={held.value === null ? 'Default' : renderModelName(held.value)}
        refreshed={held.refreshed}
        onConfirm={() => {
          const verdict = reconfirmTransitionPlan(held.plan, messages)
          if (!verdict.ok) {
            setTransitionConfirm({ ...held, plan: verdict.freshPlan, refreshed: true })
            return
          }
          setTransitionConfirm(null)
          applySelection(held.value, held.id)
        }}
        onCancel={() => {
          setTransitionConfirm(null)
          onDone(
            `Kept model as ${renderModelName(mainLoopModelForSession ?? getMainLoopModel())} — switch cancelled at the preview`,
          )
        }}
      />
    )
  }

  return (
    <MercuryModelPicker
      models={models}
      current={current}
      ctxPct={ctxPct}
      efforts={efforts}
      effort={effort}
      onEffort={handleEffort}
      notice={notice}
      groupDetails={groupDetails}
      onSlotSwitch={handleSlotSwitch}
      expandRows={expandRows}
      {...(pendingNext !== undefined ? { pendingNext } : {})}
      onSelect={handleSelect}
      onClose={() =>
        onDone(
          mainLoopModelForSession
            ? `Kept model as ${renderModelName(mainLoopModelForSession)} (session override)`
            : `Kept model as ${renderModelName(getMainLoopModel())}`,
          { display: 'system' },
        )
      }
    />
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  if (args?.trim()) {
    const base = await import('./model.js')
    return base.call(onDone, context, args)
  }
  return <MercuryModelWrapper messages={context.messages ?? []} onDone={onDone} />
}
