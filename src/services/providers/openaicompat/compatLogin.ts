import { writeStoredCompatApiKey } from '../providerSecrets.js'
import { compatKeyEnvName, configuredCompatEndpoints } from './compatAccounts.js'
import { refreshCompatCatalogues } from './compatCatalogue.js'

export async function storeCompatApiKeyLogin(name: string, key: string): Promise<{ ok: boolean; stored: boolean; receipt: string }> {
  if (!key.trim()) return { ok: false, stored: false, receipt: 'An empty key was not stored.' }
  try {
    writeStoredCompatApiKey(key, name)
    await refreshCompatCatalogues({ force: true, name })
    const endpoint = configuredCompatEndpoints().find(entry => entry.name === name)
    return { ok: true, stored: true, receipt: `${endpoint?.label ?? name} API key stored (auth-scoped, mode 600); ${compatKeyEnvName(name)} takes precedence when set.` }
  } catch (error) {
    return { ok: false, stored: false, receipt: error instanceof Error ? error.message : String(error) }
  }
}
