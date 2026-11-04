import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TensorFoldEngine, TensorFoldModelRow, TensorFoldServed } from './contracts.js'
import { cachedTensorFoldMachineTruth, type EngineIo, type TensorFoldEngineFound } from './engine.js'
import { chosenTensorFoldWindow, reachesAgentFloor, tensorFoldLadder, type TensorFoldMachineTruth } from './fit.js'
import { servedTensorFold } from './serve.js'
import { QWEN_2B, TENSORFOLD_STARTING_POINTS, startingPointOf, tensorFoldLabel, tensorFoldShortName, type TensorFoldCheckpoint } from './starting.js'

export type TensorFoldInventoryRow = TensorFoldModelRow & { label: string; checkpoint: TensorFoldCheckpoint; quantisation?: string }

export type HfSnapshot = {
  repo: string
  dir: string
  config: Record<string, unknown>
  weightsBytes: number
  incompleteBytes: number
}

export type InventoryIo = EngineIo & {
  cacheRoot?: string
  machine?: TensorFoldMachineTruth
  served?: readonly TensorFoldServed[]
  listDir?: (path: string) => string[]
  readText?: (path: string) => string | undefined
  sizeOf?: (path: string) => number | undefined
}

export function hfCacheRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE
  if (env.HF_HOME) return join(env.HF_HOME, 'hub')
  return join(home, '.cache', 'huggingface', 'hub')
}

export const HF_CACHE_WORDS = '~/.cache/huggingface/hub'

export function hfCacheWords(root: string, home: string = homedir()): string {
  return root.startsWith(home) ? `~${root.slice(home.length)}` : root
}

function defaultListDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function defaultReadText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function defaultSizeOf(path: string): number | undefined {
  try {
    return statSync(path).size
  } catch {
    return undefined
  }
}

const rec = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)

export function repoOfCacheDir(name: string): string | undefined {
  if (!name.startsWith('models--')) return undefined
  const rest = name.slice('models--'.length)
  const cut = rest.indexOf('--')
  if (cut <= 0) return undefined
  return `${rest.slice(0, cut)}/${rest.slice(cut + 2)}`
}

export function cacheDirOfRepo(repo: string): string {
  return `models--${repo.replace('/', '--')}`
}

export function readHfSnapshot(root: string, repo: string, io: Pick<InventoryIo, 'listDir' | 'readText' | 'sizeOf'> = {}): HfSnapshot | undefined {
  const listDir = io.listDir ?? defaultListDir
  const readText = io.readText ?? defaultReadText
  const sizeOf = io.sizeOf ?? defaultSizeOf
  const base = join(root, cacheDirOfRepo(repo))
  const snapshots = join(base, 'snapshots')
  const main = readText(join(base, 'refs', 'main'))?.trim()
  const candidates = main !== undefined && main !== '' ? [main, ...listDir(snapshots).filter(name => name !== main)] : listDir(snapshots)
  let dir: string | undefined
  let config: Record<string, unknown> | undefined
  for (const sha of candidates) {
    const text = readText(join(snapshots, sha, 'config.json'))
    if (text === undefined) continue
    try {
      const parsed = rec(JSON.parse(text))
      if (parsed === undefined) continue
      dir = join(snapshots, sha)
      config = parsed
      break
    } catch {
      continue
    }
  }
  const blobs = join(base, 'blobs')
  let incompleteBytes = 0
  for (const name of listDir(blobs)) if (name.endsWith('.incomplete')) incompleteBytes += sizeOf(join(blobs, name)) ?? 0
  if (dir === undefined || config === undefined) return undefined
  let weightsBytes = 0
  for (const name of listDir(dir)) if (name.endsWith('.safetensors')) weightsBytes += sizeOf(join(dir, name)) ?? 0
  return { repo, dir, config, weightsBytes, incompleteBytes }
}

export function listHfRepos(root: string, io: Pick<InventoryIo, 'listDir'> = {}): string[] {
  const listDir = io.listDir ?? defaultListDir
  return listDir(root)
    .map(repoOfCacheDir)
    .filter((repo): repo is string => repo !== undefined)
    .sort()
}

export type ConfigFacts = { modelType?: string; trainedMax?: number; kvBytesPerToken?: number; quantisation?: string }

