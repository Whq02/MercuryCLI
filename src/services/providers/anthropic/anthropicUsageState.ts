import axios from 'axios'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isClaudeAISubscriber } from '../../../utils/auth.js'
import { logForDebugging } from '../../../utils/debug.js'
import { getMercuryHome } from '../../../utils/envUtils.js'
import { fetchUtilization, usageEndpointBase } from '../../api/usage.js'
import { noteUsageRecordChanged } from '../../claudeAiLimits.js'
import { formatUsageAge, usagePollTtlMs } from '../usageFreshness.js'

export type AnthropicUsageReadFailure = {
  kind: 'http' | 'timeout' | 'network' | 'token'
  status?: number
  host: string
  detail: string
  atMs: number
}

export interface AnthropicUsageReadStatus {
  lastAttemptAtMs?: number
  lastOkAtMs?: number
  failure?: AnthropicUsageReadFailure
  consecutiveFailures: number
  retryAtMs?: number
  inFlight: boolean
  requests: number
}

const READ_TIMEOUT_S = 5
const FAILURE_BACKOFF_CADENCES = 4
const TURN_ASK_FLOOR_MS = 2_000
const POLL_JITTER_MS = 500

let lastAttemptAtMs: number | undefined
let lastOkAtMs: number | undefined
let failure: AnthropicUsageReadFailure | undefined
let consecutiveFailures = 0
let retryAtMs: number | undefined
let requests = 0
let inFlight: Promise<AnthropicUsageReadStatus> | null = null
let generation = 0

export function anthropicUsageReadStatus(): AnthropicUsageReadStatus {
  return {
    ...(lastAttemptAtMs !== undefined ? { lastAttemptAtMs } : {}),
    ...(lastOkAtMs !== undefined ? { lastOkAtMs } : {}),
    ...(failure !== undefined ? { failure: { ...failure } } : {}),
    consecutiveFailures,
    ...(retryAtMs !== undefined ? { retryAtMs } : {}),
    inFlight: inFlight !== null,
    requests,
  }
}

function endpointHost(): string {
  const base = usageEndpointBase()
  try {
    return new URL(base).host
  } catch {
    return base
  }
}

function classify(error: unknown, host: string, atMs: number): AnthropicUsageReadFailure {
  if (axios.isAxiosError(error)) {
    if (error.response !== undefined) {
      return { kind: 'http', status: error.response.status, host, detail: `HTTP ${error.response.status}`, atMs }
    }
    if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message)) {
      return { kind: 'timeout', host, detail: `no answer within ${READ_TIMEOUT_S} s`, atMs }
    }
    return { kind: 'network', host, detail: error.code ?? error.message, atMs }
  }
  return { kind: 'network', host, detail: error instanceof Error ? error.message : String(error), atMs }
}

function sameEpisode(a: AnthropicUsageReadFailure | undefined, b: AnthropicUsageReadFailure): boolean {
  return a !== undefined && a.kind === b.kind && a.status === b.status && a.host === b.host
}

function failedWords(f: AnthropicUsageReadFailure): string {
  switch (f.kind) {
    case 'http':
      return `usage endpoint answered ${f.detail} (${f.host})`
    case 'timeout':
      return `usage endpoint did not answer within ${READ_TIMEOUT_S} s (${f.host})`
    case 'network':
      return `usage endpoint unreachable — ${f.detail} (${f.host})`
    case 'token':
      return 'usage endpoint not asked — the sign-in token is expired (the next reply refreshes it)'
  }
}

function failedWordsCompact(f: AnthropicUsageReadFailure): string {
  switch (f.kind) {
    case 'http':
      return `read failed · ${f.detail}`
    case 'timeout':
      return 'read failed · timeout'
    case 'network':
      return 'read failed · no route'
    case 'token':
      return 'read failed · expired'
  }
}

function retryWords(now: number): string {
  const wait = retryAtMs !== undefined ? retryAtMs - now : 0
  return wait <= 0 ? 'retry due' : `retry in ${formatUsageAge(wait)}`
}

export function anthropicUsageReaderNote(now: number = Date.now(), style: 'prose' | 'compact' = 'prose'): string | undefined {
  if (failure === undefined) return undefined
  if (style === 'compact') return failedWordsCompact(failure)
  return `${failedWords(failure)} · ${retryWords(now)}`
}


const RECORD_FILE = 'usage-reader.json'

export interface UsageReaderEpisodeRecord {
  kind: AnthropicUsageReadFailure['kind']
  status?: number
  host: string
  detail: string
  failedAtMs: number
  recoveredAtMs?: number
}

interface UsageReaderRecordFile {
  version: 1
  families: Partial<Record<'anthropic', UsageReaderEpisodeRecord>>
}

export function usageReaderRecordPath(configHome: string = getMercuryHome()): string {
  return join(configHome, RECORD_FILE)
}

export function readUsageReaderRecord(configHome: string = getMercuryHome()): UsageReaderEpisodeRecord | undefined {
  try {
    const path = usageReaderRecordPath(configHome)
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<UsageReaderRecordFile>
    return parsed.families?.anthropic
  } catch {
    return undefined
  }
}

