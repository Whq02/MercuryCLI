import { getContextWindowForModel } from '../../utils/context.js'
import { getCanonicalName, normalizeModelStringForAPI, parseUserSpecifiedModel } from '../../utils/model/model.js'
import { familyDefaultsModel } from '../../utils/model/configs.js'
import { anthropicProviderAdapter } from './anthropic/anthropicAdapter.js'
import { geminiProviderAdapter } from './gemini/geminiAdapter.js'
import { openaiProviderAdapter } from './openai/openaiAdapter.js'
import { openrouterProviderAdapter } from './openrouter/openrouterAdapter.js'
import type {
  ProviderDescription,
  ProviderEffortLevel,
  ProviderModelRef,
  ProviderModelClass,
  ProviderAdapter,
  ProviderFamilyId,
  ProviderModel,
  ProviderTransport,
} from './providerAdapter.js'
import { zaiProviderAdapter } from './zai/zaiAdapter.js'
import { moonshotProviderAdapter } from './moonshot/moonshotAdapter.js'
import { deepseekProviderAdapter } from './deepseek/deepseekAdapter.js'
import { xaiProviderAdapter } from './xai/xaiAdapter.js'
import { metaProviderAdapter } from './meta/metaAdapter.js'
import { compatProviderAdapter } from './openaicompat/compatAdapter.js'
import { huggingfaceProviderAdapter } from './huggingface/huggingfaceAdapter.js'
import { localProviderAdapter } from './local/localAdapter.js'
import { mistralProviderAdapter } from './mistral/mistralAdapter.js'
import { nousProviderAdapter } from './nous/nousAdapter.js'
import { zenProviderAdapter } from './zen/zenAdapter.js'
import { minimaxProviderAdapter } from './minimax/minimaxAdapter.js'
import { togetherProviderAdapter } from './together/togetherAdapter.js'
import { cohereProviderAdapter } from './cohere/cohereAdapter.js'
import { groqProviderAdapter } from './groq/groqAdapter.js'
import { meliousProviderAdapter } from './melious/meliousAdapter.js'
import { orcarouterProviderAdapter } from './orcarouter/orcarouterAdapter.js'
import { cerebrasProviderAdapter } from './cerebras/cerebrasAdapter.js'
import { fireworksProviderAdapter } from './fireworks/fireworksAdapter.js'
import { qwenProviderAdapter } from './qwen/qwenAdapter.js'
import { catalogueEpoch } from './catalogueEpoch.js'
import { isProviderDisabled, resolveDisabledProviders } from './disabledProviders.js'
import { signInLedgerEpoch } from '../../utils/accounts/signInLedger.js'
import { credentialEnvNames } from './providerSecrets.js'

export interface ProviderSnapshot {
  providers: Array<{
    id: ProviderFamilyId
    available: boolean
    reason?: string

    transport: ProviderTransport
    description: ProviderDescription
  }>

  resolve(modelClass: ProviderModelClass): ProviderModelRef | null

  resolveExact(pin: string): ProviderModelRef | null
  listAvailable(): ProviderModel[]
}

const PROVIDER_ADAPTERS: readonly ProviderAdapter[] = [
  anthropicProviderAdapter,
  openaiProviderAdapter,
  zaiProviderAdapter,

  openrouterProviderAdapter,
  geminiProviderAdapter,

  moonshotProviderAdapter,
  deepseekProviderAdapter,
  xaiProviderAdapter,
  metaProviderAdapter,
  compatProviderAdapter,
  huggingfaceProviderAdapter,
  localProviderAdapter,
  mistralProviderAdapter,
  nousProviderAdapter,
  zenProviderAdapter,
  minimaxProviderAdapter,
  togetherProviderAdapter,
  cohereProviderAdapter,
  groqProviderAdapter,
  meliousProviderAdapter,
  orcarouterProviderAdapter,
  cerebrasProviderAdapter,
  fireworksProviderAdapter,
  qwenProviderAdapter,
]

