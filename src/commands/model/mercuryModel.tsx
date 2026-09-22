import * as React from 'react'
import { isDeepStrictEqual } from 'node:util'
import type { CommandResultDisplay } from '../../commands.js'
import { MercuryModelPicker, fmtCtx as fmtCtxWindow, type ModelChoice } from '../../components/MercuryModelPicker.js'
import { MercuryModelLandingGate } from './modelPickerLandingGate.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import { useAppState, useSetAppState, useSetAppStateMaybe, useAppStateStore } from '../../state/AppState.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { contextFillView } from '../../utils/contextFill.js'
import { getDefaultMainLoopModel, getMainLoopModel, normalizeModelStringForAPI, parseUserSpecifiedModel, renderModelName } from '../../utils/model/model.js'
import { crossProviderNote, providerFamilyOfSetting, settleModelSelection } from '../../utils/model/modelTransition.js'
import { focusedSessionModelFacts, getFocusedSessionConnector, subscribeThroughFocused } from '../../services/engine-connector/focusedConnector.js'
import {
  previewForSelection,
  reconfirmTransitionPlan,
  transitionPlanSummary,
} from '../../services/providers/transitionPreview.js'
import { TransitionPreviewCard } from '../../components/TransitionPreviewCard.js'
import { resolveProviderUsability, usabilityForRoute } from '../../services/providers/providerUsability.js'
import type { TransitionPlan } from '../../utils/model/modelTransition.js'
import { ANTHROPIC_CONNECT_OPTION_VALUE, ANTHROPIC_MODEL_GROUP, anthropicNotSignedInReason, applyModelAllowlist, DEEPSEEK_MODEL_GROUP, focusedOptionSupports1m, getGptSeatAvailability, getModelOptions, GPT_CONNECT_OPTION_VALUE, isCatalogueDoorRow, isProviderActionRow, type ModelOption, MOONSHOT_MODEL_GROUP, OPENAI_MODEL_GROUP, parseKeyConnectValue, signInFamilyOfRow, stripContext1m, withContext1m, ZAI_MODEL_GROUP } from '../../utils/model/modelOptions.js'
import { nextBirthModel } from '../../services/switchboard/bootBirthFacts.js'
import {
  OPENROUTER_CONNECT_OPTION_VALUE,
  OPENROUTER_MODEL_GROUP,
  getCachedOpenrouterCatalogue,
  getOpenrouterAvailability,
  getOpenrouterFullModelOptions,
  refreshOpenrouterCatalogue,
  type OpenrouterCatalogueSnapshot,
} from '../../services/providers/openrouter/openrouterCatalogue.js'
import { resolveOpenrouterRequestAuth } from '../../services/providers/openrouter/openrouterAccounts.js'
import { credentialFingerprint } from '../../services/providers/credentialIdentity.js'
import { qualifiedIdSpaceOf } from '../../services/providers/idSpaces.js'
import {
  GEMINI_CONNECT_OPTION_VALUE,
  GEMINI_MODEL_GROUP,
  getCachedGeminiCatalogue,
  getGeminiAvailability,
  refreshGeminiCatalogue,
  type GeminiCatalogueSnapshot,
} from '../../services/providers/gemini/geminiCatalogue.js'
import { geminiSourceIdentity, resolveGeminiAccount } from '../../services/providers/gemini/geminiAccounts.js'
import {
  HUGGINGFACE_CONNECT_OPTION_VALUE,
  HUGGINGFACE_MODEL_GROUP,
  getCachedHuggingfaceCatalogue,
  getHuggingfaceAvailability,
  getHuggingfaceFullModelOptions,
  refreshHuggingfaceCatalogue,
  type HuggingfaceCatalogueSnapshot,
} from '../../services/providers/huggingface/huggingfaceCatalogue.js'
import { resolveHuggingfaceApiKey } from '../../services/providers/huggingface/huggingfaceAccounts.js'
import { HUGGINGFACE_UNVERIFIED_NOTE } from '../../services/providers/huggingface/huggingfaceCallModel.js'
import { LOCAL_MODEL_GROUP, localDiscoverySummary } from '../../services/providers/local/localCatalogue.js'
import { getCachedLocalDiscovery, localProbeTargets, refreshLocalDiscovery, type LocalDiscoverySnapshot } from '../../services/providers/local/localDiscovery.js'
import { requestCommandDispatch } from '../../utils/cockpit/helmFocus.js'
import { parseGptModelId, withGptServedWindowSuffix } from '../../services/providers/openai/gptPins.js'
import { getCachedOpenaiCatalogue, liveGptContextCeiling, refreshOpenaiCatalogue, type OpenaiCatalogueSnapshot } from '../../services/providers/openai/openaiCatalogue.js'
import { openaiSourceIdentity, resolveOpenaiAccount } from '../../services/providers/openai/openaiAccounts.js'
import { anthropicCredentialPresence } from '../../services/providers/providerUsage.js'
import { slotSeatView, switchActiveSlot, type SwitchableFamily } from '../../services/providers/slotSwitch.js'
import { paintSlotSwitchReceipt } from '../../utils/model/slotSwitchReceipt.js'
import { has1mContext } from '../../utils/context.js'
import {
  type EffortLevel,
  type EffortValue,
  getDisplayedEffortLabel,
  getInitialEffortSetting,
  getInitialSupercodeSetting,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  parseEffortValue,
  resolveStampedEffortTruth,
  selectableEffortLevels,
  toPersistableEffort,
  unpinAllLaunchEffort,
} from '../../utils/effort.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import { useCatalogueEpoch } from '../../hooks/useCatalogueEpoch.js'
import { persistModelChoice } from './persistModelChoice.js'

