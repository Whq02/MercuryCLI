import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod/v4'
import { recipeFits, type HostRecipe } from '../recipes.js'
import { currentHostRecipes } from '../recipesFile.js'
import type { HostOffer, HostPod, HostVendor } from './vendor.js'
import { VendorApi, HostVendorHttpError, type VendorTiming } from './http.js'

export const VAST_STORAGE_NOTICE = '/workspace uses the instance container disk. Stop retains data and storage billing; terminate deletes the disk and its data. No separate volume is created.'
export const VAST_GPU_NAMES: Readonly<Record<string, string>> = {
  H100: 'NVIDIA H100', 'H100 SXM': 'NVIDIA H100', 'H100 PCIE': 'NVIDIA H100',
  H200: 'NVIDIA H200', 'H200 NVL': 'NVIDIA H200', B200: 'NVIDIA B200', B300: 'NVIDIA B300', GB300: 'NVIDIA GB300',
  A100: 'NVIDIA A100', 'A100 SXM4': 'NVIDIA A100',
  'RTX PRO 6000': 'NVIDIA RTX PRO 6000 Blackwell', 'RTX PRO 6000 WS': 'NVIDIA RTX PRO 6000 Blackwell',
  'RTX PRO 6000 S': 'NVIDIA RTX PRO 6000 Blackwell', 'RTX PRO 6000 BLACKWELL': 'NVIDIA RTX PRO 6000 Blackwell',
  'RTX PRO 6000 BLACKWELL SERVER EDITION': 'NVIDIA RTX PRO 6000 Blackwell',
}
const gpuName = (name: string): string | undefined => VAST_GPU_NAMES[name.toUpperCase().replace(/^NVIDIA\s+/, '').replaceAll('_', ' ').replace(/\s+/g, ' ').trim()]
const idSchema = z.number().int().positive()
const offerSchema = z.object({
  id: idSchema, gpu_name: z.string(), gpu_ram: z.number().positive(), num_gpus: z.number().int().positive(), dph_total: z.number().positive(),
  verification: z.string(), reliability2: z.number().optional(), reliability: z.number().optional(), direct_port_count: z.number(),
  rentable: z.boolean(), rented: z.boolean(), cuda_max_good: z.number(), disk_space: z.number(), geolocation: z.string().optional(),
})
const instanceSchema = z.object({
  id: idSchema, label: z.string().nullable().optional(), actual_status: z.string().nullable(), dph_total: z.number().nonnegative(), start_date: z.number().nonnegative(),
  ssh_host: z.string().nullable().optional(), ssh_port: z.number().int().nullable().optional(),
})
const success = z.object({ success: z.literal(true) })
const fingerprint = (offer: HostOffer): string => JSON.stringify(offer)
const sortOffers = (a: HostOffer, b: HostOffer): number => Number(a.recipe.verified.by === 'unverified') - Number(b.recipe.verified.by === 'unverified') || a.price - b.price || a.recipe.id.localeCompare(b.recipe.id)

