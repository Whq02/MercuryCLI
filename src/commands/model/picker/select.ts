import * as React from 'react'
import { modelDoorRoad, removeHostEndpoint, retryHostEndpoint } from '../../../models/hosting/door.js'
import { runHostedModel } from '../../../models/hosting/index.js'
import { llmHostPopupRequest } from '../../llmhost/llmhost.js'
import { openSettingsPopup } from '../../../screen/cockpit/settingsPopup.js'
import type { CommandResultDisplay } from '../../catalogue/commands.js'
import type { Message } from '../../../engine/message-shapes/message.js'
import { settleModelSelection, type SeatReceiptState } from '../../../models/catalogue/modelTransition.js'
import { previewDaemonModelSelection } from '../model.js'
import { previewForSelection } from '../../../models/roads/transitionPreview.js'
import type { TransitionPlan } from '../../../models/catalogue/modelTransition.js'
import { getGptSeatAvailability, type parseKeyConnectValue } from '../../../models/catalogue/modelOptions.js'
import { getNousAvailability, refreshNousCatalogue } from '../../../models/roads/nous/nousCatalogue.js'
import { getHuggingfaceAvailability } from '../../../models/roads/huggingface/huggingfaceCatalogue.js'
import { requestCommandDispatch } from '../../../screen/cockpit/helmFocus.js'
import type { AppState } from '../../../screen/app-state/AppState.js'
import type { AppStateStore } from '../../../screen/app-state/AppStateStore.js'
import { retryNamedCompatRow } from './rows.js'

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type PickRoad = { flip: boolean; door?: string }

export type PickContext = {
  messages: Message[]
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay; nextInput?: string; submitNextInput?: boolean },
  ) => void
  store: AppStateStore
  setAppState: (updater: (prevState: AppState) => AppState) => void
  setNotice: React.Dispatch<React.SetStateAction<string | undefined>>
  setTransitionConfirm: (confirm: { value: string; id: string; plan: TransitionPlan; refreshed: boolean; pick: PickRoad }) => void
  applySelection: (value: string, id: string, pick?: PickRoad, seated?: (state: SeatReceiptState) => void) => void
  labelOf: (id: string) => string
  flipDoorNote: (pick: PickRoad) => string
}

export function selectHostRow({ onDone, setNotice }: PickContext, id: string): boolean {
  if (id.startsWith('host-retry:')) {
    setNotice('Checking this server…')
    void retryHostEndpoint(id.slice('host-retry:'.length)).then(setNotice)
    return true
  }
  if (id.startsWith('host-remove:')) {
    void removeHostEndpoint(id.slice('host-remove:'.length)).then(setNotice)
    return true
  }
  if (id.startsWith('host-run:')) {
    const title = id.slice('host-run:'.length)
    onDone('Opening ' + title + ' in /llmhost', { display: 'system' })
    openSettingsPopup(llmHostPopupRequest(modelDoorRoad(runHostedModel, title)))
    return true
  }
  return false
}

export function connectClaude({ onDone }: PickContext): void {
  onDone('Claude sign-in — running /logins (the picker re-opens when it settles)', {
    nextInput: '/logins anthropic --return=/model',
    submitNextInput: true,
  })
}