const CATALOGUE_DOORS: Record<string, () => ModelOption[]> = {
  [OPENROUTER_MODEL_GROUP]: () => getOpenrouterFullModelOptions(),
  [HUGGINGFACE_MODEL_GROUP]: () => getHuggingfaceFullModelOptions(),
}

function fmtCtx(windowSize: number): string {
  if (!windowSize) return ''
  return `${fmtCtxWindow(windowSize)} ctx`
}


function resolveCurrentRowId(models: ModelChoice[], served: string): string {
  if (models.some(m => m.id === served)) return served
  const target = stripContext1m(served)
  const rows = models.filter(m => !m.gated && !m.action)
  const resolvedOf = (id: string): string | null => {
    try {
      return parseUserSpecifiedModel(id)
    } catch {
      return null
    }
  }
  for (const exact of [true, false]) {
    for (const m of rows) {
      const resolved = resolvedOf(m.id)
      if (resolved === null || stripContext1m(resolved) !== target) continue
      if (exact && has1mContext(resolved) !== has1mContext(served)) continue
      return m.id
    }
  }
  return served
}

const subscribeFocusedModelFeed = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
function getFocusedModelKey(): string {
  const facts = getFocusedSessionConnector().modelFacts()
  return `${facts.effective}|${facts.setting ?? ''}|${facts.pendingSwitch ? (facts.pendingSwitch.setting ?? 'default') : ''}`
}

type CatalogueRoad<S> = {
  family: string
  identity: () => string | undefined
  cached: () => S | null
  refresh: () => Promise<S | null>
  populated: (snapshot: S) => boolean
  failed: (snapshot: S) => boolean
  changed: (before: S, after: S) => boolean
}

const byPriority = (models: OpenaiCatalogueSnapshot['models']): OpenaiCatalogueSnapshot['models'] =>
  models.toSorted((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))

const GPT_ROAD: CatalogueRoad<OpenaiCatalogueSnapshot> = {
  family: 'GPT',
  identity: () => {
    const account = resolveOpenaiAccount()
    return account ? `${account.kind}:${openaiSourceIdentity(account.kind)}` : undefined
  },
  cached: () => {
    const account = resolveOpenaiAccount()
    return account ? getCachedOpenaiCatalogue(account.kind) : null
  },
  refresh: () => {
    const account = resolveOpenaiAccount()
    return account ? refreshOpenaiCatalogue(account.kind, { force: true }) : Promise.resolve(null)
  },
  populated: snapshot => snapshot.models.length > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(byPriority(before.models), byPriority(after.models)),
}

