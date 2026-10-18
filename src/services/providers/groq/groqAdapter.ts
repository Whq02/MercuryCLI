import { groqCatalogueRows } from './groqCatalogue.js'
import { resolveGroqAccount } from './groqAccounts.js'
import { groqEffortVocabulary } from './groqPins.js'
import type { ProviderCatalogueEntry, ProviderDescription, ProviderModelRef, ProviderModelClass, ProviderAdapter, ProviderModel, ProviderStatus } from '../providerAdapter.js'
import { SPECIALIST_ROLES } from '../providerAdapter.js'

function groqLiveCatalogue(): { entries: ProviderCatalogueEntry[]; fetchedAtMs: number } | undefined {
  const { rows, source } = groqCatalogueRows()
  if (source.kind !== 'live') return undefined
  return { fetchedAtMs: source.fetchedAtMs, entries: rows.map(row => ({
    id: row.id, displayLabel: row.displayName, modelClass: 'groq',
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    efforts: [...groqEffortVocabulary(row.id)], roles: SPECIALIST_ROLES,
  })) }
}

export function groqCatalogueEntries(): readonly ProviderCatalogueEntry[] {
  const { rows } = groqCatalogueRows()
  return rows.map(row => ({ id: row.id, displayLabel: row.displayName, modelClass: 'groq', ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}), efforts: [...groqEffortVocabulary(row.id)], roles: SPECIALIST_ROLES }))
}

export function groqCatalogueEntry(id: string): ProviderCatalogueEntry | undefined {
  return groqCatalogueEntries().find(row => row.id.toLowerCase() === id.trim().toLowerCase())
}

function describeGroqProvider(): ProviderDescription {
  const account = resolveGroqAccount()
  const live = groqLiveCatalogue()
  return {
    transport: 'openai-compat-chat-completions',
    capabilities: ['streaming', 'tool-calls', 'usage-accounting', 'cancellation', 'worktree-authoring'],
    roles: SPECIALIST_ROLES,
    account: account ? { kind: 'api-key', label: account.label } : { kind: 'none', label: 'no Groq API key detected' },
    catalogue: groqCatalogueEntries(),
    ...(live ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: live.fetchedAtMs } : { catalogueSource: 'static-pin' as const }),
  }
}

function groqStatus(): ProviderStatus {
  return resolveGroqAccount() ? { available: true } : { available: false, reason: 'no-api-key:groq' }
}

function listGroqModels(): ProviderModel[] {
  if (!groqStatus().available) return []
  return groqCatalogueEntries().map(entry => ({ ref: { provider: 'groq', model: entry.id, modelClass: 'groq', effort: 'high', contextWindow: entry.contextWindow ?? 0 }, displayLabel: entry.displayLabel }))
}

function resolveGroqModel(_modelClass: ProviderModelClass): ProviderModelRef | null {
  return null
}

function buildGroqLaunchPatch(_ref: ProviderModelRef): { model: string; effort: string } {
  throw new Error('seat: provider groq has no SEAT runtime — Groq specialists dispatch through the AgentTool engine path')
}

export const groqProviderAdapter: ProviderAdapter = {
  id: 'groq', transport: 'openai-compat-chat-completions', status: groqStatus,
  describe: describeGroqProvider, listModels: listGroqModels, resolveModel: resolveGroqModel, buildLaunchPatch: buildGroqLaunchPatch,
}