function writeUsageReaderRecord(record: UsageReaderEpisodeRecord): void {
  try {
    const home = getMercuryHome()
    mkdirSync(home, { recursive: true })
    const path = usageReaderRecordPath(home)
    const file: UsageReaderRecordFile = { version: 1, families: { anthropic: record } }
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(file, null, 2))
    renameSync(tmp, path)
  } catch (error) {
    logForDebugging(`[usage] the usage reader's record could not be written: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function usageReaderRecordWords(configHome?: string): string | undefined {
  const record = readUsageReaderRecord(configHome)
  if (record === undefined) return undefined
  const clock = (ms: number): string => {
    const d = new Date(ms)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const what = record.kind === 'token' ? 'sign-in token expired' : record.detail
  const tail = record.recoveredAtMs !== undefined ? `recovered ${clock(record.recoveredAtMs)}` : 'not yet recovered'
  return `last usage read failure: ${what} from ${record.host} at ${clock(record.failedAtMs)} · ${tail}`
}


let currentEpisode: UsageReaderEpisodeRecord | undefined

function noteFailure(next: AnthropicUsageReadFailure, now: number): void {
  const ttl = usagePollTtlMs()
  const fresh = !sameEpisode(failure, next)
  failure = next
  consecutiveFailures += 1
  retryAtMs = now + FAILURE_BACKOFF_CADENCES * ttl
  if (!fresh) return
  logForDebugging(
    `[usage] the first-party usage endpoint read failed: ${next.detail} from ${next.host} — retrying in ${formatUsageAge(FAILURE_BACKOFF_CADENCES * ttl)}, then every ${formatUsageAge(FAILURE_BACKOFF_CADENCES * ttl)} until it answers`,
  )
  currentEpisode = {
    kind: next.kind,
    ...(next.status !== undefined ? { status: next.status } : {}),
    host: next.host,
    detail: next.detail,
    failedAtMs: now,
  }
  writeUsageReaderRecord(currentEpisode)
}

function noteAnswer(now: number): void {
  lastOkAtMs = now
  if (failure !== undefined) {
    logForDebugging(`[usage] the first-party usage endpoint answers again (${failure.host}) after ${consecutiveFailures} failed read(s)`)
    if (currentEpisode !== undefined) {
      currentEpisode = { ...currentEpisode, recoveredAtMs: now }
      writeUsageReaderRecord(currentEpisode)
    }
  }
  failure = undefined
  consecutiveFailures = 0
  retryAtMs = undefined
}

export function forgetAnthropicUsageRead(): void {
  generation += 1
  lastAttemptAtMs = undefined
  lastOkAtMs = undefined
  failure = undefined
  consecutiveFailures = 0
  retryAtMs = undefined
  inFlight = null
  currentEpisode = undefined
  noteUsageRecordChanged()
}

export function refreshAnthropicUsage(opts?: { reason?: 'poll' | 'turn' | 'operator' | 'sign-in'; now?: () => number }): Promise<AnthropicUsageReadStatus> {
  const reason = opts?.reason ?? 'poll'
  const now = opts?.now ?? Date.now
  if (reason === 'sign-in') forgetAnthropicUsageRead()
  if (inFlight !== null) return inFlight
  let subscriber = false
  try {
    subscriber = isClaudeAISubscriber()
  } catch {
    subscriber = false
  }
  if (!subscriber) return Promise.resolve(anthropicUsageReadStatus())
  const at = now()
  if (reason !== 'operator' && reason !== 'sign-in') {
    if (retryAtMs !== undefined && at < retryAtMs) return Promise.resolve(anthropicUsageReadStatus())
    const ttl = usagePollTtlMs()
    const turnFloor = Math.min(TURN_ASK_FLOOR_MS, ttl / 2)
    const floor = reason === 'turn' ? turnFloor : Math.max(turnFloor, ttl - POLL_JITTER_MS)
    if (lastAttemptAtMs !== undefined && at - lastAttemptAtMs < floor) return Promise.resolve(anthropicUsageReadStatus())
  }
  const issued = generation
  const ask = (async (): Promise<AnthropicUsageReadStatus> => {
    lastAttemptAtMs = at
    requests += 1
    const host = endpointHost()
    try {
      const answer = await fetchUtilization()
      if (issued !== generation) return anthropicUsageReadStatus()
      if (answer === null) noteFailure({ kind: 'token', host, detail: 'sign-in token expired', atMs: now() }, now())
      else noteAnswer(now())
    } catch (error) {
      if (issued === generation) noteFailure(classify(error, host, now()), now())
    } finally {
      if (issued === generation) inFlight = null
      noteUsageRecordChanged()
    }
    return anthropicUsageReadStatus()
  })()
  inFlight = ask
  return ask
}

export function _resetAnthropicUsageReaderForTesting(): void {
  generation += 1
  lastAttemptAtMs = undefined
  lastOkAtMs = undefined
  failure = undefined
  consecutiveFailures = 0
  retryAtMs = undefined
  requests = 0
  inFlight = null
  currentEpisode = undefined
}
