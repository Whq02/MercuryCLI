import { randomUUID } from 'node:crypto'
import { basename, dirname } from 'node:path'
import type { LlmHostRoad, LlmHostResult } from '../llmHost/index.js'
import { currentHostRecipes, rememberSessionHostRecipe } from './recipesFile.js'
import { keptDownloadMinutes, keptStallWords, pinnedWeightManifest, weightManifestWords } from './keptWeights.js'
import { manifestBytes } from './bankManifest.js'
import { hostShape } from './cluster.js'
import type { HostRecipe } from './recipes.js'
import { createRefusal, type RunpodClient, type HostOffer, type HostPod } from './runpod.js'
import { ensureHostKey, type HostRunner } from './ssh.js'
import { activeHostBanks, bankJobModel, queueHostBank, queueHostSetup, requireHostJobOwner } from './jobs.js'
import { hostJobReadOnly } from './retry.js'
import { keepSafeDoor } from './keepSafe.js'
import { hostRecords, removeHostRecord, type HostRecord } from './store.js'
import { createKeptVolume, deleteKeptVolume, fullCheckMinutes, keptDiskPrice, keptVolumes, matchesVolume, networkMonthly, readKeptVolume, reconcileVolumes, runpodKeptVolumes, volumeModel, volumePrice, writeKeptVolume, type KeptVolume } from './volumes.js'
import type { VastClient } from './vendors/vast.js'
import { VAST_VOLUME_DOOR, mirrorToVastVolume, reconcileVastVolumes, vastKeptVolumes, vastVolumeDeleteDoor, vastVolumeFor, vastVolumeState } from './vastVolumes.js'
import { BANK_DOOR, bankCandidateWords, bankCandidates, bankFolder, bankFree, bankState, bankedHostRecipes, bootMinutes, bytesWords, rememberBankFolder, shortFolder, sizeWords, type BankState } from './bank.js'

