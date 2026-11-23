import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishAtomicSync } from '../../../platform/substrate/fileStore.js'
import { getMercuryHome } from '../../../platform/environment/envUtils.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { compatEndpointDigest } from './compatSlots.js'
import type { CompatUsage } from './compatChatClient.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

const cachePath = (baseUrl: string): string => join(getMercuryHome(), 'cache', 'compat-prefix', compatEndpointDigest(baseUrl) + '.json')
const tokens = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function noteCompatPrefixCache(endpoint: { baseUrl: string }, model: string, usage: CompatUsage | undefined): void {
  try {
    const path = cachePath(endpoint.baseUrl)
    const measured = Boolean(usage && tokens(usage.inputTokens) && usage.inputTokens > 0 && tokens(usage.cachedInputTokens) && usage.cachedInputTokens <= usage.inputTokens)
    mkdirSync(join(getMercuryHome(), 'cache', 'compat-prefix'), { recursive: true, mode: 0o700 })
    publishAtomicSync(path, JSON.stringify({ model, ...(measured ? { total: usage!.inputTokens, cached: usage!.cachedInputTokens } : {}), at: Date.now() }) + '\n', { mode: 0o600 })
  } catch (error) { logForDebugging(`Prefix cache reading could not be saved: ${String(error)}`, { level: 'warn' }) }
}

export function compatEndpointLastTurnAt(endpoint: { baseUrl: string }): number | undefined {
  let raw: string
  try {
    raw = readFileSync(cachePath(endpoint.baseUrl), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const row = JSON.parse(raw) as { at?: unknown }
  return typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : undefined
}

export function compatPrefixCacheWords(endpoint: { baseUrl: string }, now = Date.now()): string {
  try {
    const row = JSON.parse(readFileSync(cachePath(endpoint.baseUrl), 'utf8')) as { cached?: unknown; total?: unknown; at?: unknown }
    if (!tokens(row.cached) || !tokens(row.total) || row.total === 0 || row.cached > row.total || typeof row.at !== 'number' || !Number.isFinite(row.at) || row.at > now || now - row.at > 15 * 60_000) return ''
    return `prefix cached · ${row.cached.toLocaleString('en-US')} of ${row.total.toLocaleString('en-US')} tokens (last turn)`
  } catch (error) { passedOver(error); return '' }
}
