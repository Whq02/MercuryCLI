import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { ClientOptions } from '@anthropic-ai/sdk'

import { getSessionId } from '../../bootstrap/state.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'

/**
 * Debug capture of outgoing request bodies for issue reporting.
 *
 * CURRENT STATE: both write paths are hard-disabled by unconditional early
 * returns — the request cache is always empty, no dump file is ever written,
 * and the fetch wrapper is a transparent pass-through. The surrounding
 * structure exists only so the exported names keep their contracts.
 */

type CachedApiRequest = Record<string, unknown>

type DumpState = {
  initialized: boolean
  messagesSeen: number
  lastInitHash: string | null
  lastInitFingerprint: string | null
}

const MAX_CACHED_REQUESTS = 5

const requestCache: CachedApiRequest[] = []
const dumpStates = new Map<string, DumpState>()

/** A copy of the cached requests (always empty while the cache is disabled). */
export function getLastApiRequests(): CachedApiRequest[] {
  return [...requestCache]
}

export function clearApiRequestCache(): void {
  requestCache.length = 0
}

export function clearDumpState(id: string): void {
  dumpStates.delete(id)
}

export function clearAllDumpState(): void {
  dumpStates.clear()
}

/** HARD-DISABLED: returns before pushing. */
export function addApiRequestToCache(data: CachedApiRequest): void {
  return
  // Intended semantics, were this re-enabled: newest appended, oldest
  // evicted past MAX_CACHED_REQUESTS.
  // eslint-disable-next-line no-unreachable
  requestCache.push(data)
  if (requestCache.length > MAX_CACHED_REQUESTS) requestCache.shift()
}

export function getDumpPromptsPath(id?: string): string {
  return join(getMercuryHome(), 'dump-prompts', `${id ?? getSessionId()}.jsonl`)
}

function ensureDumpState(id: string): DumpState {
  let state = dumpStates.get(id)
  if (state === undefined) {
    state = { initialized: false, messagesSeen: 0, lastInitHash: null, lastInitFingerprint: null }
    dumpStates.set(id, state)
  }
  return state
}

/** Swallows all errors; creates the directory recursively. */
function appendDumpRecord(id: string, record: Record<string, unknown>): void {
  try {
    const path = getDumpPromptsPath(id)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${jsonStringify(record) ?? '{}'}\n`)
  } catch {
    // Never let dumping break anything.
  }
}

/**
 * HARD-DISABLED: returns immediately after parsing the body and calling the
 * (disabled) cache append. Were the writes re-enabled: an `init` record once
 * per session (everything except messages), a `system_update` when the init
 * hash changes (gated by a cheap fingerprint of model, tool-name list, and
 * total system text length), and one `message` record per NEW user message
 * with the seen-count advanced.
 */
function dumpRequestBody(id: string, body: string, timestamp: number): void {
  try {
    const parsed = jsonParse(body) as Record<string, unknown> | null
    if (parsed === null || typeof parsed !== 'object') return
    addApiRequestToCache({ ...parsed, _capturedAt: timestamp })
    return
    // eslint-disable-next-line no-unreachable
    appendDumpRecord(id, { type: 'init', timestamp })
  } catch {
    // Parse errors are swallowed.
  }
}

/** A fetch wrapper for the given agent-or-session id. */
export function createDumpPromptsFetch(id: string): ClientOptions['fetch'] {
  return async (input, init) => {
    ensureDumpState(id)
    const method = init?.method?.toUpperCase()
    const body = init?.body
    if (method === 'POST' && typeof body === 'string') {
      // Parsing and re-serialising a request (system prompt plus tool
      // schemas run to megabytes) must never block the real call.
      const timestamp = Date.now()
      setImmediate(() => dumpRequestBody(id, body, timestamp))
    }
    return fetch(input as never, init as never)
  }
}
