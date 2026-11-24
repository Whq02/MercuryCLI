import { pollUntil } from '../../platform/async/deadline.js'
import { hostMachineName } from '../../commands/llmhost/words.js'
import { forgetTensorFoldHost, rememberTensorFoldHost } from '../roads/local/tensorfoldHosts.js'
import { TENSORFOLD_NOT_BUILT, type TensorFoldHost } from '../tensorfold/contracts.js'
import { writeBox, type HostBox } from './boxes.js'
import { hostPodBills, hostSpendSoFar } from './costs.js'
import { stopHostSetup } from './jobs.js'
import type { HostRecipe } from './recipes.js'
import { closeHostTunnel, type HostRunner, type SshTarget } from './ssh.js'
import { hostRecords, patchHostRecord, readHostRecord, removeHostRecord, type HostRecord } from './store.js'
import { terminateHostResource } from './cluster.js'
import { TENSORFOLD_CARDS, TENSORFOLD_HOST_PORT, TENSORFOLD_HOST_VERSION, tensorFoldCardFor, tensorFoldClassWords, tensorFoldKeyWriteCommand, tensorFoldReadyCommand, tensorFoldServedName, tensorFoldStartingPoint, tensorFoldTitle, tensorFoldWindowWords } from './tensorfoldRelease.js'
import { vendorClient, vendorLabel } from './vendors/client.js'
import type { HostPod, HostVendor } from './vendors/vendor.js'
import { HostVendorHttpError } from './vendors/http.js'
import { RunpodHttpError } from './runpod.js'
import { tensorFoldPodHostName, unregisterTensorFoldPod } from './tensorfoldPodKey.js'
import { passedOver } from '../../platform/errors/passedOver.js'
export { forgetTensorFoldPodKey, tensorFoldPodHostName, tensorFoldPodKey, unregisterTensorFoldPod } from './tensorfoldPodKey.js'

export const isTensorFoldRecipe = (recipe: Pick<HostRecipe, 'engine'> | undefined): boolean => recipe?.engine === 'tensorfold'
export const isTensorFoldPodBox = (box: Pick<HostBox, 'name' | 'engines'>): boolean => box.name.startsWith('pod-') && box.engines.some(engine => engine.kind === 'tensorfold')

export const TENSORFOLD_HOST_WORDS = {
  rentRow: 'rent a GPU pod — Runpod or Vast.ai, through /llmhost',
  billingStarts: 'billing starts when it boots',
  stopped: (machine: string, spend: number): string => machine + ' stopped · compute billing ended · ~$' + spend.toFixed(2) + ' so far · the disk bills until you terminate it · t terminates',
  alreadyStopped: (machine: string): string => machine + ' is already stopped · the disk bills until you terminate it · t terminates',
  stopFailed: (machine: string, detail: string): string => machine + ' · ' + detail + ' · compute may still bill · /llmhost → Machines I’m paying for → Stop again or Terminate',
  stopping: (machine: string, vendor: string): string => machine + ' · stop requested · the row reads stopping until ' + vendor + ' confirms, then compute billing ends · the disk bills until you terminate it · t terminates',
  noStop: (vendor: string): string => vendor + ' has no Stop · t terminates it',
  terminated: (machine: string, spend: number): string => machine + ' terminated · the pod and its disk are gone · ~$' + spend.toFixed(2) + ' in all',
  terminateFailed: (machine: string, detail: string): string => machine + ' · ' + detail + ' · it may still bill · /llmhost → Machines I’m paying for → Terminate',
  gone: 'this pod is no longer recorded · /llmhost → Machines I’m paying for lists what still bills',
  gated: 'Mercury sends no token to a TensorFold pod · a gated or private model is not served on a pod yet',
  serves: (title: string, window: number): string => title + ' at ' + tensorFoldWindowWords(window) + ' with TensorFold ' + TENSORFOLD_HOST_VERSION + ' for CUDA',
} as const

export const tensorFoldPodDir = (recipe: Pick<HostRecipe, 'id'>): string => '/workspace/mercury-host/' + recipe.id
export const tensorFoldPodAnsweringCommand = (recipe: Pick<HostRecipe, 'id'>): string => tensorFoldReadyCommand(tensorFoldPodDir(recipe))
export const tensorFoldPodService = (key: string): { port: number; path: string; headers: Record<string, string> } => ({ port: TENSORFOLD_HOST_PORT, path: '/v1/models', headers: { Authorization: 'Bearer ' + key } })
export async function writeTensorFoldPodKey(target: SshTarget, recipe: Pick<HostRecipe, 'id'>, key: string, runner: HostRunner, signal: AbortSignal, sshArguments: (target: SshTarget) => string[]): Promise<void> {
  await runner.run('ssh', [...sshArguments(target), tensorFoldKeyWriteCommand(tensorFoldPodDir(recipe), key)], signal)
}

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