function classForCanonical(canonical: string): ProviderModelClass | null {
  if (canonical === 'claude-opus-4-6') return 'opus'
  if (canonical === 'claude-opus-5') return 'opus'
  if (canonical === 'claude-opus-5-5') return 'opus'
  if (canonical === 'claude-sonnet-5') return 'sonnet'
  if (canonical === 'claude-sonnet-5-5') return 'sonnet'
  if (canonical === 'claude-fable-5') return 'fable'
  if (canonical === 'claude-fable-5-1') return 'fable'
  return null
}

export function classOfModel(model: string | undefined): ProviderModelClass | undefined {
  if (!model?.trim()) return undefined
  return classForCanonical(getCanonicalName(familyDefaultsModel(parseUserSpecifiedModel(model.trim())))) ?? undefined
}

function defaultExactEffort(modelClass: ProviderModelClass): ProviderEffortLevel {
  return modelClass === 'opus' ? 'xhigh' : 'high'
}

const SNAPSHOT_TTL_MS = 5_000
let snapshotMemo: { at: number; key: string; snapshot: ProviderSnapshot } | null = null

function snapshotKey(): string {
  let env = ''
  for (const name of credentialEnvNames()) env += `${name}=${process.env[name] ?? ''}\u0000`
  const disabled = [...resolveDisabledProviders().disabled].sort().join(',')
  return `${signInLedgerEpoch()}:${catalogueEpoch()}:${disabled}:${env}`
}

export function resetProviderSnapshotMemo(): void {
  snapshotMemo = null
}

export function buildProviderSnapshot(): ProviderSnapshot {
  const key = snapshotKey()
  const now = Date.now()
  if (snapshotMemo !== null && snapshotMemo.key === key && now - snapshotMemo.at < SNAPSHOT_TTL_MS) {
    return snapshotMemo.snapshot
  }
  const snapshot = composeProviderSnapshot()
  snapshotMemo = { at: now, key, snapshot }
  return snapshot
}

function composeProviderSnapshot(): ProviderSnapshot {
  const statuses = PROVIDER_ADAPTERS.map(adapter =>
    isProviderDisabled(adapter.id)
      ? { available: false as const, reason: `disabled:${adapter.id}` }
      : adapter.status(),
  )
  const providers = PROVIDER_ADAPTERS.map((adapter, i) => {
    const status = statuses[i]!
    return {
      id: adapter.id,
      available: status.available,
      reason: status.reason,
      transport: adapter.transport,
      description: adapter.describe(),
    }
  })

  function resolve(modelClass: ProviderModelClass): ProviderModelRef | null {
    for (let i = 0; i < PROVIDER_ADAPTERS.length; i++) {
      if (!statuses[i]!.available) continue
      const ref = PROVIDER_ADAPTERS[i]!.resolveModel(modelClass)
      if (ref) return ref
    }
    return null
  }

  function resolveExact(pin: string): ProviderModelRef | null {
    const trimmed = pin?.trim()
    if (!trimmed) return null
    const resolved = parseUserSpecifiedModel(trimmed)
    const wanted = normalizeModelStringForAPI(resolved).toLowerCase()
    for (const listed of listAvailable()) {
      if (normalizeModelStringForAPI(listed.ref.model).toLowerCase() === wanted) return listed.ref
    }
    if (!statuses[PROVIDER_ADAPTERS.indexOf(anthropicProviderAdapter)]!.available) return null
    const modelClass = classForCanonical(getCanonicalName(familyDefaultsModel(resolved)))
    if (!modelClass) return null
    const contextWindow = getContextWindowForModel(resolved)
    const effort = defaultExactEffort(modelClass)
    return { provider: 'anthropic', model: resolved, modelClass, effort, contextWindow }
  }

  function listAvailable(): ProviderModel[] {
    const out: ProviderModel[] = []
    for (let i = 0; i < PROVIDER_ADAPTERS.length; i++) {
      if (!statuses[i]!.available) continue
      out.push(...PROVIDER_ADAPTERS[i]!.listModels())
    }
    return out
  }

  return { providers, resolve, resolveExact, listAvailable }
}
