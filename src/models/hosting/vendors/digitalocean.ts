import { isIP } from 'node:net'
import { z } from 'zod/v4'
import { recipeFits, type HostRecipe } from '../recipes.js'
import { currentHostRecipes } from '../recipesFile.js'
import type { HostReadOnly } from '../retry.js'
import { HOST_VENDOR_INFO, type HostVendor, type HostOffer, type HostPod } from './vendor.js'
import { VendorApi, HostCreateError, HostVendorHttpError, HostVendorShapeError, keyMaterial, type VendorTiming } from './http.js'
import { sortVmOffers, validateVmCreate, verifyVmAbsent, vmKeyName, VmPlacements } from './vm.js'

const BASE = 'https://api.digitalocean.com/v2'
export const DIGITALOCEAN_STORAGE_NOTICE = 'Local disk included; Terminate deletes it. Compute bills per second, five-minute minimum, even while powered off.'
export const DIGITALOCEAN_KEY_NOTICE = 'Adds an SSH key to your DigitalOcean account for new rentals. Remove it in the console when finished.'
const idSchema = z.number().int().positive()
const units = z.object({ amount: z.number().nonnegative(), unit: z.string() })
const sizeSchema = z.object({
  slug: z.string(), available: z.boolean(), regions: z.array(z.string()), price_hourly: z.number().nonnegative(), disk: z.number().nonnegative(),
  disk_info: z.array(z.object({ type: z.string(), size: units })).optional(),
  gpu_info: z.object({ count: z.number().int().positive(), model: z.string(), vram: units }).optional(),
})
const podSchema = z.object({ id: idSchema, name: z.string(), status: z.string(), created_at: z.string(), size: z.object({ price_hourly: z.number().nonnegative() }), networks: z.object({ v4: z.array(z.object({ type: z.string(), ip_address: z.string() })) }) })
const keySchema = z.object({ id: idSchema, name: z.string(), public_key: z.string() })
const gb = (value: z.infer<typeof units>): number => value.unit.toLowerCase() === 'gib' ? value.amount * 1024 ** 3 / 1e9 : value.unit.toLowerCase() === 'gb' ? value.amount : 0
function userData(scratch: boolean): string {
  return '#cloud-config\n' + JSON.stringify({
    package_update: true, packages: ['curl', 'util-linux', 'docker.io'],
    ...(scratch ? { mounts: [['LABEL=DOSCRATCH', '/workspace', 'ext4', 'discard,errors=remount-ro', '0', '2']] } : {}),
    runcmd: [['bash', '-ec', 'mkdir -p /workspace; ' + (scratch ? 'mountpoint -q /workspace; ' : '') + 'nvidia-ctk runtime configure --runtime=docker; systemctl enable --now docker; systemctl restart docker; docker info >/dev/null; touch /workspace/.mercury-vm-ready']],
  })
}

