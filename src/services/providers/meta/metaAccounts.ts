import { readStoredMetaApiKey } from '../../../utils/router/providerSecrets.js'

export function metaApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MERCURY_META_API_BASE?.trim() || 'https://api.meta.ai/v1').replace(/\/+$/, '')
}

export function metaChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${metaApiBase(env)}/chat/completions`
}

export function metaEnvKey(env: NodeJS.ProcessEnv = process.env): { key: string; name: 'MODEL_API_KEY' | 'META_API_KEY' } | undefined {
  for (const name of ['MODEL_API_KEY', 'META_API_KEY'] as const) {
    const key = env[name]?.trim()
    if (key) return { key, name }
  }
  return undefined
}

export function resolveMetaApiKey(env: NodeJS.ProcessEnv = process.env): { key: string; source: 'env' | 'stored' } | undefined {
  const key = metaEnvKey(env)
  if (key) return { key: key.key, source: 'env' }
  const stored = readStoredMetaApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export interface MetaAccountRef {
  kind: 'api-key'
  label: string
  keySource: 'env' | 'stored'
}

export function resolveMetaAccount(env: NodeJS.ProcessEnv = process.env): MetaAccountRef | undefined {
  const key = resolveMetaApiKey(env)
  return key ? { kind: 'api-key', label: key.source === 'env' ? `${metaEnvKey(env)!.name} (env)` : 'Meta API key (stored, auth-scoped)', keySource: key.source } : undefined
}
