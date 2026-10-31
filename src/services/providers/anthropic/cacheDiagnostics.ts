import { flagEnv } from '../../../substrate/flagRegistry.js'
import { logForDebugging } from '../../../utils/debug.js'
import { isTurnOwningQuerySource } from '../../../utils/effort.js'
import { isFirstPartyAnthropicBaseUrl } from '../../../utils/model/providers.js'

interface CacheDiagnosticsParam {
  previous_message_id: string | null
}

interface CacheMissReason {
  type: string
  cache_missed_input_tokens?: number
}

const PROVIDER_MESSAGE_ID = /^msg_[A-Za-z0-9_]+$/

let refusal: string | null = null

export function cacheDiagnosticsRefusal(): string | null {
  return refusal
}

export function refuseCacheDiagnostics(reason: string | null): void {
  refusal = reason
}

export function isCacheDiagnosticsRefusal(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  if (status !== 400) return false
  const message = error instanceof Error ? error.message : String(error)
  return /diagnostics/i.test(message)
}

function cacheDiagnosticsEnabled(querySource: string | undefined, firstParty: () => boolean = isFirstPartyAnthropicBaseUrl): boolean {
  const setting = (flagEnv('MERCURY_CACHE_DIAGNOSTICS') ?? '').trim()
  if (setting === '0' || refusal !== null) return false
  if (!isTurnOwningQuerySource(querySource)) return false
  return setting === '1' || firstParty()
}

export function previousProviderMessageId(wireMessageIds: ReadonlyArray<string | null>): string | null {
  for (let index = wireMessageIds.length - 1; index >= 0; index--) {
    const id = wireMessageIds[index]
    if (typeof id === 'string' && PROVIDER_MESSAGE_ID.test(id)) return id
  }
  return null
}

export function cacheDiagnosticsParam(wireMessageIds: ReadonlyArray<string | null>, querySource: string | undefined, firstParty?: () => boolean): CacheDiagnosticsParam | null {
  if (!cacheDiagnosticsEnabled(querySource, firstParty)) return null
  return { previous_message_id: previousProviderMessageId(wireMessageIds) }
}

export function cacheMissReasonOf(message: unknown): CacheMissReason | null | undefined {
  const diagnostics = (message as { diagnostics?: unknown } | null | undefined)?.diagnostics
  if (diagnostics === undefined || diagnostics === null) return diagnostics
  const reason = (diagnostics as { cache_miss_reason?: unknown }).cache_miss_reason
  if (reason === null || reason === undefined) return null
  if (typeof reason !== 'object' || typeof (reason as { type?: unknown }).type !== 'string') return null
  return reason as CacheMissReason
}

export function describeCacheDiagnostics(message: unknown, usage: { cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined): string | null {
  const diagnostics = (message as { diagnostics?: unknown } | null | undefined)?.diagnostics
  if (diagnostics === undefined) return null
  const read = usage?.cache_read_input_tokens ?? 0
  const written = usage?.cache_creation_input_tokens ?? 0
  const tokens = `cache read ${read} · written ${written}`
  if (diagnostics === null) return `cache diagnostics: no divergence from the previous request (${tokens})`
  const reason = cacheMissReasonOf(message)
  if (reason === null || reason === undefined) return `cache diagnostics: comparison pending (${tokens})`
  const missed = typeof reason.cache_missed_input_tokens === 'number' ? `, ~${reason.cache_missed_input_tokens} tokens after the divergence` : ''
  return `cache diagnostics: ${reason.type}${missed} (${tokens})`
}

export function noteCacheDiagnostics(message: unknown, usage: { cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined): void {
  const words = describeCacheDiagnostics(message, usage)
  if (words === null) return
  const reason = cacheMissReasonOf(message)
  logForDebugging(words, reason !== null && reason !== undefined && reason.type.endsWith('_changed') ? { level: 'warn' } : undefined)
}
