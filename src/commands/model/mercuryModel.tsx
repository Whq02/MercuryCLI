// mercuryModel — Mercury's /model surface: the dedicated MercuryModelPicker wired
// to the REAL model list (getModelOptions, allowlist-filtered) and the REAL
// switch (setAppState mainLoopModel), with live context-fill. No fabricated
// models. Falls back to the base model.tsx for `/model <arg>` and info/help so the
// React-Compiler picker logic (validation, 1m access) is preserved.
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

/** THE CATALOGUE DOORS' full lists, by picker group: each live-catalogue
 *  family's UNBOUNDED accessor — the same builder its bounded top-N rows
 *  derive from, so a row reads the same at both depths. The wrapper maps
 *  them through the one row mapping below under the one allowlist. */
const CATALOGUE_DOORS: Record<string, () => ModelOption[]> = {
  [OPENROUTER_MODEL_GROUP]: () => getOpenrouterFullModelOptions(),
  [HUGGINGFACE_MODEL_GROUP]: () => getHuggingfaceFullModelOptions(),
}

/** The picker's context COLUMN cell — the picker's one window formatter plus
 *  the unit; empty when the window is unknown (the row shows no column). */
function fmtCtx(windowSize: number): string {
  if (!windowSize) return ''
  return `${fmtCtxWindow(windowSize)} ctx`
}

// The /model effort row offers the live model's SELECTABLE stops (the
// resolution owner's vocabulary — H1: the old full low→max axis
// offered tiers dispatch stepped past, e.g. xhigh on Sonnet 4.6), plus the
// supercode MODE when the live model supports max (supercode pins max —
// Mercury's deliberate divergence from the default's xhigh pair, operator
// Each label IS a real, runnable level — no lossy collapse.