export { BANK_DOOR }
const FAST_LOAD_DOOR = 'Fast-load volume'
type Ask = Parameters<LlmHostRoad>[0]
type Emit = Parameters<LlmHostRoad>[1]
interface FastLoadOptions { runner: HostRunner; sessionId: string; apiBaseUrl?: string; vastApiBaseUrl?: string; startJob?: (record: HostRecord) => void; vast?: () => VastClient | undefined }
export interface BankDoorOptions extends FastLoadOptions { api: () => RunpodClient | undefined; connect: () => Promise<boolean>; refreshVolumes?: () => Promise<void> }
const cancelled = (): LlmHostResult => ({ ok: true, words: 'Bank closed. Existing weights disks keep billing until deleted.' })
const modelTitle = (recipe: HostRecipe): string => recipe.label.split(' · ')[0]!
const pad = (text: string, width: number): string => text.length >= width ? text + ' ' : text.padEnd(width)
const fit = (text: string, width: number): string => text.length <= width ? text : text.slice(0, Math.max(1, width - 1)) + '…'
export const fastLoadRecipes = (): HostRecipe[] => {
  const current = currentHostRecipes()
  const saved = [...bankedHostRecipes(), ...keptVolumes().flatMap(volume => volume.state !== 'gone' && volume.recipeRow && matchesVolume(volume, volume.recipeRow) ? [volume.recipeRow] : [])]
  for (const recipe of saved) if (!current.some(row => row.id === recipe.id)) rememberSessionHostRecipe(recipe)
  return [...new Map(currentHostRecipes().map(row => [volumeModel(row), row])).values()]
}
export function fastLoadState(recipe: HostRecipe): string {
  const row = runpodKeptVolumes().find(row => matchesVolume(row, recipe) && row.state !== 'gone') ?? runpodKeptVolumes().find(row => matchesVolume(row, recipe))
  const vast = vastKeptVolumes().some(row => matchesVolume(row, recipe)) ? ' · ' + vastVolumeState(recipe) : ''
  if (!row) return 'not kept' + vast
  return runpodFastLoadState(recipe, row) + vast
}
function runpodFastLoadState(recipe: HostRecipe, row: KeptVolume): string {
  if (row.state === 'gone') return 'not kept · ' + (row.error ?? 'disk gone')
  if (row.state === 'creating') return 'preparing · create answer unclear; disk may exist and bill'
  if (row.state === 'kept') return 'kept on ' + row.id + ' in ' + row.dataCenter + ' since ' + row.createdAt.slice(0, 10) + ' · ' + volumePrice(row) + (row.verifiedSums?.check ? ' · ' + row.verifiedSums.check + ' check passed' : '') + (row.verifiedSums?.sampleManifestSha256 ? '' : ' · next check is full ' + fullCheckMinutes(recipe.weightsGb))
  if (row.state === 'failed') return 'failed · ' + row.id + ' in ' + row.dataCenter + ' · ' + keptDiskPrice(row) + (row.error ? ' · ' + row.error : '') + ' · the next rental downloads again'
  return 'preparing · ' + row.id + ' in ' + row.dataCenter + ' · ' + volumePrice(row) + (row.preparingPod ? ' · on pod ' + row.preparingPod : '')
}
export const volumeFitsOffer = (offer: HostOffer): boolean => {
  const volume = runpodKeptVolumes().find(row => matchesVolume(row, offer.recipe) && row.state !== 'gone')
  return !volume || volume.kind === 'global' || !offer.dataCenter || volume.dataCenter === offer.dataCenter
}
export async function volumeDeleteDoor(api: RunpodClient, id: string, ask: Ask, signal: AbortSignal, emit?: Emit, timeoutMs = 4 * 60_000): Promise<LlmHostResult> {
  await reconcileVolumes(api, signal)
  const record = readKeptVolume(id)
  if (!record) return { ok: true, words: 'Created outside Mercury · read-only. Manage this disk in Runpod.' }
  if (record.state === 'gone') return { ok: true, words: 'The disk is gone. The next rental downloads the weights again.' }
  const choice = await ask({ step: 'volume-delete', title: 'Delete weights disk?', found: id + ' · ' + volumePrice(record), willRun: 'The weights are gone after deletion; the next rental downloads them again.', rows: [{ value: 'delete', label: 'Confirm Delete weights disk' }, { value: 'cancel', label: 'Cancel' }] })
  if (choice !== 'delete' || signal.aborted) return cancelled()
  const confirming = hostJobReadOnly({ label: 'Runpod', pauseMs: 1000, timeoutMs, signal, mark: words => emit?.({ title: 'Delete weights disk', words: id + ' · ' + words }) })
  emit?.({ title: 'Delete weights disk', words: id + ' · deleting · waiting for Runpod to drop it from the volume list' })
  try { await deleteKeptVolume(api, id, confirming) } catch (error) { return { ok: false, words: error instanceof Error ? error.message : String(error) } }
  return { ok: true, words: 'Weights disk deleted · next rental downloads the weights again.' }
}
export function keptDiskForPod(pod: HostPod, record?: HostRecord): string | undefined {
  return [...(pod.mounts?.network ?? []), ...(pod.mounts?.global ?? [])].find(row => readKeptVolume(row.volumeId))?.volumeId ?? record?.volumeId
}
export async function terminateVolumeChoice(id: string | undefined, ask: Ask, signal: AbortSignal): Promise<'keep' | 'delete' | null> {
  const volume = id && readKeptVolume(id)
  if (!volume || volume.state === 'gone') return 'keep'
  const choice = await ask({ step: 'terminate-weights', title: 'Keep the weights disk or delete it?', found: volume.id + ' · ' + volumePrice(volume), willRun: 'Keep: disk bills without a pod. Delete: weights are gone; the next rental downloads them again.', rows: [{ value: 'keep', label: 'Keep the weights disk (' + volumePrice(volume) + ')' }, { value: 'delete', label: 'Delete the weights disk too' }, { value: 'cancel', label: 'Cancel termination' }] })
  return !signal.aborted && (choice === 'keep' || choice === 'delete') ? choice : null
}
export function fillOffer(offers: HostOffer[], recipe: HostRecipe, kind: KeptVolume['kind'], dataCenter: string): HostOffer | undefined {
  const cheapest = offers.filter(row => (row.recipe.nodes ?? 1) === 1 && (kind === 'global' || !row.dataCenter || row.dataCenter === dataCenter)).sort((a, b) => a.price - b.price || Number(b.recipe.id === recipe.id) - Number(a.recipe.id === recipe.id) || a.recipe.id.localeCompare(b.recipe.id))[0]
  return cheapest && { ...cheapest, recipe: { ...recipe, gpu: cheapest.recipe.gpu, count: cheapest.recipe.count, vramGb: cheapest.recipe.vramGb, cuda: cheapest.recipe.cuda, nodes: undefined } }
}
const fillPodWords = (offer: HostOffer): string => 'a temporary ' + hostShape(offer.recipe) + ' pod at $' + offer.price.toFixed(2) + '/hr'
async function prepareVolume(api: RunpodClient, recipe: HostRecipe, volume: KeptVolume, offer: HostOffer, options: FastLoadOptions, signal: AbortSignal, fully = false): Promise<HostRecord> {
  if (!options.startJob) await requireHostJobOwner()
  const sshKey = await ensureHostKey(options.runner, signal)
  signal.throwIfAborted()
  const name = 'mercury-fill-' + randomUUID().slice(0, 12)
  let created: string | undefined
  try {
    const pod = await api.create(offer, sshKey.publicKey, name, volume)
    created = pod.id
    writeKeptVolume({ ...volume, state: 'preparing', preparingPod: pod.id, error: undefined })
    const record = queueHostSetup({ id: pod.id, name: pod.name, recipe: offer.recipe.id, recipeRow: offer.recipe, price: offer.price, startedAt: pod.startedAt ?? pod.createdAt, status: pod.status, sessionId: options.sessionId, workspace: process.cwd(), sshKey: sshKey.path, apiBaseUrl: options.apiBaseUrl, volumeId: volume.id, prepareWeightsOnly: true, verifyWeightsFully: fully })
    options.startJob?.(record)
    return record
  } catch (error) {
    const detail = created ? created + ' exists and may still bill; Machines I’m paying for → Terminate. ' : createRefusal(error) ? 'Runpod refused the preparation pod. ' : name + ' may exist and bill; inspect Machines I’m paying for before retrying. '
    writeKeptVolume({ ...volume, state: 'failed', preparingPod: created, error: detail + String(error) })
    throw new Error(detail + 'The weights disk still bills ' + volumePrice(volume) + '. ' + String(error))
  }
}
export async function mirrorToVolume(api: RunpodClient | undefined, recipe: HostRecipe, ask: Ask, emit: Emit, signal: AbortSignal, options: FastLoadOptions): Promise<LlmHostResult | undefined> {
  const manifest = pinnedWeightManifest(recipe)
  if (!manifest) {
    emit({ title: modelTitle(recipe), words: 'This recipe cannot be mirrored without a trusted file manifest: ' + weightManifestWords(recipe) + '. No volume or pod was created.' })
    return
  }
  const pinned: HostRecipe = recipe.weightManifest ? recipe : { ...recipe, weightManifest: manifest }
  const vast = options.vast?.()
  if (api) await reconcileVolumes(api, signal)
  const existing = runpodKeptVolumes().find(row => matchesVolume(row, recipe) && row.state !== 'gone')
  if (!api) {
    if (!vast) return
    return mirrorToVastVolume(vast, recipe, ask, emit, signal, options)
  }
  const vastRow = vast ? [{ value: 'vast', label: VAST_VOLUME_DOOR + ' · keep on one Vast.ai machine · per GB-month at the machine’s rate · ' + (vastVolumeFor(recipe) ? 'kept' : 'not kept') }] : []
  if (existing) {
    const action = await ask({ step: 'fast-load-kept', title: recipe.label, found: fastLoadState(recipe), willRun: 'Disks bill whether or not a pod exists. Reopen the Bank to refresh preparation.', rows: [...(existing.state === 'kept' ? [{ value: 'verify', label: 'Verify fully · rent a temporary pod to check every file' }] : []), ...(existing.state !== 'creating' ? [{ value: 'delete', label: 'Delete weights disk' }] : []), ...vastRow, { value: 'back', label: 'Back' }] })
    if (action === 'vast' && vast) return mirrorToVastVolume(vast, recipe, ask, emit, signal, options)
    if (action === 'verify') {
      const offer = fillOffer(await api.offers(signal), pinned, existing.kind, existing.dataCenter)
      if (!offer) { emit({ title: FAST_LOAD_DOOR, words: 'No pod has stock in ' + existing.dataCenter + ' for the verification. No pod was created; the kept disk still bills.' }); return }
      const confirm = await ask({ step: 'fast-load-verify-confirm', title: 'Verify fully · check every file', found: existing.id + ' · ' + volumePrice(existing) + ' · full check ' + fullCheckMinutes(recipe.weightsGb), willRun: 'Rent ' + fillPodWords(offer) + ' for the verification (the cheapest in stock there; checking files needs no particular GPU), then terminate it. A mismatch downloads the weights again on that pod first. The disk keeps billing without a pod.', rows: [{ value: 'verify', label: 'Confirm full verification · temporary pod ' + hostShape(offer.recipe) + ' $' + offer.price.toFixed(2) + '/hr' }, { value: 'cancel', label: 'Cancel' }] })
      if (confirm === 'verify' && !signal.aborted) await prepareVolume(api, pinned, existing, offer, options, signal, true)
      return
    }
    if (action === 'delete') { const result = await volumeDeleteDoor(api, existing.id, ask, signal, emit); emit({ title: FAST_LOAD_DOOR, words: result.words }) }
    if (!action) return cancelled()
    return
  }
  const how = await ask({ step: 'fast-load-how', title: recipe.label + ' · How?', found: recipe.weightsGb.toFixed(2) + ' GB of weights · ' + (vastVolumeFor(recipe) ? vastVolumeState(recipe) : 'not kept'), willRun: 'Choose where to keep this model. No disk has been created.', rows: [{ value: 'network', label: 'Runpod network volume · one data centre · $0.07/GB/month' }, { value: 'global', label: 'Runpod global volume (beta) · any data centre · $0.09/GB/month + IOPS' }, ...vastRow, { value: 'ssh', label: 'My own bank over SSH · mercury host' }, { value: 'back', label: 'Back' }] })
  if (!how) return cancelled()
  if (how === 'back') return
  if (how === 'vast' && vast) return mirrorToVastVolume(vast, recipe, ask, emit, signal, options)
  if (how === 'ssh') { emit({ title: 'My own bank over SSH', words: 'Use mercury host for an SSH bank. Mirroring from the Bank creates a Runpod volume only; it does not create or copy an SSH bank.' }); return }
  if (how !== 'network' && how !== 'global') throw new Error('Choose a storage kind from the catalogue.')
  let dataCenter = 'any DC'
  if (how === 'network') {
    const centres = (await api.dataCenters(signal)).filter(row => row.networkVolumeTypes.includes('STANDARD'))
    const where = await ask({ step: 'fast-load-where', title: 'Where should the weights live?', found: recipe.label, willRun: 'Network volumes attach only to new pods in the same data centre.', rows: [...centres.map(row => ({ value: row.id, label: row.id + ' · ' + row.name })), { value: 'back', label: 'Back' }] })
    if (!where) return cancelled()
    if (where === 'back') return
    if (!centres.some(row => row.id === where)) throw new Error('Choose a data centre from the live catalogue.')
    dataCenter = where
  }
  if (how === 'network' && manifestBytes(manifest) > recipe.diskGb * 1e9) { emit({ title: FAST_LOAD_DOOR, words: 'The recipe’s ' + recipe.diskGb + ' GB disk has no room for its ' + (manifestBytes(manifest) / 1e9).toFixed(2) + ' GB of weights. Nothing was created.' }); return }
  const when = await ask({ step: 'fast-load-when', title: 'When should the weights be prepared?', found: recipe.label + ' · ' + dataCenter, willRun: 'Prepare now rents the cheapest pod in stock with room for the weights (any GPU shape; it only downloads), downloads and verifies them, then terminates that pod.', rows: [{ value: 'now', label: 'Prepare now · temporary pod charges plus disk' }, { value: 'next', label: 'At the next rental · create disk now; fill it when I rent' }, { value: 'back', label: 'Back' }] })
  if (!when) return cancelled()
  if (when === 'back') return
  if (when !== 'now' && when !== 'next') throw new Error('Choose a preparation time.')
  const offer = when === 'now' ? fillOffer(await api.offers(signal), pinned, how, dataCenter) : undefined
  if (when === 'now' && !offer) { emit({ title: FAST_LOAD_DOOR, words: 'No pod has stock in ' + dataCenter + ' to fill the disk. Nothing was created; try another data centre or prepare at the next rental.' }); return }
  const amount = volumePrice({ kind: how, price: how === 'global' ? recipe.weightsGb * 0.09 : networkMonthly(recipe.diskGb) })
  const confirm = await ask({ step: 'fast-load-confirm', title: 'Confirm weights disk · ' + amount, found: recipe.label + ' · ' + (how === 'network' ? recipe.diskGb + ' GB disk' : recipe.weightsGb.toFixed(2) + ' GB estimated usage') + ' · ' + dataCenter, willRun: 'Disk bills whether or not a pod exists.' + (offer ? ' Prepare now: ' + fillPodWords(offer) + ' (the cheapest in stock in ' + dataCenter + ' with room for the weights; filling a disk needs no particular GPU) until the download verifies; then terminate. A temporary pod fills the volume from Hugging Face and verifies the same files next to the GPUs; nothing is uploaded from your drive. A stalled download (' + keptStallWords + ') or one past ' + keptDownloadMinutes(recipe) + ' min also terminates the pod and keeps the partial disk.' : ' No pod now; the next rental downloads the weights from Hugging Face onto the disk and verifies them there; nothing is uploaded from your drive.'), rows: [{ value: 'confirm', label: 'Confirm ' + amount + (offer ? ' + temporary pod ' + hostShape(offer.recipe) + ' $' + offer.price.toFixed(2) + '/hr' : '') }, { value: 'cancel', label: 'Cancel' }] })
  if (confirm !== 'confirm' || signal.aborted) return
  if (offer && !options.startJob) await requireHostJobOwner()
  const volume = await createKeptVolume(api, pinned, how, dataCenter, signal)
  if (offer) {
    try { await prepareVolume(api, pinned, volume, offer, options, signal) } catch (error) {
      throw new Error('Weights disk ' + volume.id + ' exists and bills ' + amount + '. Machines I’m paying for → Delete. ' + String(error))
    }
  }
  emit({ title: FAST_LOAD_DOOR, words: volume.id + ' · preparing' + (offer ? ' · temporary pod terminates after verification' : ' at the next rental') + ' · ' + amount })
  return
}
function volumeCell(recipe: HostRecipe, banked: boolean): string {
  const volume = keptVolumes().find(row => matchesVolume(row, recipe) && row.state !== 'gone')
  const where = volume ? (volume.kind === 'vast' ? 'Vast.ai machine ' + volume.machineId : volume.dataCenter) : ''
  if (volume?.state === 'kept') return '✓ ' + where + ' · boots ~' + bootMinutes(recipe, volume) + ' min'
  if (volume?.state === 'preparing' || volume?.state === 'creating') return '… preparing in ' + where
  if (volume?.state === 'failed') return '✗ failed in ' + where + ' · d to drop'
  return banked ? pinnedWeightManifest(recipe) ? '— m to mirror' : '— cannot mirror · Enter says why' : '—'
}
const bankDrive = (folder: string): string => shortFolder(basename(folder) === 'mercury-model-bank' ? dirname(folder) : folder)
function bankCell(state: BankState, job: HostRecord | undefined, width: number): string {
  if (job) return pad(fit('… ' + (job.step ?? 'starting'), width - 1), width)
  if (state.banked) return pad('✓ ' + fit(bankDrive(state.folder!), width - 3), width)
  if (state.files > 0 && state.missing < state.files) return pad(fit('… ' + (state.files - state.missing) + '/' + state.files + ' files · b resumes', width - 1), width)
  return pad('— b to bank', width)
}
export type BankActionKind = 'bank' | 'verify' | 'mirror' | 'drop' | 'keep-safe'
export const BANK_KEYS = [{ key: 'b', value: 'bank', label: 'bank' }, { key: 'v', value: 'verify', label: 'verify' }, { key: 'm', value: 'mirror', label: 'mirror' }, { key: 'd', value: 'drop', label: 'drop' }, { key: 'k', value: 'keep-safe', label: 'keep safe' }] as const
export async function ensureBankFolder(ask: Ask, change = false): Promise<string | undefined> {
  const folder = bankFolder()
  if (folder && !change) return folder
  const named = await ask({ step: 'door-bank-folder', title: 'Where should the bank live?', found: (folder ? 'Current bank: ' + shortFolder(folder) + '. Choose ' : 'No bank folder was found on this computer. Choose ') + bankCandidateWords() + ', or another folder.', willRun: 'The folder is created if missing and remembered. Existing weights stay in their current folder.', initial: shortFolder(folder ?? bankCandidates()[0]!) })
  if (named === null) return
  return rememberBankFolder(named)
}
export async function bankAction(recipe: HostRecipe, action: BankActionKind, folder: string, ask: Ask, emit: Emit, signal: AbortSignal, options: BankDoorOptions): Promise<LlmHostResult | undefined> {
  const state = bankState(recipe, folder)
  if (action === 'keep-safe') return keepSafeDoor(recipe, folder, ask, emit, signal, () => bankAction(recipe, 'mirror', folder, ask, emit, signal, options))
  const job = activeHostBanks().find(row => bankJobModel(row) === volumeModel(recipe))
  if (action === 'bank' || action === 'verify') {
    if (job) { emit({ title: modelTitle(recipe), words: 'Already ' + (job.bankTask === 'verify' ? 'verifying' : 'banking') + ' · ' + job.step }); return }
    if (action === 'verify' && !state.banked) { emit({ title: modelTitle(recipe), words: state.sealed ? 'The folder is missing ' + state.missing + ' of ' + state.files + ' files · b banks the weights' : 'Not banked yet · b banks the weights to ' + shortFolder(folder) }); return }
    let task: 'bank' | 'verify' = action
    if (action === 'bank' && state.banked) {
      const again = await ask({ step: 'door-bank-again', title: modelTitle(recipe) + ' · already banked', found: 'Every file is on ' + state.path + (state.verifiedAt ? ' · verified ' + state.verifiedAt.slice(0, 10) : ' · not verified yet') + '.', willRun: 'Bank again re-checks every file against Hugging Face (complete files are skipped) and seals SHA256SUMS anew. v verifies without a download.', rows: [{ value: 'verify', label: 'Verify instead (no download)' }, { value: 'bank', label: 'Bank again · re-check against Hugging Face' }, { value: 'cancel', label: 'Cancel' }] })
      if (again !== 'verify' && again !== 'bank') return
      task = again
    }
    if (task === 'bank') {
      const free = bankFree(folder)
      const confirm = await ask({ step: 'door-bank-confirm', title: 'Bank ' + modelTitle(recipe), found: sizeWords(recipe.weightsGb) + ' from https://huggingface.co/' + recipe.model + ' → ' + state.path + (free !== undefined && free < recipe.weightsGb * 1e9 ? ' · only ' + bytesWords(free) + ' free on the drive' : ''), willRun: 'Downloads in the background with hf download (your Hugging Face token is used when a repo is gated), then seals SHA256SUMS and verifies every file ' + (state.pinned ? 'against the pinned manifest' : 'against the download') + '. Mercury tells you when it is done; nothing is rented.', rows: [{ value: 'bank', label: 'Bank it · ' + sizeWords(recipe.weightsGb) + ' download' }, { value: 'cancel', label: 'Cancel' }] })
      if (confirm !== 'bank' || signal.aborted) return
    }
    await bankDoorQueue(recipe, task, folder, emit, options)
    return
  }
  let client = options.api()
  const vast = options.vast?.()
  if (!client && !vast) { if (!await options.connect()) return; client = options.api() }
  if (!client && !vast) return
  if (action === 'drop') {
    const volume = keptVolumes().find(row => matchesVolume(row, recipe) && row.state !== 'gone')
    if (!volume) { emit({ title: modelTitle(recipe), words: 'No fast-load volume for this model · the bank stays as it is' }); return }
    if (volume.kind === 'vast' && !vast) { emit({ title: modelTitle(recipe), words: 'Connect Vast.ai to delete its volume · the bank stays as it is' }); return }
    if (volume.kind !== 'vast' && !client) { emit({ title: modelTitle(recipe), words: 'Connect Runpod to delete its disk · the bank stays as it is' }); return }
    const result = volume.kind === 'vast' ? await vastVolumeDeleteDoor(vast!, volume.id, ask, signal, emit) : await volumeDeleteDoor(client!, volume.id, ask, signal, emit)
    emit({ title: modelTitle(recipe), words: result.words + ' · the bank on your drive is untouched' })
    return
  }
  return mirrorToVolume(client, recipe, ask, emit, signal, options)
}
export async function bankDoor(ask: Ask, emit: Emit, signal: AbortSignal, options: BankDoorOptions): Promise<LlmHostResult> {
  let folder = await ensureBankFolder(ask)
  if (!folder) return { ok: true, words: 'Bank closed. No folder was chosen.' }
  for (;;) {
    if (options.refreshVolumes) await options.refreshVolumes()
    else {
      const api = options.api()
      if (api) try { await reconcileVolumes(api, signal) } catch (error) { emit({ title: BANK_DOOR, words: 'Volume list unavailable; the VOLUME column may be stale. ' + String(error) }) }
      const vastApi = options.vast?.()
      if (vastApi) try { await reconcileVastVolumes(vastApi, signal) } catch (error) { emit({ title: BANK_DOOR, words: 'Vast.ai volume list unavailable; the VOLUME column may be stale. ' + String(error) }) }
    }
    for (const record of hostRecords().filter(row => row.jobKind === 'bank' && (row.jobState === 'failed' || row.jobState === 'stopped'))) removeHostRecord(record.id)
    const jobs = activeHostBanks()
    const recipes = fastLoadRecipes()
    const states = new Map(recipes.map(recipe => [recipe.id, bankState(recipe, folder)]))
    const bankedWidth = Math.min(20, Math.max(14, bankDrive(folder).length + 3))
    const rowTitle = (recipe: HostRecipe): string => recipes.some(row => row !== recipe && modelTitle(row) === modelTitle(recipe)) ? recipe.label : modelTitle(recipe)
    const nameWidth = Math.min(45 - bankedWidth, Math.max(10, ...recipes.map(recipe => rowTitle(recipe).length + 2)))
    const rows = recipes.map(recipe => {
      const state = states.get(recipe.id)!
      const job = jobs.find(row => bankJobModel(row) === volumeModel(recipe))
      const verified = state.verifiedAt ? '✓ ' + state.verifiedAt.slice(0, 10) : state.failedAt && !state.verifiedAt ? '✗ ' + state.failedAt.slice(0, 10) : ''
      return { value: recipe.id, label: pad(fit(rowTitle(recipe), nameWidth - 1), nameWidth) + pad(sizeWords(recipe.weightsGb), 8) + bankCell(state, job, bankedWidth) + pad(verified, 13) + volumeCell(recipe, state.banked) }
    })
    const header = '─ ' + pad('MODEL', nameWidth) + pad('SIZE', 8) + pad('BANKED', bankedWidth) + pad('VERIFIED', 13) + 'VOLUME'
    if (rows[0]) rows[0].label = header + '\n' + rows[0].label
    const banked = recipes.filter(recipe => states.get(recipe.id)!.banked)
    const bankedBytes = banked.reduce((sum, recipe) => sum + states.get(recipe.id)!.bytes, 0)
    const lastVerified = banked.map(recipe => states.get(recipe.id)!.verifiedAt ?? '').filter(Boolean).sort().at(-1)
    const kept = keptVolumes().filter(row => row.state === 'kept' && recipes.some(recipe => matchesVolume(row, recipe)))
    const keptGb = kept.reduce((sum, row) => sum + (recipes.find(recipe => matchesVolume(row, recipe))?.weightsGb ?? 0), 0)
    const totals = 'Banked: ' + banked.length + ' of ' + recipes.length + ' models · ' + bytesWords(bankedBytes) + (lastVerified ? ' · last verified ' + lastVerified.slice(0, 10) : '') + (kept.length ? ' · fast-load volumes: ' + kept.length + ' kept (' + sizeWords(keptGb) + ', $' + kept.reduce((sum, row) => sum + row.price, 0).toFixed(2) + '/month' + (kept.length === 1 ? ', ' + (kept[0]!.kind === 'vast' ? 'Vast.ai machine ' + kept[0]!.machineId : kept[0]!.dataCenter) : '') + ')' : ' · no fast-load volume')
    const free = bankFree(folder)
    const choice = await ask({ step: 'door-bank', title: 'Bank', found: 'Your copy of the weights. Banked once from Hugging Face, hash-verified, kept on your drive; mirrored to a fast-load volume so a rental boots in minutes. The repo holds recipes, never weights.\n' + shortFolder(folder) + (free === undefined ? '' : ' · ' + bytesWords(free) + ' free') + ' · ' + totals, willRun: '', initial: rows[0]?.value, keys: BANK_KEYS, rows: [...rows, { value: 'change-folder', label: 'Change folder' }, { value: 'refresh', label: '────────────────────\nRefresh · re-read the bank folder and the volumes' }, { value: 'back', label: 'Back · Escape closes' }] })
    if (!choice || signal.aborted) return { ok: true, words: 'Bank closed.' + (kept.length ? ' Kept weights disks keep billing until deleted.' : '') }
    if (choice === 'change-folder') { folder = await ensureBankFolder(ask, true) ?? folder; continue }
    if (choice === 'refresh') continue
    if (choice === 'back') return { ok: true, words: 'Bank closed.' + (kept.length ? ' Kept weights disks keep billing until deleted.' : '') }
    const [action, target] = choice.includes(':') ? [choice.slice(0, choice.indexOf(':')), choice.slice(choice.indexOf(':') + 1)] : ['open', choice]
    const recipe = recipes.find(row => row.id === target)
    if (!recipe) continue
    const state = states.get(recipe.id)!
    if (action === 'open') { emit({ title: modelTitle(recipe), words: (state.banked ? 'banked ✓ on ' + state.path : state.files > 0 && state.missing < state.files ? (state.files - state.missing) + ' of ' + state.files + ' files on ' + state.path : 'not banked') + (state.verifiedAt ? ' · verified ' + state.verifiedAt.slice(0, 10) + ' against the ' + (state.check === 'manifest' ? 'pinned manifest' : 'download') : '') + (state.error ? ' · ' + state.error : '') + ' · ' + fastLoadState(recipe) + (pinnedWeightManifest(recipe) ? '' : ' · mirroring unavailable: ' + weightManifestWords(recipe)) + ' · keys: b bank · v verify · m mirror · d drop · k keep safe' }); continue }
    if (!BANK_KEYS.some(row => row.value === action)) continue
    const result = await bankAction(recipe, action as BankActionKind, folder, ask, emit, signal, options)
    if (result) return result
  }
}
async function bankDoorQueue(recipe: HostRecipe, task: 'bank' | 'verify', folder: string, emit: Emit, options: BankDoorOptions): Promise<void> {
  if (!options.startJob) await requireHostJobOwner()
  const id = (task === 'verify' ? 'verify-' : 'bank-') + randomUUID().slice(0, 12)
  const record = queueHostBank({ id, name: modelTitle(recipe), recipe: recipe.id, price: 0, startedAt: new Date().toISOString(), status: task === 'verify' ? 'VERIFYING' : 'BANKING', sessionId: options.sessionId, workspace: process.cwd(), bankTask: task, bankFolder: folder })
  if (record.id === id) options.startJob?.(record)
  emit({ title: modelTitle(recipe), words: (record.id === id ? (task === 'verify' ? 'Verifying the bank' : 'Banking the weights to ' + shortFolder(folder)) : 'Already running') + ' · ' + record.id + ' · in the background · Mercury tells you when it is done' })
}
