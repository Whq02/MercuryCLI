import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { hostMachineName } from '../../commands/llmhost/words.js'
import { publishAtomicSync } from '../../substrate/fileStore.js'
import { forgetTensorFoldHost, rememberTensorFoldHost } from '../providers/local/tensorfoldHosts.js'
import { TENSORFOLD_NOT_BUILT, type TensorFoldHost } from '../tensorfold/contracts.js'
import { listBoxes, writeBox, type HostBox } from './boxes.js'
import { hostPodBills, hostSpendSoFar } from './costs.js'
import { stopHostSetup } from './jobs.js'
import type { HostRecipe } from './recipes.js'
import { closeHostTunnel, type HostRunner, type SshTarget } from './ssh.js'
import { hostDirectory, hostRecords, patchHostRecord, readHostRecord, type HostRecord } from './store.js'
import { TENSORFOLD_CARDS, TENSORFOLD_HOST_PORT, TENSORFOLD_HOST_VERSION, tensorFoldCardFor, tensorFoldClassWords, tensorFoldKeyPath, tensorFoldKeyWriteCommand, tensorFoldReadyCommand, tensorFoldServedName, tensorFoldStartingPoint, tensorFoldTitle, tensorFoldWindowWords, type TensorFoldCard } from './tensorfoldRelease.js'
import { vendorClient, vendorLabel } from './vendors/client.js'
import type { HostVendor } from './vendors/vendor.js'

export const isTensorFoldRecipe = (recipe: Pick<HostRecipe, 'engine'> | undefined): boolean => recipe?.engine === 'tensorfold'
export const tensorFoldPodHostName = (id: string): string => ('pod-' + id.toLowerCase().replaceAll('_', '-')).slice(0, 28)
export const isTensorFoldPodBox = (box: Pick<HostBox, 'name' | 'engines'>): boolean => box.name.startsWith('pod-') && box.engines.some(engine => engine.kind === 'tensorfold')

export const TENSORFOLD_HOST_WORDS = {
  rentRow: 'rent a GPU pod — Runpod, through /llmhost',
  through: '/llmhost rents it, installs TensorFold, pulls, serves, then this session switches · s stops the pod and its billing',
  billingStarts: 'billing starts when it boots',
  stopped: (machine: string, spend: number): string => machine + ' stopped · compute billing ended · ~$' + spend.toFixed(2) + ' so far · the disk bills until you terminate it in /llmhost',
  alreadyStopped: (machine: string): string => machine + ' is already stopped · the disk bills until you terminate it in /llmhost',
  stopFailed: (machine: string, detail: string): string => machine + ' · ' + detail + ' · compute may still bill · /llmhost → Machines I’m paying for → Stop again or Terminate',
  noStop: (vendor: string): string => vendor + ' has no Stop · Terminate it in /llmhost → Machines I’m paying for',
  gone: 'this pod is no longer recorded · /llmhost → Machines I’m paying for lists what still bills',
  gated: 'TensorFold pulls public checkpoints only · a gated or private model is not served on a pod yet',
  refused: (gpu: string, evidence: string): string => gpu + ' is not offered · ' + evidence,
  serves: (title: string, window: number): string => title + ' at ' + tensorFoldWindowWords(window) + ' with TensorFold ' + TENSORFOLD_HOST_VERSION + ' for CUDA',
} as const

