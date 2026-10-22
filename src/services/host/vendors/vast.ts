import { isIP } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod/v4'
import { recipeFits, type HostRecipe } from '../recipes.js'
import { currentHostRecipes } from '../recipesFile.js'
import { HOST_VENDOR_INFO, type HostOffer, type HostPod, type HostVendor } from './vendor.js'
import { HostCreateError, HostVendorHttpError, VendorApi, isOpenSshKey, keyMaterial, retryAfterSeconds, type VendorTiming } from './http.js'
import { HostTerminationUnconfirmed, type HostReadOnly } from '../retry.js'

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
})
const instanceSchema = z.object({
  id: idSchema, label: z.string().nullable().optional(), actual_status: z.string().nullable().optional(), dph_total: z.number().nonnegative(), start_date: z.number().nonnegative().nullable().optional(),
  public_ipaddr: z.string().nullable().optional(), ports: z.unknown().optional(),
})
const instanceListSchema = z.object({ success: z.literal(true), instances: z.array(instanceSchema), instances_found: z.number().int().nonnegative(), total_instances: z.number().int().nonnegative(), next_token: z.string().min(1).nullable() })
const keyListSchema = z.array(z.object({ key: z.string(), deleted_at: z.string().nullable().optional() }))
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
          const offer: HostOffer = { recipe, gpuId, price: hardware.dph_total, availability: 'HIGH', hostingType: hardware.datacenter === true ? 'datacenter' : hardware.datacenter === false ? 'community host' : 'hosting type unknown' }
          this.placements.set(offer, { id: hardware.id, fingerprint: fingerprint(offer) })
          offers.push(offer)
        }
      }
    }
    return { offers: offers.sort(sortOffers), unmapped }
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
    return (await this.search(siblings.length ? siblings : [recipe], signal)).offers.filter(row => row.price <= maxPrice).sort((a, b) => Number(b.recipe.id === recipe.id) - Number(a.recipe.id === recipe.id) || sortOffers(a, b))[0]
  }
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
    })
  }
  async create(offer: HostOffer, publicKey: string, name: string): Promise<HostPod> {
    const placement = this.placements.get(offer)
    if (!placement || placement.fingerprint !== fingerprint(offer)) throw new Error('Choose an unchanged offer returned by this Vast.ai client before renting.')
    if (!isOpenSshKey(publicKey)) throw new Error('Vast.ai needs one OpenSSH public key.')
    await this.api.reconcile(() => this.pods())
    await this.registerKey(publicKey)
    let contract: number
    try {
      contract = (await this.api.request('/api/v0/asks/' + placement.id + '/', z.object({ success: z.literal(true), new_contract: idSchema }), 'PUT', {
        image: offer.recipe.image, disk: offer.recipe.diskGb, label: name, runtype: 'ssh_direct', cancel_unavail: true, onstart: ONSTART,
        env: { HF_HOME: '/workspace/huggingface' },
      }, undefined, true)).new_contract
    } catch (error) {
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
