import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { durableAtomicPublishSync } from '../substrate/durablePublish.js'
import type { Entry } from '../types/logs.js'
import { getMercuryHome } from './envUtils.js'
import { lockSync } from './lockfile.js'
import { calculateUSDCost, modelPricingBasis, resolveModelPricing } from './modelCost.js'
import { MERCURY_VERSION } from '../constants/product.js'
import { servedModelOfAssistantRow } from './model/retainedModel.js'
import { scanTranscriptEntriesForward } from './sessionStorage/transcriptReader.js'

const HOUR_MS = 3_600_000
export const USAGE_HISTORY_MAX_ROWS = 32_768
export const USAGE_HISTORY_MAX_FILES = 4_096
export const USAGE_OBSERVATION_MAX_ROWS = 4_096
const MAX_CACHE_BYTES = 32 * 1024 * 1024
const REVISION = 1

export type UsageTotals = {
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUSD: number
  unpricedTurns: number
}
export type UsageHour = UsageTotals & { hour: string; model: string; project: string }
export type UsageObservation = {
  hour: string
  provider: string
  account: string
  window: string
  observedAtMs: number
  usedPct?: number
  resetsAtMs?: number
  source?: string
  state: string
}
type CachedFile = { signature: string; pricing: string; rows: UsageHour[]; skipped: number }

function pricingKey(rows: UsageHour[]): string {
  const models = [...new Set(rows.map(row => row.model))].sort()
  const rates = models.map(model => [model, resolveModelPricing(model)])
  return createHash('sha256').update(JSON.stringify([MERCURY_VERSION, REVISION, rates])).digest('hex')
}
type HistoryStore = { revision: number; files: Record<string, CachedFile>; observations: UsageObservation[] }
export type UsageHistoryReport = {
  totals: UsageTotals
  byDay: Array<UsageTotals & { key: string }>
  byModel: Array<UsageTotals & { key: string }>
  byProject: Array<UsageTotals & { key: string }>
  observations: UsageObservation[]
  filesRead: number
  filesCached: number
  skippedRecords: number
  warnings: string[]
}

const emptyStore = (): HistoryStore => ({ revision: REVISION, files: {}, observations: [] })
const emptyTotals = (): UsageTotals => ({ turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0, unpricedTurns: 0 })
const finite = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
const hourOf = (at: number): string => new Date(Math.floor(at / HOUR_MS) * HOUR_MS).toISOString()
const storePath = (): string => join(getMercuryHome(), 'usage-history.json')

function readStore(): HistoryStore {
  try {
    const path = storePath()
    if (lstatSync(path).size > MAX_CACHE_BYTES) return emptyStore()
    const stored = JSON.parse(readFileSync(path, 'utf8')) as HistoryStore
    if (stored.revision !== REVISION || !stored.files || typeof stored.files !== 'object' || !Array.isArray(stored.observations)) return emptyStore()
    const files: Record<string, CachedFile> = {}
    for (const [name, file] of Object.entries(stored.files)) {
      if (!file || typeof file.signature !== 'string' || typeof file.pricing !== 'string' || !Array.isArray(file.rows) || !Number.isSafeInteger(file.skipped) || file.skipped < 0) continue
      if (!file.rows.every(row => row && typeof row.hour === 'string' && Number.isFinite(Date.parse(row.hour)) && typeof row.model === 'string' && typeof row.project === 'string'
        && Object.keys(emptyTotals()).every(key => typeof row[key as keyof UsageTotals] === 'number' && Number.isFinite(row[key as keyof UsageTotals]) && row[key as keyof UsageTotals] >= 0))) continue
      files[name] = file
    }
    const observations = stored.observations.filter(row => row && typeof row.hour === 'string' && Number.isFinite(Date.parse(row.hour)) && typeof row.provider === 'string' && typeof row.account === 'string' && typeof row.window === 'string' && Number.isFinite(row.observedAtMs))
    return boundUsageHistory({ revision: REVISION, files, observations })
  } catch { return emptyStore() }
}