export function connectGpt({ onDone, setNotice }: PickContext): void {
  const availability = getGptSeatAvailability()
  const why = availability.state === 'disabled' ? availability.why : undefined
  if (why === 'catalogue-pending' || why === 'catalogue-error') {
    void (async () => {
      const { refreshOpenaiCatalogue } = await import(
        '../../../models/roads/openai/openaiCatalogue.js'
      )
      const { resolveOpenaiAccount } = await import(
        '../../../models/roads/openai/openaiAccounts.js'
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
      let refreshError: string | undefined
      const snapshot = await refreshOpenaiCatalogue(account.kind, { force: true }).catch((error: unknown) => {
        refreshError = errorDetail(error)
        return null
      })
      const detail = snapshot?.lastError ?? refreshError
      setNotice(
        snapshot && snapshot.models.length > 0 && !snapshot.lastError
          ? `GPT catalogue landed: ${snapshot.models.length} model(s) from the ${account.label} — pick one above`
          : `GPT catalogue unavailable — ↵ retries · /logins shows readiness${detail ? ` (${detail})` : ''}`,
      )
    })()
    return
  }
  onDone('GPT sign-in — running /logins (the picker re-opens when it settles)', {
    nextInput: '/logins openai --return=/model',
    submitNextInput: true,
  })
}

export function connectOpenrouter({ onDone, setNotice }: PickContext): void {
  void (async () => {
    const { getOpenrouterAvailability, refreshOpenrouterCatalogue } = await import(
      '../../../models/roads/openrouter/openrouterCatalogue.js'
    )
    const availability = getOpenrouterAvailability()
    if (
      availability.state === 'ready' ||
      availability.why === 'catalogue-pending' ||
      availability.why === 'catalogue-error'
    ) {
      const { resolveOpenrouterRequestAuth } = await import(
        '../../../models/roads/openrouter/openrouterAccounts.js'
      )
      const auth = resolveOpenrouterRequestAuth()
      if (auth) {
        setNotice('OpenRouter — refreshing the live catalogue…')
        let refreshError: string | undefined
        const snapshot = await refreshOpenrouterCatalogue(auth.account.keySource, { force: true }).catch((error: unknown) => {
          refreshError = errorDetail(error)
          return null
        })
        const detail = snapshot?.lastError ?? refreshError
        setNotice(
          snapshot && snapshot.models.length > 0 && !snapshot.lastError
            ? `OpenRouter catalogue landed: ${snapshot.models.length} model(s) — pick one above`
            : `OpenRouter catalogue unavailable — ↵ retries${detail ? ` (${detail})` : ''}`,
        )
        return
      }
    }
    onDone('OpenRouter sign-in — running /logins (the picker re-opens when it settles)', {
      nextInput: '/logins openrouter --return=/model',
      submitNextInput: true,
    })
  })()
}

export function connectNous({ onDone, setNotice }: PickContext): void {
  void (async () => {
    const availability = getNousAvailability()
    if (availability.state === 'ready' || availability.why === 'catalogue-pending' || availability.why === 'catalogue-error') {
      setNotice('Nous Portal — refreshing the live catalogue…')
      let refreshError: string | undefined
      const snapshot = await refreshNousCatalogue({ force: true }).catch((error: unknown) => {
        refreshError = errorDetail(error)
        return null
      })
      const detail = snapshot?.lastError ?? refreshError
      setNotice(
        snapshot && snapshot.models.length > 0 && !snapshot.lastError
          ? `Nous Portal catalogue landed: ${snapshot.models.length} model(s) — pick one above`
          : `Nous Portal catalogue unavailable — ↵ retries${detail ? ` (${detail})` : ''}`,
      )
      return
    }
    onDone('Nous Portal key — running /logins nous (the picker re-opens when it settles)', {
      nextInput: '/logins nous --return=/model',
      submitNextInput: true,
    })
  })()
}

export function connectGemini({ onDone, setNotice }: PickContext): void {
  void (async () => {
    const { getGeminiAvailability, refreshGeminiCatalogue } = await import(
      '../../../models/roads/gemini/geminiCatalogue.js'
    )
    const availability = getGeminiAvailability()
    if (
      availability.state === 'ready' ||
      availability.why === 'catalogue-pending' ||
      availability.why === 'catalogue-error'
    ) {
      const { resolveGeminiAccount } = await import(
        '../../../models/roads/gemini/geminiAccounts.js'
      )
      const account = resolveGeminiAccount()
      if (account) {
        const sourceKind = account.kind
        setNotice('Gemini — refreshing the live catalogue…')
        let refreshError: string | undefined
        const snapshot = await refreshGeminiCatalogue(sourceKind, { force: true }).catch((error: unknown) => {
          refreshError = errorDetail(error)
          return null
        })
        const detail = snapshot?.lastError ?? refreshError
        setNotice(
          snapshot && snapshot.models.length > 0 && !snapshot.lastError
            ? `Gemini catalogue landed: ${snapshot.models.length} model(s) — pick one above`
            : `Gemini catalogue unavailable — ↵ retries${detail ? ` (${detail})` : ''}`,
        )
        return
      }
    }
    onDone('Gemini sign-in — running /logins (the picker re-opens when it settles)', {
      nextInput: '/logins gemini --return=/model',
      submitNextInput: true,
    })
  })()
}

export function connectHuggingface({ onDone, setNotice }: PickContext): void {
  void (async () => {
    const { refreshHuggingfaceCatalogue } = await import(
      '../../../models/roads/huggingface/huggingfaceCatalogue.js'
    )
    const availability = getHuggingfaceAvailability()
    if (availability.state === 'ready') {
      setNotice('Hugging Face — refreshing the live catalogue…')
      let refreshError: string | undefined
      const snapshot = await refreshHuggingfaceCatalogue({ force: true }).catch((error: unknown) => {
        refreshError = errorDetail(error)
        return null
      })
      const detail = snapshot?.lastError ?? refreshError
      setNotice(
        snapshot && snapshot.models.length > 0 && !snapshot.lastError
          ? `Hugging Face catalogue landed: ${snapshot.models.length} model(s) — pick one above (any listed id types as huggingface/<org>/<model>)`
          : `Hugging Face catalogue unavailable — ↵ retries; the dated pins dispatch directly${detail ? ` (${detail})` : ''}`,
      )
      return
    }
    requestCommandDispatch('/logins')
    onDone('Hugging Face sign-in — running /logins (the rows go live once a credential connects; HF_TOKEN works too)')
  })()
}

export function selectKeyLane({ onDone, setNotice }: PickContext, id: string, keyLane: NonNullable<ReturnType<typeof parseKeyConnectValue>>): void {
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
      const { resolveMoonshotAccount } = await import('../../../models/roads/moonshot/moonshotAccounts.js')
      const account = resolveMoonshotAccount()
      if (account) {
        const { moonshotCatalogueRows, refreshMoonshotCatalogue } = await import('../../../models/roads/moonshot/moonshotCatalogue.js')
        setNotice(`Moonshot — reading the model list of the ${account.label}…`)
        let refreshError: string | undefined
        await refreshMoonshotCatalogue({ force: true }).catch((error: unknown) => {
          refreshError = errorDetail(error)
          return null
        })
        const { source } = moonshotCatalogueRows()
        const detail = (source.kind === 'unread' ? source.error : undefined) ?? refreshError
        setNotice(
          source.kind === 'live'
            ? `Moonshot model list landed: ${source.count} model(s) from the ${account.label} — pick one above`
            : `Moonshot model list unavailable — ↵ retries${detail !== undefined ? ` (${detail})` : ''}`,
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
}

export function selectThroughGate({ messages, onDone, store, setTransitionConfirm, applySelection }: PickContext, value: string, id: string, pick: PickRoad): void {
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
