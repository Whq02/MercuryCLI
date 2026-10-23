import { isIP } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod/v4'
import { recipeFits, type HostRecipe } from '../recipes.js'
import { currentHostRecipes } from '../recipesFile.js'
import { HOST_VENDOR_INFO, type HostOffer, type HostPod, type HostVendor } from './vendor.js'
import { HostCreateError, HostVendorHttpError, VendorApi, isOpenSshKey, keyMaterial, retryAfterSeconds, type VendorTiming } from './http.js'
import { HostTerminationUnconfirmed, type HostReadOnly } from '../retry.js'
import { keptVolumes, matchesVolume } from '../volumes.js'

import type { LlmHostRoad } from '../../llmHost/index.js'

export class VastOfferGone extends HostCreateError {
  constructor(readonly replacement?: HostOffer, detail = '') {
    super('Vast.ai refused it; nothing was rented. That machine is no longer available. ' + (replacement ? 'Another machine is available at $' + replacement.price.toFixed(2) + '/hr; confirm before renting.' : detail || 'No other machine for this recipe is available.'), 'refused', undefined, 410, 'no_such_ask')
  }
}
export async function createVastRental(api: VastClient, offer: HostOffer, publicKey: string, name: string, ask: Parameters<LlmHostRoad>[0], emit: Parameters<LlmHostRoad>[1], signal: AbortSignal): Promise<{ pod: HostPod; offer: HostOffer } | undefined> {
  try { return { pod: await api.create(offer, publicKey, name), offer } } catch (error) {
    if (!(error instanceof VastOfferGone)) throw error
    const next = error.replacement
    if (!next) { emit({ title: 'Vast.ai stock', words: error.message }); return }
    const choice = await ask({ step: 'vast-replacement', title: 'That machine is no longer available', found: 'Nothing was rented. Another ' + next.recipe.count + '× ' + next.recipe.gpu + ' for ' + next.recipe.label + ' is available at $' + next.price.toFixed(2) + '/hr (previously $' + offer.price.toFixed(2) + '/hr).', willRun: VAST_STORAGE_NOTICE + ' Billing starts only if you confirm this new price.', rows: [{ value: 'rent', label: 'Confirm $' + next.price.toFixed(2) + '/hr · rent this machine' }, { value: 'cancel', label: 'Cancel' }] })
    if (choice !== 'rent' || signal.aborted) return
    return { pod: await api.create(next, publicKey, name, undefined, false), offer: next }
  }
}
export const VAST_STORAGE_NOTICE = '/workspace uses the instance container disk. Stop retains data and storage billing, and a restart waits until the host’s GPUs are free; terminate deletes the disk and its data. No separate volume is created.'
export const VAST_KEY_NOTICE = 'Renting adds Mercury’s SSH public key to your Vast.ai account keys, which Vast.ai installs on your instances. Remove it at https://cloud.vast.ai/manage-keys/ when you stop renting through Mercury.'
export const VAST_GPU_NAMES: Readonly<Record<string, string>> = {
  H100: 'NVIDIA H100', 'H100 SXM': 'NVIDIA H100', 'H100 PCIE': 'NVIDIA H100',
  H200: 'NVIDIA H200', 'H200 NVL': 'NVIDIA H200', B200: 'NVIDIA B200', B300: 'NVIDIA B300', 'B300 PC': 'NVIDIA B300', GB300: 'NVIDIA GB300',
  A100: 'NVIDIA A100', 'A100 SXM4': 'NVIDIA A100',
  'RTX PRO 6000': 'NVIDIA RTX PRO 6000 Blackwell', 'RTX PRO 6000 WS': 'NVIDIA RTX PRO 6000 Blackwell',
  'RTX PRO 6000 S': 'NVIDIA RTX PRO 6000 Blackwell', 'RTX PRO 6000 BLACKWELL': 'NVIDIA RTX PRO 6000 Blackwell',
  'RTX PRO 6000 BLACKWELL SERVER EDITION': 'NVIDIA RTX PRO 6000 Blackwell',
}
const ONSTART = 'mkdir -p /workspace && touch /root/.no_auto_tmux'
const gpuName = (name: string): string | undefined => VAST_GPU_NAMES[name.toUpperCase().replace(/^NVIDIA\s+/, '').replaceAll('_', ' ').replace(/\s+/g, ' ').trim()]
const gigabytes = (mebibytes: number): number => mebibytes * 1048576 / 1e9
const mebibyteFloor = (gigabytes: number): number => Math.floor(gigabytes * 1e9 / 1048576)
const directPort = (ports: unknown): number | undefined => {
  const mapped = ports && typeof ports === 'object' && !Array.isArray(ports) ? (ports as Record<string, unknown>)['22/tcp'] : undefined
  const first = Array.isArray(mapped) ? mapped[0] as { HostPort?: unknown } | undefined : undefined
  const port = Number(typeof first?.HostPort === 'string' ? first.HostPort.trim() : first?.HostPort)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined
}
const idSchema = z.number().int().positive()
const offerSchema = z.object({
  id: idSchema, gpu_name: z.string(), gpu_ram: z.number().positive(), num_gpus: z.number().int().positive(), dph_total: z.number().positive(),
  verification: z.string(), reliability2: z.number().nullable().optional(), reliability: z.number().nullable().optional(), direct_port_count: z.number(),
  rentable: z.boolean(), rented: z.boolean(), cuda_max_good: z.number(), disk_space: z.number(), geolocation: z.string().nullable().optional(), datacenter: z.boolean().nullable().optional(),
  machine_id: idSchema.nullable().optional(),
})
const hostingType = (datacenter: boolean | null | undefined): NonNullable<HostOffer['hostingType']> => datacenter === true ? 'datacenter' : datacenter === false ? 'community host' : 'host'
const volumeOfferSchema = z.object({
  id: idSchema, machine_id: idSchema, host_id: z.number().nullable().optional(), disk_space: z.number().nonnegative(), storage_cost: z.number().nonnegative().nullable().optional(), storage_total_cost: z.number().nullable().optional(),
  verification: z.string().nullable().optional(), reliability2: z.number().nullable().optional(), reliability: z.number().nullable().optional(), geolocation: z.string().nullable().optional(), datacenter: z.boolean().nullable().optional(),
  cuda_max_good: z.number().nullable().optional(), disk_bw: z.number().nullable().optional(), inet_down: z.number().nullable().optional(), inet_up: z.number().nullable().optional(),
})
const volumeRowSchema = z.object({
  id: idSchema, label: z.string().nullable().optional(), name: z.string().nullable().optional(), status: z.string().nullable().optional(), machine_id: z.number().nullable().optional(), host_id: z.number().nullable().optional(),
  disk_space: z.number().nullable().optional(), storage_total_cost: z.number().nullable().optional(), storage_cost: z.number().nullable().optional(), instances: z.unknown().optional(), start_date: z.number().nullable().optional(), deleted_at: z.string().nullable().optional(),
})
const volumeRows = z.array(volumeRowSchema)
const volumeListSchema = z.union([volumeRows, z.object({ volumes: volumeRows }), z.object({ data: volumeRows })]).transform(value => Array.isArray(value) ? value : 'volumes' in value ? value.volumes : value.data)
const volumeCreatedSchema = z.object({ success: z.literal(true), volume_name: z.string().nullable().optional(), volume_id: z.number().nullable().optional(), id: z.number().nullable().optional() })
export const VAST_VOLUME_MOUNT = '/workspace/mercury-weights'
export const VAST_VOLUME_NOTICE = 'A Vast.ai volume lives on one physical machine: only an instance on that machine can mount it, it bills per GB-month for its whole size with or without an instance (never while the machine is offline), and it cannot be resized or moved. Delete it from Machines I’m paying for when you stop renting there.'
export interface VastVolumeOffer { id: number; machineId: number; hostId?: number; diskGb: number; storageCost: number; verification: string; reliability: number; geolocation?: string; hostingType: NonNullable<HostOffer['hostingType']>; cudaMaxGood?: number }
export interface VastVolume { id: number; name: string; status: string; machineId?: number; diskGb?: number; hourly?: number; instances: string[]; createdAt: string }
const instanceIds = (value: unknown): string[] => Array.isArray(value) ? value.flatMap(row => typeof row === 'number' ? [String(row)] : row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'number' ? [String((row as { id: number }).id)] : []) : []
const instanceSchema = z.object({
  id: idSchema, label: z.string().nullable().optional(), actual_status: z.string().nullable().optional(), dph_total: z.number().nonnegative(), start_date: z.number().nonnegative().nullable().optional(),
  public_ipaddr: z.string().nullable().optional(), ports: z.unknown().optional(),
})
const instanceListSchema = z.object({ success: z.literal(true), instances: z.array(instanceSchema), instances_found: z.number().int().nonnegative(), total_instances: z.number().int().nonnegative(), next_token: z.string().min(1).nullable() })
const keyRowSchema = z.object({ key: z.string().optional(), public_key: z.string().optional(), deleted_at: z.string().nullable().optional() })
const keyRows = z.array(keyRowSchema)
const keyListSchema = z.union([keyRows, z.object({ ssh_keys: keyRows }), z.object({ keys: keyRows }), z.object({ data: keyRows })]).transform(value => (Array.isArray(value) ? value : 'ssh_keys' in value ? value.ssh_keys : 'keys' in value ? value.keys : value.data).flatMap(row => { const key = row.key ?? row.public_key; return key ? [{ key, deleted_at: row.deleted_at }] : [] }))
const success = z.object({ success: z.literal(true) })
const fingerprint = (offer: HostOffer): string => JSON.stringify(offer)
const sortOffers = (a: HostOffer, b: HostOffer): number => Number(a.recipe.verified.by === 'unverified') - Number(b.recipe.verified.by === 'unverified') || a.price - b.price || a.recipe.id.localeCompare(b.recipe.id)