const keysDirectory = (): string => {
  const dir = join(hostDirectory(), 'tensorfold')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
const keyFile = (id: string): string => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid host record id')
  return join(keysDirectory(), id + '.key')
}
export function tensorFoldPodKey(id: string): string {
  const path = keyFile(id)
  if (existsSync(path)) { chmodSync(path, 0o600); return readFileSync(path, 'utf8').trim() }
  const key = randomBytes(24).toString('base64url')
  publishAtomicSync(path, key + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
  return key
}
export function forgetTensorFoldPodKey(id: string): void {
  try { unlinkSync(keyFile(id)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
export const tensorFoldPodDir = (recipe: Pick<HostRecipe, 'id'>): string => '/workspace/mercury-host/' + recipe.id
export const tensorFoldPodAnsweringCommand = (recipe: Pick<HostRecipe, 'id'>): string => tensorFoldReadyCommand(tensorFoldPodDir(recipe))
export const tensorFoldPodService = (key: string): { port: number; path: string; headers: Record<string, string> } => ({ port: TENSORFOLD_HOST_PORT, path: '/v1/models', headers: { Authorization: 'Bearer ' + key } })
export async function writeTensorFoldPodKey(target: SshTarget, recipe: Pick<HostRecipe, 'id'>, key: string, runner: HostRunner, signal: AbortSignal, sshArguments: (target: SshTarget) => string[]): Promise<void> {
  await runner.run('ssh', [...sshArguments(target), tensorFoldKeyWriteCommand(tensorFoldPodDir(recipe), key)], signal)
}
export const tensorFoldPodKeyPath = (recipe: Pick<HostRecipe, 'id'>): string => tensorFoldKeyPath(tensorFoldPodDir(recipe))

export interface TensorFoldPodRegistration { id: string; vendor?: HostRecord['vendor']; recipe: HostRecipe; baseUrl: string; key: string; served: string; window?: number; gpu?: { name: string; memoryGb: number }; target?: SshTarget; memoryGb?: number; arch?: string }
export async function registerTensorFoldPod(registration: TensorFoldPodRegistration, remember: (host: TensorFoldHost & { key?: string }) => Promise<void> = rememberTensorFoldHost, write: (box: HostBox) => void = writeBox): Promise<{ hostName: string; host: TensorFoldHost; box?: HostBox; remembered: boolean }> {
  const card = tensorFoldCardFor(registration.gpu?.name ?? registration.recipe.gpu) ?? TENSORFOLD_CARDS.find(row => row.gpu === registration.recipe.gpu)
  const hostName = tensorFoldPodHostName(registration.id)
  const host: TensorFoldHost & { key?: string } = {
    name: hostName, baseUrl: registration.baseUrl.replace(/\/v1\/?$/, ''), origin: 'pod', key: registration.key, keyRef: hostName,
    serving: registration.served, version: TENSORFOLD_HOST_VERSION, chip: card?.gpu ?? registration.recipe.gpu,
    ...(registration.window ?? registration.recipe.context ? { window: registration.window ?? registration.recipe.context } : {}),
  }
  let remembered = true
  try { await remember(host) } catch (error) { if (!String(error).includes(TENSORFOLD_NOT_BUILT)) throw error; remembered = false }
  let box: HostBox | undefined
  if (registration.target) {
    const memory = registration.gpu?.memoryGb ?? card?.vramGb ?? registration.recipe.vramGb
    box = {
      name: hostName, kind: 'ssh', target: registration.target, os: 'linux', arch: registration.arch ?? 'x86_64', home: '/root',
      memoryGb: registration.memoryGb ?? memory, unifiedMemory: false,
      gpus: [{ name: registration.gpu?.name ?? 'NVIDIA ' + (card?.gpu ?? registration.recipe.gpu), memory }],
      engines: [{ kind: 'tensorfold', path: tensorFoldPodDir(registration.recipe) + '/tensorfold-' + TENSORFOLD_HOST_VERSION + '-linux-' + (registration.arch === 'aarch64' ? 'aarch64' : 'x86_64') + '/bin/tensorfold-native', version: TENSORFOLD_HOST_VERSION, port: TENSORFOLD_HOST_PORT }],
      bankPaths: [], discoveredAt: new Date().toISOString(),
    }
    write(box)
  }
  return { hostName, host, box, remembered }
}
export async function unregisterTensorFoldPod(id: string, forget: (name: string) => Promise<void> = forgetTensorFoldHost): Promise<void> {
  const hostName = tensorFoldPodHostName(id)
  try { await forget(hostName) } catch (error) { if (!String(error).includes(TENSORFOLD_NOT_BUILT)) throw error }
  const box = join(hostDirectory(), 'boxes', hostName + '.json')
  try { unlinkSync(box) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  forgetTensorFoldPodKey(id)
}

export type TensorFoldPodState = 'starting' | 'serving' | 'stopped' | 'paused' | 'failed'
export interface TensorFoldPodFacts { id: string; hostName: string; vendor: NonNullable<HostRecord['vendor']>; machine: string; gpu: string; title: string; served: string; window: number | undefined; price: number; elapsedMs: number; spendUSD: number; state: TensorFoldPodState; step?: string; provider?: string; baseUrl?: string; bills: boolean }
const podState = (record: HostRecord): TensorFoldPodState => record.status === 'EXITED' ? 'stopped' : record.jobState === 'paused' ? 'paused' : record.jobState === 'failed' || record.status === 'TERMINATED' ? 'failed' : record.jobState === 'ready' ? 'serving' : 'starting'
export function tensorFoldPodFacts(record: HostRecord, recipe: HostRecipe | undefined, now = Date.now()): TensorFoldPodFacts | undefined {
  const row = recipe ?? record.recipeRow
  if (!row || !isTensorFoldRecipe(row) || record.jobKind === 'watch' || record.jobKind === 'bank') return
  const point = tensorFoldStartingPoint(row)
  const vendor = record.vendor ?? 'runpod'
  const elapsedMs = Math.max(0, now - Date.parse(record.startedAt)) || 0
  return {
    id: record.id, hostName: tensorFoldPodHostName(record.id), vendor, machine: hostMachineName(vendor, record.id), gpu: row.gpu,
    title: point?.title ?? row.label.split(' · ')[0]!, served: tensorFoldServedName(row) ?? point?.name ?? row.model, window: row.context,
    price: record.price, elapsedMs, spendUSD: hostSpendSoFar([{ status: record.status, cost: record.price, createdAt: record.startedAt }], now),
    state: podState(record), step: record.step, provider: record.provider, ...(record.localPort ? { baseUrl: 'http://127.0.0.1:' + record.localPort } : {}), bills: hostPodBills(record),
  }
}
export function tensorFoldPods(recipes: readonly HostRecipe[], now = Date.now()): TensorFoldPodFacts[] {
  return hostRecords().flatMap(record => { const facts = tensorFoldPodFacts(record, recipes.find(row => row.id === record.recipe), now); return facts ? [facts] : [] })
}
export interface TensorFoldPodRowFacts { hostName: string; id: string; provider?: string; words: string; bills: boolean }
export function tensorFoldPodRowFacts(pod: TensorFoldPodFacts): TensorFoldPodRowFacts {
  const minutes = Math.floor(pod.elapsedMs / 60_000)
  const elapsed = minutes >= 60 ? Math.floor(minutes / 60) + ' h ' + String(minutes % 60).padStart(2, '0') + ' min' : minutes + ' min'
  const words = pod.state === 'stopped' ? 'stopped · compute billing ended · ~$' + pod.spendUSD.toFixed(2) + ' so far · the disk bills until you terminate it in /llmhost' : '$' + pod.price.toFixed(2) + '/h on ' + vendorLabel(pod.vendor) + ' · ' + elapsed + ' · ~$' + pod.spendUSD.toFixed(2) + ' so far · s stops the pod and its billing'
  return { hostName: pod.hostName, id: pod.id, ...(pod.provider !== undefined ? { provider: pod.provider } : {}), words, bills: pod.bills }
}
export const tensorFoldPodRows = (recipes: readonly HostRecipe[], now = Date.now()): TensorFoldPodRowFacts[] => tensorFoldPods(recipes, now).map(tensorFoldPodRowFacts)
export const tensorFoldPodByHost = (hostName: string, recipes: readonly HostRecipe[], now = Date.now()): TensorFoldPodFacts | undefined => tensorFoldPods(recipes, now).find(pod => pod.hostName === hostName)

export interface TensorFoldRentRow { gpu: string; vramGb: number; vendor: string; title: string; window: number; price?: number; classWords: string }
export function tensorFoldRentRow(offers: readonly { recipe: HostRecipe; price: number }[], recipes: readonly HostRecipe[], vendor = 'Runpod'): TensorFoldRentRow | undefined {
  const inStock = offers.filter(offer => isTensorFoldRecipe(offer.recipe) && offer.recipe.verified.by !== 'unverified').sort((a, b) => a.price - b.price)[0]
  const recipe = inStock?.recipe ?? recipes.find(row => isTensorFoldRecipe(row) && row.verified.by !== 'unverified' && row.gpu === 'RTX 5090' && tensorFoldStartingPoint(row)?.name === 'qwen3.8-27b') ?? recipes.find(row => isTensorFoldRecipe(row) && row.verified.by !== 'unverified')
  if (!recipe) return
  const card = TENSORFOLD_CARDS.find(row => row.gpu === recipe.gpu)
  return { gpu: recipe.gpu, vramGb: recipe.vramGb, vendor, title: tensorFoldStartingPoint(recipe)?.title ?? recipe.label.split(' · ')[0]!, window: recipe.context ?? 0, ...(inStock ? { price: inStock.price } : {}), classWords: card ? tensorFoldClassWords(card) : 'supported' }
}
export function tensorFoldRentFacts(row: TensorFoldRentRow): { pod: string; serves: string; title: string } {
  return {
    pod: row.gpu + ' ' + row.vramGb + ' GB' + (row.price === undefined ? ' on ' + row.vendor + ' · the price shows in /llmhost' : ' · $' + row.price.toFixed(2) + '/h on ' + row.vendor) + ' · ' + TENSORFOLD_HOST_WORDS.billingStarts,
    serves: TENSORFOLD_HOST_WORDS.serves(row.title, row.window),
    title: tensorFoldTitle(row),
  }
}
export function tensorFoldRentCardLines(row: TensorFoldRentRow): string[] {
  const facts = tensorFoldRentFacts(row)
  return ['pod       ' + facts.pod, 'serves    ' + facts.serves, 'through   ' + TENSORFOLD_HOST_WORDS.through]
}
export const tensorFoldCardWords = (gpu: string): string | undefined => {
  const card = tensorFoldCardFor(gpu)
  if (!card) return
  return card.class === 'refused' ? TENSORFOLD_HOST_WORDS.refused(card.gpu, card.evidence) : card.gpu + ' · ' + tensorFoldClassWords(card) + ' · ' + card.evidence
}
export const tensorFoldCardsByClass = (kind: TensorFoldCard['class']): readonly TensorFoldCard[] => TENSORFOLD_CARDS.filter(card => card.class === kind)

export async function stopTensorFoldPod(id: string, options: { client?: HostVendor; signal?: AbortSignal; pauseMs?: number; timeoutMs?: number; forget?: (name: string) => Promise<void> } = {}): Promise<{ ok: boolean; words: string }> {
  const record = readHostRecord(id)
  if (!record) return { ok: false, words: TENSORFOLD_HOST_WORDS.gone }
  const vendor = record.vendor ?? 'runpod'
  const machine = hostMachineName(vendor, id)
  const signal = options.signal ?? new AbortController().signal
  let api: HostVendor
  try { api = options.client ?? vendorClient(record) } catch (error) { return { ok: false, words: TENSORFOLD_HOST_WORDS.stopFailed(machine, error instanceof Error ? error.message : String(error)) } }
  if (!api.capabilities.stop) return { ok: false, words: TENSORFOLD_HOST_WORDS.noStop(vendorLabel(vendor)) }
  if (record.status === 'EXITED') return { ok: true, words: TENSORFOLD_HOST_WORDS.alreadyStopped(machine) }
  const spend = hostSpendSoFar([{ status: record.status, cost: record.price, createdAt: record.startedAt }])
  try {
    await stopHostSetup(id)
    let pod = await api.stop(id)
    const deadline = Date.now() + (options.timeoutMs ?? 120_000)
    while (pod.status !== 'EXITED' && Date.now() < deadline) { await delay(options.pauseMs ?? 5000, undefined, { signal }); pod = await api.get(id, signal) }
    if (pod.status !== 'EXITED') throw new Error('Stop requested but the pod has not stopped yet')
  } catch (error) {
    return { ok: false, words: TENSORFOLD_HOST_WORDS.stopFailed(machine, error instanceof Error ? error.message : String(error)) }
  }
  closeHostTunnel(id)
  patchHostRecord(id, { status: 'EXITED', step: 'stopped · compute billing ended · the disk bills until Terminate' })
  const hostName = tensorFoldPodHostName(id)
  try { await (options.forget ?? forgetTensorFoldHost)(hostName) } catch (error) { if (!String(error).includes(TENSORFOLD_NOT_BUILT)) throw error }
  return { ok: true, words: TENSORFOLD_HOST_WORDS.stopped(machine, spend) }
}

export const tensorFoldPodBoxes = (): HostBox[] => listBoxes().filter(isTensorFoldPodBox)
