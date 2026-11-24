import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { readStoredZenApiKey } from '../../sign-in/account-ledger/providerSecrets.js'
import { resolveProviderKeyCommand } from '../providerKeyCommand.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'

export const ZEN_API_BASE_URL = 'https://opencode.ai/zen/v1'
export const ZEN_GO_API_BASE_URL = 'https://opencode.ai/zen/go/v1'
export const ZEN_ENV_KEY = 'OPENCODE_API_KEY'

const goneBases = new Set<string>()

function zenFallbackBase(base: string): string | undefined {
  const moved = base.replace(/\/zen(\/go)?\/v1$/, '/inference$1/v1')
  return moved === base ? undefined : moved
}

function zenServingBase(base: string): string {
  return goneBases.has(base) ? zenFallbackBase(base) ?? base : base
}

export function zenApiBase(env: NodeJS.ProcessEnv = hostEnv()): string {
  return zenServingBase((flagEnv('MERCURY_ZEN_API_BASE', env)?.trim() || ZEN_API_BASE_URL).replace(/\/+$/, ''))
}

export function zenGoApiBase(env: NodeJS.ProcessEnv = hostEnv()): string {
  return zenServingBase((flagEnv('MERCURY_ZEN_GO_API_BASE', env)?.trim() || ZEN_GO_API_BASE_URL).replace(/\/+$/, ''))
}

export function zenFetch(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await fetchImpl(input, init)
    if (response.status !== 404 && response.status !== 410) return response
    const url = typeof input === 'string' ? input : undefined
    const base = url === undefined ? undefined : /^(.*\/zen(?:\/go)?\/v1)\//.exec(url)?.[1]
    const fallback = base === undefined ? undefined : zenFallbackBase(base)
    if (url === undefined || base === undefined || fallback === undefined) return response
    const moved = await fetchImpl(`${fallback}${url.slice(base.length)}`, init)
    if (moved.status === 404 || moved.status === 410) {
      void moved.body?.cancel()
      return response
    }
    void response.body?.cancel()
    goneBases.add(base)
    logForDebugging(`[zen] ${base} answered HTTP ${response.status}; this session uses ${fallback}`)
    return moved
  }) as typeof fetch
}

export function __resetZenBaseFallbackForTest(): void {
  goneBases.clear()
}

export function zenChatCompletionsUrl(env: NodeJS.ProcessEnv = hostEnv()): string {
  return `${zenApiBase(env)}/chat/completions`
}

export function zenGoUsageUrl(env: NodeJS.ProcessEnv = hostEnv()): string {
  return `${zenGoApiBase(env)}/usage`
}

export function resolveZenApiKey(env: NodeJS.ProcessEnv = hostEnv()): { key: string; source: 'env' | 'stored' } | undefined {
  const key = env[ZEN_ENV_KEY]?.trim()
  if (key) return { key, source: 'env' }
  const fromCommand = resolveProviderKeyCommand('zen')
  if (fromCommand) return { key: fromCommand, source: 'stored' }
  const stored = readStoredZenApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export interface ZenAccountRef {
  kind: 'api-key'
  label: string
  keySource: 'env' | 'stored'
}

export function resolveZenAccount(env: NodeJS.ProcessEnv = hostEnv()): ZenAccountRef | undefined {
  const key = resolveZenApiKey(env)
  return key
    ? { kind: 'api-key', label: key.source === 'env' ? `${ZEN_ENV_KEY} (env)` : 'OpenCode Zen API key (stored, auth-scoped)', keySource: key.source }
    : undefined
}

export function zenRequestHeaders(userAgent: string, sessionId: string): Record<string, string> {
  return { 'user-agent': userAgent, 'x-opencode-session': sessionId }
}
