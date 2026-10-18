import { qwenCatalogueRows } from './qwenCatalogue.js'
import { resolveQwenAccount, resolveQwenCredentialSnapshot } from './qwenAccounts.js'
import type { ProviderCatalogueEntry, ProviderDescription, ProviderModelRef, ProviderModelClass, ProviderAdapter, ProviderModel, ProviderStatus } from '../providerAdapter.js'
import { SPECIALIST_ROLES } from '../providerAdapter.js'

function qwenLiveCatalogue(): { entries: ProviderCatalogueEntry[]; fetchedAtMs: number } | undefined {
  const { rows, source } = qwenCatalogueRows()
  if (source.kind !== 'live') return undefined
  return { fetchedAtMs: source.fetchedAtMs, entries: rows.map(row => ({
    id: row.id, displayLabel: row.displayName, modelClass: 'qwen',
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    efforts: [], roles: SPECIALIST_ROLES,
  })) }
}

export function qwenCatalogueEntries(): readonly ProviderCatalogueEntry[] {
  return qwenLiveCatalogue()?.entries ?? []
}

export function qwenCatalogueEntry(id: string): ProviderCatalogueEntry | undefined {
  return qwenCatalogueEntries().find(row => row.id.toLowerCase() === id.trim().toLowerCase())
}

function describeQwenProvider(): ProviderDescription {
  const account = resolveQwenAccount()
  const live = qwenLiveCatalogue()
  return {
    transport: 'openai-compat-chat-completions',
    capabilities: ['streaming', 'tool-calls', 'usage-accounting', 'cancellation', 'worktree-authoring'],
    roles: SPECIALIST_ROLES,
    account: account ? { kind: account.kind === 'signin' ? 'provider-oauth' : 'api-key', label: account.label } : { kind: 'none', label: 'no Qwen account sign-in or Model Studio API key detected' },
    catalogue: live?.entries ?? [],
    ...(live ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: live.fetchedAtMs } : { catalogueSource: 'static-pin' as const }),
  }
}

function qwenStatus(): ProviderStatus {
  const account = resolveQwenAccount()
  if (account?.expired) return { available: false, reason: 'signin-expired:qwen' }
  return resolveQwenCredentialSnapshot() ? { available: true } : { available: false, reason: 'no-api-key:qwen' }
}

function listQwenModels(): ProviderModel[] {
  if (!qwenStatus().available) return []
  return qwenCatalogueEntries().map(entry => ({ ref: { provider: 'qwen', model: entry.id, modelClass: 'qwen', effort: 'high', contextWindow: entry.contextWindow ?? 0 }, displayLabel: entry.displayLabel }))
}

function resolveQwenModel(_modelClass: ProviderModelClass): ProviderModelRef | null {
  return null
}

function buildQwenLaunchPatch(_ref: ProviderModelRef): { model: string; effort: string } {
  throw new Error('seat: provider qwen has no SEAT runtime — Qwen specialists dispatch through the AgentTool engine path')
}

export const qwenProviderAdapter: ProviderAdapter = {
  id: 'qwen', transport: 'openai-compat-chat-completions', status: qwenStatus,
  describe: describeQwenProvider, listModels: listQwenModels, resolveModel: resolveQwenModel, buildLaunchPatch: buildQwenLaunchPatch,
}
