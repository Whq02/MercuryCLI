import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { usagePollTtlMs } from '../usageFreshness.js'
import { openaiSourceIdentity, openaiSubscriptionRef, resolveOpenaiRequestAuth } from './openaiAccounts.js'
import { noteOpenaiSourceIdentity, openaiObservedUsage, openaiSubscriptionRevision, recordOpenaiUsageResponse } from './openaiLimitState.js'

let revision = -1
let nextReadAtMs = 0
let readerNote: string | undefined
let readerWait = false
let inFlight: Promise<void> | undefined

function syncIdentity(env: NodeJS.ProcessEnv = process.env): void {
  noteOpenaiSourceIdentity('chatgpt-subscription', openaiSourceIdentity('chatgpt-subscription', env))
  const current = openaiSubscriptionRevision()
  if (revision === current) return
  revision = current
  nextReadAtMs = 0
  readerNote = undefined
  readerWait = false
  inFlight = undefined
}

export function openaiSubscriptionUsage() {
  syncIdentity()
  return openaiObservedUsage()
}

export function openaiUsageReaderState(): { readerNote?: string; readerNoteCompact?: string; readerWait?: boolean } {
  syncIdentity()
  return readerNote === undefined ? {} : { readerNote, readerNoteCompact: readerNote, readerWait }
}

export function refreshOpenaiUsage(io?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  force?: boolean
  reason?: 'open' | 'operator' | 'sign-in'
}): Promise<void> {
  const env = io?.env ?? process.env
  const now = io?.now ?? Date.now
  syncIdentity(env)
  if (openaiSubscriptionRef() === undefined) return Promise.resolve()
  if (inFlight) return inFlight
  if (!io?.force && io?.reason !== 'operator' && now() < nextReadAtMs) return Promise.resolve()
  let generation = revision
  let work!: Promise<void>
  work = (async () => {
    await Promise.resolve()
    try {
      const auth = await resolveOpenaiRequestAuth({ env, sourceKind: 'chatgpt-subscription', ...(io?.fetchImpl ? { fetchImpl: io.fetchImpl } : {}) })
      if (openaiSubscriptionRevision() !== generation) return
      syncIdentity(env)
      generation = revision
      inFlight = work
      if (!auth) {
        readerNote = 'usage read unavailable — /logins openai reconnects'
        nextReadAtMs = now() + usagePollTtlMs()
        return
      }
      const identity = openaiSourceIdentity('chatgpt-subscription', env)
      const url = `${auth.baseUrl.replace(/\/codex\/?$/, '').replace(/\/$/, '')}/wham/usage`
      const response = await fetchWithProviderDeadline(io?.fetchImpl ?? getApiFetch(), 'openai', 10_000, url, {
        method: 'GET',
        redirect: 'error',
        headers: { ...auth.headers, accept: 'application/json', 'user-agent': getUserAgent() },
        ...(io?.fetchImpl ? {} : getProxyFetchOptions()),
      })
      if (generation !== openaiSubscriptionRevision() || identity !== openaiSourceIdentity('chatgpt-subscription', env)) return
      nextReadAtMs = now() + usagePollTtlMs()
      if (!response.ok) {
        const retry = response.headers.get('retry-after')
        const seconds = retry === null ? Number.NaN : Number(retry)
        const waitUntil = Number.isFinite(seconds) ? now() + Math.max(0, seconds) * 1000 : retry === null ? 0 : Date.parse(retry)
        if (Number.isFinite(waitUntil)) nextReadAtMs = Math.max(nextReadAtMs, waitUntil)
        readerWait = response.status === 429
        readerNote = `usage read ${readerWait ? 'waiting' : 'failed'} · HTTP ${response.status}`
        return
      }
      const body: unknown = await response.json()
      if (generation !== openaiSubscriptionRevision() || identity !== openaiSourceIdentity('chatgpt-subscription', env)) return
      if (!recordOpenaiUsageResponse(body, now())) {
        readerNote = 'usage read failed · invalid reply'
        readerWait = false
        return
      }
      readerNote = undefined
      readerWait = false
    } catch {
      if (generation !== openaiSubscriptionRevision()) return
      readerNote = 'usage read failed · endpoint unreachable'
      readerWait = false
      nextReadAtMs = now() + usagePollTtlMs()
    } finally {
      if (inFlight === work) inFlight = undefined
    }
  })()
  inFlight = work
  return work
}
