import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod/v4'
import { recipeFits, type HostRecipe } from '../recipes.js'
import { currentHostRecipes } from '../recipesFile.js'
import { HOST_VENDOR_INFO, type HostOffer, type HostPod, type HostVendor } from './vendor.js'
import { HostCreateError, VendorApi, isOpenSshKey, keyMaterial, type VendorTiming } from './http.js'

export const LAMBDA_STORAGE_NOTICE = '/workspace uses the instance root disk and survives a restart, not termination. Lambda has no stop; compute keeps billing until termination. No persistent filesystem is created or attached.'
export const LAMBDA_KEY_NOTICE = 'Renting adds Mercury’s SSH public key to your Lambda account keys, named mercury-host- and the key’s fingerprint; only instances launched with that key accept it. Remove it in the Lambda console when you stop renting through Mercury.'
export const LAMBDA_USER_DATA = '#cloud-config\n' + JSON.stringify({
  package_update: true, packages: ['tmux', 'curl', 'util-linux'],
  runcmd: [['mkdir', '-p', '/workspace'], ['chown', 'ubuntu:ubuntu', '/workspace'], ['groupadd', '-f', 'docker'], ['usermod', '-aG', 'docker', 'ubuntu']],
})
const idSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/)
const typeSchema = z.object({
  name: z.string().min(1), gpu_description: z.string(), price_cents_per_hour: z.number().int().nonnegative(), architecture: z.string(),
  specs: z.object({ gpus: z.number().int().nonnegative(), storage_gib: z.number().nonnegative() }),
})
const instanceSchema = z.object({
  id: idSchema, name: z.string().nullable().optional(), status: z.string(), ip: z.string().nullable().optional(),
  first_healthy: z.string().datetime({ offset: true }).nullable().optional(), instance_type: typeSchema,
})
const keySchema = z.object({ id: idSchema, name: z.string(), public_key: z.string() })
const catalogueSchema = z.object({ data: z.record(z.string(), z.object({ instance_type: typeSchema, regions_with_capacity_available: z.array(z.object({ name: z.string().min(1) })) })) })
const keyName = (publicKey: string): string => 'mercury-host-' + createHash('sha256').update(keyMaterial(publicKey)).digest('hex').slice(0, 16)
const sortOffers = (a: HostOffer, b: HostOffer): number => Number(a.recipe.verified.by === 'unverified') - Number(b.recipe.verified.by === 'unverified') || a.price - b.price || a.recipe.id.localeCompare(b.recipe.id) || (a.dataCenter ?? '').localeCompare(b.dataCenter ?? '')

export function lambdaGpu(description: string): { id: string; memory: number } | undefined {
  const memory = /\b(\d+(?:\.\d+)?)\s*(?:GB|GiB)\b/i.exec(description)
  if (!memory || Number(memory[1]) <= 0) return undefined
  return { id: description, memory: Number(memory[1]) }
}