export function boundUsageHistory(store: HistoryStore): HistoryStore {
  const files: Record<string, CachedFile> = {}
  let rows = 0
  let count = 0
  const newest = Object.entries(store.files).sort((a, b) => (b[1].rows.at(-1)?.hour ?? '').localeCompare(a[1].rows.at(-1)?.hour ?? ''))
  for (const [path, file] of newest) {
    if (count >= USAGE_HISTORY_MAX_FILES || rows + file.rows.length > USAGE_HISTORY_MAX_ROWS) continue
    files[path] = file
    count++
    rows += file.rows.length
  }
  return { revision: REVISION, files, observations: store.observations.sort((a, b) => a.observedAtMs - b.observedAtMs).slice(-USAGE_OBSERVATION_MAX_ROWS) }
}

function publish(update: (current: HistoryStore) => HistoryStore): boolean {
  let release: (() => void) | undefined
  try {
    mkdirSync(getMercuryHome(), { recursive: true, mode: 0o700 })
    release = lockSync(storePath(), { realpath: false, stale: 10_000 })
    const next = boundUsageHistory(update(readStore()))
    const text = JSON.stringify(next)
    if (Buffer.byteLength(text) > MAX_CACHE_BYTES) return false
    durableAtomicPublishSync(storePath(), text, { mode: 0o600 })
    return true
  } catch { return false }
  finally { try { release?.() } catch {} }
}

export function recordUsageObservations(provider: string, account: string, windows: ReadonlyArray<{
  key: string; state: string; observedAtMs?: number; usedPct?: number; resetsAtMs?: number; source?: string
}>): boolean {
  const rows = windows.filter(window => window.observedAtMs !== undefined && Number.isFinite(window.observedAtMs)).map(window => ({
    hour: hourOf(window.observedAtMs!), provider,
    account: createHash('sha256').update(`${provider}:${account}`).digest('hex').slice(0, 16),
    window: window.key, state: window.state, observedAtMs: window.observedAtMs!,
    ...(window.usedPct === undefined ? {} : { usedPct: window.usedPct }),
    ...(window.resetsAtMs === undefined ? {} : { resetsAtMs: window.resetsAtMs }),
    ...(window.source === undefined ? {} : { source: window.source }),
  }))
  if (rows.length === 0) return true
  const key = (row: UsageObservation): string => JSON.stringify([row.hour, row.provider, row.account, row.window])
  return publish(store => {
    const all = new Map(store.observations.map(row => [key(row), row]))
    for (const row of rows) {
      const previous = all.get(key(row))
      if (!previous || previous.observedAtMs < row.observedAtMs) all.set(key(row), row)
    }
    return { ...store, observations: [...all.values()] }
  })
}

function add(target: UsageTotals, value: UsageTotals): void {
  for (const key of Object.keys(emptyTotals()) as Array<keyof UsageTotals>) target[key] += value[key]
}

function group(rows: UsageHour[], keyOf: (row: UsageHour) => string): Array<UsageTotals & { key: string }> {
  const groups = new Map<string, UsageTotals & { key: string }>()
  for (const row of rows) {
    const key = keyOf(row)
    const sum = groups.get(key) ?? { key, ...emptyTotals() }
    add(sum, row)
    groups.set(key, sum)
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))
}

