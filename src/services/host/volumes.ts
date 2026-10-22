import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { acquirePidLock, noteLockRelease, releasePidLock } from '../../substrate/pidLock.js'
import { z } from 'zod/v4'
import { publishAtomicSync } from '../../substrate/fileStore.js'
import { hostDirectory } from './store.js'
import type { HostRecipe } from './recipes.js'
import { hostRecipeSchema } from './recipesFile.js'
import { hostSetupEstimate } from '../../commands/llmhost/words.js'
import { createRefusal, RunpodHttpError, type HostPod, type RunpodClient, type HostVolume } from './runpod.js'

const volumeRecordSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/), name: z.string(), model: z.string(), include: z.string(),
  recipeRow: hostRecipeSchema.optional(),
  kind: z.enum(['network', 'global']), dataCenter: z.string(), size: z.number().positive(), price: z.number().nonnegative(), createdAt: z.string(),
  state: z.enum(['creating', 'preparing', 'kept', 'gone', 'failed']), filledBy: z.string().optional(), checkedBy: z.string().optional(), preparingPod: z.string().optional(), error: z.string().optional(), partialBytes: z.number().nonnegative().optional(),
  verifiedSums: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), sampleManifestSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), check: z.enum(['full', 'sampled']).optional(), files: z.number().int().positive(), bytes: z.number().positive(), at: z.string() }).optional(),
})
export type KeptVolume = z.infer<typeof volumeRecordSchema>
const directory = (): string => { const path = join(hostDirectory(), 'volumes'); mkdirSync(path, { recursive: true, mode: 0o700 }); return path }
const pathOf = (id: string): string => { if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid volume id'); return join(directory(), id + '.json') }
export const volumeModel = (recipe: HostRecipe): string => recipe.model + '\n' + (recipe.include ?? '')
export const matchesVolume = (volume: KeptVolume, recipe: HostRecipe): boolean => volume.model === recipe.model && volume.include === (recipe.include ?? '')
export function keptVolumes(): KeptVolume[] { return readdirSync(directory()).filter(name => name.endsWith('.json')).map(name => volumeRecordSchema.parse(JSON.parse(readFileSync(join(directory(), name), 'utf8')))) }
export function readKeptVolume(id: string): KeptVolume | undefined { try { return volumeRecordSchema.parse(JSON.parse(readFileSync(pathOf(id), 'utf8'))) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error } }
export function writeKeptVolume(record: KeptVolume): void { publishAtomicSync(pathOf(record.id), JSON.stringify(volumeRecordSchema.parse(record)) + '\n', { mode: 0o600 }) }
const removeRecord = (id: string): void => { try { unlinkSync(pathOf(id)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
export const networkMonthly = (size: number): number => Math.round((Math.min(size, 1000) * 0.07 + Math.max(0, size - 1000) * 0.05) * 100) / 100
export const volumePrice = (record: Pick<KeptVolume, 'kind' | 'price'>): string => (record.kind === 'global' ? '~' : '') + '$' + record.price.toFixed(2) + '/month' + (record.kind === 'global' ? ' + IOPS (actual usage)' : '')
export const gigabytes = (bytes: number): string => (bytes / 1e9).toFixed(2) + ' GB'
export const fullCheckMinutes = (weightsGb: number): string => Math.max(1, Math.round(weightsGb / 24)) + '–' + Math.max(1, Math.ceil(weightsGb / 12)) + ' min'
export const keptDiskPrice = (record: KeptVolume): string => record.kind === 'global' && record.partialBytes !== undefined ? '~$' + (record.partialBytes / 1e9 * 0.09).toFixed(2) + '/month for ' + gigabytes(record.partialBytes) + ' stored + IOPS' : volumePrice(record) + (record.kind === 'network' ? ' for its ' + record.size + ' GB' : '')
export function volumeLabel(volume: HostVolume): string {
  const own = readKeptVolume(volume.id)
  const amount = own ? keptDiskPrice(own) : volume.kind === 'global' ? '$0.09/GB/month + IOPS · size not reported by Runpod' : volume.type === 'STANDARD' ? '$' + networkMonthly(volume.size!).toFixed(2) + '/month' : 'monthly price depends on storage tier; see Runpod billing'
  return volume.name + ' · ' + volume.id + ' · ' + (volume.dataCenter ?? 'any DC') + ' · ' + amount + (own ? ' · weights disk' + (own.state === 'kept' ? '' : ' · ' + own.state + (own.partialBytes !== undefined ? ' · ' + gigabytes(own.partialBytes) + ' downloaded' : '')) : ' · created outside Mercury · read-only')
}
const pendingGraceMs = 10 * 60_000
export async function reconcileVolumes(api: RunpodClient, signal?: AbortSignal): Promise<HostVolume[]> {
  const live = await api.volumes(signal)
  for (const record of keptVolumes()) {
    const found = record.id.startsWith('pending-') ? live.filter(row => row.name === record.name && row.kind === record.kind) : live.filter(row => row.id === record.id && row.kind === record.kind)
    if (found.length > 1) throw new Error(record.name + ' has multiple matches in Runpod; inspect the account before retrying.')
    const row = found[0]
    if (row) {
      const next = { ...record, id: row.id, size: row.size ?? record.size, price: row.kind === 'network' && row.size ? networkMonthly(row.size) : record.price, dataCenter: row.dataCenter ?? 'any DC', ...(record.state === 'creating' || record.state === 'gone' ? { state: 'preparing' as const, verifiedSums: undefined, error: undefined, partialBytes: undefined } : {}) }
      writeKeptVolume(next)
      if (record.id !== row.id) removeRecord(record.id)
    } else if (record.state === 'creating' && Date.now() - Date.parse(record.createdAt) >= pendingGraceMs) writeKeptVolume({ ...record, state: 'gone', error: 'Runpod never listed ' + record.name + '; no disk was created' })
    else if (record.state !== 'creating' && record.state !== 'gone') writeKeptVolume({ ...record, state: 'gone', verifiedSums: undefined, error: undefined, partialBytes: undefined })
  }
  return live
}
export async function rentalVolume(api: RunpodClient, recipe: HostRecipe, signal?: AbortSignal): Promise<KeptVolume | undefined> {
  if (!keptVolumes().some(row => matchesVolume(row, recipe) && row.state !== 'gone')) return
  try { await reconcileVolumes(api, signal) } catch (error) { throw new Error('The weights disk for this model cannot be confirmed while Runpod’s volume list is unavailable; no pod was created. ' + String(error)) }
  const rows = keptVolumes().filter(row => matchesVolume(row, recipe) && row.state !== 'gone')
  if (rows.length > 1) throw new Error('Multiple weights disks for this model; open Fast-load before renting.')
  const volume = rows[0]
  if (volume?.state === 'creating') throw new Error(volume.name + ' may exist; refresh Fast-load before renting. No retry was sent.')
  if (volume?.state === 'preparing' && volume.preparingPod && (await api.pods(signal)).some(pod => pod.id === volume.preparingPod)) throw new Error('Pod ' + volume.preparingPod + ' is still filling weights disk ' + volume.id + '; rent when Fast-load shows it kept, or terminate that pod in Pods I’m paying for. No pod was created.')
  return volume
}
async function createKeptVolumeLocked(api: RunpodClient, recipe: HostRecipe, kind: KeptVolume['kind'], dataCenter: string, signal: AbortSignal): Promise<KeptVolume> {
  const existing = await rentalVolume(api, recipe, signal)
  if (existing) throw new Error('This model already has a weights disk: ' + existing.id)
  signal.throwIfAborted()
  const suffix = randomUUID()
  const record: KeptVolume = { id: 'pending-' + suffix, name: 'mercury-weights-' + suffix, model: recipe.model, include: recipe.include ?? '', recipeRow: recipe, kind, dataCenter: kind === 'global' ? 'any DC' : dataCenter, size: recipe.diskGb, price: kind === 'global' ? recipe.weightsGb * 0.09 : networkMonthly(recipe.diskGb), createdAt: new Date().toISOString(), state: 'creating' }
  writeKeptVolume(record)
  try {
    const volume = await api.createVolume(kind, record.name, record.size, dataCenter)
    const created = { ...record, id: volume.id, state: 'preparing' as const }
    writeKeptVolume(created)
    removeRecord(record.id)
    return created
  } catch (error) {
    if (createRefusal(error)) { removeRecord(record.id); throw new Error('Runpod refused the weights disk. ' + String(error)) }
    throw new Error(record.name + ' may exist and bill: Runpod gave no clear create answer. Refresh Fast-load or Pods I’m paying for before retrying. ' + String(error))
  }
}
export async function createKeptVolume(api: RunpodClient, recipe: HostRecipe, kind: KeptVolume['kind'], dataCenter: string, signal: AbortSignal): Promise<KeptVolume> {
  const owner = randomUUID()
  const lock = join(directory(), createHash('sha256').update(volumeModel(recipe)).digest('hex') + '.lock')
  if (!(await acquirePidLock(lock, owner, { liveness: 'assume-alive' })).held) throw new Error('Another fast-load creation is in progress for this model. Refresh the catalogue; do not create another disk.')
  try { return await createKeptVolumeLocked(api, recipe, kind, dataCenter, signal) } finally { noteLockRelease('fast-load creation', await releasePidLock(lock, owner)) }
}
export async function deleteKeptVolume(api: RunpodClient, id: string): Promise<void> {
  const record = readKeptVolume(id)
  if (!record || record.state === 'creating') throw new Error('This volume was created outside Mercury or its identity is not yet confirmed; it is read-only.')
  try { await api.deleteVolume(record.kind, id) } catch (error) {
    if (createRefusal(error) || error instanceof RunpodHttpError && error.status === 409) {
      const mounting = (await api.pods().catch((): HostPod[] => [])).filter(pod => [...(pod.mounts?.network ?? []), ...(pod.mounts?.global ?? [])].some(row => row.volumeId === id))
      throw new Error('Runpod refused to delete ' + id + (mounting.length ? ' while ' + mounting.map(pod => pod.id + ' (' + pod.status + ')').join(', ') + (mounting.length > 1 ? ' still mount it; terminate those pods first' : ' still mounts it; terminate that pod first') + (record.kind === 'global' ? ' (a stopped pod still counts).' : '.') : '.') + ' Nothing was deleted; the disk still bills ' + keptDiskPrice(record) + '. ' + (error as Error).message)
    }
    if (!(error instanceof RunpodHttpError && error.status === 404)) throw new Error('Runpod gave no clear answer to deleting ' + id + '; it may still exist and bill ' + keptDiskPrice(record) + '. Refresh Pods I’m paying for before trying again. ' + String(error))
  }
  if ((await api.volumes()).some(row => row.id === id)) throw new Error('Runpod still lists the disk; deletion is not yet verified and storage may still bill.')
  writeKeptVolume({ ...record, state: 'gone', verifiedSums: undefined, error: undefined, partialBytes: undefined })
}
export function fastLoadEstimate(recipe: HostRecipe, volume?: KeptVolume): string {
  return hostSetupEstimate(recipe, volume?.state === 'kept' ? { check: volume.verifiedSums?.sampleManifestSha256 ? 'sampled check' : 'full check ' + fullCheckMinutes(recipe.weightsGb) } : undefined)
}