// The focused chat's model feed as a primitive snapshot (a fresh object per
// read would churn useSyncExternalStore's stability comparison).
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
  // The SESSION model override (a session pin). The
  // API resolves mainLoopModelForSession ?? mainLoopModel, so the readout must
  // surface it — otherwise /model shows the base model while the session actually
  // runs the override, a false signal that masks whether a pin took effect.
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)
  const effortValue = useAppState(s => s.effortValue)
  const supercode = useAppState(s => s.supercode)
  const setAppState = useSetAppState()
  const store = useAppStateStore()
  const betas = getSdkBetas()
  // Live catalogue rows land IN PLACE: every catalogue settle re-renders
  // this wrapper and getModelOptions() below re-reads the caches, so the
  // OpenRouter / GPT / Gemini / Hugging Face groups move from "connecting…"
  // to their rows while the picker stays open.
  useCatalogueEpoch()
  // The focused chat's model facts, subscribed: a daemon-hosted session's
  // CURRENT dot and its queued switch read ITS facts (never the in-process
  // engine's) and repaint when its connector's feed moves.
  const focusedModelKey = React.useSyncExternalStore(subscribeFocusedModelFeed, getFocusedModelKey, getFocusedModelKey)
  const focusedSeat = getFocusedSessionConnector().carrier === 'daemon' ? getFocusedSessionConnector().modelFacts() : null
  void focusedModelKey

  // Effort controls keyed to the live model. supercode is a MODE (not a level):
  // offered only on max-capable models, and selecting it pins max + flips
  // AppState.supercode. Hidden entirely on models without effort support.
  const liveModel = getMainLoopModel()
  const efforts = modelSupportsEffort(liveModel)
    ? [
        ...selectableEffortLevels(liveModel),
        ...(modelSupportsMaxEffort(liveModel) ? ['supercode'] : []),
      ]
    : []
  // Initial bracket: the supercode MODE wins; else the resolved applied LABEL
  // (handles auto→the live default, per-model step-downs, and the honest
  // 'default' — an out-of-track label simply brackets nothing).
  const initialEffort = supercode
    ? 'supercode'
    : getDisplayedEffortLabel(liveModel, effortValue)
  const [effort, setEffort] = React.useState<string>(initialEffort)

  function handleEffort(mode: string): void {
    setEffort(mode)
    if (mode === 'supercode') {
      // supercode pins max + sets the session mode flag (⊥ a co-set level)
      // and PERSISTS exactly as /effort supercode does — effortLevel max
      // with supercodeEffort, the launch pins released — so the session
      // reopens the way it was left, not on the stale stored level with
      // supercode off (FN-018 rank 19; the comment here used to claim
      // parity with /effort while /effort persisted).
      unpinAllLaunchEffort()
      updateSettingsForSource('userSettings', { effortLevel: 'max', supercodeEffort: true })
      setAppState(prev => ({ ...prev, effortValue: 'max', supercode: true }))
      return
    }
    // A real effort level; selecting it clears supercode (mutual exclusion).
    // PERSIST like every other explicit effort control (F7,
    // operator-ruled): the inline picker and /effort save the pick as the
    // default and unpin launch efforts — this control was silently
    // session-only, so the choice evaporated at the next boot.
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

  // Real model list — already allowlist-filtered + custom/default included.
  const options = getModelOptions()
  // ONE row mapping (option → picker row) for the listed rows AND the
  // catalogue doors' full lists, so an expanded row reads exactly as its
  // top-N twin does.
  const choiceOf = (opt: ModelOption): ModelChoice => {
    let ctx = ''
    let ctxBase = ''
    let ctx1m = ''
    // Connect/attach action rows are not models — no window column. Real
    // rows resolve their SOURCE window through the capabilities owner below.
    // A catalogue door is an action row carrying its facet: the group it
    // opens, the family word its header leads with, the live count.
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
    // Carrier rows state their own window (the live catalogue's fact); the
    // Anthropic window resolver never sees a carrier id — it would answer
    // its own family's default for a slug it cannot know. Absent = no column.
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
      // DEFAULT-1M display: any row whose family carries a [1m] variant
      // DEFAULTS to it in the picker — the column shows the window the row
      // actually delivers on ↵ (the `c` toggle drops to 200k, not up to 1M).
      const v = (opt.value ?? getMainLoopModel()) as string
      const shown =
        focusedOptionSupports1m(v) && !has1mContext(v)
          ? withContext1m(v)
          : v
      // The column resolves an ALIAS to the model it actually serves before
      // the window query (Image-35: bare 'opus' read the 200k fallback while
      // resolving to the natively-1M Opus 5 — the row lied and `c` could not
      // correct it).
      const windowProbe = has1mContext(shown)
        ? withContext1m(parseUserSpecifiedModel(stripContext1m(shown)))
        : parseUserSpecifiedModel(shown)
      ctx = fmtCtx(getContextWindowForModel(windowProbe as never, betas))
      // Unified per-row context display: the COLUMN is the one display, so a
      // toggle-capable row carries BOTH window states — the picker renders the
      // focused row from its live c-toggle state; ctx stays the DEFAULT-1M
      // column every other row shows.
      if (focusedOptionSupports1m(v)) {
        const pairBase = parseUserSpecifiedModel(stripContext1m(v))
        ctxBase = fmtCtx(getContextWindowForModel(pairBase as never, betas))
        ctx1m = fmtCtx(getContextWindowForModel(withContext1m(pairBase) as never, betas))
      }
      // A toggle-capable GPT row (the source declares a ceiling above its
      // served default) carries the SAME pair: base = the `[served]` opt-down,
      // big = the bare id's item C ceiling — both resolved through the ONE
      // context-window owner so the column can never disagree with the budget.
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
      // Visible-but-unavailable (the owning resolver's refusal): never
      // selectable; the honest reason rides the row + footer copy.
      ...(opt.unavailable !== undefined ? { gated: true, gatedReason: opt.unavailable } : {}),
    }
  }
  const models: ModelChoice[] = options.map(choiceOf)
  // The door's full list for a group: the owning accessor's rows (every
  // snapshot row, the vendor's order), the operator's allowlist applied as
  // getModelOptions applies it, mapped through the same row mapping. The
  // picker reads this once per expansion — never per keystroke.
  const expandRows = (group: string): ModelChoice[] =>
    applyModelAllowlist(CATALOGUE_DOORS[group]?.() ?? []).map(choiceOf)
  // The receipt's label for a picked id: the listed row's, else the door's
  // full list's (a row picked past the bound reads like its top-N twins).
  const labelOf = (id: string): string =>
    options.find(o => (o.value ?? 'default') === id)?.label ??
    Object.values(CATALOGUE_DOORS)
      .flatMap(rows => rows())
      .find(o => o.value === id)?.label ??
    id
  // The Fable row is the SHARED catalog's (an ordinary tier row in
  // getModelOptions, allowlist-filtered like every model): this surface
  // reads it like every other row, so /model, the submodel picker, and every
  // consumer agree on one list. Its ctx column and [1m] toggle pair derive
  // through the generic mapping above (focusedOptionSupports1m owns the
  // frontier canonical).
  const current =
    focusedSeat !== null
      ? focusedSeat.effective
      // Drive-12 amend (the reviewer): the CURRENT dot reads the SAME channel
      // the query + strip resolve (session pin first) — the swap pins the
      // entered session's model there; the dot must not lag on the default.
      : (mainLoopModelForSession ?? mainLoopModel ?? 'default')
  // Visibility: a queued switch renders current→next in the picker.
  const pendingSwitch = useAppState(s => s.pendingModelSwitch)
  const pendingNext =
    focusedSeat !== null
      ? focusedSeat.pendingSwitch
        ? (focusedSeat.pendingSwitch.setting ?? 'default')
        : undefined
      : pendingSwitch
        ? (pendingSwitch.setting ?? 'default')
        : undefined

  // Live context-fill for the detail gauge (the ONE fill derivation the
  // frame, the rails and the compaction trigger read) — over the
  // SESSION-EFFECTIVE model the frame publishes (the focused session's pin,
  // then the session override, then the global model), never the global
  // model alone: a session pinned to a 1M variant over a 200k default read
  // 90% here while the frame read 18% (FN-018 rank 13). The unavailable
  // state stays null — the picker paints the em dash, never a hard 0%.
  let ctxPct: number | null = null
  try {
    const windowModel = getFocusedSessionConnector().modelFacts().sessionPin ?? mainLoopModelForSession ?? mainLoopModel ?? getMainLoopModel()
    const { usedPct } = contextFillView(messages, windowModel)
    if (usedPct != null) ctxPct = Math.round(usedPct)
  } catch {
    ctxPct = null
  }

  // The picker's one-line notice slot (catalogue refresh outcomes).
  const [notice, setNotice] = React.useState<string | undefined>(undefined)
  // needs_choice gate: a lossy pick parks here until the operator
  // confirms the frozen plan (or cancels); confirm re-derives staleness and
  // regenerates on drift — the card never writes state.
  const [transitionConfirm, setTransitionConfirm] = React.useState<{
    value: string | null
    id: string
    plan: TransitionPlan
    refreshed: boolean
  } | null>(null)
  // The OpenAI group's live availability (the same chain as its rows).
  const gptAvailability = getGptSeatAvailability()
  // Per-provider signed-in state under each group heading (provider parity
  // one grammar): the Anthropic answer from the ONE presence owner (the
  // same read the catalogue's Anthropic gate and the /accounts board make —
  // a credential's EXISTENCE, said so: no live probe runs on this surface),
  // the OpenAI answer from the ONE seat-availability chain (its 'ready'
  // state is a live fact — the catalogue fetched under the credential).
  // Never assembled from UI guesses; an unavailable provider names its
  // reason. The frontier fact leads and the signed-in state follows: the
  // detail row truncates at the panel cap, the observation date must
  // survive whole (law 4), and the sign-in affordance is redundantly
  // carried by the group's own action row right below the heading.
  const withFrontier = (detail: string, route: Parameters<typeof providerFrontierLine>[0]): string => {
    const line = providerFrontierLine(route)
    return line ? `${line} · ${detail}` : detail
  }
  // The key lanes' credential state from the ONE usability resolver (the
  // same read /logins and the transition preview make), resolved ONCE per
  // render: present ⇒ the credential kind; absent ⇒ the lane's own blocker
  // verbatim.
  const usability = resolveProviderUsability()
  const withCredential = (line: string, route: 'zai' | 'moonshot' | 'deepseek'): string => {
    const lane = usability[route]
    return lane.credential !== 'none'
      ? `${line} · ${lane.credential === 'oauth' ? 'signed in' : 'key present'}`
      : `${line} · ${lane.blockers[0] ?? 'not connected'}`
  }
  const anthropicPresence = anthropicCredentialPresence()
  // The account surface's SEAT line: which slot the wire
  // bills now, and — exactly where the two-slot pair is signed in — the
  // one-key switch affordance. Recomputed each render; the `s` handler
  // bumps slotVersion so a flip repaints the seat words immediately.
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
    // THE RECEIPT (FN-016 R20): the picker's notice dies with the picker —
    // the durable transcript row is the record; the notice keeps the words
    // while the picker stands.
    paintSlotSwitchReceipt(outcome)
    setSlotVersion(v => v + 1)
    return outcome.receipt
  }
  const groupDetails: Record<string, string> = {
    [ANTHROPIC_MODEL_GROUP]: withFrontier(
      // PRESENT-BUT-DEAD reads its observed state (item 11): a stored
      // sign-in the estate already knows is expired must not say
      // "credential present" while every send would 401.
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
    // The key lanes: the frontier fact leads, the signed-in state follows —
    // the same grammar the Anthropic/OpenAI/Hugging Face headings carry
    // (a heading that named only a frontier while its siblings named their
    // credential state read as a different product per family).
    ...(providerFrontierLine('zai') !== undefined ? { [ZAI_MODEL_GROUP]: withCredential(providerFrontierLine('zai')!, 'zai') } : {}),
    ...(providerFrontierLine('moonshot') !== undefined
      ? { [MOONSHOT_MODEL_GROUP]: withCredential(providerFrontierLine('moonshot')!, 'moonshot') }
      : {}),
    ...(providerFrontierLine('deepseek') !== undefined
      ? { [DEEPSEEK_MODEL_GROUP]: withCredential(providerFrontierLine('deepseek')!, 'deepseek') }
      : {}),
    // The carrier lanes: the OWNING availability chain's words — source +
    // signed in + the live row count when ready, its own reason otherwise
    // (these two headings carried no detail at all while every other
    // family's did).
    // The state words lead the source label: the detail row truncates at
    // the panel cap and a long source label (the base-override proof seam)
    // must never push "signed in" off the screen.
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
    // The two blind-shipped families carry their honesty label in the
    // group detail until the first live turn settles (the receipt's
    // deferred-live checklist owns the flip).
    // The honesty label leads the sign-in words: the detail row truncates
    // at the panel cap and the label must survive whole.
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
    // A catalogue door never arrives here — the picker opens and closes it
    // in place — and its sentinel must never be written as a model.
    if (isCatalogueDoorRow(id)) return
    const value = id === 'default' ? null : id
    // The Anthropic action row: ↵ runs /logins with the family pre-focused
    // and chains back here — the same grammar as every other family's
    // sign-in row; the sentinel is never written as a model.
    if (id === ANTHROPIC_CONNECT_OPTION_VALUE) {
      onDone('Claude sign-in — running /logins (the picker re-opens when it settles)', {
        nextInput: '/logins anthropic --return=/model',
        submitNextInput: true,
      })
      return
    }
    // The GPT action row: ↵ never writes the
    // sentinel as a model. Sign-in states run /logins; catalogue
    // states retry the fetch NOW and settle with the real outcome (the old
    // unconditional connect dispatch re-ran OAuth against an already-
    // connected account when only the catalogue fetch had failed).
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
          // The retry settles IN PLACE: the catalogue epoch re-renders the
          // group's rows and the notice slot carries the outcome — the
          // picker never closes for a fetch.
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
    // The OpenRouter/Gemini action rows: the same
    // grammar — sign-in states run /logins; catalogue states retry the fetch
    // NOW and settle with the real outcome.
    if (id === OPENROUTER_CONNECT_OPTION_VALUE) {
      void (async () => {
        const { getOpenrouterAvailability, refreshOpenrouterCatalogue } = await import(
          '../../services/providers/openrouter/openrouterCatalogue.js'
        )
        const availability = getOpenrouterAvailability()
        // A connected credential retries the fetch IN PLACE (the pending /
        // unreachable rows AND the stale-but-labelled row all promise "↵
        // retries now"): the epoch re-renders the rows, the notice slot
        // carries the outcome, the picker stays open.
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
    // The key-lane attach rows: route the lane's
    // key-entry surface; the compat slot names its config route.
    {
      const keyLane = parseKeyConnectValue(id)
      if (keyLane !== undefined) {
        if (keyLane === 'compat') {
          onDone(
            'Custom endpoint: set MERCURY_COMPAT_BASE_URL (+ MERCURY_COMPAT_MODELS, optional MERCURY_COMPAT_API_KEY or /router key compat) — the rows go live next /model open',
          )
          return
        }
        // The /logins card carries each family's leg (the Kimi sign-in or
        // a key; the Z.AI key with its plan; the DeepSeek key) — route there
        // with the family pre-focused; the picker re-opens when it settles.
        onDone(
          `${keyLane === 'zai' ? 'GLM (Z.AI)' : keyLane === 'moonshot' ? 'Kimi (Moonshot)' : 'DeepSeek'} sign-in — running /logins ${keyLane}; the picker re-opens when it settles`,
          { nextInput: `/logins ${keyLane} --return=/model`, submitNextInput: true },
        )
        return
      }
    }
    // A real model (or the Default row) applies THROUGH the ONE ModelTransition
    // machine (one boundary-aware apply owner for UI/direct-command
    // changes; the inline PromptInput picker rides the same decision). A live
    // pendingModelSwitch means a turn is still settling — a new pick REPLACES
    // the pending slot atomically instead of re-modeling mid-flight.
    // needs_choice gate: a pick that WOULD change the model and whose
    // frozen plan carries meaningful loss parks at the preview card first.
    // settleModelSelection is pure — probing the decision writes nothing; the
    // mode exits run in the apply tail, so the preview's from-model is the
    // still-engaged seat (the honest current wire).
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
    // A daemon-hosted focused chat switches through its connector's model
    // door — ITS settlement owner applies now (idle) or parks the switch for
    // the turn's end (busy); the in-process engine's modes are not its.
    const focused = getFocusedSessionConnector()
    if (focused.carrier === 'daemon') {
      const label = labelOf(id)
      // The cross-provider fact reads the session's effective model BEFORE
      // the door applies the switch (an applied receipt updates the
      // connector's facts synchronously, so a post-apply read would compare
      // the destination against itself and stay silent — FN-016 R17).
      const factsBefore = focused.modelFacts()
      // The receipt is the daemon's word (FN-015 rank 50): the sentence
      // waits for it, so a refusal is spoken and never painted as a switch.
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
        // The preview reads the SAME before-the-door fact: the connector's
        // facts already name the destination on an applied receipt, and a
        // preview against them compared the destination with itself (an
        // always-empty loss note).
        const plan = previewForSelection(messages, factsBefore.effective, value)
        const lossNote = transitionPlanSummary(plan)
        onDone(
          receipt.state === 'queued'
            ? `Model switch queued: ${label} applies when this session's turn settles (the running turn keeps its model)${doorCross}${lossNote}`
            : `Set model to ${label} — this session's next message runs it${doorCross}${lossNote}`,
        )
      })
      return
    }
    const label = labelOf(id)
    const stateNow = store.getState()
    // settlement (state patch + exactly-once receipt) is minted by
    // the ONE owner — settleModelSelection — shared with the inline picker and
    // the REPL boundary effect. A /model no-op that keeps a live
    // pending switch the picker cancelled is the guarded drift; the shared owner ends it.
    const settled = settleModelSelection(stateNow, value, {
      // The query guard's PUBLISHED truth: the old
      // `pendingModelSwitch !== null` proxy was false on the FIRST mid-turn
      // pick, so /model applied mid-flight — the exact re-model the machine's
      // ACTIVE-TURN PENDING law exists to prevent. A queued switch still
      // means the boundary hasn't settled, so it stays as an OR-term.
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
    // The frozen preview plan for a REAL change — its typed loss
    // summary rides the operator's receipt line (the blocking preview card
    // is the capture leg; the PLAN mechanics are live from here on).
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
          // A02: stale-safe — re-derive the CURRENT keys; regenerate and
          // re-present on drift, settle through the owner only on ok.
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
  // Inline set / info / help — preserve the React-Compiler behavior verbatim.
  if (args?.trim()) {
    const base = await import('./model.js')
    return base.call(onDone, context, args)
  }
  return <MercuryModelWrapper messages={context.messages ?? []} onDone={onDone} />
}
