import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getMercuryHome } from '../../utils/envUtils.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import type { TensorFoldPullProgress } from './contracts.js'
import { findTensorFoldEngine } from './engine.js'
import { cacheDirOfRepo, configFactsOf, hfCacheRoot, type ConfigFacts, type InventoryIo } from './inventory.js'
import { isGgufRepo, isRepoId, startingPointOf, tensorFoldLabel, tensorFoldShortName, type TensorFoldCheckpoint } from './starting.js'

export type PullIo = InventoryIo & {
  binary?: string
  signal?: AbortSignal
  pollMs?: number
  spawnImpl?: typeof spawn
  logDir?: string
  totalBytes?: number
}

const rec = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)

export function cacheBytesOf(root: string, repo: string, io: Pick<InventoryIo, 'listDir' | 'sizeOf'> = {}): number {
  const blobs = join(root, cacheDirOfRepo(repo), 'blobs')
  const listDir = io.listDir ?? ((path: string): string[] => { try { return readdirSync(path) } catch { return [] } })
  const sizeOf = io.sizeOf ?? ((path: string): number | undefined => { try { return statSync(path).size } catch { return undefined } })
  let total = 0
  for (const name of listDir(blobs)) total += sizeOf(join(blobs, name)) ?? 0
  return total
}

export function pullSpec(repo: string): string {
  const point = startingPointOf(repo)
  return point?.pin !== undefined ? `${point.repo}@${point.pin}` : repo
}

export function pullCommandLines(repo: string): string[] {
  const point = startingPointOf(repo)
  return [`tensorfold pull ${pullSpec(repo)}`, ...(point?.drafter !== undefined ? [`tensorfold pull ${point.drafter.repo}`] : [])]
}

export class TensorFoldPullError extends Error {
  constructor(message: string, public readonly repo: string, public readonly stopped: boolean) {
    super(message)
  }
}

const pulls = new Map<string, ChildProcess>()

export function pullingTensorFold(): string[] {
  return [...pulls.keys()]
}

export function stopTensorFoldPull(repo: string): boolean {
  const child = pulls.get(repo)
  if (child === undefined) return false
  child.kill('SIGTERM')
  return true
}

async function pullOne(binary: string, repo: string, totalBytes: number | undefined, onProgress: (progress: TensorFoldPullProgress) => void, io: PullIo): Promise<void> {
  const env = io.env ?? process.env
  const home = io.home ?? homedir()
  const root = io.cacheRoot ?? hfCacheRoot(env, home)
  const logDir = io.logDir ?? join(getMercuryHome(), 'tensorfold')
  mkdirSync(logDir, { recursive: true })
  const logFd = openSync(join(logDir, `pull-${cacheDirOfRepo(repo)}.log`), 'a')
  const launch = io.spawnImpl ?? spawn
  let child: ChildProcess
  try {
    child = launch(binary, ['pull', pullSpec(repo)], { env: { ...(io.env === undefined ? subprocessEnv() : io.env), ...(io.cacheRoot !== undefined ? { HF_HUB_CACHE: io.cacheRoot } : {}) }, stdio: ['ignore', logFd, logFd] })
  } finally {
    closeSync(logFd)
  }
  pulls.set(repo, child)
  const abort = (): void => {
    child.kill('SIGTERM')
  }
  io.signal?.addEventListener('abort', abort, { once: true })
  const report = (): void => onProgress({ repo, bytes: cacheBytesOf(root, repo, io), ...(totalBytes !== undefined ? { totalBytes } : {}) })
  report()
  const poll = setInterval(report, io.pollMs ?? 500)
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('error', () => resolve({ code: null, signal: null }))
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    report()
    if (exit.signal !== null || io.signal?.aborted) throw new TensorFoldPullError(`the download stopped · it resumes next time`, repo, true)
    if (exit.code !== 0) throw new TensorFoldPullError(`tensorfold pull ${pullSpec(repo)} exited ${exit.code ?? 'without a code'}`, repo, false)
  } finally {
    clearInterval(poll)
    io.signal?.removeEventListener('abort', abort)
    pulls.delete(repo)
  }
}

export async function pullTensorFold(repo: string, onProgress: (progress: TensorFoldPullProgress) => void, io: PullIo = {}): Promise<void> {
  const binary = io.binary ?? (await findTensorFoldEngine(io))?.binary
  if (binary === undefined) throw new TensorFoldPullError('TensorFold is not installed', repo, false)
  const point = startingPointOf(repo)
  await pullOne(binary, repo, io.totalBytes ?? point?.downloadBytes, onProgress, io)
  if (point?.drafter !== undefined) await pullOne(binary, point.drafter.repo, point.drafter.downloadBytes, onProgress, io)
}

export type HubRead = { checkpoint: TensorFoldCheckpoint; facts: ConfigFacts } | { refused: string }

export const GGUF_REFUSED = "GGUF is llama.cpp's format · /localsetup serves it"
export const NOT_A_REPO = 'not a repository id · owner/name'

