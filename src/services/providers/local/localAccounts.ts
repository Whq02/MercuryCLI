import { readStoredLocalApiKey } from '../../../utils/router/providerSecrets.js'
import { getCachedLocalDiscovery } from './localDiscovery.js'

export const LOCAL_UNREACHABLE_REMEDY =
  'no local server discovered — start Ollama (:11434), LM Studio (:1234), vLLM (:8000) or llama.cpp-server (:8080), or set MERCURY_LOCAL_BASE_URL'

export function resolveLocalApiKey(
  env: Record<string, string | undefined> = process.env,
): { key: string; source: 'env' | 'stored' } | undefined {
  const envKey = env.MERCURY_LOCAL_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const stored = readStoredLocalApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export interface LocalAccountRef {
  kind: 'keyless' | 'api-key'
  label: string
  keySource?: 'env' | 'stored'
  serverCount: number
  modelCount: number
}

export function resolveLocalAccount(env: NodeJS.ProcessEnv = process.env): LocalAccountRef | undefined {
  const snapshot = getCachedLocalDiscovery()
  if (!snapshot || snapshot.servers.length === 0) return undefined
  const modelCount = snapshot.servers.reduce((n, s) => n + s.models.length, 0)
  const servers = snapshot.servers.map(s => `${s.label} (${s.models.length})`).join(' · ')
  const key = resolveLocalApiKey(env)
  return {
    kind: key ? 'api-key' : 'keyless',
    label: key ? `${servers} · key (${key.source})` : servers,
    ...(key ? { keySource: key.source } : {}),
    serverCount: snapshot.servers.length,
    modelCount,
  }
}