const OPENROUTER_ROAD: CatalogueRoad<OpenrouterCatalogueSnapshot> = {
  family: 'OpenRouter',
  identity: () => {
    const auth = resolveOpenrouterRequestAuth()
    return auth ? `${auth.account.keySource}:${credentialFingerprint(auth.headers.authorization)}:${auth.baseUrl}` : undefined
  },
  cached: () => {
    const auth = resolveOpenrouterRequestAuth()
    return auth ? getCachedOpenrouterCatalogue(auth.account.keySource) : null
  },
  refresh: () => {
    const auth = resolveOpenrouterRequestAuth()
    return auth ? refreshOpenrouterCatalogue(auth.account.keySource, { force: true }) : Promise.resolve(null)
  },
  populated: snapshot => snapshot.models.length > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}

const geminiSourceKind = (): 'oauth' | 'api-key' | undefined => {
  const account = resolveGeminiAccount()
  return account ? (account.kind === 'oauth' ? 'oauth' : 'api-key') : undefined
}

const GEMINI_ROAD: CatalogueRoad<GeminiCatalogueSnapshot> = {
  family: 'Gemini',
  identity: () => {
    const sourceKind = geminiSourceKind()
    return sourceKind ? `${sourceKind}:${geminiSourceIdentity(sourceKind)}` : undefined
  },
  cached: () => {
    const sourceKind = geminiSourceKind()
    return sourceKind ? getCachedGeminiCatalogue(sourceKind) : null
  },
  refresh: () => {
    const sourceKind = geminiSourceKind()
    return sourceKind ? refreshGeminiCatalogue(sourceKind, { force: true }) : Promise.resolve(null)
  },
  populated: snapshot => snapshot.models.length > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}

const HUGGINGFACE_ROAD: CatalogueRoad<HuggingfaceCatalogueSnapshot> = {
  family: 'Hugging Face',
  identity: () => {
    const credential = resolveHuggingfaceApiKey()
    return credential ? `${credential.source}:${credentialFingerprint(credential.key)}` : undefined
  },
  cached: () => (resolveHuggingfaceApiKey() ? getCachedHuggingfaceCatalogue() : null),
  refresh: () => (resolveHuggingfaceApiKey() ? refreshHuggingfaceCatalogue({ force: true }) : Promise.resolve(null)),
  populated: snapshot => snapshot.models.length > 0,
  failed: snapshot => snapshot.lastError !== undefined,
  changed: (before, after) => !isDeepStrictEqual(before.models, after.models),
}

const LOCAL_ROAD: CatalogueRoad<LocalDiscoverySnapshot> = {
  family: 'Local',
  identity: () => {
    const targets = localProbeTargets()
    return targets.length === 0 ? undefined : targets.map(target => `${target.kind}=${target.root}`).join(',')
  },
  cached: () => getCachedLocalDiscovery(),
  refresh: () => refreshLocalDiscovery({ force: true }),
  populated: snapshot => snapshot.servers.some(server => server.models.length > 0),
  failed: () => false,
  changed: (before, after) => !isDeepStrictEqual(before.servers, after.servers),
}

function useCatalogueRefreshOnOpen<S>(road: CatalogueRoad<S>, setNotice: (notice: string) => void): void {
  const identity = road.identity()
  React.useEffect(() => {
    if (identity === undefined) return
    const before = road.cached()
    let open = true
    void road.refresh().then(snapshot => {
      if (
        open && before !== null && road.populated(before) && snapshot !== null && !road.failed(snapshot) &&
        road.identity() === identity && road.cached() === snapshot && road.changed(before, snapshot)
      ) {
        setNotice(`${road.family} — the live list changed; rows updated`)
      }
    }, () => {})
    return () => { open = false }
  }, [road, identity, setNotice])
}

