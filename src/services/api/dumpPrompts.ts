import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { ClientOptions } from '@anthropic-ai/sdk'

import { getSessionId } from '../../bootstrap/state.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'


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

export function addApiRequestToCache(data: CachedApiRequest): void {
  return
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

function appendDumpRecord(id: string, record: Record<string, unknown>): void {
  try {
    const path = getDumpPromptsPath(id)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${jsonStringify(record) ?? '{}'}\n`)
  } catch {
  }
}

function dumpRequestBody(id: string, body: string, timestamp: number): void {
  try {
    const parsed = jsonParse(body) as Record<string, unknown> | null
    if (parsed === null || typeof parsed !== 'object') return
    addApiRequestToCache({ ...parsed, _capturedAt: timestamp })
    return
    // eslint-disable-next-line no-unreachable
    appendDumpRecord(id, { type: 'init', timestamp })
  } catch {
  }
}

export function createDumpPromptsFetch(id: string): ClientOptions['fetch'] {
  return async (input, init) => {
    ensureDumpState(id)
    const method = init?.method?.toUpperCase()
    const body = init?.body
    if (method === 'POST' && typeof body === 'string') {
      const timestamp = Date.now()
      setImmediate(() => dumpRequestBody(id, body, timestamp))
    }
    return fetch(input as never, init as never)
  }
}