export class VastClient implements HostVendor {
  readonly vendor = 'vast' as const
  readonly label = 'Vast.ai'
  readonly keyHelp = 'Create a Vast.ai API key at https://cloud.vast.ai/manage-keys/.'
  readonly capabilities = { stop: true, dataCenters: false, persistentDisk: 'root' } as const
  private api: VendorApi
  private lastShapes: HostOffer[] = []
  private placements = new WeakMap<HostOffer, { id: number; fingerprint: string }>()
  constructor(key: string, base = 'https://console.vast.ai/api/v0', private timing: VendorTiming = {}) {
    this.api = new VendorApi(this.label, key, base, 'https://console.vast.ai/api/v0', [400, 401, 403, 404, 410, 429], timing)
  }
  rateLimitPolicy(): string { return this.api.policy() ?? 'Vast.ai limits requests per endpoint and identity; search backs off five seconds on HTTP 429 within its read deadline. Creates are never retried.' }
  shapes(): readonly HostOffer[] { return this.lastShapes }
  private async searchPage(body: unknown, signal?: AbortSignal): Promise<z.infer<typeof offerSchema>[]> {
    const deadline = AbortSignal.timeout(this.timing.requestTimeoutMs ?? 30000)
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline
    for (;;) {
      try {
        return (await this.api.request('/bundles/', z.object({ offers: z.array(offerSchema) }), 'POST', body, bounded)).offers
      } catch (error) {
        if (!(error instanceof HostVendorHttpError) || error.status !== 429 || bounded.aborted) throw error
        await delay(5000, undefined, { signal: bounded })
      }
    }
  }
  private async search(recipes: readonly HostRecipe[], signal?: AbortSignal): Promise<HostOffer[]> {
    const offers: HostOffer[] = []
    const groups = new Map<string, HostRecipe[]>()
    for (const recipe of recipes) {
      const group = [recipe.count, recipe.cuda, recipe.diskGb].join(':')
      groups.set(group, [...(groups.get(group) ?? []), recipe])
    }
    for (const rows of groups.values()) {
      const first = rows[0]!
      const found = await this.searchPage({
        verified: { eq: true }, rentable: { eq: true }, rented: { eq: false }, reliability: { gte: 0.99 }, direct_port_count: { gte: 1 },
        num_gpus: { eq: first.count }, cuda_max_good: { gte: Number(first.cuda) }, disk_space: { gte: first.diskGb }, allocated_storage: first.diskGb,
        type: 'ondemand', order: [['dph_total', 'asc']],
      }, signal)
      for (const hardware of found) {
        const gpuId = gpuName(hardware.gpu_name)
        const reliability = hardware.reliability2 ?? hardware.reliability ?? 0
        if (!gpuId || hardware.verification !== 'verified' || reliability < 0.99 || reliability > 1 || (hardware.reliability !== undefined && hardware.reliability < 0.99) || hardware.direct_port_count < 1 || !hardware.rentable || hardware.rented || hardware.num_gpus !== first.count || hardware.cuda_max_good < Number(first.cuda) || hardware.disk_space < first.diskGb) continue
        for (const recipe of rows) {
          if (!recipeFits(recipe, gpuId, hardware.gpu_ram / 1024, hardware.num_gpus)) continue
          const offer: HostOffer = { recipe, gpuId, price: hardware.dph_total, availability: 'HIGH' }
          this.placements.set(offer, { id: hardware.id, fingerprint: fingerprint(offer) })
          offers.push(offer)
        }
      }
    }
    return offers.sort(sortOffers)
  }
  async offers(signal: AbortSignal): Promise<HostOffer[]> {
    this.lastShapes = []
    this.lastShapes = await this.search(currentHostRecipes(), signal)
    return [...this.lastShapes]
  }
  async watchOffer(recipe: HostRecipe, maxPrice: number, signal?: AbortSignal): Promise<HostOffer | undefined> {
    const model = recipe.label.split(' · ')[0]
    const siblings = currentHostRecipes().filter(row => row.label.split(' · ')[0] === model && row.count === recipe.count && row.cuda === recipe.cuda)
    return (await this.search(siblings.length ? siblings : [recipe], signal)).filter(row => row.price <= maxPrice).sort((a, b) => Number(b.recipe.id === recipe.id) - Number(a.recipe.id === recipe.id) || sortOffers(a, b))[0]
  }
  private pod(row: z.infer<typeof instanceSchema>): HostPod {
    const direct = row.ssh_host && /^(?!-)[a-zA-Z0-9.:[\]-]+$/.test(row.ssh_host) && row.ssh_port && row.ssh_port > 0 && row.ssh_port <= 65535 ? { host: row.ssh_host, port: row.ssh_port, username: 'root' } : null
    const status = row.actual_status === 'running' ? 'RUNNING' : row.actual_status === 'stopped' ? 'EXITED' : ['exited', 'unknown', 'offline'].includes(row.actual_status ?? '') ? 'ERROR' : (row.actual_status ?? 'PENDING').toUpperCase()
    const createdAt = new Date(row.start_date * 1000).toISOString()
    return { id: String(row.id), name: this.api.redact(row.label ?? String(row.id)), status, cost: row.dph_total, createdAt, startedAt: createdAt, ssh: { direct } }
  }
  async pods(signal?: AbortSignal): Promise<HostPod[]> {
    const page = await this.api.request('/instances/', z.object({ instances: z.array(instanceSchema), instances_found: z.number().optional(), next_token: z.string().nullable().optional() }), 'GET', undefined, signal)
    if (page.next_token || page.instances_found !== undefined && page.instances_found > page.instances.length) throw new Error('Vast.ai returned an incomplete instance list; check the console before renting or declaring termination complete.')
    return page.instances.map(row => this.pod(row))
  }
  async get(id: string, signal?: AbortSignal): Promise<HostPod> {
    if (!/^[1-9][0-9]*$/.test(id)) throw new Error('Vast.ai requires a numeric instance ID.')
    const { instances } = await this.api.request('/instances/' + id + '/', z.object({ instances: instanceSchema }), 'GET', undefined, signal)
    if (String(instances.id) !== id) throw new Error('Vast.ai returned a different instance ID.')
    return this.pod(instances)
  }
  async create(offer: HostOffer, publicKey: string, name: string): Promise<HostPod> {
    const placement = this.placements.get(offer)
    if (!placement || placement.fingerprint !== fingerprint(offer)) throw new Error('Choose an unchanged offer returned by this Vast.ai client before renting.')
    if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[^ ]+) [A-Za-z0-9+/]+={0,3}(?: [^\r\n\0]*)?$/.test(publicKey.trim())) throw new Error('Vast.ai needs one OpenSSH public key.')
    const onstart = 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server tmux curl && mkdir -p /root/.ssh /run/sshd && chmod 700 /root/.ssh && printf "%s\n" "$PUBLIC_KEY" >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && ssh-keygen -A && service ssh start && mkdir -p /workspace && sleep infinity'
    const result = await this.api.request('/asks/' + placement.id + '/', z.object({ success: z.literal(true), new_contract: idSchema }), 'PUT', {
      image: offer.recipe.image, disk: offer.recipe.diskGb, label: name, runtype: 'ssh_direct', cancel_unavail: true, onstart,
      env: { PUBLIC_KEY: publicKey, HF_HOME: '/workspace/huggingface' },
    }, undefined, true)
    const id = String(result.new_contract)
    try { return await this.get(id) } catch { throw this.api.ambiguous(id) }
  }
  async stop(id: string): Promise<HostPod> {
    if (!/^[1-9][0-9]*$/.test(id)) throw new Error('Vast.ai requires a numeric instance ID.')
    await this.api.request('/instances/' + id + '/', success, 'PUT', { state: 'stopped' })
    return this.get(id)
  }
  async terminate(id: string): Promise<void> {
    if (!/^[1-9][0-9]*$/.test(id)) throw new Error('Vast.ai requires a numeric instance ID.')
    await this.api.request('/instances/' + id + '/', success, 'DELETE')
    const signal = AbortSignal.timeout(this.timing.readyTimeoutMs ?? 120000)
    do {
      if (!(await this.pods(signal)).some(row => row.id === id)) return
      await delay(this.timing.pollMs ?? 2000, undefined, { signal })
    } while (!signal.aborted)
    throw new Error('Vast.ai termination is not verified; check the instance list in the console.')
  }
  async logs(id: string): Promise<string> {
    try {
      if (!/^[1-9][0-9]*$/.test(id)) throw new Error('invalid instance ID')
      const signal = AbortSignal.timeout(3000)
      const result = await this.api.request('/instances/request_logs/' + id + '/', z.object({ success: z.literal(true), result_url: z.string() }), 'PUT', { tail: '12' }, signal)
      const url = new URL(result.result_url)
      const fixture = new URL(this.api.base)
      const allowed = !url.username && !url.password && !url.hash && (url.protocol === 'https:' && url.hostname === 's3.amazonaws.com' && url.pathname.startsWith('/vast.ai/instance_logs/') || fixture.protocol === 'http:' && url.origin === fixture.origin && url.pathname.startsWith('/fixture-logs/'))
      if (!allowed) throw new Error('unexpected log URL')
      const response = await fetch(url, { redirect: 'error', signal })
      if (!response.ok) throw new Error('logs not ready')
      const reader = response.body?.getReader()
      let text = ''
      const decoder = new TextDecoder()
      if (reader) try { while (text.length < 12000) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }) } } finally { await reader.cancel().catch(() => {}) }
      return this.api.redact(text).split('\n').filter(Boolean).slice(-12).join('\n')
    } catch { return 'Vast.ai log tail unavailable; open the instance in its console.' }
  }
}
