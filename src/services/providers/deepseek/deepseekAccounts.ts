// ============================================================================
//  providers/deepseek/deepseekAccounts — the DeepSeek account-source owner
//
//
//  DeepSeek's platform is API-KEY ONLY (checked live — the
//  api-docs show Bearer keys and no OAuth product; per the operator's law,
//  keys are the honest answer and no OAuth flow is invented). ONE resolver:
//  env DEEPSEEK_API_KEY WINS over the auth-scoped provider-secret store.
//  Base https://api.deepseek.com;
//  fixture seam MERCURY_DEEPSEEK_API_BASE pins it for provers.
//  Values never enter records, logs, errors, or UI — presence + labels only.
// ============================================================================
import { readStoredDeepseekApiKey } from '../../../utils/router/providerSecrets.js'

const DEEPSEEK_API_BASE_URL = 'https://api.deepseek.com'

export function deepseekApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env['MERCURY_DEEPSEEK_API_BASE']?.trim() || DEEPSEEK_API_BASE_URL
}
export function deepseekChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${deepseekApiBase(env)}/chat/completions`
}
/** GET — the documented billing-truth endpoint (api-docs get-user-balance). */
export function deepseekBalanceUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${deepseekApiBase(env)}/user/balance`
}

/** The ONE DeepSeek key resolution: env DEEPSEEK_API_KEY WINS over the
 *  auth-scoped store. The VALUE never enters records, logs, or errors. */
export function resolveDeepseekApiKey(
  env: Record<string, string | undefined> = process.env,
): { key: string; source: 'env' | 'stored' } | undefined {
  const envKey = env.DEEPSEEK_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const stored = readStoredDeepseekApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export interface DeepseekAccountRef {
  kind: 'api-key'
  label: string
  keySource: 'env' | 'stored'
}

export function resolveDeepseekAccount(
  env: NodeJS.ProcessEnv = process.env,
): DeepseekAccountRef | undefined {
  const key = resolveDeepseekApiKey(env)
  if (!key) return undefined
  return {
    kind: 'api-key',
    label: key.source === 'env' ? 'DEEPSEEK_API_KEY (env)' : 'DeepSeek API key (stored, auth-scoped)',
    keySource: key.source,
  }
}
