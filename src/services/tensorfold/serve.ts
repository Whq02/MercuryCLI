import { readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { freemem } from 'node:os'
import { join } from 'node:path'
import { getSessionId } from '../../bootstrap/state.js'
import { publishAtomicSync } from '../../substrate/fileStore.js'
import { getCwd } from '../../utils/cwd.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { gibWords } from '../localServer/localServerMemory.js'
import type { ServiceRecord, ServiceSpec } from '../projectServices/contracts.js'
import { readRecord, reconcileRecord, startService, stopService, waitForReady } from '../projectServices/serviceManager.js'
import type { TensorFoldModelRow, TensorFoldPullProgress, TensorFoldServeRequest, TensorFoldServed } from './contracts.js'
import { cachedTensorFoldMachineTruth, findTensorFoldEngine, type EngineIo } from './engine.js'
import { tensorFoldLadder, tensorFoldProjectedBytes, type TensorFoldMachineTruth } from './fit.js'
import { pullCommandLines, pullTensorFold as pullWithEngine, type PullIo } from './pull.js'
import { readTensorFoldRefusal, type TensorFoldRefusal } from './refusal.js'
import { PROMPT_CACHE_OPT_IN_FAMILIES, startingPointOf, tensorFoldShortName, type TensorFoldCheckpoint } from './starting.js'

export const TENSORFOLD_SERVICE = 'tensorfold'
export const TENSORFOLD_DEFAULT_PORT = 8080
export const TENSORFOLD_HOST = '127.0.0.1'
export const TENSORFOLD_DRAIN_SECONDS = 4
export const TENSORFOLD_START_WAIT_MS = 15 * 60_000
export const TENSORFOLD_MEMORY_TIGHT_GIB = 2

export type TensorFoldServedRecord = TensorFoldServed & { project: string; busy?: { port: number; answersAs?: string } }

export type TensorFoldPortPick = { port: number; busy?: { port: number; answersAs?: string } }

export type ServeIo = EngineIo & {
  binary?: string
  cwd?: string
  sessionId?: string
  startWaitMs?: number
  signal?: AbortSignal
  onLoading?: (seconds: number) => void
  onPort?: (pick: TensorFoldPortPick) => void
  freeMemoryBytes?: () => Promise<number>
  machine?: TensorFoldMachineTruth
  answersAs?: (port: number) => Promise<string | undefined>
  rememberPort?: (port: number) => void
  forgetPort?: (port: number) => void
  servedFile?: string
  serviceEnv?: Record<string, string>
  sleep?: (ms: number) => Promise<void>
  keyFile?: () => { path: string; key: string; line: string }
  announce?: (offer: { model: string; enginePort: number; window: number; key: string }) => { stop: () => void }
}

export const TENSORFOLD_SHARE_HOST = '0.0.0.0'
export const SHARE_NEEDS_KEY_FILE = 'sharing on your network needs the key file road'

let announcement: { name: string; stop: () => void } | null = null

export function tensorFoldAnnouncing(): string | null {
  return announcement?.name ?? null
}

function endAnnouncement(): void {
  try {
    announcement?.stop()
  } catch {
    void 0
  }
  announcement = null
}

export class TensorFoldStartError extends Error {
  constructor(message: string, public readonly refusal: TensorFoldRefusal | null, public readonly tight: { needBytes: number; freeBytes: number; offers: string[] } | null = null) {
    super(message)
  }
}

function servedFile(io: Pick<ServeIo, 'servedFile'> = {}): string {
  return io.servedFile ?? join(getMercuryHome(), 'tensorfold', 'served.json')
}

export function readServedRecord(io: Pick<ServeIo, 'servedFile'> = {}): TensorFoldServedRecord | null {
  try {
    const raw = JSON.parse(readFileSync(servedFile(io), 'utf8')) as TensorFoldServedRecord
    return typeof raw.repo === 'string' && typeof raw.port === 'number' && typeof raw.project === 'string' ? raw : null
  } catch {
    return null
  }
}

function writeServedRecord(record: TensorFoldServedRecord | null, io: Pick<ServeIo, 'servedFile'> = {}): void {
  publishAtomicSync(servedFile(io), JSON.stringify(record) + '\n', { mode: 0o600 })
}

export function servedTensorFold(io: Pick<ServeIo, 'servedFile'> = {}): readonly TensorFoldServed[] {
  const record = readServedRecord(io)
  if (record === null) return []
  const service = reconcileRecord(record.project, TENSORFOLD_SERVICE)
  if (service === null || !['starting', 'ready', 'running'].includes(service.state) || service.pid === null) return []
  return [{ ...record, pid: service.pid }]
}

export function servedTensorFoldRecord(io: Pick<ServeIo, 'servedFile'> = {}): (TensorFoldServedRecord & { service: ServiceRecord }) | null {
  const record = readServedRecord(io)
  if (record === null) return null
  const service = reconcileRecord(record.project, TENSORFOLD_SERVICE)
  if (service === null) return null
  return { ...record, service }
}

export function rememberedTensorFoldPort(io: Pick<ServeIo, 'servedFile'> = {}): number | undefined {
  return readServedRecord(io)?.port
}

export function serveArgs(point: Pick<TensorFoldCheckpoint, 'repo' | 'shortName' | 'drafter' | 'promptCacheGib'>, window: number, port: number, name = point.shortName, share?: { keyFile: string }): string[] {
  return [
    'serve',
    point.repo,
    ...(point.drafter !== undefined ? ['--drafter', point.drafter.repo] : []),
    '--name',
    name,
    '--context',
    String(window),
    ...(point.promptCacheGib !== undefined ? ['--prompt-cache-gib', String(point.promptCacheGib)] : []),
    ...(share !== undefined ? ['--host', TENSORFOLD_SHARE_HOST, '--api-key-file', share.keyFile] : []),
    '--port',
    String(port),
  ]
}

export function serveCommandLine(point: Pick<TensorFoldCheckpoint, 'repo' | 'shortName' | 'drafter' | 'promptCacheGib'>, window: number, port: number, name?: string): string {
  return ['tensorfold', ...serveArgs(point, window, port, name)].join(' ')
}

function checkpointOfRow(row: TensorFoldModelRow): Pick<TensorFoldCheckpoint, 'repo' | 'shortName' | 'drafter' | 'promptCacheGib'> {
  const point = startingPointOf(row.repo)
  if (point !== undefined) return point
  return {
    repo: row.repo,
    shortName: row.shortName,
    ...(row.drafter !== undefined ? { drafter: { repo: row.drafter, weightsBytes: 0, downloadBytes: 0 } } : {}),
    ...(row.promptCacheGib !== undefined ? { promptCacheGib: row.promptCacheGib } : PROMPT_CACHE_OPT_IN_FAMILIES.has(row.family) ? { promptCacheGib: 1 } : {}),
  }
}

export function tensorFoldWillRun(row: TensorFoldModelRow, window: number): string[] {
  const port = row.port ?? rememberedTensorFoldPort() ?? TENSORFOLD_DEFAULT_PORT
  const pulls = row.state === 'not-pulled' || row.state === 'pulling' ? pullCommandLines(row.repo) : []
  return [...pulls, serveCommandLine(checkpointOfRow(row), window, port)]
}

async function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, TENSORFOLD_HOST, () => probe.close(() => resolve(true)))
  })
}