export function hubEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return (env.HF_ENDPOINT ?? 'https://huggingface.co').replace(/\/+$/, '')
}

export async function readHubRepo(repo: string, io: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; families?: ReadonlySet<string>; signal?: AbortSignal } = {}): Promise<HubRead> {
  if (!isRepoId(repo)) return { refused: NOT_A_REPO }
  if (isGgufRepo(repo)) return { refused: GGUF_REFUSED }
  const fetchImpl = io.fetchImpl ?? fetch
  const base = hubEndpoint(io.env)
  const options = { signal: io.signal ?? AbortSignal.timeout(15_000) }
  let listing: Record<string, unknown> | undefined
  try {
    const response = await fetchImpl(`${base}/api/models/${repo}?blobs=true`, options)
    if (response.status === 401 || response.status === 403) return { refused: 'a gated repository · pull takes no token' }
    if (response.status === 404) return { refused: 'not on Hugging Face' }
    if (!response.ok) return { refused: `Hugging Face answered ${response.status}` }
    listing = rec(await response.json())
  } catch (error) {
    return { refused: `Hugging Face did not answer · ${error instanceof Error ? error.message : String(error)}` }
  }
  const siblings = Array.isArray(listing?.siblings) ? listing!.siblings.map(rec).filter((row): row is Record<string, unknown> => row !== undefined) : []
  const sizeOf = (row: Record<string, unknown>): number => (typeof row.size === 'number' ? row.size : typeof rec(row.lfs)?.size === 'number' ? (rec(row.lfs)!.size as number) : 0)
  const names = siblings.map(row => (typeof row.rfilename === 'string' ? row.rfilename : ''))
  if (names.some(name => /\.gguf$/i.test(name)) && !names.some(name => /\.safetensors$/i.test(name))) return { refused: GGUF_REFUSED }
  const weightsBytes = siblings.filter(row => /\.safetensors$/i.test(String(row.rfilename))).reduce((sum, row) => sum + sizeOf(row), 0)
  const downloadBytes = siblings.reduce((sum, row) => sum + sizeOf(row), 0)
  if (weightsBytes === 0) return { refused: 'no safetensors weights · MLX, NVFP4 or EXL3 checkpoints only' }
  let config: Record<string, unknown> | undefined
  try {
    const response = await fetchImpl(`${base}/${repo}/resolve/main/config.json`, options)
    if (response.ok) config = rec(await response.json())
  } catch {
    config = undefined
  }
  const facts = config === undefined ? {} : configFactsOf(config)
  if (facts.modelType === undefined) return { refused: 'no config.json names its family' }
  if (io.families !== undefined && io.families.size > 0 && !io.families.has(facts.modelType)) return { refused: `TensorFold has no engine for ${facts.modelType} checkpoints` }
  const checkpoint: TensorFoldCheckpoint = {
    repo,
    label: tensorFoldLabel(repo),
    shortName: tensorFoldShortName(repo),
    family: facts.modelType,
    weightsBytes,
    downloadBytes,
    kvBytesPerToken: facts.kvBytesPerToken ?? 0,
    trainedMax: facts.trainedMax ?? 32_768,
    ...(facts.modelType === 'qwen3_5' ? { promptCacheGib: 1 } : {}),
    qualified: false,
  }
  return { checkpoint, facts }
}

export type PullPace = { bytesPerSecond?: number; secondsLeft?: number }

export function pullPace(samples: readonly { at: number; bytes: number }[], totalBytes: number | undefined): PullPace {
  if (samples.length < 2) return {}
  const first = samples[0]!
  const last = samples[samples.length - 1]!
  const seconds = (last.at - first.at) / 1000
  if (seconds <= 0 || last.bytes <= first.bytes) return {}
  const bytesPerSecond = (last.bytes - first.bytes) / seconds
  const secondsLeft = totalBytes !== undefined && totalBytes > last.bytes ? (totalBytes - last.bytes) / bytesPerSecond : undefined
  return { bytesPerSecond, ...(secondsLeft !== undefined ? { secondsLeft } : {}) }
}

export function pullProgressWords(label: string, bytes: number, totalBytes: number | undefined, pace: PullPace): string {
  const gb = (value: number): string => `${(value / 1e9).toFixed(1)} GB`
  const parts = [`pulling ${label}`, totalBytes !== undefined ? `${gb(bytes)} of ${(totalBytes / 1e9).toFixed(0)} GB` : gb(bytes)]
  if (pace.bytesPerSecond !== undefined) parts.push(`${Math.round(pace.bytesPerSecond / 1e6)} MB/s`)
  if (pace.secondsLeft !== undefined) parts.push(pace.secondsLeft < 90 ? 'under 2 min' : `about ${Math.round(pace.secondsLeft / 60)} min`)
  return parts.join(' · ')
}

export function pullPercent(bytes: number, totalBytes: number | undefined): number | undefined {
  if (totalBytes === undefined || totalBytes <= 0) return undefined
  return Math.max(0, Math.min(99, Math.floor((bytes / totalBytes) * 100)))
}