export type TensorFoldPodState = 'starting' | 'serving' | 'stopping' | 'stopped' | 'paused' | 'failed'
export interface TensorFoldPodFacts { id: string; hostName: string; vendor: NonNullable<HostRecord['vendor']>; machine: string; gpu: string; title: string; served: string; window: number | undefined; price: number; elapsedMs: number; spendUSD: number; state: TensorFoldPodState; step?: string; provider?: string; baseUrl?: string; bills: boolean }
const podState = (record: HostRecord): TensorFoldPodState => record.status === 'EXITED' ? 'stopped' : record.stopRequestedAt !== undefined ? 'stopping' : record.jobState === 'paused' ? 'paused' : record.jobState === 'failed' || record.status === 'TERMINATED' ? 'failed' : record.jobState === 'ready' ? 'serving' : 'starting'
export function tensorFoldPodFacts(record: HostRecord, recipe: HostRecipe | undefined, now = Date.now()): TensorFoldPodFacts | undefined {
  const row = recipe ?? record.recipeRow
  if (!row || !isTensorFoldRecipe(row) || record.jobKind === 'watch' || record.jobKind === 'bank') return
  const point = tensorFoldStartingPoint(row)
  const vendor = record.vendor ?? 'runpod'
  const elapsedMs = Math.max(0, now - Date.parse(record.startedAt)) || 0
  return {
    id: record.id, hostName: tensorFoldPodHostName(record.id), vendor, machine: hostMachineName(vendor, record.id), gpu: row.gpu,
    title: point?.title ?? row.label.split(' · ')[0]!, served: tensorFoldServedName(row) ?? point?.name ?? row.model, window: row.context,
    price: record.price, elapsedMs, spendUSD: record.status === 'EXITED' || record.stopRequestedAt !== undefined ? record.spendUSD ?? 0 : hostSpendSoFar([{ status: record.status, cost: record.price, createdAt: record.startedAt }], now),
    state: podState(record), step: record.step, provider: record.provider, ...(record.localPort ? { baseUrl: 'http://127.0.0.1:' + record.localPort } : {}), bills: hostPodBills(record) && record.stopRequestedAt === undefined,
  }
}
export function tensorFoldPods(recipes: readonly HostRecipe[], now = Date.now()): TensorFoldPodFacts[] {
  return hostRecords().flatMap(record => { const facts = tensorFoldPodFacts(record, recipes.find(row => row.id === record.recipe), now); return facts ? [facts] : [] })
}
export interface TensorFoldPodRowFacts { hostName: string; id: string; provider?: string; words: string; bills: boolean; state: TensorFoldPodState; title: string; served: string; window?: number; gpu: string; vendor: string; step?: string }
export function tensorFoldPodRowFacts(pod: TensorFoldPodFacts): TensorFoldPodRowFacts {
  const minutes = Math.floor(pod.elapsedMs / 60_000)
  const elapsed = minutes >= 60 ? Math.floor(minutes / 60) + ' h ' + String(minutes % 60).padStart(2, '0') + ' min' : minutes + ' min'
  const words = pod.state === 'stopped' ? 'stopped · compute billing ended · ~$' + pod.spendUSD.toFixed(2) + ' so far · the disk bills until you terminate it · t terminates' : '$' + pod.price.toFixed(2) + '/h on ' + vendorLabel(pod.vendor) + ' · ' + elapsed + ' · ~$' + pod.spendUSD.toFixed(2) + ' so far · s stops the pod and its billing'
  return {
    hostName: pod.hostName, id: pod.id, ...(pod.provider !== undefined ? { provider: pod.provider } : {}), words, bills: pod.bills,
    state: pod.state, title: pod.title, served: pod.served, ...(pod.window !== undefined ? { window: pod.window } : {}), gpu: pod.gpu, vendor: vendorLabel(pod.vendor), ...(pod.step !== undefined ? { step: pod.step } : {}),
  }
}
export const tensorFoldPodRows = (recipes: readonly HostRecipe[], now = Date.now()): TensorFoldPodRowFacts[] => tensorFoldPods(recipes, now).map(tensorFoldPodRowFacts)

