import { readStoredLocalApiKey } from '../providerSecrets.js'
import { resolveProviderKeyCommand } from '../providerKeyCommand.js'
import { getCachedLocalDiscovery } from './localDiscovery.js'
import { tensorFoldHostKey, tensorFoldHostRoot } from './tensorfoldHosts.js'

export const LOCAL_PULL_RECOMMENDATION = 'ollama pull qwen3.5:9b (tool-capable, ~6.6 GB; qwen3.5:27b for 48 GB and up)'
export const LOCAL_SETUP_WORDS = '/localsetup sets one up (Ollama, LM Studio, vLLM, llama.cpp)'
export const LOCAL_NO_MODEL_REMEDY = 'no model pulled yet — /localsetup pulls one'
export const LOCAL_NO_SERVER_BLOCKER = `no local server discovered — ${LOCAL_SETUP_WORDS}, or start one and set MERCURY_LOCAL_BASE_URL`
export const LOCAL_UNREACHABLE_REMEDY = `no local server discovered — start Ollama (:11434), LM Studio (:1234), vLLM (:8000) or llama.cpp-server (:8080), or set MERCURY_LOCAL_BASE_URL; then ${LOCAL_PULL_RECOMMENDATION}`

export function localRoadBesideSignIn(account: LocalAccountRef | undefined = resolveLocalAccount()): string {
  if (account !== undefined && account.modelCount > 0) return `or run a local model with --model local/<name> (${account.label})`
  return `or run a local model — ${LOCAL_SETUP_WORDS}`
}

export function resolveLocalApiKey(
  env: Record<string, string | undefined> = process.env,
): { key: string; source: 'env' | 'stored' } | undefined {
  const envKey = env.MERCURY_LOCAL_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const fromCommand = resolveProviderKeyCommand('local')
  if (fromCommand) return { key: fromCommand, source: 'stored' }
  const stored = readStoredLocalApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export type LocalApiKeyReads = {
  hostKey?: (root: string) => string | undefined
  sharedKey?: (root: string) => string | undefined
}

const LOOPBACK_ROOT = /^http:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0):(\d+)$/

export function sharedTensorFoldKey(root: string): string | undefined {
  const port = Number(LOOPBACK_ROOT.exec(root)?.[2])
  if (!Number.isInteger(port) || port <= 0) return undefined
  try {
    const { readServedRecord } = require('../../tensorfold/serve.js') as typeof import('../../tensorfold/serve.js')
    const { readTensorFoldKeyFile } = require('./tensorfoldKeyFile.js') as typeof import('./tensorfoldKeyFile.js')
    const served = readServedRecord()
    if (served === null || served.port !== port || served.keyFile === undefined) return undefined
    return readTensorFoldKeyFile(served.keyFile)?.key
  } catch {
    return undefined
  }
}

export function resolveLocalApiKeyFor(
  baseUrl: string,
  env: Record<string, string | undefined> = process.env,
  reads: LocalApiKeyReads = {},
): { key: string; source: 'env' | 'stored' | 'host' | 'shared' } | undefined {
  const root = tensorFoldHostRoot(baseUrl)
  try {
    const hostKey = (reads.hostKey ?? tensorFoldHostKey)(root)
    if (hostKey !== undefined) return { key: hostKey, source: 'host' }
  } catch {
  }
  const shared = (reads.sharedKey ?? sharedTensorFoldKey)(root)
  if (shared !== undefined) return { key: shared, source: 'shared' }
  return resolveLocalApiKey(env)
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
  const listed = snapshot.servers.map(s => `${s.label} (${s.models.length})`).join(' · ')
  const servers = modelCount === 0 ? `${listed} · ${LOCAL_NO_MODEL_REMEDY}` : listed
  const key = resolveLocalApiKey(env)
  return {
    kind: key ? 'api-key' : 'keyless',
    label: key ? `${servers} · key (${key.source})` : servers,
    ...(key ? { keySource: key.source } : {}),
    serverCount: snapshot.servers.length,
    modelCount,
  }
}