export function configFactsOf(config: Record<string, unknown>): ConfigFacts {
  const text = rec(config.text_config) ?? config
  const modelType = typeof config.model_type === 'string' ? config.model_type : typeof text.model_type === 'string' ? text.model_type : undefined
  const trainedMax = num(text.max_position_embeddings) ?? num(config.max_position_embeddings)
  const layers = num(text.num_hidden_layers) ?? num(config.num_hidden_layers)
  const heads = num(text.num_attention_heads) ?? num(config.num_attention_heads)
  const kvHeads = num(text.num_key_value_heads) ?? num(config.num_key_value_heads) ?? heads
  const hidden = num(text.hidden_size) ?? num(config.hidden_size)
  const headDim = num(text.head_dim) ?? num(config.head_dim) ?? (heads !== undefined && hidden !== undefined ? hidden / heads : undefined)
  let attentionLayers = layers
  const pattern = typeof text.hybrid_override_pattern === 'string' ? text.hybrid_override_pattern : typeof config.hybrid_override_pattern === 'string' ? config.hybrid_override_pattern : undefined
  const layerTypes = Array.isArray(text.layer_types) ? text.layer_types : Array.isArray(config.layer_types) ? config.layer_types : undefined
  const interval = num(text.full_attention_interval) ?? num(config.full_attention_interval)
  if (pattern !== undefined) attentionLayers = pattern.split('').filter(ch => ch === '*').length
  else if (layerTypes !== undefined) attentionLayers = layerTypes.filter(kind => kind === 'full_attention' || kind === 'attention').length
  else if (interval !== undefined && layers !== undefined) attentionLayers = Math.floor(layers / interval)
  const kvBytesPerToken = attentionLayers !== undefined && kvHeads !== undefined && headDim !== undefined ? attentionLayers * kvHeads * headDim * 2 * 2 : undefined
  const quant = rec(config.quantization) ?? rec(config.quantization_config)
  const bits = num(quant?.bits)
  const group = num(quant?.group_size)
  return {
    ...(modelType !== undefined ? { modelType } : {}),
    ...(trainedMax !== undefined ? { trainedMax } : {}),
    ...(kvBytesPerToken !== undefined ? { kvBytesPerToken } : {}),
    ...(bits !== undefined ? { quantisation: `${bits}-bit${group !== undefined ? `, group ${group}` : ''}` } : {}),
  }
}

function checkpointOfSnapshot(snapshot: HfSnapshot, facts: ConfigFacts): TensorFoldCheckpoint {
  return {
    repo: snapshot.repo,
    label: tensorFoldLabel(snapshot.repo),
    shortName: tensorFoldShortName(snapshot.repo),
    family: facts.modelType ?? 'unknown',
    weightsBytes: snapshot.weightsBytes,
    downloadBytes: snapshot.weightsBytes,
    kvBytesPerToken: facts.kvBytesPerToken ?? 0,
    trainedMax: facts.trainedMax ?? 32_768,
    qualified: false,
  }
}

export function rowOfCheckpoint(point: TensorFoldCheckpoint, machine: TensorFoldMachineTruth, disk: { onDisk: boolean; bytesOnDisk: number; drafterOnDisk: boolean }, served?: TensorFoldServed): TensorFoldInventoryRow {
  const ladder = tensorFoldLadder(point, machine)
  const window = served?.window ?? chosenTensorFoldWindow(ladder)
  const fit = ladder.find(rung => rung.window === window)?.fit ?? ladder[0]!.fit
  const whole = disk.onDisk && (point.drafter === undefined || disk.drafterOnDisk)
  const missing = (disk.onDisk ? 0 : point.downloadBytes) + (point.drafter !== undefined && !disk.drafterOnDisk ? point.drafter.downloadBytes : 0)
  return {
    repo: point.repo,
    shortName: point.shortName,
    label: point.label,
    family: point.family,
    state: served !== undefined ? 'serving' : whole ? 'on-disk' : 'not-pulled',
    fit,
    window,
    qualified: point.qualified,
    ...(point.drafter !== undefined ? { drafter: point.drafter.repo } : {}),
    ...(point.promptCacheGib !== undefined ? { promptCacheGib: point.promptCacheGib } : {}),
    ...(served !== undefined ? { port: served.port, startedBy: 'mercury' as const } : {}),
    bytesOnDisk: disk.bytesOnDisk,
    ...(whole ? {} : { downloadBytes: missing }),
    ladder,
    checkpoint: point,
  }
}

