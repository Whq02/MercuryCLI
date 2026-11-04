import { createServer } from 'node:net'
import { totalmem } from 'node:os'
import { getGlobalConfig, saveGlobalConfig } from '../../../utils/config/globalConfig.js'
import { logForDebugging } from '../../../utils/debug.js'
import { getEngineModel } from '../../../utils/model/model.js'
import { bankedHostRecipes, bankFolder } from '../../host/bank.js'
import { gibWords } from '../../localServer/localServerMemory.js'
import { defaultMachineTruth } from '../../localServer/localServerTruth.js'
import type { HelperModelSize, HelperModelState } from '../../tensorfold/contracts.js'
import { LOCAL_MODEL_PREFIX, LOCAL_SERVER_NAMES, localRecordFor } from './localCatalogue.js'
import { cachedLocalModels, refreshLocalDiscovery, type LocalModelRecord } from './localDiscovery.js'
import { forgetTensorFoldPort, rememberTensorFoldPort } from './tensorfoldHosts.js'

export type HelperModelSetting = 'off' | HelperModelSize

export const HELPER_MODEL_SETTINGS: readonly HelperModelSetting[] = ['off', '2b', '4b', 'session']

export const HELPER_2B_REPO = 'mlx-community/Qwen3.5-2B-MLX-4bit'
export const HELPER_2B_NAME = 'qwen3.5-2b'
export const HELPER_2B_WINDOW = 32768
export const HELPER_2B_PROMPT_CACHE_GIB = 1
export const HELPER_4B_PATTERN = /qwen3[._-]?5[-_]4b/i
export const HELPER_SERVICE_NAME = 'mercury-helper'

const GIB = 1024 ** 3
const HELPER_2B_PROJECTED_BYTES = Math.round((1.6 + 0.4 + HELPER_2B_PROMPT_CACHE_GIB + 2) * GIB)
const HELPER_4B_PROJECTED_BYTES = Math.round((2.5 + 4.5 + 1) * GIB)

export const HELPER_JOB_WORDS = {
  titles: 'titles and summaries',
  judge: 'the judge',
  compaction: 'compaction',
  compactionReason: 'a small model can drop details',
}

export const HELPER_SINGLE_SLOT_REASON = 'its prompt cache holds one conversation · a helper request would evict this session\'s'
export const HELPER_NO_SESSION_LOCAL_REASON = 'the session is not on a local model'

const SINGLE_SLOT_FAMILIES: readonly RegExp[] = [/qwen3[._-]?8[-_]27b/i]

export interface HelperModelChoice {
  size: HelperModelSetting
  label: string
  engine?: 'tensorfold' | 'llamacpp'
  memory?: string
  fit?: 'fits' | 'does not fit'
  available: boolean
  reason?: string
  modelId?: string
}

interface HelperConfigShape {
  helperModel?: { size?: string; compaction?: boolean }
}

export function readHelperModelSetting(config: HelperConfigShape = getGlobalConfig() as HelperConfigShape): { size: HelperModelSetting; compaction: boolean } {
  const raw = config.helperModel
  const size = typeof raw?.size === 'string' && (HELPER_MODEL_SETTINGS as readonly string[]).includes(raw.size) ? (raw.size as HelperModelSetting) : 'off'
  return { size, compaction: raw?.compaction === true }
}

export function writeHelperModelSetting(next: { size?: HelperModelSetting; compaction?: boolean }, write: (updater: (config: ReturnType<typeof getGlobalConfig>) => ReturnType<typeof getGlobalConfig>) => void = saveGlobalConfig): void {
  write(config => {
    const current = readHelperModelSetting(config as HelperConfigShape)
    const merged = { size: next.size ?? current.size, compaction: next.compaction ?? current.compaction }
    return { ...config, helperModel: merged } as ReturnType<typeof getGlobalConfig>
  })
}

export function nextHelperModelSetting(current: HelperModelSetting, direction: 1 | -1, choices: readonly HelperModelChoice[] = helperModelChoices()): HelperModelSetting {
  const order = choices.map(choice => choice.size)
  const at = Math.max(0, order.indexOf(current))
  for (let step = 1; step <= order.length; step++) {
    const candidate = choices[(at + direction * step + order.length * order.length) % order.length]!
    if (candidate.available) return candidate.size
  }
  return current
}

function usableBytes(): number {
  return defaultMachineTruth(process.platform, totalmem()).usableMemoryBytes
}

function sessionLocalRecord(): LocalModelRecord | undefined {
  try {
    return localRecordFor(getEngineModel())
  } catch {
    return undefined
  }
}

export function singleSlotCache(record: Pick<LocalModelRecord, 'server' | 'id'>): boolean {
  return record.server === 'tensorfold' && SINGLE_SLOT_FAMILIES.some(family => family.test(record.id))
}

