import { mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { publishAtomicSync } from '../../../substrate/fileStore.js'
import { getMercuryHome } from '../../../utils/envUtils.js'
import { logForDebugging } from '../../../utils/debug.js'
import { compatEndpointDigest } from './compatSlots.js'
import type { CompatUsage } from './compatChatClient.js'

const cachePath = (baseUrl: string): string => join(getMercuryHome(), 'cache', 'compat-prefix', compatEndpointDigest(baseUrl) + '.json')
const tokens = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function noteCompatPrefixCache(endpoint: { baseUrl: string }, model: string, usage: CompatUsage | undefined): void {
  try {
    const path = cachePath(endpoint.baseUrl)
    if (!usage || !tokens(usage.inputTokens) || usage.inputTokens === 0 || !tokens(usage.cachedInputTokens) || usage.cachedInputTokens > usage.inputTokens) {
      try { unlinkSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      return
    }
    mkdirSync(join(getMercuryHome(), 'cache', 'compat-prefix'), { recursive: true, mode: 0o700 })
    publishAtomicSync(path, JSON.stringify({ model, total: usage.inputTokens, cached: usage.cachedInputTokens, at: Date.now() }) + '\n', { mode: 0o600 })
  } catch (error) { logForDebugging(`Prefix cache reading could not be saved: ${String(error)}`, { level: 'warn' }) }
}

export function compatPrefixCacheWords(endpoint: { baseUrl: string }, now = Date.now()): string {
  try {
    const row = JSON.parse(readFileSync(cachePath(endpoint.baseUrl), 'utf8')) as { cached?: unknown; total?: unknown; at?: unknown }
    if (!tokens(row.cached) || !tokens(row.total) || row.total === 0 || row.cached > row.total || typeof row.at !== 'number' || !Number.isFinite(row.at) || row.at > now || now - row.at > 15 * 60_000) return ''
    return `prefix cached · ${row.cached.toLocaleString('en-US')} of ${row.total.toLocaleString('en-US')} tokens (last turn)`
  } catch { return '' }
}