function modelChoiceOf(opt: ModelOption, betas: string[] | undefined): ModelChoice {
  let ctx = ''
  let ctxBase = ''
  let ctx1m = ''
  if (isProviderActionRow(opt.value)) {
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
  if (opt.unavailable !== undefined && parseGptModelId(opt.value)) {
    return { id: opt.value, name: opt.label, tag: opt.description, ctx: '', group: opt.group ?? ANTHROPIC_MODEL_GROUP, gated: true, gatedReason: opt.unavailable }
  }
  if (opt.statedContextWindow !== undefined || qualifiedIdSpaceOf(opt.value)?.qualifiedPrefix !== undefined) {
    return {
      id: opt.value,
      name: opt.label,
      tag: opt.description,
      ctx: opt.statedContextWindow !== undefined ? fmtCtx(opt.statedContextWindow) : '',
      group: opt.group ?? ANTHROPIC_MODEL_GROUP,
      ...(opt.unavailable ? { gated: true, gatedReason: opt.unavailable } : {}),
    }
  }
  try {
    const v = opt.value
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
    if (parseGptModelId(opt.value) && liveGptContextCeiling(opt.value) !== undefined) {
      ctxBase = fmtCtx(getContextWindowForModel(withGptServedWindowSuffix(opt.value) as never, betas))
      ctx1m = fmtCtx(getContextWindowForModel(opt.value as never, betas))
    }
  } catch {
    ctx = ''
    ctxBase = ''
    ctx1m = ''
  }
  return {
    id: opt.value,
    name: opt.label,
    tag: opt.description,
    ctx,
    ...(ctxBase !== '' ? { ctxBase } : {}),
    ...(ctx1m !== '' ? { ctx1m } : {}),
    group: opt.group ?? ANTHROPIC_MODEL_GROUP,
    ...(opt.unavailable !== undefined ? { gated: true, gatedReason: opt.unavailable } : {}),
  }
}

function expandRowsOf(group: string, betas: string[] | undefined): ModelChoice[] {
  return applyModelAllowlist(CATALOGUE_DOORS[group]?.() ?? []).map(opt => modelChoiceOf(opt, betas))
}

function pickLabelOf(options: ModelOption[], id: string): string {
  return (
    options.find(o => o.value === id)?.label ??
    Object.values(CATALOGUE_DOORS)
      .flatMap(rows => rows())
      .find(o => o.value === id)?.label ??
    id
  )
}

function seatDetailOf(family: SwitchableFamily): string {
  try {
    const view = slotSeatView(family)
    if (view.other === undefined || view.activeLabel === undefined) return ''
    return ` · active slot: ${view.activeLabel} · s switches to ${view.other.label}`
  } catch {
    return ''
  }
}

function slotSwitchOf(group: string, bump: () => void): string | null {
  const family: SwitchableFamily | null =
    group === ANTHROPIC_MODEL_GROUP ? 'anthropic' : group === OPENAI_MODEL_GROUP ? 'openai' : null
  if (family === null) return null
  if (slotSeatView(family).other === undefined) return null
  const outcome = switchActiveSlot(family)
  paintSlotSwitchReceipt(outcome)
  bump()
  return outcome.receipt
}

function groupDetailsOf(seatDetail: (family: SwitchableFamily) => string): Record<string, string> {
  const gptAvailability = getGptSeatAvailability()
  const usability = resolveProviderUsability()
  const credentialWords = (route: 'zai' | 'moonshot' | 'deepseek'): string => {
    const lane = usability[route]
    return lane.credential !== 'none'
      ? lane.credential === 'oauth' ? 'signed in' : 'key present'
      : lane.blockers[0] ?? 'not connected'
  }
  const anthropicPresence = anthropicCredentialPresence()
  return {
    [ANTHROPIC_MODEL_GROUP]:
      (anthropicPresence.expired
        ? `${anthropicPresence.credentialLabel ?? 'Claude sign-in'} · sign-in expired — /logins reconnects`
        : anthropicPresence.credentialed
          ? 'credential present'
          : anthropicNotSignedInReason()) + seatDetail('anthropic'),
    [OPENAI_MODEL_GROUP]:
      (gptAvailability.state === 'ready' ? `${gptAvailability.source} · signed in` : gptAvailability.reason) + seatDetail('openai'),
    [ZAI_MODEL_GROUP]: credentialWords('zai'),
    [MOONSHOT_MODEL_GROUP]: credentialWords('moonshot'),
    [DEEPSEEK_MODEL_GROUP]: credentialWords('deepseek'),
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
    [HUGGINGFACE_MODEL_GROUP]: ((): string => {
      const availability = getHuggingfaceAvailability()
      return availability.state === 'ready'
        ? `${HUGGINGFACE_UNVERIFIED_NOTE} · ${availability.source} · signed in`
        : `${HUGGINGFACE_UNVERIFIED_NOTE} · ${availability.reason}`
    })(),
    [LOCAL_MODEL_GROUP]: ((): string => {
      const summary = localDiscoverySummary()
      return summary.servers > 0
        ? `${summary.labels.join(' · ')} · ${summary.models} model${summary.models === 1 ? '' : 's'} · keyless`
        : 'no local server answered'
    })(),
  }
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
  const focusedSeat = focusedSessionModelFacts()
  void focusedModelKey
  const servedModel = focusedSeat !== null ? focusedSeat.effective : (mainLoopModelForSession ?? getMainLoopModel())

  const liveModel = servedModel
  const efforts = modelSupportsEffort(liveModel)
    ? [
        ...selectableEffortLevels(liveModel),
        ...(modelSupportsMaxEffort(liveModel) ? ['supercode'] : []),
      ]
    : []
  const seatEffort = focusedSeat?.effort != null ? parseEffortValue(focusedSeat.effort) : undefined
  const initialEffort = supercode
    ? 'supercode'
    : seatEffort !== undefined
      ? resolveStampedEffortTruth(liveModel, seatEffort).label
      : getDisplayedEffortLabel(liveModel, effortValue)
  const [effort, setEffort] = React.useState<string>(initialEffort)

  function handleEffort(mode: string): void {
    setEffort(mode)
    if (mode === 'supercode') {
      unpinAllLaunchEffort()
      updateSettingsForSource('userSettings', { effortLevel: 'max', supercodeEffort: true })
      if (settleOnSeat('max', () => setAppState(prev => ({ ...prev, effortValue: 'max', supercode: true })))) return
      setAppState(prev => ({ ...prev, effortValue: 'max', supercode: true }))
      return
    }
    unpinAllLaunchEffort()
    const persistable = toPersistableEffort(mode as EffortValue)
    if (persistable !== undefined) {
      updateSettingsForSource('userSettings', { effortLevel: persistable, supercodeEffort: undefined })
      if (settleOnSeat(persistable, () => setAppState(prev => ({ ...prev, effortValue: persistable, supercode: false })))) return
    }
    setAppState(prev => ({
      ...prev,
      effortValue: mode as EffortValue,
      supercode: false,
    }))
  }

  function settleOnSeat(level: EffortLevel, mirror: () => void): boolean {
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
            : `Effort set to ${level} — this session's next request runs it`,
      )
    })
    return true
  }

  const options = getModelOptions()
  const models: ModelChoice[] = options.map(opt => modelChoiceOf(opt, betas))
  const expandRows = (group: string): ModelChoice[] => expandRowsOf(group, betas)
  const labelOf = (id: string): string => pickLabelOf(options, id)
  const current = focusedSeat?.effective ?? mainLoopModelForSession ?? mainLoopModel ?? getMainLoopModel()
  const currentRowId = resolveCurrentRowId(models, current)
  const pendingSwitch = useAppState(s => s.pendingModelSwitch)
  const pendingNext =
    focusedSeat !== null
      ? focusedSeat.pendingSwitch
        ? resolveCurrentRowId(models, parseUserSpecifiedModel(focusedSeat.pendingSwitch.setting ?? getDefaultMainLoopModel()))
        : undefined
      : pendingSwitch
        ? resolveCurrentRowId(models, parseUserSpecifiedModel(pendingSwitch.setting ?? getDefaultMainLoopModel()))
        : undefined

  let ctxPct: number | null = null
  try {
    const { usedPct } = contextFillView(messages, servedModel)
    if (usedPct != null) ctxPct = Math.round(usedPct)
  } catch {
    ctxPct = null
  }

  const [notice, setNotice] = React.useState<string | undefined>(undefined)
  const [transitionConfirm, setTransitionConfirm] = React.useState<{
    value: string
    id: string
    plan: TransitionPlan
    refreshed: boolean
  } | null>(null)
  const [slotVersion, setSlotVersion] = React.useState(0)
  void slotVersion
  useCatalogueRefreshOnOpen(GPT_ROAD, setNotice)
  useCatalogueRefreshOnOpen(OPENROUTER_ROAD, setNotice)
  useCatalogueRefreshOnOpen(GEMINI_ROAD, setNotice)
  useCatalogueRefreshOnOpen(HUGGINGFACE_ROAD, setNotice)
  useCatalogueRefreshOnOpen(LOCAL_ROAD, setNotice)
  const seatDetail = seatDetailOf
  const handleSlotSwitch = (group: string): string | null => slotSwitchOf(group, () => setSlotVersion(v => v + 1))
  const groupDetails: Record<string, string> = groupDetailsOf(seatDetail)
  function handleSelect(id: string): void {
    if (isCatalogueDoorRow(id)) return
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

  function applySelection(value: string, id: string): void {
    const focused = getFocusedSessionConnector()
    if (focused.carrier === 'daemon') {
      const label = labelOf(id)
      const factsBefore = focused.modelFacts()
      void focused.setModel(value).then(receipt => {
        if (receipt.state === 'refused') {
          onDone(`The model switch was refused: ${receipt.detail}`)
          return
        }
        const saved = persistModelChoice(value)
        if (receipt.state === 'no-op') {
          onDone(saved === '' ? `Already on ${label} — nothing to change` : `Already on ${label}${saved}`)
          return
        }
        const doorCross = providerFamilyOfSetting(factsBefore.effective) !== providerFamilyOfSetting(value) ? crossProviderNote(value) : ''
        const plan = previewForSelection(messages, factsBefore.effective, value)
        const lossNote = transitionPlanSummary(plan)
        onDone(
          receipt.state === 'queued'
            ? `Model switch queued: ${label}${saved} — applies when this session's turn settles (the running turn keeps its model)${doorCross}${lossNote}`
            : `Set model to ${label}${saved} — this session's next message runs it${receipt.note !== undefined ? ` (${receipt.note})` : ''}${doorCross}${lossNote}`,
        )
      })
      return
    }
    const label = labelOf(id)
    const stateNow = store.getState()
    const settled = settleModelSelection(stateNow, value, {
      turnActive: stateNow.foregroundTurnActive || stateNow.pendingModelSwitch !== null,
    })
    const saved = persistModelChoice(value)
    if (settled.kind === 'no-op') {
      onDone(saved === '' ? `Already on ${label} — nothing to change` : `Already on ${label}${saved}`)
      return
    }
    if (settled.kind === 'cancelled-pending') {
      setAppState(prev => ({ ...prev, ...settled.patch }))
      onDone(`Already on ${label} — queued switch cancelled${saved}`)
      return
    }
    const effectiveFrom = stateNow.mainLoopModelForSession ?? stateNow.mainLoopModel
    const plan = previewForSelection(messages, effectiveFrom, value)
    const lossNote = transitionPlanSummary(plan)
    if (settled.kind === 'queued') {
      setAppState(prev => ({ ...prev, ...settled.patch }))
      onDone(
        `Model switch queued: ${label}${saved} — applies when the current turn settles (the running turn keeps its model)${settled.crossProvider ? crossProviderNote(value) : ''}${lossNote}`,
      )
      return
    }
    setAppState(prev => ({ ...prev, ...settled.patch }))
    onDone(
      `Set model to ${label}${saved}${settled.receipt.crossProvider ? crossProviderNote(value) : ''}${lossNote}`,
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
          const verdict = reconfirmTransitionPlan(held.plan, messages)
          if (!verdict.ok) {
            setTransitionConfirm({ ...held, plan: verdict.freshPlan, refreshed: true })
            return
          }
          setTransitionConfirm(null)
          if (held.plan.window?.fits === false) {
            const foldingSession = getFocusedSessionConnector()
            if (foldingSession.carrier === 'daemon') {
              void foldingSession.sendWords('/compact').then(() => applySelection(held.value, held.id))
              return
            }
            requestCommandDispatch('/compact')
          }
          applySelection(held.value, held.id)
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

  return (
    <MercuryModelPicker
      models={models}
      current={currentRowId}
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
          focusedSeat === null && mainLoopModelForSession
            ? `Kept model as ${renderModelName(mainLoopModelForSession)} (session override)`
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
  const model = nextBirthModel() ?? getMainLoopModel()
  const efforts = modelSupportsEffort(model)
    ? [...selectableEffortLevels(model), ...(modelSupportsMaxEffort(model) ? ['supercode'] : [])]
    : []
  const [effort, setEffort] = React.useState<string>(() =>
    getInitialSupercodeSetting() ? 'supercode' : getDisplayedEffortLabel(model, getInitialEffortSetting()),
  )
  const [slotVersion, setSlotVersion] = React.useState(0)
  void slotVersion
  const [notice, setNotice] = React.useState<string | undefined>(undefined)
  useCatalogueRefreshOnOpen(GPT_ROAD, setNotice)
  useCatalogueRefreshOnOpen(OPENROUTER_ROAD, setNotice)
  useCatalogueRefreshOnOpen(GEMINI_ROAD, setNotice)
  useCatalogueRefreshOnOpen(HUGGINGFACE_ROAD, setNotice)
  useCatalogueRefreshOnOpen(LOCAL_ROAD, setNotice)
  const options = getModelOptions()
  const models: ModelChoice[] = options.map(opt => modelChoiceOf(opt, betas))
  function handleEffort(mode: string): void {
    const persistable = mode === 'supercode' ? 'max' : toPersistableEffort(mode as EffortValue)
    if (persistable === undefined) return
    const { error } = updateSettingsForSource('userSettings', {
      effortLevel: persistable,
      supercodeEffort: mode === 'supercode' ? true : undefined,
    })
    if (error) {
      setNotice(mode === 'supercode'
        ? `Could not save the supercode setting: ${error.message}`
        : `Could not save the effort level: ${error.message}`)
      return
    }
    unpinAllLaunchEffort()
    setEffort(mode)
    setNotice(undefined)
    setAppState?.(prev => ({ ...prev, effortValue: persistable, supercode: mode === 'supercode' }))
  }
  function handleSelect(id: string): void {
    if (isCatalogueDoorRow(id)) return
    if (isProviderActionRow(id)) {
      onSignIn?.(signInFamilyOfRow(id))
      return
    }
    const saved = persistModelChoice(id)
    if (saved !== '' && saved !== ' · saved as your default') {
      setNotice(saved)
      return
    }
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
      current={resolveCurrentRowId(models, model)}
      ctxPct={null}
      efforts={efforts}
      effort={effort}
      onEffort={handleEffort}
      notice={notice}
      groupDetails={groupDetailsOf(seatDetailOf)}
      onSlotSwitch={group => slotSwitchOf(group, () => setSlotVersion(v => v + 1))}
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
  const model = currentModel ?? nextBirthModel() ?? getMainLoopModel()
  const efforts = modelSupportsEffort(model) ? [...selectableEffortLevels(model)] : []
  const effort = currentEffort ?? 'default'
  const [slotVersion, setSlotVersion] = React.useState(0)
  void slotVersion
  const [notice, setNotice] = React.useState<string | undefined>(undefined)
  useCatalogueRefreshOnOpen(GPT_ROAD, setNotice)
  useCatalogueRefreshOnOpen(OPENROUTER_ROAD, setNotice)
  useCatalogueRefreshOnOpen(GEMINI_ROAD, setNotice)
  useCatalogueRefreshOnOpen(HUGGINGFACE_ROAD, setNotice)
  useCatalogueRefreshOnOpen(LOCAL_ROAD, setNotice)
  const options = getModelOptions()
  const models: ModelChoice[] = options.map(opt => modelChoiceOf(opt, betas))
  function handleEffort(mode: string): void {
    onEffort(mode)
  }
  function handleSelect(id: string): void {
    if (isCatalogueDoorRow(id)) return
    if (isProviderActionRow(id)) {
      onSignIn?.(signInFamilyOfRow(id))
      return
    }
    onSelect(id, models.find(m => m.id === id)?.name ?? id)
    onDone()
  }
  return (
    <MercuryModelPicker
      models={models}
      current={resolveCurrentRowId(models, model)}
      ctxPct={null}
      efforts={efforts}
      effort={effort}
      onEffort={handleEffort}
      notice={notice}
      groupDetails={groupDetailsOf(seatDetailOf)}
      onSlotSwitch={group => slotSwitchOf(group, () => setSlotVersion(v => v + 1))}
      expandRows={group => expandRowsOf(group, betas)}
      onSelect={handleSelect}
      onClose={onDone}
    />
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  if (args?.trim()) {
    const base = await import('./model.js')
    return base.call(onDone, context, args)
  }
  return (
    <MercuryModelLandingGate>
      <MercuryModelWrapper messages={context.messages ?? []} onDone={onDone} />
    </MercuryModelLandingGate>
  )
}

export function MercuryModelChoicePicker({ leading, current, onSelect, onSignIn, onClose }: {
  leading?: ModelChoice[]
  current: string
  onSelect: (id: string) => void
  onSignIn?: (id: string) => void
  onClose: () => void
}): React.ReactNode {
  useCatalogueEpoch()
  const [notice, setNotice] = React.useState<string | undefined>(undefined)
  useCatalogueRefreshOnOpen(GPT_ROAD, setNotice)
  useCatalogueRefreshOnOpen(OPENROUTER_ROAD, setNotice)
  useCatalogueRefreshOnOpen(GEMINI_ROAD, setNotice)
  useCatalogueRefreshOnOpen(HUGGINGFACE_ROAD, setNotice)
  useCatalogueRefreshOnOpen(LOCAL_ROAD, setNotice)
  const betas = getSdkBetas()
  const options = getModelOptions().filter(opt => onSignIn !== undefined || !isProviderActionRow(opt.value) || isCatalogueDoorRow(opt.value))
  const models: ModelChoice[] = [...(leading ?? []), ...options.map(opt => modelChoiceOf(opt, betas))]
  return (
    <MercuryModelPicker
      models={models}
      current={current}
      ctxPct={null}
      notice={notice}
      groupDetails={groupDetailsOf(seatDetailOf)}
      expandRows={group => expandRowsOf(group, betas)}
      onSelect={id => {
        if (isCatalogueDoorRow(id)) return
        if (isProviderActionRow(id)) {
          onSignIn?.(id)
          return
        }
        onSelect(id)
      }}
      onClose={onClose}
    />
  )
}

function modelChoiceRowOf(options: ModelOption[], id: string): ModelOption | undefined {
  const wanted = normalizeModelStringForAPI(parseUserSpecifiedModel(id)).toLowerCase()
  return options.find(
    option =>
      typeof option.value === 'string' &&
      !option.value.startsWith('__') &&
      !isProviderActionRow(option.value) &&
      normalizeModelStringForAPI(parseUserSpecifiedModel(option.value)).toLowerCase() === wanted,
  )
}

export function modelChoiceLabel(id: string): string {
  const options = getModelOptions()
  const direct = pickLabelOf(options, id)
  if (direct !== id) return direct
  return modelChoiceRowOf(options, id)?.label ?? renderModelName(id)
}

export function modelChoiceRow(id: string): string {
  if (id === '') return id
  const options = getModelOptions()
  if (options.some(option => option.value === id)) return id
  return modelChoiceRowOf(options, id)?.value ?? id
}
