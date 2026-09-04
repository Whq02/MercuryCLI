import { getContextWindowForModel } from '../context.js'
import { getCanonicalName, parseUserSpecifiedModel } from '../model/model.js'
import { isHaikuTier } from '../model/modelFloor.js'
import { SEAT_ALLOWED_FAMILIES } from '../model/seatSlots.js'
import { anthropicProviderAdapter } from './providers/anthropic.js'
import { geminiProviderAdapter } from './providers/gemini.js'
import { openaiProviderAdapter } from './providers/openai.js'
import { openrouterProviderAdapter } from './providers/openrouter.js'
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
} from './providers/types.js'
import { zaiProviderAdapter } from './providers/zai.js'
import { moonshotProviderAdapter } from './providers/moonshot.js'
import { deepseekProviderAdapter } from './providers/deepseek.js'
import { compatProviderAdapter } from './providers/openaicompat.js'
import { huggingfaceProviderAdapter } from './providers/huggingface.js'
import { localProviderAdapter } from './providers/local.js'
import { catalogueEpoch } from '../../services/providers/catalogueEpoch.js'
import { signInLedgerEpoch } from '../accounts/signInLedger.js'
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
  compatProviderAdapter,
  huggingfaceProviderAdapter,
  localProviderAdapter,
]

function classForCanonical(canonical: string): RouterModelClass | null {
  if (canonical === 'claude-opus-4-6') return 'opus'
  if (canonical === 'claude-opus-5') return 'opus'
  if (canonical === 'claude-sonnet-5') return 'sonnet'
  if (canonical === 'claude-fable-5') return 'fable'
  if (canonical === 'claude-fable-5-1') return 'fable'
  return null
}

export function classOfModel(model: string | undefined): RouterModelClass | undefined {
  if (!model?.trim()) return undefined
  return classForCanonical(getCanonicalName(parseUserSpecifiedModel(model.trim()))) ?? undefined
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
    if (isHaikuTier(trimmed)) return null
    const lowered = trimmed.toLowerCase()
    if (lowered === 'sonnet' || lowered === 'sonnet[1m]') return null
    const resolved = parseUserSpecifiedModel(trimmed)
    if (isHaikuTier(resolved)) return null
    const canonical = getCanonicalName(resolved)
    if (!SEAT_ALLOWED_FAMILIES.includes(canonical)) return null
    const modelClass = classForCanonical(canonical)
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
