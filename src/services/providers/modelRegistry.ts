import { getContextWindowForModel } from '../../utils/context.js'
import { getCanonicalName, normalizeModelStringForAPI, parseUserSpecifiedModel } from '../../utils/model/model.js'
import { familyDefaultsModel } from '../../utils/model/configs.js'
import { anthropicProviderAdapter } from './anthropic/anthropicAdapter.js'
import { geminiProviderAdapter } from './gemini/geminiAdapter.js'
import { openaiProviderAdapter } from './openai/openaiAdapter.js'
import { openrouterProviderAdapter } from './openrouter/openrouterAdapter.js'
import type {
  ProviderDescription,
  RouteEffortLevel,
  RouteModelRef,
  RouterModelClass,
  RouterPosture,
  RouterProviderAdapter,
  RouterProviderId,
  RouterProviderModel,
  RouterTransport,
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
import { catalogueEpoch } from './catalogueEpoch.js'
import { signInLedgerEpoch } from '../../utils/accounts/signInLedger.js'
import { credentialEnvNames } from './providerSecrets.js'

export interface RouterModelSnapshot {
  providers: Array<{
    id: RouterProviderId
    available: boolean
    reason?: string
    transport: RouterTransport
    description: ProviderDescription
  }>
  resolve(modelClass: RouterModelClass, posture: RouterPosture): RouteModelRef | null
  resolveExact(pin: string): RouteModelRef | null
  listAvailable(): RouterProviderModel[]
}

const PROVIDER_ADAPTERS: readonly RouterProviderAdapter[] = [
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
]

function classForCanonical(canonical: string): RouterModelClass | null {
  if (canonical === 'claude-opus-4-6') return 'opus'
  if (canonical === 'claude-opus-5') return 'opus'
  if (canonical === 'claude-opus-5-5') return 'opus'
  if (canonical === 'claude-sonnet-5') return 'sonnet'
  if (canonical === 'claude-sonnet-5-5') return 'sonnet'
  if (canonical === 'claude-fable-5') return 'fable'
  if (canonical === 'claude-fable-5-1') return 'fable'
  return null
}

export function classOfModel(model: string | undefined): RouterModelClass | undefined {
  if (!model?.trim()) return undefined
  return classForCanonical(getCanonicalName(familyDefaultsModel(parseUserSpecifiedModel(model.trim())))) ?? undefined
}

function defaultExactEffort(modelClass: RouterModelClass): RouteEffortLevel {
  return modelClass === 'opus' ? 'xhigh' : 'high'
}

const SNAPSHOT_TTL_MS = 5_000
let snapshotMemo: { at: number; key: string; snapshot: RouterModelSnapshot } | null = null

function snapshotKey(): string {
  let env = ''
  for (const name of credentialEnvNames()) env += `${name}=${process.env[name] ?? ''}\u0000`
  return `${signInLedgerEpoch()}:${catalogueEpoch()}:${env}`
}

export function resetRouterModelSnapshotMemo(): void {
  snapshotMemo = null
}

export function buildRouterModelSnapshot(): RouterModelSnapshot {
  const key = snapshotKey()
  const now = Date.now()
  if (snapshotMemo !== null && snapshotMemo.key === key && now - snapshotMemo.at < SNAPSHOT_TTL_MS) {
    return snapshotMemo.snapshot
  }
  const snapshot = composeRouterModelSnapshot()
  snapshotMemo = { at: now, key, snapshot }
  return snapshot
}

function composeRouterModelSnapshot(): RouterModelSnapshot {
  const statuses = PROVIDER_ADAPTERS.map(adapter => adapter.status())
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

  function resolve(modelClass: RouterModelClass, posture: RouterPosture): RouteModelRef | null {
    for (let i = 0; i < PROVIDER_ADAPTERS.length; i++) {
      if (!statuses[i]!.available) continue
      const ref = PROVIDER_ADAPTERS[i]!.resolveModel(modelClass, posture)
      if (ref) return ref
    }
    return null
  }

  function resolveExact(pin: string): RouteModelRef | null {
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

  function listAvailable(): RouterProviderModel[] {
    const out: RouterProviderModel[] = []
    for (let i = 0; i < PROVIDER_ADAPTERS.length; i++) {
      if (!statuses[i]!.available) continue
      out.push(...PROVIDER_ADAPTERS[i]!.listModels())
    }
    return out
  }

  return { providers, resolve, resolveExact, listAvailable }
}
