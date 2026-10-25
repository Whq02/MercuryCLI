import { orcarouterCatalogueRows, orcarouterEffortVocabulary } from './orcarouterCatalogue.js'
import { resolveOrcarouterAccount } from './orcarouterAccounts.js'
import { SPECIALIST_ROLES, type ProviderAdapter, type ProviderCatalogueEntry } from '../providerAdapter.js'

export function orcarouterCatalogueEntries(): readonly ProviderCatalogueEntry[] {
  return orcarouterCatalogueRows().rows.map(row => ({ id: row.id, displayLabel: row.displayName, modelClass: 'orcarouter',
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}), efforts: orcarouterEffortVocabulary(row.id), roles: SPECIALIST_ROLES }))
}

export function orcarouterCatalogueEntry(id: string): ProviderCatalogueEntry | undefined {
  return orcarouterCatalogueEntries().find(row => row.id.toLowerCase() === id.trim().toLowerCase())
}

export const orcarouterProviderAdapter: ProviderAdapter = {
  id: 'orcarouter', transport: 'openai-compat-chat-completions',
  status: () => resolveOrcarouterAccount() ? { available: true } : { available: false, reason: 'no-api-key:orcarouter' },
  describe: () => {
    const account = resolveOrcarouterAccount()
    const { source } = orcarouterCatalogueRows()
    return {
      transport: 'openai-compat-chat-completions', capabilities: ['streaming', 'tool-calls', 'reasoning-deltas', 'usage-accounting', 'cancellation', 'worktree-authoring'], roles: SPECIALIST_ROLES,
      account: account ? { kind: 'api-key', label: account.label } : { kind: 'none', label: 'no OrcaRouter API key detected' },
      catalogue: orcarouterCatalogueEntries(),
      ...(source.kind === 'live' ? { catalogueSource: 'live-discovery', discoveredAtMs: source.fetchedAtMs } : { catalogueSource: 'static-pin' }),
    }
  },
  listModels: () => resolveOrcarouterAccount() ? orcarouterCatalogueEntries().map(entry => ({ ref: { provider: 'orcarouter', model: entry.id, modelClass: 'orcarouter', effort: 'high', contextWindow: entry.contextWindow ?? 0 }, displayLabel: entry.displayLabel })) : [],
  resolveModel: () => null,
  buildLaunchPatch: () => { throw new Error('seat: provider orcarouter has no SEAT runtime — OrcaRouter specialists dispatch through the AgentTool engine path') },
}