export interface TensorFoldRentRow { gpu: string; vramGb: number; vendor: string; title: string; window: number; price?: number; classWords: string }
export function tensorFoldRentRow(offers: readonly { recipe: HostRecipe; price: number }[], recipes: readonly HostRecipe[], vendor = 'Runpod or Vast.ai'): TensorFoldRentRow | undefined {
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
  let pod: HostPod
  try {
    await stopHostSetup(id)
    pod = await api.stop(id)
    if (pod.status !== 'EXITED') {
      let first = true
      pod = await pollUntil(
        async () => {
          if (first) { first = false; return undefined }
          pod = await api.get(id, signal)
          return pod.status === 'EXITED' ? pod : undefined
        },
        options.pauseMs ?? 2000,
        options.timeoutMs ?? 10_000,
        () => pod,
        { signal },
      )
    }
  } catch (error) {
    return { ok: false, words: TENSORFOLD_HOST_WORDS.stopFailed(machine, error instanceof Error ? error.message : String(error)) }
  }
  closeHostTunnel(id)
  const hostName = tensorFoldPodHostName(id)
  try { await (options.forget ?? forgetTensorFoldHost)(hostName) } catch (error) { if (!String(error).includes(TENSORFOLD_NOT_BUILT)) throw error }
  if (pod.status !== 'EXITED') {
    patchHostRecord(id, { stopRequestedAt: Date.now(), spendUSD: spend, step: 'stopping · requested, not yet confirmed by ' + vendorLabel(vendor) })
    return { ok: true, words: TENSORFOLD_HOST_WORDS.stopping(machine, vendorLabel(vendor)) }
  }
  patchHostRecord(id, { status: 'EXITED', spendUSD: spend, step: 'stopped · compute billing ended · the disk bills until Terminate' })
  return { ok: true, words: TENSORFOLD_HOST_WORDS.stopped(machine, spend) }
}

const vendorGone = (error: unknown): boolean => (error instanceof HostVendorHttpError || error instanceof RunpodHttpError) && error.status === 404

export async function terminateTensorFoldPod(id: string, options: { client?: HostVendor; signal?: AbortSignal } = {}): Promise<{ ok: boolean; words: string }> {
  const record = readHostRecord(id)
  if (!record) return { ok: false, words: TENSORFOLD_HOST_WORDS.gone }
  const vendor = record.vendor ?? 'runpod'
  const machine = hostMachineName(vendor, id)
  const spend = record.status === 'EXITED' ? record.spendUSD ?? 0 : hostSpendSoFar([{ status: record.status, cost: record.price, createdAt: record.startedAt }])
  let api: HostVendor
  try { api = options.client ?? vendorClient(record) } catch (error) { return { ok: false, words: TENSORFOLD_HOST_WORDS.terminateFailed(machine, error instanceof Error ? error.message : String(error)) } }
  try {
    await stopHostSetup(id)
    const pod = await api.get(id, options.signal).catch(error => { if (vendorGone(error)) return undefined; throw error })
    if (pod !== undefined) await terminateHostResource(api, pod)
  } catch (error) {
    return { ok: false, words: TENSORFOLD_HOST_WORDS.terminateFailed(machine, error instanceof Error ? error.message : String(error)) }
  }
  closeHostTunnel(id)
  const { configuredCompatEndpoints } = await import('../roads/openaicompat/compatAccounts.js')
  const { removeLlmHostProvider, tensorFoldUnregisterFailedNote } = await import('../llm-host/index.js')
  let unregistered = false
  let unregisterNote = ''
  for (const endpoint of configuredCompatEndpoints()) {
    if (endpoint.hostPodId === id || endpoint.name === record.provider) {
      if (endpoint.hostPodId === id) unregistered = true
      const removed = await removeLlmHostProvider(endpoint.name)
      if (removed.tensorFoldUnregisterError && !unregisterNote) unregisterNote = ' · ' + tensorFoldUnregisterFailedNote(removed.tensorFoldUnregisterError)
    }
  }
  if (!unregistered) {
    try {
      await unregisterTensorFoldPod(id)
    } catch (error) {
      passedOver(error)
      const detail = error instanceof SyntaxError ? 'a hosts file is not valid JSON' : error instanceof Error ? error.message : String(error)
      unregisterNote = ' · ' + tensorFoldUnregisterFailedNote(detail)
    }
  }
  const { restoreRentingSessionOutcome } = await import('./worker.js')
  const restored = await restoreRentingSessionOutcome(record)
  removeHostRecord(id)
  const restoreNote = restored.state === 'failed'
    ? ' · this session stays on a model that is gone (' + restored.detail + ') — run /model ' + record.sessionModelBefore
    : ''
  return { ok: true, words: TENSORFOLD_HOST_WORDS.terminated(machine, spend) + restoreNote + unregisterNote }
}

export async function settleStoppingTensorFoldPods(options: { client?: (record: HostRecord) => HostVendor; signal?: AbortSignal } = {}): Promise<number> {
  let settled = 0
  for (const record of hostRecords()) {
    if (record.stopRequestedAt === undefined || record.status === 'EXITED') continue
    try {
      const api = options.client ? options.client(record) : vendorClient(record)
      const pod = await api.get(record.id, options.signal ?? AbortSignal.timeout(5000)).catch(error => { if (vendorGone(error)) return undefined; throw error })
      if (pod === undefined || pod.status === 'TERMINATED') {
        await unregisterTensorFoldPod(record.id)
        removeHostRecord(record.id)
        settled += 1
        continue
      }
      if (pod.status !== 'EXITED') continue
      patchHostRecord(record.id, { status: 'EXITED', step: 'stopped · compute billing ended · the disk bills until Terminate' })
      settled += 1
    } catch (error) { passedOver(error) }
  }
  return settled
}