export function rankTensorFoldRows(rows: readonly TensorFoldInventoryRow[]): TensorFoldInventoryRow[] {
  const rank = (row: TensorFoldInventoryRow): number => {
    const at = TENSORFOLD_STARTING_POINTS.findIndex(point => point.repo === row.repo)
    return at < 0 ? TENSORFOLD_STARTING_POINTS.length : at
  }
  const serving = rows.filter(row => row.state === 'serving' || row.state === 'loading')
  const rest = rows.filter(row => !serving.includes(row)).sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
  const best = bestTensorFoldFit(rest)
  return [...serving, ...(best === null ? rest : [best as TensorFoldInventoryRow, ...rest.filter(row => row !== best)])]
}

export async function readTensorFoldInventory(engine: TensorFoldEngine | null, io: InventoryIo = {}): Promise<TensorFoldInventoryRow[]> {
  const env = io.env ?? process.env
  const home = io.home ?? homedir()
  const root = io.cacheRoot ?? hfCacheRoot(env, home)
  const machine = io.machine ?? (await cachedTensorFoldMachineTruth(io))
  const served = io.served ?? servedTensorFold()
  const servedOf = (repo: string): TensorFoldServed | undefined => served.find(row => row.repo.toLowerCase() === repo.toLowerCase())
  const known = new Set((engine as TensorFoldEngineFound | null)?.families.map(family => family.id) ?? [])
  const snapshots = new Map<string, HfSnapshot | undefined>()
  const snapshotOf = (repo: string): HfSnapshot | undefined => {
    if (!snapshots.has(repo)) snapshots.set(repo, existsSync(join(root, cacheDirOfRepo(repo))) || io.listDir !== undefined ? readHfSnapshot(root, repo, io) : undefined)
    return snapshots.get(repo)
  }
  const rows: TensorFoldInventoryRow[] = []
  for (const point of TENSORFOLD_STARTING_POINTS) {
    const snapshot = snapshotOf(point.repo)
    const drafter = point.drafter === undefined ? undefined : snapshotOf(point.drafter.repo)
    rows.push(
      rowOfCheckpoint(
        point,
        machine,
        { onDisk: snapshot !== undefined && snapshot.weightsBytes > 0, bytesOnDisk: (snapshot?.weightsBytes ?? 0) + (snapshot?.incompleteBytes ?? 0), drafterOnDisk: drafter !== undefined && drafter.weightsBytes > 0 },
        servedOf(point.repo),
      ),
    )
  }
  const pinned = new Set([...TENSORFOLD_STARTING_POINTS.map(point => point.repo.toLowerCase()), ...TENSORFOLD_STARTING_POINTS.flatMap(point => (point.drafter ? [point.drafter.repo.toLowerCase()] : []))])
  for (const repo of listHfRepos(root, io)) {
    if (pinned.has(repo.toLowerCase())) continue
    const snapshot = snapshotOf(repo)
    if (snapshot === undefined || snapshot.weightsBytes === 0) continue
    const facts = configFactsOf(snapshot.config)
    if (facts.modelType === undefined || (known.size > 0 && !known.has(facts.modelType))) continue
    const point = checkpointOfSnapshot(snapshot, facts)
    rows.push({ ...rowOfCheckpoint(point, machine, { onDisk: true, bytesOnDisk: snapshot.weightsBytes, drafterOnDisk: true }, servedOf(repo)), ...(facts.quantisation !== undefined ? { quantisation: facts.quantisation } : {}) })
  }
  return rankTensorFoldRows(rows)
}

export function bestTensorFoldFit(rows: readonly TensorFoldModelRow[]): TensorFoldModelRow | null {
  for (const point of TENSORFOLD_STARTING_POINTS) {
    const row = rows.find(candidate => candidate.repo === point.repo)
    if (row === undefined) continue
    if (row.ladder !== undefined ? reachesAgentFloor(row.ladder) : row.fit.verdict === 'fits') return row
  }
  return rows.find(row => row.repo === QWEN_2B.repo) ?? rows.find(row => startingPointOf(row.repo) !== undefined) ?? rows[0] ?? null
}