export async function pickTensorFoldPort(preferred: number, io: Pick<ServeIo, 'answersAs'> = {}, free: (port: number) => Promise<boolean> = portFree): Promise<TensorFoldPortPick> {
  if (await free(preferred)) return { port: preferred }
  const answersAs = await io.answersAs?.(preferred)
  for (let port = preferred + 1; port < preferred + 50; port += 1) {
    if (await free(port)) return { port, busy: { port: preferred, ...(answersAs !== undefined ? { answersAs } : {}) } }
  }
  throw new TensorFoldStartError(`no free port from ${preferred} on`, null)
}

async function defaultFreeMemory(platform: NodeJS.Platform, run: (file: string, args: string[]) => Promise<string | undefined>): Promise<number> {
  if (platform !== 'darwin') return freemem()
  const text = (await run('/usr/bin/vm_stat', [])) ?? ''
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1])
  const counts = ['free', 'inactive', 'speculative'].map(name => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(text)?.[1]))
  if (!page || counts.some(value => !Number.isFinite(value))) return freemem()
  return counts.reduce((sum, value) => sum + value, 0) * page
}

export function memoryOffers(records: readonly { name: string }[], ollamaRunning: boolean): string[] {
  const offers: string[] = []
  if (ollamaRunning) offers.push('ollama stop frees its model')
  if (records.some(record => record.name === 'local-gguf')) offers.push("s on Mercury's own llama.cpp server stops it")
  return offers
}

