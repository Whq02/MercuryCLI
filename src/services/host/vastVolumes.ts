import { randomUUID } from 'node:crypto'
import type { LlmHostRoad, LlmHostResult } from '../llmHost/index.js'
import type { HostRecipe } from './recipes.js'
import type { HostOffer, HostVolumeMount } from './runpod.js'
import { HostCreateError } from './vendors/http.js'
import { VAST_VOLUME_MOUNT, VastClient, type VastVolume, type VastVolumeOffer } from './vendors/vast.js'
import { fullCheckMinutes, keptDiskPrice, keptVolumes, matchesVolume, readKeptVolume, removeKeptVolumeRecord, vastVolumeBilling, writeKeptVolume, type KeptVolume } from './volumes.js'
import { hostShape } from './cluster.js'
import { keptDownloadMinutes, keptStallWords, pinnedWeightManifest, weightManifestWords } from './keptWeights.js'
import { manifestBytes } from './bankManifest.js'
import { hostJobReadOnly, type HostReadOnly } from './retry.js'
import { ensureHostKey, type HostRunner } from './ssh.js'
import { queueHostSetup, requireHostJobOwner } from './jobs.js'
import type { HostRecord } from './store.js'
import { hostSetupEstimate } from '../../commands/llmhost/words.js'

type Ask = Parameters<LlmHostRoad>[0]
type Emit = Parameters<LlmHostRoad>[1]
interface VastFastLoadOptions { runner: HostRunner; sessionId: string; vastApiBaseUrl?: string; startJob?: (record: HostRecord) => void }
export const VAST_VOLUME_DOOR = 'Vast.ai volume'
const modelTitle = (recipe: HostRecipe): string => recipe.label.split(' · ')[0]!
const hourly = (price: number): string => '$' + price.toFixed(2) + '/hr'
const pendingGraceMs = 10 * 60_000
export const vastKeptVolumes = (): KeptVolume[] => keptVolumes().filter(row => row.kind === 'vast')
export const vastVolumeFor = (recipe: HostRecipe): KeptVolume | undefined => vastKeptVolumes().find(row => matchesVolume(row, recipe) && row.state !== 'gone')
const vastMachineWords = (volume: Pick<KeptVolume, 'machineId'>): string => 'Vast.ai machine ' + (volume.machineId ?? 'unknown')
const vastVolumeSizeGb = (bytes: number): number => Math.ceil(bytes / 1e9 * 1.05) + 20
export const vastBootMinutes = (recipe: HostRecipe, volume: KeptVolume): string => /~(\d+) min total/.exec(hostSetupEstimate(recipe, { check: volume.verifiedSums?.sampleManifestSha256 ? 'sampled check' : 'full check ' + fullCheckMinutes(recipe.weightsGb) }))?.[1] ?? '?'
export const vastBootsFromVolume = (recipe: HostRecipe, machineId?: number): boolean => { const volume = vastVolumeFor(recipe); return volume?.state === 'kept' && machineId !== undefined && volume.machineId === machineId }
export function vastVolumeState(recipe: HostRecipe, volume = vastVolumeFor(recipe) ?? vastKeptVolumes().find(row => matchesVolume(row, recipe))): string {
  if (!volume) return 'not kept on Vast.ai'
  if (volume.state === 'gone') return 'not kept on Vast.ai · ' + (volume.error ?? 'volume gone')
  if (volume.state === 'creating') return 'preparing · create answer unclear; the Vast.ai volume may exist and bill · check Storage in the Vast.ai console'
  if (volume.state === 'kept') return 'weights kept on ' + vastMachineWords(volume) + ' (' + volume.size + ' GB, ' + vastVolumeBilling(volume) + ') · a rental on that machine boots in ~' + vastBootMinutes(recipe, volume) + ' min · other machines download'
  if (volume.state === 'failed') return 'failed · ' + vastMachineWords(volume) + ' · ' + keptDiskPrice(volume) + (volume.error ? ' · ' + volume.error : '') + ' · the next rental on that machine downloads again'
  return 'preparing on ' + vastMachineWords(volume) + ' · ' + vastVolumeBilling(volume) + (volume.preparingPod ? ' · on instance ' + volume.preparingPod : ' · filled by the next rental on that machine')
}
export function vastVolumeLabel(record: KeptVolume, live?: VastVolume): string {
  const using = live?.instances.length ? ' · used by instance ' + live.instances.join(', ') : ''
  return 'Vast.ai volume ' + record.id + ' · ' + vastMachineWords(record) + (record.hostingType ? ' · ' + record.hostingType : '') + ' · ' + vastVolumeBilling(record) + ' · weights' + (record.state === 'kept' ? '' : ' · ' + record.state) + using
}
export async function reconcileVastVolumes(api: VastClient, signal?: AbortSignal): Promise<VastVolume[]> {
  const live = await api.volumes(signal)
  for (const record of vastKeptVolumes()) {
    const found = record.id.startsWith('pending-') ? live.filter(row => row.name === record.name) : live.filter(row => String(row.id) === record.id)
    if (found.length > 1) throw new Error(record.name + ' has multiple matches on Vast.ai; check Storage in the console before retrying.')
    const row = found[0]
    if (row) {
      const next: KeptVolume = { ...record, id: String(row.id), size: row.diskGb ?? record.size, price: row.hourly !== undefined ? Math.round(row.hourly * 720 * 100) / 100 : record.price, machineId: row.machineId ?? record.machineId, ...(record.state === 'creating' || record.state === 'gone' ? { state: 'preparing' as const, verifiedSums: undefined, error: undefined, partialBytes: undefined } : {}) }
      writeKeptVolume(next)
      if (record.id !== next.id) removeVastRecord(record.id)
    } else if (record.state === 'creating' && Date.now() - Date.parse(record.createdAt) >= pendingGraceMs) writeKeptVolume({ ...record, state: 'gone', error: 'Vast.ai never listed ' + record.name + '; no volume was created' })
    else if (record.state !== 'creating' && record.state !== 'gone') writeKeptVolume({ ...record, state: 'gone', verifiedSums: undefined, error: undefined, partialBytes: undefined })
  }
  return live
}
const removeVastRecord = (id: string): void => removeKeptVolumeRecord(id)
export async function vastRentalVolume(api: VastClient, recipe: HostRecipe, offer: HostOffer, signal?: AbortSignal): Promise<HostVolumeMount | undefined> {
  if (!vastVolumeFor(recipe)) return
  try { await reconcileVastVolumes(api, signal) } catch (error) { throw new Error('The Vast.ai volume for this model cannot be confirmed while Vast.ai’s volume list is unavailable; no instance was created. ' + String(error)) }
  const rows = vastKeptVolumes().filter(row => matchesVolume(row, recipe) && row.state !== 'gone')
  if (rows.length > 1) throw new Error('Several Vast.ai volumes keep this model; open /llmhost → Bank before renting.')
  const volume = rows[0]
  if (!volume || offer.machineId === undefined || volume.machineId !== offer.machineId) return
  if (volume.state === 'creating') throw new Error(volume.name + ' may exist; refresh /llmhost → Bank before renting. No retry was sent.')
  if (volume.state === 'preparing' && volume.preparingPod && (await api.pods(signal)).some(pod => pod.id === volume.preparingPod)) throw new Error('Instance ' + volume.preparingPod + ' is still filling Vast.ai volume ' + volume.id + '; rent when the Bank shows it kept, or terminate that instance in Machines I’m paying for. No instance was created.')
  return { id: volume.id, kind: 'vast', machineId: volume.machineId }
}
export async function createVastKeptVolume(api: VastClient, recipe: HostRecipe, offer: VastVolumeOffer, sizeGb: number, signal: AbortSignal): Promise<KeptVolume> {
  if (vastVolumeFor(recipe)) throw new Error('This model already has a Vast.ai volume: ' + vastVolumeFor(recipe)!.id)
  signal.throwIfAborted()
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const monthly = Math.round(offer.storageCost * sizeGb * 100) / 100
  const record: KeptVolume = { id: 'pending-' + suffix, name: 'mercury_weights_' + suffix, model: recipe.model, include: recipe.include ?? '', recipeRow: recipe, kind: 'vast', dataCenter: 'Vast.ai machine ' + offer.machineId, size: sizeGb, price: monthly, storageCost: offer.storageCost, machineId: offer.machineId, hostingType: offer.hostingType, mountPath: VAST_VOLUME_MOUNT, createdAt: new Date().toISOString(), state: 'creating' }
  writeKeptVolume(record)
  try {
    const volume = await api.createVolume(offer, sizeGb, record.name, signal)
    const created: KeptVolume = { ...record, id: String(volume.id), state: 'preparing', machineId: volume.machineId ?? record.machineId, size: volume.diskGb ?? sizeGb }
    writeKeptVolume(created)
    removeVastRecord(record.id)
    return created
  } catch (error) {
    if (error instanceof HostCreateError && error.outcome === 'refused') { removeVastRecord(record.id); throw new Error('Vast.ai refused the volume; nothing bills. ' + String(error)) }
    throw new Error(record.name + ' may exist and bill on ' + vastMachineWords(record) + ': Vast.ai gave no clear create answer. Refresh the Bank or Machines I’m paying for before retrying; check Storage in the Vast.ai console. ' + String(error))
  }
}
export async function deleteVastKeptVolume(api: VastClient, id: string, readOnly?: HostReadOnly): Promise<void> {
  const record = readKeptVolume(id)
  if (!record || record.kind !== 'vast' || record.state === 'creating') throw new Error('This volume was created outside Mercury or its identity is not yet confirmed; it is read-only.')
  try { await api.deleteVolume(Number(id), readOnly) } catch (error) {
    const using = (await api.volumes().catch((): VastVolume[] => [])).find(row => String(row.id) === id)?.instances ?? []
    throw new Error('Vast.ai did not confirm the deletion of volume ' + id + (using.length ? ' while instance ' + using.join(', ') + ' still uses it; terminate that instance first' : '') + '. It may still bill ' + keptDiskPrice(record) + '; refresh Machines I’m paying for or check Storage in the Vast.ai console before trying again. ' + (error instanceof Error ? error.message : String(error)))
  }
  writeKeptVolume({ ...record, state: 'gone', verifiedSums: undefined, error: undefined, partialBytes: undefined })
}
export async function vastVolumeDeleteDoor(api: VastClient, id: string, ask: Ask, signal: AbortSignal, emit?: Emit, timeoutMs = 4 * 60_000): Promise<LlmHostResult> {
  await reconcileVastVolumes(api, signal)
  const record = readKeptVolume(id)
  if (!record || record.kind !== 'vast') return { ok: true, words: 'Created outside Mercury · read-only. Manage this volume in the Vast.ai console.' }
  if (record.state === 'gone') return { ok: true, words: 'The Vast.ai volume is gone. The next rental downloads the weights again.' }
  const choice = await ask({ step: 'volume-delete', title: 'Delete Vast.ai volume?', found: id + ' · ' + vastMachineWords(record) + ' · ' + vastVolumeBilling(record), willRun: 'The weights are gone after deletion; the next rental downloads them again. Vast.ai refuses to delete a volume while an instance still uses it; terminate that instance first.', rows: [{ value: 'delete', label: 'Confirm Delete Vast.ai volume' }, { value: 'cancel', label: 'Cancel' }] })
  if (choice !== 'delete' || signal.aborted) return { ok: true, words: 'Kept the volume. It bills ' + vastVolumeBilling(record) + ' until deleted.' }
  const confirming = hostJobReadOnly({ label: 'Vast.ai', pauseMs: 1000, timeoutMs, signal, mark: words => emit?.({ title: 'Delete Vast.ai volume', words: id + ' · ' + words }) })
  emit?.({ title: 'Delete Vast.ai volume', words: id + ' · deleting · waiting for Vast.ai to drop it from the volume list' })
  try { await deleteVastKeptVolume(api, id, confirming) } catch (error) { return { ok: false, words: error instanceof Error ? error.message : String(error) } }
  return { ok: true, words: 'Vast.ai volume deleted · verified absent from the volume list · the next rental downloads the weights again.' }
}
async function prepareVastVolume(api: VastClient, recipe: HostRecipe, volume: KeptVolume, offer: HostOffer, options: VastFastLoadOptions, signal: AbortSignal, fully = false): Promise<HostRecord> {
  if (!options.startJob) await requireHostJobOwner()
  const sshKey = await ensureHostKey(options.runner, signal)
  signal.throwIfAborted()
  const name = 'mercury-fill-' + randomUUID().slice(0, 12)
  let created: string | undefined
  try {
    const pod = await api.create(offer, sshKey.publicKey, name, { id: volume.id, kind: 'vast', machineId: volume.machineId })
    created = pod.id
    writeKeptVolume({ ...volume, state: 'preparing', preparingPod: pod.id, error: undefined })
    const record = queueHostSetup({ vendor: 'vast', id: pod.id, name: pod.name, recipe: offer.recipe.id, recipeRow: offer.recipe, price: offer.price, startedAt: pod.startedAt ?? pod.createdAt, status: pod.status, sessionId: options.sessionId, workspace: process.cwd(), sshKey: sshKey.path, apiBaseUrl: options.vastApiBaseUrl, volumeId: volume.id, prepareWeightsOnly: true, verifyWeightsFully: fully })
    options.startJob?.(record)
    return record
  } catch (error) {
    const detail = created ? created + ' exists and may still bill; Machines I’m paying for → Terminate. ' : error instanceof HostCreateError && error.outcome === 'refused' ? 'Vast.ai refused the temporary instance. ' : name + ' may exist and bill; check Machines I’m paying for before retrying. '
    writeKeptVolume({ ...volume, state: 'failed', preparingPod: created, error: detail + String(error) })
    throw new Error(detail + 'The Vast.ai volume still bills ' + vastVolumeBilling(volume) + '. ' + String(error))
  }
}
const fillWords = (offer: HostOffer): string => 'a temporary ' + hostShape(offer.recipe) + ' instance at ' + hourly(offer.price) + ' on that machine (the cheapest there with room; filling a volume needs no particular GPU)'
export async function mirrorToVastVolume(api: VastClient, recipe: HostRecipe, ask: Ask, emit: Emit, signal: AbortSignal, options: VastFastLoadOptions): Promise<LlmHostResult | undefined> {
  const manifest = pinnedWeightManifest(recipe)
  if (!manifest) { emit({ title: modelTitle(recipe), words: 'This recipe cannot be kept on Vast.ai without a trusted file manifest: ' + weightManifestWords(recipe) + '. No volume or instance was created.' }); return }
  const pinned: HostRecipe = recipe.weightManifest ? recipe : { ...recipe, weightManifest: manifest }
  await reconcileVastVolumes(api, signal)
  const existing = vastVolumeFor(recipe)
  if (existing) {
    const action = await ask({ step: 'vast-volume-kept', title: recipe.label + ' · Vast.ai', found: vastVolumeState(recipe, existing), willRun: 'The volume bills whether or not an instance runs on its machine. Reopen the Bank to refresh preparation.', rows: [...(existing.state === 'kept' ? [{ value: 'verify', label: 'Verify fully · rent a temporary instance on that machine to check every file' }] : []), ...(existing.state !== 'creating' ? [{ value: 'delete', label: 'Delete Vast.ai volume' }] : []), { value: 'back', label: 'Back' }] })
    if (action === 'verify') {
      const offer = (await api.machineOffers(pinned, existing.machineId!, signal))[0]
      if (!offer) { emit({ title: VAST_VOLUME_DOOR, words: 'No instance has stock on ' + vastMachineWords(existing) + ' right now. No instance was created; the volume still bills ' + vastVolumeBilling(existing) + '.' }); return }
      const confirm = await ask({ step: 'vast-volume-verify-confirm', title: 'Verify fully · check every file', found: existing.id + ' · ' + vastMachineWords(existing) + ' · ' + vastVolumeBilling(existing) + ' · full check ' + fullCheckMinutes(recipe.weightsGb), willRun: 'Rent ' + fillWords(offer) + ' for the verification, then terminate it and verify it is gone. A mismatch downloads the weights again on that instance first.', rows: [{ value: 'verify', label: 'Confirm full verification · temporary instance ' + hostShape(offer.recipe) + ' ' + hourly(offer.price) }, { value: 'cancel', label: 'Cancel' }] })
      if (confirm === 'verify' && !signal.aborted) await prepareVastVolume(api, pinned, existing, offer, options, signal, true)
      return
    }
    if (action === 'delete') { const result = await vastVolumeDeleteDoor(api, existing.id, ask, signal, emit); emit({ title: VAST_VOLUME_DOOR, words: result.words }) }
    if (!action) return { ok: true, words: 'Bank closed. Existing Vast.ai volumes keep billing until deleted.' }
    return
  }
  const sizeGb = vastVolumeSizeGb(manifestBytes(manifest))
  const [stock, volumeOffers] = await Promise.all([api.recipeOffers([recipe], signal), api.volumeOffers(sizeGb, undefined, signal)])
  if (!volumeOffers.length) { emit({ title: VAST_VOLUME_DOOR, words: 'No Vast.ai machine has ' + sizeGb + ' GB of volume space to sell right now. Nothing was created; refresh later.' }); return }
  const machines = volumeOffers.map(offer => ({ offer, rental: stock.filter(row => row.machineId === offer.machineId).sort((a, b) => a.price - b.price)[0] })).sort((a, b) => Number(!a.rental) - Number(!b.rental) || (a.rental?.price ?? 0) - (b.rental?.price ?? 0) || a.offer.storageCost - b.offer.storageCost)
  const machineLabel = (row: typeof machines[number]): string => 'machine ' + row.offer.machineId + ' · ' + row.offer.hostingType + (row.offer.geolocation ? ' · ' + row.offer.geolocation : '') + ' · ' + (row.rental ? hostShape(recipe) + ' in stock at ' + hourly(row.rental.price) : 'no ' + hostShape(recipe) + ' stock right now') + ' · volume $' + row.offer.storageCost.toFixed(2) + '/GB-month → $' + (row.offer.storageCost * sizeGb).toFixed(2) + '/month for ' + sizeGb + ' GB'
  const where = await ask({ step: 'vast-volume-where', title: 'Which Vast.ai machine keeps the weights?', found: recipe.label + ' · ' + sizeGb + ' GB volume (' + manifest.files.length + ' files, ' + (manifestBytes(manifest) / 1e9).toFixed(1) + ' GB, plus room for the engine’s compiled kernels)', willRun: 'A Vast.ai volume lives on one physical machine: only a rental on that machine boots from it; other machines download. Machines with stock for this shape come first. No volume has been created.', rows: [...machines.map(row => ({ value: String(row.offer.id), label: machineLabel(row) })), { value: 'back', label: 'Back' }] })
  if (!where) return { ok: true, words: 'Bank closed. No Vast.ai volume was created.' }
  if (where === 'back') return
  const chosen = machines.find(row => String(row.offer.id) === where)
  if (!chosen) throw new Error('Choose a machine from the live list.')
  const when = await ask({ step: 'vast-volume-when', title: 'When should the weights be prepared?', found: recipe.label + ' · machine ' + chosen.offer.machineId, willRun: 'Prepare now rents the cheapest instance on that machine with room (any GPU shape; it only downloads), fills and verifies the volume, then terminates that instance and verifies it is gone.', rows: [{ value: 'now', label: 'Prepare now · temporary instance on that machine plus the volume' }, { value: 'next', label: 'At the next rental on that machine · create the volume now; fill it when I rent there' }, { value: 'back', label: 'Back' }] })
  if (!when) return { ok: true, words: 'Bank closed. No Vast.ai volume was created.' }
  if (when === 'back') return
  if (when !== 'now' && when !== 'next') throw new Error('Choose a preparation time.')
  const fill = when === 'now' ? (await api.machineOffers(pinned, chosen.offer.machineId, signal))[0] : undefined
  if (when === 'now' && !fill) { emit({ title: VAST_VOLUME_DOOR, words: 'No instance has stock on machine ' + chosen.offer.machineId + ' right now, so nothing can fill a volume there. Nothing was created; choose another machine or prepare at the next rental.' }); return }
  const billing = vastVolumeBilling({ price: Math.round(chosen.offer.storageCost * sizeGb * 100) / 100, size: sizeGb, storageCost: chosen.offer.storageCost })
  const confirm = await ask({ step: 'vast-volume-confirm', title: 'Confirm Vast.ai volume · $' + (chosen.offer.storageCost * sizeGb).toFixed(2) + '/month', found: recipe.label + ' · ' + sizeGb + ' GB on machine ' + chosen.offer.machineId + ' (' + chosen.offer.hostingType + ') · ' + billing, willRun: 'Vast.ai bills the volume per GB-month at that machine’s rate from creation, with or without an instance, until you delete it.' + (fill ? ' Prepare now: ' + fillWords(fill) + ' until the download verifies; then Mercury terminates it and verifies it is gone. The instance downloads from Hugging Face onto the volume and verifies every file next to the GPUs; nothing is uploaded from your drive. A stalled download (' + keptStallWords + ') or one past ' + keptDownloadMinutes(recipe) + ' min also terminates the instance and keeps the partial volume.' : ' No instance now; your next rental on that machine downloads the weights from Hugging Face onto the volume and verifies them there; nothing is uploaded from your drive.'), rows: [{ value: 'confirm', label: 'Confirm $' + (chosen.offer.storageCost * sizeGb).toFixed(2) + '/month' + (fill ? ' + temporary instance ' + hostShape(fill.recipe) + ' ' + hourly(fill.price) : '') }, { value: 'cancel', label: 'Cancel' }] })
  if (confirm !== 'confirm' || signal.aborted) return
  if (fill && !options.startJob) await requireHostJobOwner()
  const volume = await createVastKeptVolume(api, pinned, chosen.offer, sizeGb, signal)
  if (fill) {
    try { await prepareVastVolume(api, pinned, volume, fill, options, signal) } catch (error) {
      throw new Error('Vast.ai volume ' + volume.id + ' exists and bills ' + billing + '. Machines I’m paying for → Delete. ' + String(error))
    }
  }
  emit({ title: VAST_VOLUME_DOOR, words: volume.id + ' · preparing on machine ' + chosen.offer.machineId + (fill ? ' · temporary instance terminates after verification' : ' at the next rental on that machine') + ' · ' + billing })
  return
}
