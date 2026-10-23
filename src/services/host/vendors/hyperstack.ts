import { isIP } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod/v4'
import { recipeFits, type HostRecipe } from '../recipes.js'
import { currentHostRecipes } from '../recipesFile.js'
import type { HostReadOnly } from '../retry.js'
import { HOST_VENDOR_INFO, type HostVendor, type HostOffer, type HostPod } from './vendor.js'
import { VendorApi, HostCreateError, HostVendorHttpError, HostVendorShapeError, keyMaterial, type VendorTiming } from './http.js'
import { sortVmOffers, validateVmCreate, verifyVmAbsent, vmKeyName, VmPlacements } from './vm.js'

const BASE = 'https://infrahub-api.nexgencloud.com/v1'
const PUBLIC_IP_HOURLY = 0.00672043
export const HYPERSTACK_STORAGE_NOTICE = '/workspace uses included local disk; termination deletes it, and hibernation loses ephemeral data. Compute bills per minute, even while shut down. The price includes one public IP at $0.00672043/hr. Mercury creates no separate volume. Initial new-account quotas are not published; check the console.'
export const HYPERSTACK_KEY_NOTICE = 'Renting adds Mercury’s SSH public key to the selected Hyperstack environment, creating that environment if needed. Its name contains mercury-host- and the key fingerprint. Remove the key in the console when finished.'
const GPUs: Readonly<Record<string, { id: string; memory: number }>> = {
  'RTX-PRO6000-SE': { id: 'NVIDIA RTX PRO 6000 Blackwell', memory: 96 },
  'H100-80G-PCIe': { id: 'NVIDIA H100', memory: 80 }, 'H100-80G-PCIe-NVLink': { id: 'NVIDIA H100', memory: 80 }, 'H100-80G-SXM5': { id: 'NVIDIA H100', memory: 80 },
  'H200-141G-SXM5': { id: 'NVIDIA H200', memory: 141 }, 'B200-SXM': { id: 'NVIDIA B200', memory: 192 }, 'B300-SXM': { id: 'NVIDIA B300', memory: 288 },
}
const idSchema = z.number().int().positive()
const money = z.union([z.number(), z.string().regex(/^(?:\d+(?:\.\d+)?|\d+E-\d+)$/i)]).transform(Number).pipe(z.number().finite().nonnegative())
const flavorSchema = z.object({ id: idSchema, name: z.string(), gpu: z.string(), gpu_count: z.number().int().nonnegative(), cpu: z.number().nonnegative(), ram: z.number().nonnegative(), disk: z.number().nonnegative(), ephemeral: z.number().nonnegative().nullable().optional() })
const offerFlavorSchema = flavorSchema.extend({ region_name: z.string(), stock_available: z.boolean() })
const instanceSchema = z.object({ id: idSchema, name: z.string(), status: z.string(), flavor: flavorSchema, created_at: z.string(), floating_ip: z.string().nullable().optional() })
const environmentSchema = z.object({ id: idSchema, name: z.string(), region: z.string() })
const keySchema = z.object({ id: idSchema, name: z.string(), public_key: z.string(), environment: z.object({ id: idSchema, name: z.string() }) })
const imageSchema = z.object({ id: idSchema, name: z.string(), region_name: z.string(), flavor_restrictions: z.object({ has_flavor_restrictions: z.boolean(), compatible_flavors: z.array(z.object({ flavor_id: idSchema, constraints: z.record(z.string(), z.unknown()).optional() })) }).nullable().optional() })
function userData(ephemeral: boolean): string {
  return '#cloud-config\n' + JSON.stringify({
    package_update: true, packages: ['curl', 'util-linux'],
    ...(ephemeral ? { mounts: [['ephemeral0', '/workspace']] } : {}),
    runcmd: [['bash', '-ec', 'mkdir -p /workspace; ' + (ephemeral ? 'mountpoint -q /workspace; ' : '') + 'chown ubuntu:ubuntu /workspace; groupadd -f docker; usermod -aG docker ubuntu; docker info >/dev/null; touch /workspace/.mercury-vm-ready']],
  })
}
export class HyperstackClient implements HostVendor {
  readonly vendor = 'hyperstack' as const
  readonly label = HOST_VENDOR_INFO.hyperstack.label
  readonly keyHelp = HOST_VENDOR_INFO.hyperstack.keyHelp
  readonly capabilities = { stop: false, dataCenters: true, persistentDisk: 'root', vm: true } as const
  private api: VendorApi
  private lastShapes: HostOffer[] = []
  private placements = new VmPlacements<{ flavor: string; region: string; image: number; ephemeral: boolean }>()
  constructor(key: string, base = BASE, private timing: VendorTiming = {}) {
    this.api = new VendorApi(this.label, key, base, BASE, [400, 401, 403, 404, 422, 429], timing, false, { headers: () => ({ api_key: key }) })
  }
  rateLimitPolicy(): string { return this.api.policy() ?? 'Hyperstack read failures use bounded backoff. Creates are never retried.' }
  shapes(): readonly HostOffer[] { return this.lastShapes }
  offersNote(): string { return 'Prices cover the full on-demand shape plus one public IP; billed per minute. H200/B200/B300 shapes are eight GPUs, not single GPUs. Only CUDA-compatible Docker images are offered.' }
  private async rates(signal?: AbortSignal): Promise<Map<string, number>> {
    const rows = await this.api.request('/pricebook', z.array(z.object({ name: z.string(), value: money, start_time: z.string().nullable().optional(), end_time: z.string().nullable().optional() })), 'GET', undefined, signal)
    const now = Date.now()
    return new Map(rows.filter(row => (!row.start_time || Date.parse(row.start_time) <= now) && (!row.end_time || Date.parse(row.end_time) > now)).map(row => [row.name, row.value]))
  }
  private price(flavor: z.infer<typeof flavorSchema>, rates: Map<string, number>, ip = true): number {
    const gpu = flavor.gpu_count ? rates.get(flavor.gpu) : 0, cpu = rates.get('vCPU'), ram = rates.get('RAM')
    if (gpu === undefined || cpu === undefined || ram === undefined) throw new Error('Hyperstack has no readable price for ' + this.api.redact(flavor.name) + '; refresh prices before renting.')
    return gpu * flavor.gpu_count + cpu * flavor.cpu + ram * flavor.ram + (ip ? PUBLIC_IP_HOURLY : 0)
  }
  private async pages<T>(path: string, field: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T[]> {
    const rows: T[] = [], seen = new Set<number>()
    for (let page = 1; ; page++) {
      const result = await this.api.request(path + '?page=' + page + '&pageSize=100', z.object({ status: z.literal(true), page: z.number().int().positive(), page_size: z.number().int().positive(), count: z.number().int().nonnegative() }).passthrough(), 'GET', undefined, signal)
      const parsed = z.array(schema).safeParse(result[field])
      if (!parsed.success || result.page !== page || result.count !== parsed.data.length || parsed.data.length > result.page_size) throw new HostVendorShapeError('Hyperstack returned an incomplete ' + field + ' list shape.')
      for (const row of parsed.data) {
        const id = (row as { id: number }).id
        if (seen.has(id)) throw new Error('Hyperstack repeated a page; the list is incomplete.')
        seen.add(id); rows.push(row)
      }
      if (parsed.data.length < result.page_size) return rows
    }
  }
  private async search(recipes: readonly HostRecipe[], signal?: AbortSignal): Promise<{ offers: HostOffer[]; shapes: HostOffer[] }> {
    const catalog = await this.api.request('/core/flavors', z.object({ status: z.literal(true), data: z.array(z.object({ flavors: z.array(offerFlavorSchema) })) }), 'GET', undefined, signal)
    const rates = await this.rates(signal)
    const images = (await this.api.request('/core/images', z.object({ status: z.literal(true), images: z.array(z.object({ images: z.array(imageSchema) })) }), 'GET', undefined, signal)).images.flatMap(row => row.images)
    const offers: HostOffer[] = [], shapes: HostOffer[] = []
    for (const flavor of catalog.data.flatMap(row => row.flavors)) {
      const gpu = GPUs[flavor.gpu]
      if (!gpu || /spot/i.test(flavor.name) || !rates.has(flavor.gpu)) continue
      const price = this.price(flavor, rates)
      if (price <= PUBLIC_IP_HOURLY) continue
      for (const recipe of recipes) {
        const ephemeral = (flavor.ephemeral ?? 0) >= recipe.diskGb
        if (flavor.gpu_count !== recipe.count || !recipeFits(recipe, gpu.id, gpu.memory, flavor.gpu_count) || !ephemeral && flavor.disk < recipe.diskGb) continue
        const image = images.find(row => {
          const cuda = /CUDA (\d+\.\d+) with Docker$/.exec(row.name)
          const restrictions = row.flavor_restrictions
          return row.region_name === flavor.region_name && row.name.startsWith('Ubuntu Server 24.04 LTS ') && cuda && Number(cuda[1]) >= Math.max(Number(recipe.cuda), flavor.gpu === 'B300-SXM' ? 13.2 : 0) && (!restrictions?.has_flavor_restrictions || restrictions.compatible_flavors.some(item => item.flavor_id === flavor.id && !Object.keys(item.constraints ?? {}).length))
        })
        if (!image) continue
        const shape: HostOffer = { recipe, gpuId: gpu.id, price, dataCenter: flavor.region_name, availability: flavor.stock_available ? 'HIGH' : 'NONE' }
        shapes.push(shape)
        if (!flavor.stock_available) continue
        this.placements.add(shape, { flavor: flavor.name, region: flavor.region_name, image: image.id, ephemeral }); offers.push(shape)
      }
    }
    return { offers: offers.sort(sortVmOffers), shapes: shapes.sort(sortVmOffers) }
  }
  async offers(signal: AbortSignal): Promise<HostOffer[]> { this.lastShapes = []; const found = await this.search(currentHostRecipes(), signal); this.lastShapes = found.shapes; return found.offers }
  async watchOffer(recipe: HostRecipe, maxPrice: number, signal?: AbortSignal): Promise<HostOffer | undefined> { return (await this.search([recipe], signal)).offers.find(row => row.price <= maxPrice) }
  private pod(row: z.infer<typeof instanceSchema>, rates: Map<string, number>): HostPod {
    const host = row.floating_ip
    const transitional = ['HIBERNATING', 'RESTORING', 'STARTING', 'STOPPING', 'REBOOTING', 'CREATING', 'BUILD', 'DELETING', 'DELETED', 'ERROR'].includes(row.status)
    const cost = transitional ? 0 : row.status === 'HIBERNATED' ? (host ? PUBLIC_IP_HOURLY : 0) : this.price(row.flavor, rates, Boolean(host))
    return { id: String(row.id), name: this.api.redact(row.name), status: row.status === 'ACTIVE' ? 'RUNNING' : row.status, cost, createdAt: row.created_at, startedAt: row.created_at, ssh: { direct: row.status === 'ACTIVE' && host && isIP(host) === 4 ? { host, port: 22, username: 'ubuntu' } : null } }
  }
  async pods(signal?: AbortSignal): Promise<HostPod[]> {
    const rows = await this.pages('/core/virtual-machines', 'instances', instanceSchema, signal)
    if (!rows.length) return []
    const rates = await this.rates(signal)
    return rows.map(row => this.pod(row, rates))
  }
  async get(id: string, signal?: AbortSignal): Promise<HostPod> {
    if (!/^[1-9]\d*$/.test(id)) throw new Error('Hyperstack requires a numeric VM ID.')
    const { instance } = await this.api.request('/core/virtual-machines/' + id, z.object({ status: z.literal(true), instance: instanceSchema }), 'GET', undefined, signal)
    if (String(instance.id) !== id) throw new Error('Hyperstack returned a different VM ID.')
    return this.pod(instance, await this.rates(signal))
  }
  private prepare(publicKey: string, region: string): Promise<{ environment: string; key: string }> {
    return this.api.serial(async () => {
      const environments = () => this.pages('/core/environments', 'environments', environmentSchema)
      let environment = (await environments()).find(row => row.region === region)
      if (!environment) {
        const name = 'mercury-' + region.toLowerCase()
        try { await this.api.request('/core/environments', z.object({ status: z.literal(true), environment: environmentSchema }), 'POST', { name, region }) } catch (error) { if (!(await environments()).some(row => row.name === name && row.region === region)) throw error }
        environment = (await environments()).find(row => row.name === name && row.region === region)
      }
      if (!environment) throw new Error('Hyperstack did not confirm the environment; no instance was created.')
      const name = vmKeyName(publicKey) + '-' + environment.id, material = keyMaterial(publicKey)
      const keys = () => this.pages('/core/keypairs', 'keypairs', keySchema)
      const existing = (await keys()).find(row => row.name === name && row.environment.id === environment.id)
      if (existing && keyMaterial(existing.public_key) !== material) throw new Error('Hyperstack has a different public key with Mercury’s key name; no instance was created.')
      if (!existing) {
        try { await this.api.request('/core/keypairs', z.object({ status: z.literal(true), keypair: keySchema }), 'POST', { name, environment_name: environment.name, public_key: publicKey.trim() }) } catch (error) {
          if (!(await keys()).some(row => row.name === name && row.environment.id === environment.id && keyMaterial(row.public_key) === material)) throw error
        }
        if (!(await keys()).some(row => row.name === name && row.environment.id === environment.id && keyMaterial(row.public_key) === material)) throw new Error('Hyperstack did not confirm Mercury’s SSH public key in this environment; no instance was created.')
      }
      return { environment: environment.name, key: name }
    })
  }
  async create(offer: HostOffer, publicKey: string, name: string): Promise<HostPod> {
    const placement = this.placements.get(offer)
    validateVmCreate(publicKey, name, 50)
    await this.api.reconcile(() => this.pods())
    const prepared = await this.prepare(publicKey, placement.region)
    let id: string
    try {
      const answer = await this.api.request('/core/virtual-machines', z.object({ status: z.literal(true), instances: z.array(z.object({ id: idSchema })).length(1) }), 'POST', { count: 1, name, environment_name: prepared.environment, key_name: prepared.key, flavor_name: placement.flavor, image_id: placement.image, assign_floating_ip: true, enable_port_randomization: false, create_bootable_volume: false, security_rules: [{ direction: 'ingress', ethertype: 'IPv4', protocol: 'tcp', remote_ip_prefix: '0.0.0.0/0', port_range_min: 22, port_range_max: 22 }], user_data: userData(placement.ephemeral) }, undefined, true)
      id = String(answer.instances[0]!.id)
    } catch (error) { if (error instanceof HostCreateError && error.outcome === 'ambiguous') this.api.remember(name); throw error }
    return this.api.readBack(id, () => this.get(id))
  }
  async stop(_id: string): Promise<HostPod> { throw new Error('Hyperstack shutdown keeps compute billing. Use terminate to delete the instance and its local data.') }
  async terminate(id: string, readOnly?: HostReadOnly): Promise<void> {
    if (!/^[1-9]\d*$/.test(id)) throw new Error('Hyperstack requires a numeric VM ID.')
    const deadline = Date.now() + (this.timing.readyTimeoutMs ?? 120000)
    for (;;) {
      try { await this.api.request('/core/virtual-machines/' + id, z.object({ status: z.literal(true) }), 'DELETE'); break } catch (error) {
        if (error instanceof HostVendorHttpError && error.status === 404) break
        if (!(error instanceof HostVendorHttpError && error.status === 400) || Date.now() >= deadline) throw error
        const pod = await (readOnly ? readOnly('instance', signal => this.get(id, signal)) : this.get(id))
        if (!['CREATING', 'BUILD', 'BUILDING', 'RUNNING'].includes(pod.status) || !/currently being created/.test(error.message)) throw error
        await delay(this.timing.pollMs ?? 2000)
      }
    }
    await verifyVmAbsent(this.label, id, signal => this.pods(signal), this.timing, readOnly)
  }
  async logs(id: string, signal?: AbortSignal): Promise<string> {
    if (!/^[1-9]\d*$/.test(id)) throw new Error('Hyperstack requires a numeric VM ID.')
    const bounded = AbortSignal.any([AbortSignal.timeout(this.timing.requestTimeoutMs ?? 10000), ...(signal ? [signal] : [])])
    const request = await this.api.request('/core/virtual-machines/' + id + '/logs', z.object({ request_id: idSchema }), 'POST', { length: 12 }, bounded)
    for (;;) {
      const result = await this.api.request('/core/virtual-machines/' + id + '/logs?request_id=' + request.request_id, z.object({ logs: z.string().nullable() }), 'GET', undefined, bounded)
      if (result.logs !== null) return this.api.redact(result.logs).split('\n').slice(-12).join('\n')
      await delay(this.timing.pollMs ?? 1000, undefined, { signal: bounded })
    }
  }
}