export class VastClient implements HostVendor {
  readonly vendor = 'vast' as const
  readonly label = HOST_VENDOR_INFO.vast.label
  readonly keyHelp = HOST_VENDOR_INFO.vast.keyHelp
  readonly capabilities = { stop: true, dataCenters: false, persistentDisk: 'root' } as const
  private api: VendorApi
  private lastShapes: HostOffer[] = []
  private note = ''
  private placements = new WeakMap<HostOffer, { id: number; fingerprint: string }>()
  constructor(key: string, base = 'https://console.vast.ai/api/v0', private timing: VendorTiming = {}) {
    this.api = new VendorApi(this.label, key, base, ['https://console.vast.ai/api/v0', 'https://console.vast.ai/api/v1'], [400, 401, 403, 404, 410, 429], timing)
  }
  rateLimitPolicy(): string { return this.api.policy() ?? 'Vast.ai limits requests per endpoint and identity; search backs off five seconds on HTTP 429 within its read deadline. Creates are never retried.' }
  shapes(): readonly HostOffer[] { return this.lastShapes }
  offersNote(): string { return this.note }
  private async searchPage(body: unknown, signal?: AbortSignal): Promise<z.infer<typeof offerSchema>[]> {
    const deadline = AbortSignal.timeout(this.timing.requestTimeoutMs ?? 30000)
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline
    for (;;) {
      try {
        return (await this.api.request('/api/v0/bundles/', z.object({ offers: z.array(offerSchema) }), 'POST', body, bounded)).offers
      } catch (error) {
        if (!(error instanceof HostVendorHttpError) || error.status !== 429 || bounded.aborted) throw error
        await delay(5000, undefined, { signal: bounded })
      }
    }
  }
  private async search(recipes: readonly HostRecipe[], signal?: AbortSignal): Promise<{ offers: HostOffer[]; unmapped: Map<string, Set<number>> }> {
    const offers: HostOffer[] = []
    const unmapped = new Map<string, Set<number>>()
    const groups = new Map<string, HostRecipe[]>()
    for (const recipe of recipes) {
      const group = [recipe.count, recipe.cuda, recipe.diskGb].join(':')
      groups.set(group, [...(groups.get(group) ?? []), recipe])
    }
    for (const rows of groups.values()) {
      const first = rows[0]!
      const found = await this.searchPage({
        verified: { eq: true }, rentable: { eq: true }, rented: { eq: false }, reliability: { gte: 0.99 }, direct_port_count: { gte: 1 },
        num_gpus: { eq: first.count }, gpu_ram: { gte: mebibyteFloor(Math.min(...rows.map(row => row.vramGb))) }, cuda_max_good: { gte: Number(first.cuda) },
        disk_space: { gte: first.diskGb }, allocated_storage: first.diskGb, type: 'ondemand', order: [['dph_total', 'asc']],
      }, signal)
      for (const hardware of found) {
        const reliability = hardware.reliability2 ?? hardware.reliability ?? 0
        if (hardware.verification !== 'verified' || reliability < 0.99 || reliability > 1 || (hardware.reliability != null && hardware.reliability < 0.99) || hardware.direct_port_count < 1 || !hardware.rentable || hardware.rented || hardware.num_gpus !== first.count || hardware.cuda_max_good < Number(first.cuda) || hardware.disk_space < first.diskGb) continue
        const gpuId = gpuName(hardware.gpu_name)
        if (!gpuId) {
          const name = this.api.redact(hardware.gpu_name).replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, 48) || 'unnamed GPU'
          unmapped.set(name, (unmapped.get(name) ?? new Set<number>()).add(hardware.id))
          continue
        }
        for (const recipe of rows) {
          if (!recipeFits(recipe, gpuId, gigabytes(hardware.gpu_ram), hardware.num_gpus)) continue
          const offer: HostOffer = { recipe, gpuId, price: hardware.dph_total, availability: 'HIGH', hostingType: hostingType(hardware.datacenter), ...(hardware.machine_id ? { machineId: hardware.machine_id } : {}) }
          this.placements.set(offer, { id: hardware.id, fingerprint: fingerprint(offer) })
          offers.push(offer)
        }
      }
    }
    return { offers: offers.sort(sortOffers), unmapped }
  }
  async recipeOffers(recipes: readonly HostRecipe[], signal?: AbortSignal): Promise<HostOffer[]> { return (await this.search(recipes, signal)).offers }
  async machineOffers(recipe: HostRecipe, machineId: number, signal?: AbortSignal): Promise<HostOffer[]> {
    const containerGb = 30
    const found = await this.searchPage({ verified: { eq: true }, rentable: { eq: true }, rented: { eq: false }, direct_port_count: { gte: 1 }, machine_id: { eq: machineId }, disk_space: { gte: containerGb }, allocated_storage: containerGb, type: 'ondemand', order: [['dph_total', 'asc']] }, signal)
    const offers: HostOffer[] = []
    for (const hardware of found) {
      if (hardware.verification !== 'verified' || !hardware.rentable || hardware.rented || hardware.direct_port_count < 1 || hardware.disk_space < containerGb || hardware.machine_id !== machineId) continue
      const gpuId = gpuName(hardware.gpu_name) ?? hardware.gpu_name.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, 48)
      const offer: HostOffer = { recipe: { ...recipe, gpu: gpuId.replace(/^NVIDIA\s+/, ''), count: hardware.num_gpus, vramGb: Math.round(gigabytes(hardware.gpu_ram)), cuda: String(hardware.cuda_max_good), nodes: undefined, diskGb: containerGb }, gpuId, price: hardware.dph_total, availability: 'HIGH', hostingType: hostingType(hardware.datacenter), machineId }
      this.placements.set(offer, { id: hardware.id, fingerprint: fingerprint(offer) })
      offers.push(offer)
    }
    return offers.sort((a, b) => a.price - b.price)
  }
  async volumeOffers(minGb: number, machineId?: number, signal?: AbortSignal): Promise<VastVolumeOffer[]> {
    const body = { verified: { eq: true }, external: { eq: false }, disk_space: { gte: minGb }, ...(machineId ? { machine_id: { eq: machineId } } : {}), order: [['storage_cost', 'asc']], limit: 64, allocated_storage: minGb }
    const found = (await this.api.request('/api/v0/volumes/search/', z.object({ offers: z.array(volumeOfferSchema) }), 'POST', body, signal)).offers
    return found.filter(row => row.disk_space >= minGb && (row.verification ?? 'verified') === 'verified' && (machineId === undefined || row.machine_id === machineId)).map(row => ({ id: row.id, machineId: row.machine_id, hostId: row.host_id ?? undefined, diskGb: row.disk_space, storageCost: row.storage_cost ?? (row.storage_total_cost != null && minGb > 0 ? row.storage_total_cost * 720 / minGb : 0), verification: row.verification ?? 'verified', reliability: row.reliability2 ?? row.reliability ?? 0, geolocation: row.geolocation ?? undefined, hostingType: hostingType(row.datacenter), cudaMaxGood: row.cuda_max_good ?? undefined })).sort((a, b) => a.storageCost - b.storageCost || a.machineId - b.machineId)
  }
  async volumes(signal?: AbortSignal): Promise<VastVolume[]> {
    const rows = await this.api.request('/api/v0/volumes?owner=me&type=local_volume', volumeListSchema, 'GET', undefined, signal)
    return rows.filter(row => !row.deleted_at).map(row => ({ id: row.id, name: this.api.redact(row.label ?? row.name ?? 'V.' + row.id), status: row.status ?? 'unknown', machineId: row.machine_id ?? undefined, diskGb: row.disk_space ?? undefined, hourly: row.storage_total_cost ?? undefined, instances: instanceIds(row.instances), createdAt: row.start_date != null && row.start_date > 0 ? new Date(row.start_date * 1000).toISOString() : '' }))
  }
  async createVolume(offer: VastVolumeOffer, sizeGb: number, name: string, signal?: AbortSignal): Promise<VastVolume> {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new Error('Vast.ai volume names are letters, digits and underscores, at most 64.')
    const size = Math.ceil(sizeGb)
    if (!(size > 0) || size > offer.diskGb) throw new Error('Vast.ai machine ' + offer.machineId + ' sells at most ' + offer.diskGb + ' GB of volume space; ' + size + ' GB does not fit. Nothing was created.')
    const answer = await this.api.request('/api/v0/volumes/', volumeCreatedSchema, 'PUT', { id: offer.id, size, name }, signal, true)
    const named = answer.volume_id ?? answer.id ?? Number(/^V\.(\d+)$/.exec(answer.volume_name ?? '')?.[1])
    for (let attempt = 1; ; attempt++) {
      let listed: VastVolume[] | undefined
      try { listed = await this.volumes(signal) } catch { listed = undefined }
      const found = listed?.filter(row => row.name === name || Number.isInteger(named) && row.id === named) ?? []
      if (found.length === 1) return found[0]!
      if (found.length > 1) throw new HostCreateError('Vast.ai lists ' + found.length + ' volumes named ' + name + '; they bill. Check Storage in the Vast.ai console before creating another.', 'ambiguous')
      if (attempt >= 3) throw new HostCreateError('Vast.ai accepted the volume' + (answer.volume_name ? ' (' + this.api.redact(answer.volume_name) + ')' : '') + ' but does not list it yet; it may bill. Check Storage in the Vast.ai console before creating another.', 'ambiguous')
      await delay(this.timing.pollMs ?? 2500, undefined, { signal })
    }
  }
  async deleteVolume(id: number, readOnly?: HostReadOnly): Promise<void> {
    if (!Number.isInteger(id) || id <= 0) throw new Error('Vast.ai requires a numeric volume ID.')
    try { await this.api.request('/api/v0/volumes/?id=' + id, success, 'DELETE', { id }) } catch (error) { if (!(error instanceof HostVendorHttpError && error.status === 404)) throw error }
    const deadline = Date.now() + (this.timing.readyTimeoutMs ?? 120000)
    let last = ''
    for (;;) {
      try { if (!(await (readOnly ? readOnly('volume listing', signal => this.volumes(signal)) : this.volumes())).some(row => row.id === id)) return } catch (error) { if (readOnly) throw new HostTerminationUnconfirmed(this.label, error); last = ' ' + (error instanceof Error ? error.message : String(error)) }
      if (Date.now() >= deadline) throw new Error('Vast.ai still lists volume ' + id + '; the deletion is not verified and it may still bill. Check Storage in the Vast.ai console.' + last)
      await delay(this.timing.pollMs ?? 2000)
    }
  }
  async offers(signal: AbortSignal): Promise<HostOffer[]> {
    this.lastShapes = []
    this.note = ''
    const { offers, unmapped } = await this.search(currentHostRecipes(), signal)
    this.lastShapes = offers
    const total = [...unmapped.values()].reduce((sum, ids) => sum + ids.size, 0)
    const names = [...unmapped].map(([name, ids]) => name + ' ×' + ids.size)
    this.note = total ? 'Skipped ' + total + ' Vast.ai offer' + (total === 1 ? '' : 's') + ' whose GPU name Mercury does not map: ' + names.slice(0, 6).join(', ') + (names.length > 6 ? ', …' : '') + '.' : ''
    return [...this.lastShapes]
  }
  async watchOffer(recipe: HostRecipe, maxPrice: number, signal?: AbortSignal): Promise<HostOffer | undefined> {
    const model = recipe.label.split(' · ')[0]
    const siblings = [recipe, ...currentHostRecipes().filter(row => row.id !== recipe.id && (row.label.split(' · ')[0] === model && row.count === recipe.count && row.cuda === recipe.cuda))]
    const kept = this.keptMachine(recipe)
    return (await this.search(siblings.length ? siblings : [recipe], signal)).offers.filter(row => row.price <= maxPrice).sort((a, b) => Number(kept !== undefined && b.machineId === kept) - Number(kept !== undefined && a.machineId === kept) || Number(b.recipe.id === recipe.id) - Number(a.recipe.id === recipe.id) || sortOffers(a, b))[0]
  }
  keptMachine: (recipe: HostRecipe) => number | undefined = recipe => keptVolumes().find(row => row.kind === 'vast' && row.state === 'kept' && matchesVolume(row, recipe))?.machineId
  private pod(row: z.infer<typeof instanceSchema>): HostPod {
    const host = row.public_ipaddr?.trim()
    const port = directPort(row.ports)
    const direct = row.actual_status === 'running' && host && isIP(host) && port ? { host, port, username: 'root' } : null
    const status = row.actual_status === 'running' ? 'RUNNING' : row.actual_status === 'stopped' ? 'EXITED' : ['exited', 'unknown', 'offline'].includes(row.actual_status ?? '') ? 'ERROR' : (row.actual_status ?? 'PENDING').toUpperCase()
    const createdAt = row.start_date != null && row.start_date > 0 ? new Date(row.start_date * 1000).toISOString() : ''
    return { id: String(row.id), name: this.api.redact(row.label ?? String(row.id)), status, cost: row.dph_total, createdAt, startedAt: createdAt || null, ssh: { direct } }
  }
  async pods(signal?: AbortSignal): Promise<HostPod[]> {
    const pods: HostPod[] = []
    const ids = new Set<number>()
    const tokens = new Set<string>()
    const query = new URLSearchParams({ limit: '25', order_by: JSON.stringify([{ col: 'id', dir: 'asc' }]) })
    let total = 0
    const incomplete = () => new Error('Vast.ai returned an incomplete instance list; check the console before renting or declaring termination complete.')
    for (;;) {
      const page = await this.api.request('/api/v1/instances/?' + query, instanceListSchema, 'GET', undefined, signal)
      if (page.instances_found !== page.instances.length) throw incomplete()
      total = Math.max(total, page.total_instances)
      for (const row of page.instances) {
        if (ids.has(row.id)) throw incomplete()
        ids.add(row.id)
        pods.push(this.pod(row))
      }
      if (!page.next_token) {
        if (pods.length !== total) throw incomplete()
        return pods
      }
      if (!page.instances.length || tokens.has(page.next_token)) throw incomplete()
      tokens.add(page.next_token)
      query.set('after_token', page.next_token)
    }
  }
  async get(id: string, signal?: AbortSignal): Promise<HostPod> {
    if (!/^[1-9][0-9]*$/.test(id)) throw new Error('Vast.ai requires a numeric instance ID.')
    const { instances } = await this.api.request('/api/v0/instances/' + id + '/', z.object({ instances: instanceSchema }), 'GET', undefined, signal)
    if (String(instances.id) !== id) throw new Error('Vast.ai returned a different instance ID.')
    return this.pod(instances)
  }
  private async registerKey(publicKey: string): Promise<void> {
    const material = keyMaterial(publicKey)
    const listed = async (): Promise<boolean> => {
      try { return (await this.api.request('/api/v0/ssh/', keyListSchema)).some(row => !row.deleted_at && keyMaterial(row.key) === material) } catch (error) {
        if (error instanceof HostVendorHttpError && error.status === 404) return false
        throw error
      }
    }
    await this.api.serial(async () => {
      if (await listed()) return
      try {
        const created = await this.api.request('/api/v0/ssh/', z.object({ success: z.literal(true), key: z.object({ public_key: z.string() }) }), 'POST', { ssh_key: publicKey.trim() })
        if (keyMaterial(created.key.public_key) !== material) throw new Error('Vast.ai answered with a different public key.')
      } catch (error) {
        if (await listed().catch(() => false)) return
        throw new Error(this.api.redact('Vast.ai did not confirm Mercury’s SSH key on the account; no rent was sent. ' + (error instanceof Error ? error.message : String(error)) + ' Check SSH keys at https://cloud.vast.ai/manage-keys/.'))
      }
    }).catch(error => { throw new HostCreateError(this.api.redact('no instance was created — the SSH key step failed: ' + (error instanceof Error ? error.message : String(error))), 'refused') })
  }
  async create(offer: HostOffer, publicKey: string, name: string, volume?: Parameters<HostVendor['create']>[3], findReplacement = true): Promise<HostPod> {
    const placement = this.placements.get(offer)
    if (!placement || placement.fingerprint !== fingerprint(offer)) throw new Error('Choose an unchanged offer returned by this Vast.ai client before renting.')
    if (!isOpenSshKey(publicKey)) throw new Error('Vast.ai needs one OpenSSH public key.')
    if (volume && volume.kind !== 'vast') throw new Error('A Runpod weights disk cannot be attached to a Vast.ai instance. Nothing was created.')
    if (volume && !/^[1-9][0-9]*$/.test(volume.id)) throw new Error('Vast.ai requires a numeric volume ID. Nothing was created.')
    if (volume?.machineId !== undefined && offer.machineId !== volume.machineId) throw new Error('The kept volume lives on Vast.ai machine ' + volume.machineId + '; choose an offer on that machine. Nothing was created.')
    await this.api.reconcile(() => this.pods())
    await this.registerKey(publicKey)
    let contract: number
    try {
      contract = (await this.api.request('/api/v0/asks/' + placement.id + '/', z.object({ success: z.literal(true), new_contract: idSchema }), 'PUT', {
        image: offer.recipe.image, disk: offer.recipe.diskGb, label: name, runtype: 'ssh_direct', cancel_unavail: true, onstart: ONSTART,
        env: { HF_HOME: '/workspace/huggingface' },
        ...(volume ? { volume_info: { create_new: false, volume_id: Number(volume.id), mount_path: VAST_VOLUME_MOUNT } } : {}),
      }, undefined, true)).new_contract
    } catch (error) {
      if (findReplacement && error instanceof HostCreateError && error.outcome === 'refused' && error.status === 410 && (error.code === 'no_such_ask' || error.message.includes('no_such_ask'))) {
        let replacement: HostOffer | undefined
        try { replacement = (await this.search([offer.recipe])).offers.find(row => this.placements.get(row)?.id !== placement.id && (volume?.machineId === undefined || row.machineId === volume.machineId)) } catch { throw new VastOfferGone(undefined, 'Replacement stock could not be read; refresh stock before trying again.') }
        throw new VastOfferGone(replacement, volume?.machineId !== undefined && !replacement ? 'No other offer on Vast.ai machine ' + volume.machineId + ', where the kept volume lives, is available right now.' : '')
      }
      if (error instanceof HostCreateError && error.outcome === 'ambiguous') this.api.remember(name)
      throw error
    }
    const id = String(contract)
    const launchedAt = new Date().toISOString()
    const pod = await this.api.readBack(id, () => this.get(id))
    return pod.createdAt ? pod : { ...pod, createdAt: launchedAt }
  }
  async stop(id: string): Promise<HostPod> {
    if (!/^[1-9][0-9]*$/.test(id)) throw new Error('Vast.ai requires a numeric instance ID.')
    await this.api.request('/api/v0/instances/' + id + '/', success, 'PUT', { state: 'stopped' })
    return this.get(id)
  }
  async terminate(id: string, readOnly?: HostReadOnly): Promise<void> {
    if (!/^[1-9][0-9]*$/.test(id)) throw new Error('Vast.ai requires a numeric instance ID.')
    await this.api.request('/api/v0/instances/' + id + '/', success, 'DELETE')
    const deadline = Date.now() + (this.timing.readyTimeoutMs ?? 120000)
    let last = ''
    for (;;) {
      try { if (!(await (readOnly ? readOnly('pod listing', signal => this.pods(signal)) : this.pods())).some(row => row.id === id)) return } catch (error) { if (readOnly) throw new HostTerminationUnconfirmed(this.label, error); last = ' ' + (error instanceof Error ? error.message : String(error)) }
      if (Date.now() >= deadline) throw new Error('Vast.ai termination is not verified; check the instance list in the console.' + last)
      await delay(this.timing.pollMs ?? 2000)
    }
  }
  async logs(id: string, jobSignal?: AbortSignal): Promise<string> {
    try {
      if (!/^[1-9][0-9]*$/.test(id)) throw new Error('invalid instance ID')
      const deadline = AbortSignal.timeout(10000)
      const signal = jobSignal ? AbortSignal.any([jobSignal, deadline]) : deadline
      const result = await this.api.request('/api/v0/instances/request_logs/' + id + '/', z.object({ success: z.literal(true), result_url: z.string() }), 'PUT', { tail: '12' }, signal)
      const url = new URL(result.result_url)
      const fixture = new URL(this.api.base)
      const allowed = !url.username && !url.password && !url.hash && (url.protocol === 'https:' && url.hostname === 's3.amazonaws.com' && url.pathname.startsWith('/vast.ai/instance_logs/') || fixture.protocol === 'http:' && url.origin === fixture.origin && url.pathname.startsWith('/fixture-logs/'))
      if (!allowed) throw new Error('unexpected log URL')
      for (;;) {
        const response = await fetch(url, { redirect: 'error', signal })
        if (response.ok) {
          const reader = response.body?.getReader()
          let text = ''
          const decoder = new TextDecoder()
          if (reader) try { while (text.length < 12000) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }) } } finally { await reader.cancel().catch(() => {}) }
          return this.api.redact(text).split('\n').filter(Boolean).slice(-12).join('\n')
        }
        await response.body?.cancel().catch(() => {})
        if (jobSignal) throw new HostVendorHttpError('Vast.ai log read returned HTTP ' + response.status, response.status, retryAfterSeconds(response.headers.get('retry-after')))
        await delay(300, undefined, { signal })
      }
    } catch (error) { if (jobSignal) throw error; return 'Vast.ai log tail unavailable; open the instance in its console.' }
  }
}