export function tensorFoldServiceSpec(binary: string, point: Pick<TensorFoldCheckpoint, 'repo' | 'shortName' | 'drafter' | 'promptCacheGib'>, window: number, port: number, cwd: string, name?: string, extraEnv: Record<string, string> = {}, share?: { keyFile: string }): ServiceSpec {
  return {
    name: TENSORFOLD_SERVICE,
    command: binary,
    args: serveArgs(point, window, port, name, share),
    cwd,
    env: { ...extraEnv, TF_DRAIN_S: String(TENSORFOLD_DRAIN_SECONDS), TENSORFOLD_NO_UPDATE_CHECK: '1', TENSORFOLD_NO_LIVE: '1' },
    readiness: [{ kind: 'http', url: `http://${TENSORFOLD_HOST}:${port}/health` }],
    readinessMode: 'all',
    restart: 'never',
    lifecycle: 'project',
  }
}

function logTail(record: ServiceRecord | null, bytes = 65_536): string {
  if (record === null) return ''
  try {
    const size = statSync(record.logFile).size
    const start = Math.max(record.logStartByte ?? 0, size - bytes)
    return readFileSync(record.logFile, 'utf8').slice(start)
  } catch {
    return ''
  }
}

export function tensorFoldLogTail(io: Pick<ServeIo, 'servedFile'> = {}): string {
  const served = servedTensorFoldRecord(io)
  return served === null ? '' : logTail(served.service)
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export async function startTensorFold(request: TensorFoldServeRequest, io: ServeIo = {}): Promise<TensorFoldServed> {
  const binary = io.binary ?? (await findTensorFoldEngine(io))?.binary
  if (binary === undefined) throw new TensorFoldStartError('TensorFold is not installed', null)
  const point = startingPointOf(request.repo) ?? {
    repo: request.repo,
    shortName: request.name ?? tensorFoldShortName(request.repo),
    ...(request.drafter !== undefined ? { drafter: { repo: request.drafter, weightsBytes: 0, downloadBytes: 0 } } : {}),
    ...(request.promptCacheGib !== undefined ? { promptCacheGib: request.promptCacheGib } : {}),
  }
  const name = request.name ?? point.shortName
  const cwd = io.cwd ?? getCwd()
  const sessionId = io.sessionId ?? getSessionId()
  const sleep = io.sleep ?? defaultSleep
  const existing = servedTensorFoldRecord(io)
  if (existing !== null && ['starting', 'ready', 'running'].includes(existing.service.state)) {
    await stopTensorFold(existing.name, io)
  }
  const machine = io.machine ?? (await cachedTensorFoldMachineTruth(io))
  const full = startingPointOf(request.repo)
  if (full !== undefined) {
    const needBytes = tensorFoldProjectedBytes({ ...full, ...(request.promptCacheGib !== undefined ? { promptCacheGib: request.promptCacheGib } : {}) }, request.window)
    const freeBytes = io.freeMemoryBytes !== undefined ? await io.freeMemoryBytes() : await defaultFreeMemory(machine.platform, io.run ?? (async () => undefined))
    if (freeBytes + TENSORFOLD_MEMORY_TIGHT_GIB * 1024 ** 3 < needBytes && freeBytes > 0) {
      const ollama = await portFree(11434).then(free => !free)
      const offers = memoryOffers(readRecord(cwd, 'local-gguf') !== null ? [{ name: 'local-gguf' }] : [], ollama)
      throw new TensorFoldStartError(`${gibWords(needBytes)} needed · ${gibWords(freeBytes)} free`, null, { needBytes, freeBytes, offers })
    }
  }
  const pick = await pickTensorFoldPort(request.port ?? rememberedTensorFoldPort(io) ?? TENSORFOLD_DEFAULT_PORT, io)
  io.onPort?.(pick)
  if (request.share === true && io.keyFile === undefined) throw new TensorFoldStartError(SHARE_NEEDS_KEY_FILE, null)
  const key = request.share === true && io.keyFile !== undefined ? io.keyFile() : undefined
  const spec = tensorFoldServiceSpec(binary, point, request.window, pick.port, cwd, name, io.serviceEnv ?? {}, key !== undefined ? { keyFile: key.path } : undefined)
  const started = await startService({ spec, sessionId })
  if ('error' in started) throw new TensorFoldStartError(started.error, null)
  const record: TensorFoldServedRecord = {
    repo: request.repo,
    name,
    port: pick.port,
    window: request.window,
    pid: started.record.pid ?? 0,
    startedAt: new Date(started.record.startedAt ?? Date.now()).toISOString(),
    project: cwd,
    ...(key !== undefined ? { keyFile: key.path } : {}),
    ...(pick.busy !== undefined ? { busy: pick.busy } : {}),
    ...(point.drafter !== undefined ? { drafter: point.drafter.repo } : {}),
    ...(point.promptCacheGib !== undefined ? { promptCacheGib: point.promptCacheGib } : {}),
  }
  writeServedRecord(record, io)
  const begun = Date.now()
  const deadline = begun + (io.startWaitMs ?? TENSORFOLD_START_WAIT_MS)
  for (;;) {
    if (io.signal?.aborted) {
      await stopTensorFold(name, io)
      throw new TensorFoldStartError('the start was stopped', null)
    }
    const ready = await waitForReady(cwd, TENSORFOLD_SERVICE, 500)
    if (ready.ready) break
    const state = ready.record?.state
    if (ready.record === null || state === 'failed' || state === 'stopped') {
      const tail = logTail(ready.record)
      writeServedRecord(null, io)
      const exit = { code: ready.record?.lastExitCode ?? null, signal: ready.record?.lastExitCode === -1 ? 'SIGKILL' : null }
      const refusal = readTensorFoldRefusal(tail, { window: request.window, machine, ...(full !== undefined ? { needBytes: tensorFoldProjectedBytes(full, request.window), ladder: tensorFoldLadder(full, machine) } : {}), exit })
      throw new TensorFoldStartError(refusal.line, refusal)
    }
    io.onLoading?.(Math.round((Date.now() - begun) / 1000))
    if (Date.now() >= deadline) {
      await stopTensorFold(name, io)
      throw new TensorFoldStartError('the model did not finish loading', null)
    }
    await sleep(0)
  }
  io.rememberPort?.(pick.port)
  endAnnouncement()
  if (key !== undefined && io.announce !== undefined) {
    try {
      announcement = { name, stop: io.announce({ model: name, enginePort: pick.port, window: request.window, key: key.key }).stop }
    } catch {
      announcement = null
    }
  }
  return { ...record, pid: readRecord(cwd, TENSORFOLD_SERVICE)?.pid ?? record.pid }
}

export async function stopTensorFold(name: string, io: Pick<ServeIo, 'servedFile' | 'forgetPort'> = {}): Promise<void> {
  const record = readServedRecord(io)
  if (record === null) return
  if (record.name !== name && record.repo !== name) return
  endAnnouncement()
  const stopped = await stopService(record.project, TENSORFOLD_SERVICE)
  writeServedRecord(null, io)
  io.forgetPort?.(record.port)
  if ('error' in stopped) throw new Error(stopped.error)
  if (stopped.note !== undefined) throw new Error(stopped.note)
}

export async function pullTensorFold(repo: string, onProgress: (progress: TensorFoldPullProgress) => void, io: PullIo = {}): Promise<void> {
  return pullWithEngine(repo, onProgress, io)
}

export function tensorFoldExit(io: Pick<ServeIo, 'servedFile'> = {}): { line: string; refusal: TensorFoldRefusal } | null {
  const served = servedTensorFoldRecord(io)
  if (served === null || !['failed', 'stopped'].includes(served.service.state) || served.service.explicitStop) return null
  const exit = { code: served.service.lastExitCode, signal: served.service.lastExitCode === -1 ? 'SIGKILL' : null }
  const refusal = readTensorFoldRefusal(logTail(served.service), { window: served.window, exit })
  return { line: refusal.line, refusal }
}