function transcriptFiles(root: string, warnings: string[]): Array<{ path: string; session: string; project: string }> {
  const files: Array<{ path: string; session: string; project: string }> = []
  const dirs = (path: string) => {
    try { return readdirSync(path, { withFileTypes: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Could not list ${path}.`)
      return []
    }
  }
  for (const project of dirs(root).filter(entry => entry.isDirectory())) {
    const directory = join(root, project.name)
    for (const entry of dirs(directory)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl') || entry.name.startsWith('agent-')) continue
      const session = entry.name.slice(0, -6)
      files.push({ path: join(directory, entry.name), session, project: project.name })
      const walk = (path: string, depth: number): void => {
        for (const child of dirs(path)) {
          if (child.isFile() && /^agent-.+\.jsonl$/.test(child.name)) files.push({ path: join(path, child.name), session, project: project.name })
          else if (child.isDirectory() && depth < 4) walk(join(path, child.name), depth + 1)
        }
      }
      walk(join(directory, session, 'subagents'), 0)
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

type ResponseRow = { sequence: number; response: string; row: UsageHour }
function scanFile(file: { path: string; session: string; project: string }): CachedFile {
  const byUuid = new Map<string, ResponseRow>()
  let sequence = 0
  let skipped = 0
  const read = scanTranscriptEntriesForward(file.path, (entry: Entry) => {
    sequence++
    if (entry.type !== 'assistant') return
    if (entry.sessionId !== file.session) return
    const model = servedModelOfAssistantRow(entry)
    if (!model) return
    const raw = entry.message.usage as unknown as Record<string, unknown> | undefined
    if (!raw) return
    const usage = {
      input_tokens: finite(raw.input_tokens), output_tokens: finite(raw.output_tokens),
      cache_read_input_tokens: finite(raw.cache_read_input_tokens), cache_creation_input_tokens: finite(raw.cache_creation_input_tokens),
      cache_creation: { ephemeral_1h_input_tokens: finite((raw.cache_creation as Record<string, unknown> | undefined)?.ephemeral_1h_input_tokens) },
      server_tool_use: { web_search_requests: finite((raw.server_tool_use as Record<string, unknown> | undefined)?.web_search_requests) },
      request_started_at_ms: finite(raw.request_started_at_ms) || Date.parse(entry.timestamp),
    }
    const inputTokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
    if (inputTokens + usage.output_tokens + usage.server_tool_use.web_search_requests === 0) { byUuid.delete(entry.uuid); return }
    if (!Number.isFinite(usage.request_started_at_ms)) { skipped++; return }
    const unpriced = modelPricingBasis(model) === 'unpriced'
    const row: UsageHour = {
      hour: hourOf(usage.request_started_at_ms), model, project: entry.cwd || file.project,
      turns: 1, inputTokens, outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens, cacheWriteTokens: usage.cache_creation_input_tokens,
      costUSD: unpriced ? 0 : calculateUSDCost(model, usage), unpricedTurns: unpriced ? 1 : 0,
    }
    byUuid.set(entry.uuid, { sequence, response: entry.message.id || entry.uuid, row })
  })
  if (read.refusal) throw new Error(read.refusal)
  skipped += read.accounting.invalid + read.accounting.malformed
  const byResponse = new Map<string, ResponseRow>()
  for (const row of byUuid.values()) {
    const previous = byResponse.get(row.response)
    if (!previous || previous.sequence < row.sequence) byResponse.set(row.response, row)
  }
  const hourly = new Map<string, UsageHour>()
  for (const { row } of byResponse.values()) {
    const key = JSON.stringify([row.hour, row.model, row.project])
    const total = hourly.get(key) ?? { ...row, ...emptyTotals() }
    add(total, row)
    hourly.set(key, total)
  }
  const rows = [...hourly.values()].sort((a, b) => a.hour.localeCompare(b.hour))
  return { signature: '', pricing: pricingKey(rows), rows, skipped }
}

export function readUsageHistory(opts: { days?: number; project?: string; now?: number } = {}): UsageHistoryReport {
  const now = opts.now ?? Date.now()
  const since = opts.days === undefined ? -Infinity : Date.parse(new Date(now).toISOString().slice(0, 10)) - (opts.days - 1) * 24 * HOUR_MS
  const warnings: string[] = []
  const root = join(getMercuryHome(), 'projects')
  const cached = readStore()
  const files: Record<string, CachedFile> = {}
  const rows: UsageHour[] = []
  let filesRead = 0
  let filesCached = 0
  let skippedRecords = 0
  for (const file of transcriptFiles(root, warnings)) {
    const key = relative(root, file.path)
    try {
      const stat = lstatSync(file.path)
      const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
      const prior = cached.files[key]
      let data: CachedFile
      if (prior?.signature === signature && prior.pricing === pricingKey(prior.rows)) { data = prior; filesCached++ }
      else { data = scanFile(file); data.signature = signature; filesRead++ }
      files[key] = data
      skippedRecords += data.skipped
      rows.push(...data.rows.filter(row => Date.parse(row.hour) >= since && (!opts.project || row.project === opts.project)))
    } catch { warnings.push(`Could not read ${file.path}.`) }
  }
  if (!publish(current => ({ ...current, files }))) warnings.push('Usage cache could not be saved; totals were read from local files.')
  const totals = emptyTotals()
  for (const row of rows) add(totals, row)
  return { totals, byDay: group(rows, row => row.hour.slice(0, 10)), byModel: group(rows, row => row.model), byProject: group(rows, row => row.project),
    observations: cached.observations.filter(row => Date.parse(row.hour) >= since), filesRead, filesCached, skippedRecords, warnings }
}
