import {
  getCachedOpenaiCatalogue,
  gptDisplayPin,
  qualifiedGptCandidates,
  GPT_DISPLAY_PINS,
} from '../../../services/providers/openai/openaiCatalogue.js'
import { primeOpenaiDiscovery } from '../providerDiscovery.js'
import type {
  ProviderCatalogueEntry,
  ProviderDescription,
  RouteModelRef,
  RouterModelClass,
  RouterPosture,
  RouterProviderAdapter,
  RouterProviderModel,
  RouterProviderStatus,
  SpecialistRole,
} from './types.js'
import { SPECIALIST_ROLES } from './types.js'

const ALL_ROLES: readonly SpecialistRole[] = SPECIALIST_ROLES

export const DEPRECATED_GPT_IDS: readonly string[] = [
  'gpt-5.2',
  'gpt-5.3-codex',
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
]

function activeAccount() {
  const discovery = primeOpenaiDiscovery()
  return discovery?.provider === 'openai' ? discovery.account : undefined
}

function staticPinCatalogue(): ProviderCatalogueEntry[] {
  return GPT_DISPLAY_PINS.map(pin => ({
    id: pin.id,
    displayLabel: pin.displayName,
    modelClass: 'gpt' as const,
    ...(pin.contextWindow !== undefined ? { contextWindow: pin.contextWindow } : {}),
    efforts: [],
    roles: ALL_ROLES,
  }))
}

function liveCatalogue(): { entries: ProviderCatalogueEntry[]; fetchedAtMs: number } | null {
  const account = activeAccount()
  if (!account) return null
  const snapshot = getCachedOpenaiCatalogue(account.kind)
  if (!snapshot || snapshot.fetchedAtMs === 0) return null
  const entries: ProviderCatalogueEntry[] = []
  for (const candidate of qualifiedGptCandidates('specialist', account.kind)) {
    entries.push({
      id: candidate.identity.canonicalId,
      displayLabel: candidate.displayName,
      modelClass: 'gpt',
      ...(candidate.live.contextWindow !== undefined
        ? { contextWindow: candidate.live.contextWindow }
        : candidate.pin && candidate.pin.contextWindow !== undefined
          ? { contextWindow: candidate.pin.contextWindow }
          : {}),
      efforts: candidate.live.supportedReasoningEfforts,
      roles: ALL_ROLES,
    })
  }
  return { entries, fetchedAtMs: snapshot.fetchedAtMs }
}

export function describeOpenaiProvider(): ProviderDescription {
  const account = activeAccount()
  const live = liveCatalogue()
  return {
    transport: 'openai-responses',
    capabilities: [
      'streaming',
      'tool-calls',
      'structured-output',
      'reasoning-deltas',
      'usage-accounting',
      'cancellation',
      'worktree-authoring',
    ],
    roles: ALL_ROLES,
    account: account
      ? {
          kind: account.kind === 'chatgpt-subscription' ? 'chatgpt-login' : 'api-key',
          label: account.label,
        }
      : { kind: 'none', label: 'no OpenAI account source connected' },
    catalogue: live?.entries ?? staticPinCatalogue(),
    catalogueSource: live ? 'live-discovery' : 'static-pin',
    ...(live ? { discoveredAtMs: live.fetchedAtMs } : {}),
  }
}

export function openaiStatus(): RouterProviderStatus {
  if (!activeAccount()) return { available: false, reason: 'no-account:openai' }
  return { available: true }
}

export function listOpenaiModels(): RouterProviderModel[] {
  if (!openaiStatus().available) return []
  const live = liveCatalogue()
  if (!live) return []
  return live.entries.map(entry => ({
    ref: {
      provider: 'openai' as const,
      model: entry.id,
      modelClass: 'gpt' as const,
      effort: 'high' as const,
      contextWindow: entry.contextWindow ?? gptDisplayPin(entry.id)?.contextWindow ?? 0,
    },
    displayLabel: entry.displayLabel,
  }))
}

export function resolveOpenaiModel(
  modelClass: RouterModelClass,
  _posture: RouterPosture,
): RouteModelRef | null {
  if (modelClass !== 'gpt') return null
  if (!openaiStatus().available) return null
  const account = activeAccount()
  if (!account) return null
  const head = qualifiedGptCandidates('specialist', account.kind)[0]
  if (!head) return null
  return {
    provider: 'openai',
    model: head.identity.canonicalId,
    modelClass: 'gpt',
    effort: 'high',
    contextWindow: head.live.contextWindow ?? head.pin?.contextWindow ?? 0,
  }
}

export function buildOpenaiLaunchPatch(ref: RouteModelRef): { model: string; effort: string } {
  return { model: ref.model, effort: ref.effort }
}

export const openaiProviderAdapter: RouterProviderAdapter = {
  id: 'openai',
  transport: 'openai-responses',
  status: openaiStatus,
  describe: describeOpenaiProvider,
  listModels: listOpenaiModels,
  resolveModel: resolveOpenaiModel,
  buildLaunchPatch: buildOpenaiLaunchPatch,
}