export class DigitalOceanClient implements HostVendor {
  readonly vendor = 'digitalocean' as const
  readonly label = HOST_VENDOR_INFO.digitalocean.label
  readonly keyHelp = HOST_VENDOR_INFO.digitalocean.keyHelp
  readonly capabilities = { stop: false, dataCenters: true, persistentDisk: 'root', vm: true } as const
  private api: VendorApi
  private lastShapes: HostOffer[] = []
  private placements = new VmPlacements<{ size: string; region: string; scratch: boolean }>()
  constructor(key: string, base = BASE, private timing: VendorTiming = {}) {
    this.api = new VendorApi(this.label, key, base, BASE, [400, 401, 403, 404, 422, 429], timing, false, { textResponses: true })
  }
  rateLimitPolicy(): string { return this.api.policy() ?? 'DigitalOcean read failures use bounded backoff. Creates are never retried.' }
  shapes(): readonly HostOffer[] { return this.lastShapes }
  offersNote(): string { return 'On-demand H100/H200 only. No B200 stock; B300 is spot or contract-only. Prices include local disk. Per-second billing, five-minute minimum.' }
  private async pages<T>(path: string, field: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T[]> {
    const original = new URL(this.api.base + path)
    let next = path + (path.includes('?') ? '&' : '?') + 'per_page=200'
    const seen = new Set<string>()
    const result: T[] = []
    const ids = new Set<string>()
    for (;;) {
      if (seen.has(next)) throw new Error('DigitalOcean repeated a page; the account list is incomplete.')
      seen.add(next)
      const page = await this.api.request(next, z.object({ meta: z.object({ total: z.number().int().nonnegative() }), links: z.object({ pages: z.object({ next: z.string().optional() }).optional() }).optional() }).passthrough(), 'GET', undefined, signal)
      const rows = z.array(schema).safeParse(page[field])
      if (!rows.success) throw new HostVendorShapeError('DigitalOcean returned an unreadable ' + field + ' shape; the list is incomplete.')
      for (const row of rows.data) {
        const identity = String((row as { id?: unknown; slug?: unknown }).id ?? (row as { slug?: unknown }).slug)
        if (ids.has(identity)) throw new Error('DigitalOcean repeated a resource; the list is incomplete.')
        ids.add(identity); result.push(row)
      }
      const link = page.links?.pages?.next
      if (!link) {
        if (result.length !== page.meta.total) throw new Error('DigitalOcean returned an incomplete ' + field + ' list.')
        return result
      }
      const url = new URL(link, this.api.base)
      if (!rows.data.length || ![new URL(BASE).origin, original.origin].includes(url.origin) || url.username || url.password || url.hash || url.pathname !== original.pathname || (original.searchParams.get('type') && url.searchParams.get('type') !== original.searchParams.get('type'))) throw new Error('DigitalOcean returned an unsafe or incomplete pagination link.')
      next = url.pathname.slice('/v2'.length) + url.search
    }
  }
  private async search(recipes: readonly HostRecipe[], signal?: AbortSignal): Promise<{ offers: HostOffer[]; shapes: HostOffer[] }> {
    const sizes = await this.pages('/sizes', 'sizes', sizeSchema, signal)
    const offers: HostOffer[] = [], shapes: HostOffer[] = []
    for (const size of sizes) {
      const gpu = size.gpu_info
      if (!gpu || !/^gpu-h(?:100|200)x(?:1|8)-\d+gb$/.test(size.slug) || !['nvidia_h100', 'nvidia_h200'].includes(gpu.model) || size.price_hourly <= 0) continue
      const gpuId = gpu.model === 'nvidia_h200' ? 'NVIDIA H200' : 'NVIDIA H100'
      const scratchGb = size.disk_info?.find(row => row.type === 'scratch')?.size
      const root = size.disk_info?.find(row => row.type === 'boot' || row.type === 'local')?.size
      for (const recipe of recipes) {
        const scratch = Boolean(scratchGb && gb(scratchGb) >= recipe.diskGb)
        if (gpu.count !== recipe.count || !recipeFits(recipe, gpuId, gb(gpu.vram), gpu.count) || !scratch && (root ? gb(root) : size.disk * 1024 ** 3 / 1e9) < recipe.diskGb || Number(recipe.cuda) > 13.1) continue
        const shape: HostOffer = { recipe, gpuId, price: size.price_hourly, availability: size.available && size.regions.length ? 'HIGH' : 'NONE' }
        shapes.push(shape)
        if (shape.availability === 'NONE') continue
        for (const region of size.regions) {
          const offer = { ...shape, dataCenter: region }
          this.placements.add(offer, { size: size.slug, region, scratch }); offers.push(offer)
        }
      }
    }
    return { offers: offers.sort(sortVmOffers), shapes: shapes.sort(sortVmOffers) }
  }
  async offers(signal: AbortSignal): Promise<HostOffer[]> { this.lastShapes = []; const found = await this.search(currentHostRecipes(), signal); this.lastShapes = found.shapes; return found.offers }
  async watchOffer(recipe: HostRecipe, maxPrice: number, signal?: AbortSignal): Promise<HostOffer | undefined> { return (await this.search([recipe], signal)).offers.find(row => row.price <= maxPrice) }
  private pod(row: z.infer<typeof podSchema>): HostPod {
    const host = row.networks.v4.find(network => network.type === 'public' && isIP(network.ip_address) === 4)?.ip_address
    return { id: String(row.id), name: this.api.redact(row.name), status: row.status === 'active' ? 'RUNNING' : row.status.toUpperCase(), cost: row.size.price_hourly, createdAt: row.created_at, startedAt: row.created_at, ssh: { direct: row.status === 'active' && host ? { host, port: 22, username: 'root' } : null } }
  }
  async pods(signal?: AbortSignal): Promise<HostPod[]> { return (await this.pages('/droplets?type=gpus', 'droplets', podSchema, signal)).map(row => this.pod(row)) }
  async get(id: string, signal?: AbortSignal): Promise<HostPod> {
    if (!/^[1-9]\d*$/.test(id)) throw new Error('DigitalOcean requires a numeric Droplet ID.')
    const { droplet } = await this.api.request('/droplets/' + id, z.object({ droplet: podSchema }), 'GET', undefined, signal)
    if (String(droplet.id) !== id) throw new Error('DigitalOcean returned a different Droplet ID.')
    return this.pod(droplet)
  }
  private registerKey(publicKey: string): Promise<number> {
    return this.api.serial(async () => {
      const material = keyMaterial(publicKey), name = vmKeyName(publicKey)
      const list = () => this.pages('/account/keys', 'ssh_keys', keySchema)
      let keys = await list()
      const existing = keys.find(row => keyMaterial(row.public_key) === material)
      if (existing) return existing.id
      if (keys.some(row => row.name === name)) throw new Error('DigitalOcean has a different public key with Mercury’s key name; no instance was created.')
      try { await this.api.request('/account/keys', z.object({ ssh_key: keySchema }), 'POST', { name, public_key: publicKey.trim() }) } catch (error) {
        keys = await list()
        const observed = keys.find(row => row.name === name && keyMaterial(row.public_key) === material)
        if (observed) return observed.id
        throw error
      }
      keys = await list()
      const confirmed = keys.find(row => row.name === name && keyMaterial(row.public_key) === material)
      if (!confirmed) throw new Error('DigitalOcean did not confirm Mercury’s SSH public key; no instance was created.')
      return confirmed.id
    })
  }
  async create(offer: HostOffer, publicKey: string, name: string): Promise<HostPod> {
    const placement = this.placements.get(offer)
    validateVmCreate(publicKey, name)
    await this.api.reconcile(() => this.pods())
    const key = await this.registerKey(publicKey)
    let id: string
    try {
      const answer = await this.api.request('/droplets', z.object({ droplet: z.object({ id: idSchema }) }), 'POST', { name, region: placement.region, size: placement.size, image: offer.recipe.count === 8 ? 'gpu-h100x8-base' : 'gpu-h100x1-base', ssh_keys: [key], user_data: userData(placement.scratch), backups: false, public_networking: true }, undefined, true)
      id = String(answer.droplet.id)
    } catch (error) { if (error instanceof HostCreateError && error.outcome === 'ambiguous') this.api.remember(name); throw error }
    return this.api.readBack(id, () => this.get(id))
  }
  async stop(_id: string): Promise<HostPod> { throw new Error('Powering off DigitalOcean keeps compute billing. Use terminate to delete the instance and its local data.') }
  async terminate(id: string, readOnly?: HostReadOnly): Promise<void> {
    if (!/^[1-9]\d*$/.test(id)) throw new Error('DigitalOcean requires a numeric Droplet ID.')
    try { await this.api.request('/droplets/' + id, z.unknown(), 'DELETE') } catch (error) { if (!(error instanceof HostVendorHttpError && error.status === 404)) throw error }
    await verifyVmAbsent(this.label, id, signal => this.pods(signal), this.timing, readOnly)
  }
  async logs(_id: string): Promise<string> { return 'DigitalOcean has no instance log-read API here. Use SSH to read /var/log/cloud-init-output.log and /workspace/mercury-host.' }
}