function banked4b(): { model: string; weightsGb: number } | undefined {
  try {
    const recipe = bankedHostRecipes(bankFolder()).find(row => HELPER_4B_PATTERN.test(row.model) && typeof row.weightFile === 'string')
    return recipe ? { model: recipe.model, weightsGb: recipe.weightsGb } : undefined
  } catch {
    return undefined
  }
}

export function helperModelChoices(reads: { usable?: number; session?: LocalModelRecord | null; banked4b?: boolean } = {}): HelperModelChoice[] {
  const usable = reads.usable ?? usableBytes()
  const session = reads.session === undefined ? sessionLocalRecord() : reads.session ?? undefined
  const has4b = reads.banked4b ?? banked4b() !== undefined
  const fit = (bytes: number): 'fits' | 'does not fit' => (bytes <= usable ? 'fits' : 'does not fit')
  const twoB: HelperModelChoice = { size: '2b', label: '2B (TensorFold)', engine: 'tensorfold', memory: `~${gibWords(HELPER_2B_PROJECTED_BYTES)} · an estimate`, fit: fit(HELPER_2B_PROJECTED_BYTES), available: fit(HELPER_2B_PROJECTED_BYTES) === 'fits', modelId: `${LOCAL_MODEL_PREFIX}${HELPER_2B_NAME}` }
  const fourB: HelperModelChoice = {
    size: '4b',
    label: '4B (llama.cpp)',
    engine: 'llamacpp',
    memory: `~${gibWords(HELPER_4B_PROJECTED_BYTES)} · an estimate`,
    fit: fit(HELPER_4B_PROJECTED_BYTES),
    available: has4b && fit(HELPER_4B_PROJECTED_BYTES) === 'fits',
    ...(has4b ? {} : { reason: 'pull it first · /localsetup' }),
  }
  const sessionChoice: HelperModelChoice = session === undefined
    ? { size: 'session', label: 'the session\'s local model', available: false, reason: HELPER_NO_SESSION_LOCAL_REASON }
    : singleSlotCache(session)
      ? { size: 'session', label: `${session.id} (${LOCAL_SERVER_NAMES[session.server]})`, engine: session.server === 'tensorfold' ? 'tensorfold' : 'llamacpp', available: false, reason: HELPER_SINGLE_SLOT_REASON }
      : { size: 'session', label: `${session.id} (${LOCAL_SERVER_NAMES[session.server]})`, ...(session.server === 'tensorfold' || session.server === 'llamacpp' ? { engine: session.server } : {}), ...(session.servedBytes !== undefined ? { memory: `${gibWords(session.servedBytes)} in use` } : {}), available: true, modelId: `${LOCAL_MODEL_PREFIX}${session.id}` }
  return [{ size: 'off', label: 'off', available: true }, twoB, fourB, sessionChoice]
}

export function helperChoiceWords(choice: HelperModelChoice): string {
  const parts = [choice.label]
  if (choice.memory !== undefined) parts.push(choice.memory)
  if (choice.fit !== undefined && choice.fit !== 'fits') parts.push(choice.fit)
  if (choice.reason !== undefined) parts.push(choice.reason)
  return parts.join(' · ')
}

export function helperJobsWords(compaction: boolean): string {
  return `${HELPER_JOB_WORDS.titles} ✓ · ${HELPER_JOB_WORDS.judge} ✓ · ${HELPER_JOB_WORDS.compaction} ${compaction ? '✓' : `✗ · ${HELPER_JOB_WORDS.compactionReason}`}`
}

let helperProcess: { size: HelperModelSize; port: number; modelId: string; stop?: () => Promise<void> } | undefined
let helperStarting: Promise<void> | undefined
let helperFailure: string | undefined

function helperServing(size: HelperModelSize): LocalModelRecord | undefined {
  if (size === 'session') return sessionLocalRecord()
  const records = cachedLocalModels()
  const own = helperProcess?.size === size ? records.find(record => record.baseUrl === `http://127.0.0.1:${helperProcess!.port}/v1`) : undefined
  if (own !== undefined) return own
  const sessionBase = sessionLocalRecord()?.baseUrl
  return size === '2b'
    ? records.find(record => record.server === 'tensorfold' && record.id === HELPER_2B_NAME && record.baseUrl !== sessionBase)
    : records.find(record => record.server === 'llamacpp' && HELPER_4B_PATTERN.test(record.id) && record.baseUrl !== sessionBase)
}