export class LambdaClient implements HostVendor {
  readonly vendor = 'lambda' as const
  readonly label = HOST_VENDOR_INFO.lambda.label
  readonly keyHelp = HOST_VENDOR_INFO.lambda.keyHelp
  readonly capabilities = { stop: false, dataCenters: true, persistentDisk: 'root' } as const
  private api: VendorApi
  private lastShapes: HostOffer[] = []
  private note = ''
  private placements = new WeakMap<HostOffer, { type: string; fingerprint: string }>()
  constructor(key: string, base = 'https://cloud.lambda.ai/api/v1', private timing: VendorTiming = {}) {
    this.api = new VendorApi(this.label, key, base, 'https://cloud.lambda.ai/api/v1', [400, 401, 403, 404, 429], timing, true)
  }
  rateLimitPolicy(): string { return 'Lambda: one request per second (one-token bucket); one launch per 12 seconds. Retry-After delays subsequent requests; creates are never retried.' }
  shapes(): readonly HostOffer[] { return this.lastShapes }
  offersNote(): string { return this.note }
  private async search(recipes: readonly HostRecipe[], signal?: AbortSignal): Promise<{ offers: HostOffer[]; shapes: HostOffer[]; unreadable: string[] }> {
    const { data } = await this.api.request('/instance-types', catalogueSchema, 'GET', undefined, signal)
    const offers: HostOffer[] = []
    const shapes: HostOffer[] = []
    const unreadable: string[] = []
    for (const [name, entry] of Object.entries(data)) {
      const type = entry.instance_type
      if (type.name !== name || type.architecture !== 'x86_64' || type.price_cents_per_hour <= 0 || type.specs.gpus <= 0 || type.specs.storage_gib <= 0) continue
      const gpu = lambdaGpu(type.gpu_description)
      if (!gpu) { unreadable.push(this.api.redact(type.gpu_description).replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, 48) || name); continue }
      for (const recipe of recipes) {
        if (type.specs.gpus !== recipe.count || type.specs.storage_gib < recipe.diskGb || !recipeFits(recipe, gpu.id, gpu.memory, type.specs.gpus)) continue
        const shape: HostOffer = { recipe, gpuId: gpu.id, price: type.price_cents_per_hour / 100, availability: entry.regions_with_capacity_available.length ? 'HIGH' : 'NONE' }
        shapes.push(shape)
        for (const region of entry.regions_with_capacity_available) {
          const offer = { ...shape, dataCenter: region.name }
          this.placements.set(offer, { type: name, fingerprint: JSON.stringify(offer) })
          offers.push(offer)
        }
      }
    }
    return { offers: offers.sort(sortOffers), shapes: shapes.sort(sortOffers), unreadable }
  }
  async offers(signal: AbortSignal): Promise<HostOffer[]> {
    this.lastShapes = []
    this.note = ''
    const { offers, shapes, unreadable } = await this.search(currentHostRecipes(), signal)
    this.lastShapes = shapes
    this.note = unreadable.length ? 'Skipped ' + unreadable.length + ' Lambda instance type' + (unreadable.length === 1 ? '' : 's') + ' whose GPU description states no memory: ' + unreadable.slice(0, 6).join(', ') + (unreadable.length > 6 ? ', …' : '') + '.' : ''
    return offers
  }
  async watchOffer(recipe: HostRecipe, maxPrice: number, signal?: AbortSignal): Promise<HostOffer | undefined> {
    const model = recipe.label.split(' · ')[0]
    const siblings = currentHostRecipes().filter(row => row.label.split(' · ')[0] === model && row.count === recipe.count && row.cuda === recipe.cuda)
    return (await this.search(siblings.length ? siblings : [recipe], signal)).offers.filter(row => row.price <= maxPrice).sort((a, b) => Number(b.recipe.id === recipe.id) - Number(a.recipe.id === recipe.id) || sortOffers(a, b))[0]
  }
  private pod(row: z.infer<typeof instanceSchema>): HostPod {
    const status = row.status === 'active' ? 'RUNNING' : row.status === 'unhealthy' || row.status === 'preempted' ? 'ERROR' : row.status.toUpperCase()
    return { id: row.id, name: this.api.redact(row.name ?? row.id), status, cost: row.instance_type.price_cents_per_hour / 100,
      createdAt: row.first_healthy ?? '', startedAt: row.first_healthy ?? null,
      ssh: { direct: row.status === 'active' && row.ip && isIP(row.ip) === 4 ? { host: row.ip, port: 22, username: 'ubuntu' } : null } }
  }
  async pods(signal?: AbortSignal): Promise<HostPod[]> {
    const page = await this.api.request('/instances', z.object({ data: z.array(instanceSchema), page_token: z.string().nullable().optional() }), 'GET', undefined, signal)
    if (page.page_token) throw new Error('Lambda returned an incomplete instance list; check the console before renting or declaring termination complete.')
    return page.data.map(row => this.pod(row))
  }
  async get(id: string, signal?: AbortSignal): Promise<HostPod> {
    if (!idSchema.safeParse(id).success) throw new Error('Lambda requires a valid instance ID.')
    const { data } = await this.api.request('/instances/' + encodeURIComponent(id), z.object({ data: instanceSchema }), 'GET', undefined, signal)
    if (data.id !== id) throw new Error('Lambda returned a different instance ID.')
    return this.pod(data)
  }
  private async registerKey(publicKey: string): Promise<string> {
    const name = keyName(publicKey)
    const material = keyMaterial(publicKey)
    await this.api.serial(async () => {
      const { data } = await this.api.request('/ssh-keys', z.object({ data: z.array(keySchema) }))
      const existing = data.find(row => row.name === name)
      if (existing) {
        if (keyMaterial(existing.public_key) !== material) throw new Error('Lambda SSH key ' + name + ' holds a different public key. Resolve that name in the console; no launch was sent.')
        return
      }
      try {
        const result = await this.api.request('/ssh-keys', z.object({ data: keySchema }), 'POST', { name, public_key: publicKey.trim() })
        if (result.data.name !== name || keyMaterial(result.data.public_key) !== material) throw new Error('Lambda did not confirm the ' + name + ' public key; no launch was sent. Check SSH keys in the console.')
      } catch (error) {
        const observed = await this.api.request('/ssh-keys', z.object({ data: z.array(keySchema) }))
        if (!observed.data.some(row => row.name === name && keyMaterial(row.public_key) === material)) throw error
      }
    })
    return name
  }
  async create(offer: HostOffer, publicKey: string, name: string): Promise<HostPod> {
    const placement = this.placements.get(offer)
    if (!placement || placement.fingerprint !== JSON.stringify(offer) || !offer.dataCenter) throw new Error('Choose an unchanged regional offer returned by this Lambda client before renting.')
    if (name.length > 64) throw new Error('Lambda instance names must be 64 characters or fewer; no launch was sent.')
    if (!isOpenSshKey(publicKey) || publicKey.trim().length > 4096) throw new Error('Lambda needs one OpenSSH public key of 4096 characters or fewer.')
    await this.api.reconcile(() => this.pods())
    const key = await this.registerKey(publicKey)
    let id: string
    try {
      id = (await this.api.request('/instance-operations/launch', z.object({ data: z.object({ instance_ids: z.array(idSchema).length(1) }) }), 'POST', {
        region_name: offer.dataCenter, instance_type_name: placement.type, ssh_key_names: [key], name, user_data: LAMBDA_USER_DATA,
      }, undefined, true)).data.instance_ids[0]!
    } catch (error) {
      if (error instanceof HostCreateError && error.outcome === 'ambiguous') this.api.remember(name)
      throw error
    }
    const launchedAt = new Date().toISOString()
    const pod = await this.api.readBack(id, () => this.get(id))
    return pod.createdAt ? pod : { ...pod, createdAt: launchedAt }
  }
  async stop(_id: string): Promise<HostPod> { throw new Error('Lambda has no stop operation. Use terminate to end compute billing; termination deletes the root disk and /workspace data.') }
  async terminate(id: string): Promise<void> {
    if (!idSchema.safeParse(id).success) throw new Error('Lambda requires a valid instance ID.')
    await this.api.request('/instance-operations/terminate', z.object({ data: z.object({ terminated_instances: z.array(z.object({ id: idSchema })) }) }), 'POST', { instance_ids: [id] })
    const deadline = Date.now() + (this.timing.readyTimeoutMs ?? 120000)
    let last = ''
    for (;;) {
      try {
        const pod = (await this.pods()).find(row => row.id === id)
        if (!pod || pod.status === 'TERMINATED') return
      } catch (error) { last = ' ' + (error instanceof Error ? error.message : String(error)) }
      if (Date.now() >= deadline) throw new Error('Lambda termination is not verified; check the instance list in the console.' + last)
      await delay(this.timing.pollMs ?? 1000)
    }
  }
  async logs(_id: string): Promise<string> { return 'Lambda exposes no instance log-read API; connect by SSH to read /var/log/cloud-init-output.log and /workspace/mercury-host, or open the instance in its console.' }
}
