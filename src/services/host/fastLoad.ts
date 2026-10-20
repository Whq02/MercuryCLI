import { randomUUID } from 'node:crypto'
import type { LlmHostRoad, LlmHostResult } from '../llmHost/index.js'
import { currentHostRecipes } from './recipesFile.js'
import { keptDownloadMinutes, keptStallWords, weightManifest } from './keptWeights.js'
import type { HostRecipe } from './recipes.js'
import { createRefusal, type RunpodClient, type HostOffer, type HostPod } from './runpod.js'
import { ensureHostKey, type HostRunner } from './ssh.js'
import { queueHostSetup, requireHostJobOwner } from './jobs.js'
import type { HostRecord } from './store.js'
import { createKeptVolume, deleteKeptVolume, fullCheckMinutes, keptDiskPrice, keptVolumes, matchesVolume, networkMonthly, readKeptVolume, reconcileVolumes, volumeModel, volumePrice, writeKeptVolume, type KeptVolume } from './volumes.js'

export const FAST_LOAD_DOOR = 'Fast-load (keep weights near the GPU)'
type Ask = Parameters<LlmHostRoad>[0]
type Emit = Parameters<LlmHostRoad>[1]
export interface FastLoadOptions { runner: HostRunner; sessionId: string; apiBaseUrl?: string; startJob?: (record: HostRecord) => void }
const cancelled = (): LlmHostResult => ({ ok: true, words: 'Fast-load closed. Existing weights disks keep billing until deleted.' })
export const fastLoadRecipes = (): HostRecipe[] => [...new Map(currentHostRecipes().map(row => [volumeModel(row), row])).values()]
export function fastLoadState(recipe: HostRecipe): string {
  const row = keptVolumes().find(row => matchesVolume(row, recipe) && row.state !== 'gone') ?? keptVolumes().find(row => matchesVolume(row, recipe))
  if (!row) return 'not kept'
  if (row.state === 'gone') return 'not kept · ' + (row.error ?? 'disk gone')
  if (row.state === 'creating') return 'preparing · create answer unclear; disk may exist and bill'
  if (row.state === 'kept') return 'kept on ' + row.id + ' in ' + row.dataCenter + ' since ' + row.createdAt.slice(0, 10) + ' · ' + volumePrice(row) + (row.verifiedSums?.check ? ' · ' + row.verifiedSums.check + ' check passed' : '') + (row.verifiedSums?.sampleManifestSha256 ? '' : ' · next check is full ' + fullCheckMinutes(recipe.weightsGb))
  if (row.state === 'failed') return 'failed · ' + row.id + ' in ' + row.dataCenter + ' · ' + keptDiskPrice(row) + (row.error ? ' · ' + row.error : '') + ' · the next rental downloads again'
  return 'preparing · ' + row.id + ' in ' + row.dataCenter + ' · ' + volumePrice(row) + (row.preparingPod ? ' · on pod ' + row.preparingPod : '')
}
export const volumeFitsOffer = (offer: HostOffer): boolean => {
  const volume = keptVolumes().find(row => matchesVolume(row, offer.recipe) && row.state !== 'gone')
  return !volume || volume.kind === 'global' || !offer.dataCenter || volume.dataCenter === offer.dataCenter
}
export async function volumeDeleteDoor(api: RunpodClient, id: string, ask: Ask, signal: AbortSignal): Promise<LlmHostResult> {
  await reconcileVolumes(api, signal)
  const record = readKeptVolume(id)
  if (!record) return { ok: true, words: 'Created outside Mercury · read-only. Manage this disk in Runpod.' }
  if (record.state === 'gone') return { ok: true, words: 'The disk is gone. The next rental downloads the weights again.' }
  const choice = await ask({ step: 'volume-delete', title: 'Delete weights disk?', found: id + ' · ' + volumePrice(record), willRun: 'The weights are gone after deletion; the next rental downloads them again.', rows: [{ value: 'delete', label: 'Confirm Delete weights disk' }, { value: 'cancel', label: 'Cancel' }] })
  if (choice !== 'delete' || signal.aborted) return cancelled()
  await deleteKeptVolume(api, id)
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
    const record = queueHostSetup({ id: pod.id, name: pod.name, recipe: offer.recipe.id, price: offer.price, startedAt: pod.startedAt ?? pod.createdAt, status: pod.status, sessionId: options.sessionId, workspace: process.cwd(), sshKey: sshKey.path, apiBaseUrl: options.apiBaseUrl, volumeId: volume.id, prepareWeightsOnly: true, verifyWeightsFully: fully })
    options.startJob?.(record)
    return record
  } catch (error) {
    const detail = created ? created + ' exists and may still bill; Pods I’m paying for → Terminate. ' : createRefusal(error) ? 'Runpod refused the preparation pod. ' : name + ' may exist and bill; inspect Pods I’m paying for before retrying. '
    writeKeptVolume({ ...volume, state: 'failed', preparingPod: created, error: detail + String(error) })
    throw new Error(detail + 'The weights disk still bills ' + volumePrice(volume) + '. ' + String(error))
  }
}
export async function fastLoadDoor(api: RunpodClient, ask: Ask, emit: Emit, signal: AbortSignal, options: FastLoadOptions): Promise<LlmHostResult> {
  for (;;) {
    await reconcileVolumes(api, signal)
    const recipes = fastLoadRecipes()
    const selected = await ask({ step: 'fast-load', title: FAST_LOAD_DOOR, found: 'Opt in per model. Weights live on a Runpod disk, not this computer.', willRun: 'Disks bill whether or not a pod exists. Nothing is created without confirmation.', rows: [...recipes.map(recipe => ({ value: recipe.id, label: recipe.label + ' · ' + recipe.weightsGb.toFixed(2) + ' GB · ' + fastLoadState(recipe) })), { value: 'refresh', label: 'Refresh kept disks' }, { value: 'close', label: 'Back' }] })
    if (!selected || selected === 'close') return cancelled()
    if (selected === 'refresh') continue
    const recipe = recipes.find(row => row.id === selected)
    if (!recipe) throw new Error('Choose a model from the catalogue.')
    weightManifest(recipe)
    const existing = keptVolumes().find(row => matchesVolume(row, recipe) && row.state !== 'gone')
    if (existing) {
      const action = await ask({ step: 'fast-load-kept', title: recipe.label, found: fastLoadState(recipe), willRun: 'Disks bill whether or not a pod exists. Reopen the catalogue to refresh preparation.', rows: [...(existing.state === 'kept' ? [{ value: 'verify', label: 'Verify fully · rent a temporary pod for full SHA256' }] : []), ...(existing.state !== 'creating' ? [{ value: 'delete', label: 'Delete weights disk' }] : []), { value: 'back', label: 'Back' }] })
      if (action === 'verify') {
        const offer = (await api.offers(signal)).filter(row => matchesVolume(existing, row.recipe) && (existing.kind === 'global' || !row.dataCenter || row.dataCenter === existing.dataCenter)).sort((a, b) => a.price - b.price)[0]
        if (!offer) { emit({ title: FAST_LOAD_DOOR, words: 'No fitting verification pod has stock. No pod was created; the kept disk still bills.' }); continue }
        const confirm = await ask({ step: 'fast-load-verify-confirm', title: 'Verify fully · full SHA256', found: existing.id + ' · ' + volumePrice(existing) + ' · full check ' + fullCheckMinutes(recipe.weightsGb), willRun: 'Rent $' + offer.price.toFixed(2) + '/hr for verification, then terminate. A mismatch downloads the weights again on that pod first. The disk keeps billing without a pod.', rows: [{ value: 'verify', label: 'Confirm full verification · temporary pod $' + offer.price.toFixed(2) + '/hr' }, { value: 'cancel', label: 'Cancel' }] })
        if (confirm === 'verify' && !signal.aborted) await prepareVolume(api, recipe, existing, offer, options, signal, true)
      }
      if (action === 'delete') { const result = await volumeDeleteDoor(api, existing.id, ask, signal); emit({ title: FAST_LOAD_DOOR, words: result.words }) }
      if (!action) return cancelled()
      continue
    }
    const how = await ask({ step: 'fast-load-how', title: recipe.label + ' · How?', found: recipe.weightsGb.toFixed(2) + ' GB of weights · not kept', willRun: 'Choose where to keep this model. No disk has been created.', rows: [{ value: 'network', label: 'Runpod network volume · one data centre · $0.07/GB/month' }, { value: 'global', label: 'Runpod global volume (beta) · any data centre · $0.09/GB/month + IOPS' }, { value: 'ssh', label: 'My own bank over SSH · mercury-host road' }, { value: 'back', label: 'Back' }] })
    if (!how) return cancelled()
    if (how === 'back') continue
    if (how === 'ssh') { emit({ title: 'My own bank over SSH', words: 'Use the mercury-host SSH bank road. Fast-load does not create or copy an SSH bank.' }); continue }
    if (how !== 'network' && how !== 'global') throw new Error('Choose a storage kind from the catalogue.')
    let dataCenter = 'any DC'
    if (how === 'network') {
      const centres = (await api.dataCenters(signal)).filter(row => row.networkVolumeTypes.includes('STANDARD'))
      const where = await ask({ step: 'fast-load-where', title: 'Where should the weights live?', found: recipe.label, willRun: 'Network volumes attach only to new pods in the same data centre.', rows: [...centres.map(row => ({ value: row.id, label: row.id + ' · ' + row.name })), { value: 'back', label: 'Back' }] })
      if (!where) return cancelled()
      if (where === 'back') continue
      if (!centres.some(row => row.id === where)) throw new Error('Choose a data centre from the live catalogue.')
      dataCenter = where
    }
    const when = await ask({ step: 'fast-load-when', title: 'When should the weights be prepared?', found: recipe.label + ' · ' + dataCenter, willRun: 'Prepare now rents the cheapest fitting pod, downloads and verifies weights, then terminates that pod.', rows: [{ value: 'now', label: 'Prepare now · temporary pod charges plus disk' }, { value: 'next', label: 'At the next rental · create disk now; fill it when I rent' }, { value: 'back', label: 'Back' }] })
    if (!when) return cancelled()
    if (when === 'back') continue
    if (when !== 'now' && when !== 'next') throw new Error('Choose a preparation time.')
    const offer = when === 'now' ? (await api.offers(signal)).filter(row => volumeModel(row.recipe) === volumeModel(recipe) && (how === 'global' || !row.dataCenter || row.dataCenter === dataCenter)).sort((a, b) => a.price - b.price)[0] : undefined
    if (when === 'now' && !offer) { emit({ title: FAST_LOAD_DOOR, words: 'No fitting pod has stock here. Nothing was created; try another data centre or prepare at the next rental.' }); continue }
    const amount = volumePrice({ kind: how, price: how === 'global' ? recipe.weightsGb * 0.09 : networkMonthly(recipe.diskGb) })
    const confirm = await ask({ step: 'fast-load-confirm', title: 'Confirm weights disk · ' + amount, found: recipe.label + ' · ' + (how === 'network' ? recipe.diskGb + ' GB disk' : recipe.weightsGb.toFixed(2) + ' GB estimated usage') + ' · ' + dataCenter, willRun: 'Disk bills whether or not a pod exists.' + (offer ? ' Prepare now: $' + offer.price.toFixed(2) + '/hr until download verifies; then terminate. A stalled download (' + keptStallWords + ') or one past ' + keptDownloadMinutes(recipe) + ' min also terminates the pod and keeps the partial disk.' : ' No pod now; next rental downloads the weights.'), rows: [{ value: 'confirm', label: 'Confirm ' + amount + (offer ? ' + temporary pod $' + offer.price.toFixed(2) + '/hr' : '') }, { value: 'cancel', label: 'Cancel' }] })
    if (confirm !== 'confirm' || signal.aborted) continue
    if (offer && !options.startJob) await requireHostJobOwner()
    const volume = await createKeptVolume(api, recipe, how, dataCenter, signal)
    if (offer) {
      try { await prepareVolume(api, recipe, volume, offer, options, signal) } catch (error) {
        throw new Error('Weights disk ' + volume.id + ' exists and bills ' + amount + '. Pods I’m paying for → Delete. ' + String(error))
      }
    }
    emit({ title: FAST_LOAD_DOOR, words: volume.id + ' · preparing' + (offer ? ' · temporary pod terminates after verification' : ' at the next rental') + ' · ' + amount })
  }
}