export function readHelperModelState(): HelperModelState {
  const setting = readHelperModelSetting()
  if (setting.size === 'off') return { enabled: false }
  const serving = helperServing(setting.size)
  const choice = helperModelChoices().find(row => row.size === setting.size)
  const engine = choice?.engine ?? (setting.size === '4b' ? 'llamacpp' : 'tensorfold')
  const port = serving !== undefined ? Number(new URL(serving.baseUrl).port) : helperProcess?.port
  return {
    enabled: choice?.available === true,
    size: setting.size,
    engine,
    ...(setting.size === '2b' ? { repo: HELPER_2B_REPO } : setting.size === '4b' && banked4b() !== undefined ? { repo: banked4b()!.model } : {}),
    ...(port !== undefined && Number.isFinite(port) ? { port } : {}),
  }
}

export function helperModelId(): string | undefined {
  const setting = readHelperModelSetting()
  if (setting.size === 'off') return undefined
  const choice = helperModelChoices().find(row => row.size === setting.size)
  if (choice?.available !== true) return undefined
  const serving = helperServing(setting.size)
  if (serving === undefined) {
    void ensureHelperServing().catch(() => undefined)
    return undefined
  }
  const twins = cachedLocalModels().filter(record => record.id.toLowerCase() === serving.id.toLowerCase()).length
  return twins > 1 ? `${LOCAL_MODEL_PREFIX}${serving.server}/${serving.id}` : `${LOCAL_MODEL_PREFIX}${serving.id}`
}

export function helperCompactionModelId(): string | undefined {
  return readHelperModelSetting().compaction ? helperModelId() : undefined
}

export function helperHeadingWords(): string | undefined {
  const setting = readHelperModelSetting()
  if (setting.size === 'off') return undefined
  const choice = helperModelChoices().find(row => row.size === setting.size)
  if (choice?.available !== true) return undefined
  return `· helper ${setting.size === 'session' ? choice.label.replace(/\s*\(.*\)$/, '') : setting.size.toUpperCase()}`
}

export function helperFailureWords(): string | undefined {
  return helperFailure
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

async function start2b(): Promise<void> {
  const { startTensorFold } = await import('../../tensorfold/serve.js')
  const port = await freePort()
  const served = await startTensorFold({ repo: HELPER_2B_REPO, window: HELPER_2B_WINDOW, name: HELPER_2B_NAME, port, promptCacheGib: HELPER_2B_PROMPT_CACHE_GIB })
  rememberTensorFoldPort(served.port)
  helperProcess = { size: '2b', port: served.port, modelId: `${LOCAL_MODEL_PREFIX}${served.name}` }
}

async function start4b(): Promise<void> {
  const folder = bankFolder()
  const recipe = folder === undefined ? undefined : bankedHostRecipes(folder).find(row => HELPER_4B_PATTERN.test(row.model) && typeof row.weightFile === 'string')
  if (folder === undefined || recipe === undefined) throw new Error('pull the 4B first · /localsetup')
  const { bankGgufModel } = await import('../../localSetup/ggufModels.js')
  const { ggufServerPlan, startGgufServer } = await import('../../localSetup/ggufServer.js')
  const model = await bankGgufModel(recipe, folder, totalmem(), process.platform)
  const port = await freePort()
  const spec = { ...(await ggufServerPlan(model, folder, { port })), name: HELPER_SERVICE_NAME }
  const started = await startGgufServer(model, spec, { port })
  helperProcess = { size: '4b', port, modelId: `${LOCAL_MODEL_PREFIX}${model.recipe.model.split('/').pop() ?? model.recipe.model}`, stop: started.stop }
}

export async function ensureHelperServing(): Promise<void> {
  const setting = readHelperModelSetting()
  if (setting.size === 'off' || setting.size === 'session') return
  if (helperServing(setting.size) !== undefined) return
  if (helperStarting !== undefined) return helperStarting
  helperStarting = (async () => {
    try {
      if (setting.size === '2b') await start2b()
      else await start4b()
      helperFailure = undefined
      await refreshLocalDiscovery({ force: true })
    } catch (error) {
      helperFailure = error instanceof Error ? error.message : String(error)
      logForDebugging(`helper model: ${helperFailure}`)
    } finally {
      helperStarting = undefined
    }
  })()
  return helperStarting
}

export async function stopHelperServing(): Promise<void> {
  const running = helperProcess
  helperProcess = undefined
  if (running === undefined) return
  if (running.stop !== undefined) await running.stop().catch(() => undefined)
  else {
    const { stopTensorFold } = await import('../../tensorfold/serve.js')
    await stopTensorFold(HELPER_2B_NAME).catch(() => undefined)
  }
  forgetTensorFoldPort(running.port)
}

export function __resetHelperForTest(): void {
  helperProcess = undefined
  helperStarting = undefined
  helperFailure = undefined
}
