import type { ActiveSourceUsage, ActiveUsageReads, ProviderSessionSpend } from '../providerUsage.js'
import { cachedLocalModels } from '../local/localDiscovery.js'
import { resolveLocalAccount } from '../local/localAccounts.js'

export function localUsageView(provider: 'local', spend: ProviderSessionSpend, reads: ActiveUsageReads | undefined): ActiveSourceUsage {
  const account = reads?.localAccount ? reads.localAccount() : resolveLocalAccount()
  if (!account) {
    return { provider, sourceKind: 'none', label: 'Local usage', shape: 'none', windows: [], pools: [], spend, whyNot: 'no local server — start one, or set MERCURY_LOCAL_BASE_URL' }
  }
  return {
    provider,
    sourceKind: account.kind === 'keyless' ? 'keyless' : 'api-key',
    label: 'Local usage',
    shape: 'none',
    windows: [],
    pools: [],
    spend,
    absence: cachedLocalModels().some(model => model.executionOrigin?.kind === 'remote') ? 'local inference $0 · remote pricing unknown' : 'local · no metering',
    tier: cachedLocalModels().some(model => model.executionOrigin?.kind === 'remote') ? 'remote pricing unknown' : 'local · no metering',
  }
}
