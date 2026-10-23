import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod/v4'
import { recipeFits, type HostRecipe } from '../recipes.js'
import { currentHostRecipes } from '../recipesFile.js'
import { defaultTune, readTunePreferences, tunedRecipe } from '../tune.js'
import { HOST_VENDOR_INFO, type HostOffer, type HostPod, type HostVendor } from './vendor.js'
import { HostCreateError, HostVendorHttpError, VendorApi, type VendorTiming } from './http.js'
import { HostTerminationUnconfirmed, type HostReadOnly } from '../retry.js'

export const HF_ENDPOINTS_STORAGE_NOTICE = 'HF-managed · per hour · no SSH · downloads the weights first. One replica, billed by the minute while initializing or running. Pause ends compute billing; Resume starts it again. No weights disk is attached.'
export const HF_ENDPOINTS_KEY_NOTICE = 'Uses your Hugging Face sign-in (/logins huggingface)'
const official = 'https://api.endpoints.huggingface.cloud/v2'
const nameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
const namespaceSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
const computeSchema = z.object({ id: z.string(), accelerator: z.string(), numAccelerators: z.number().int().positive(), gpuMemoryGb: z.number().nonnegative().nullable().optional(), instanceType: z.string(), instanceSize: z.string(), architecture: z.string(), status: z.string(), pricePerHour: z.number().nonnegative(), quota: z.object({ maxAccelerators: z.number().int().nonnegative(), usedAccelerators: z.number().int().nonnegative() }) })
const catalogueSchema = z.object({ vendors: z.array(z.object({ name: z.string(), regions: z.array(z.object({ name: z.string(), computes: z.array(computeSchema) })) })) })
const endpointSchema = z.object({ name: nameSchema, provider: z.object({ vendor: z.string(), region: z.string() }), compute: z.object({ instanceType: z.string(), instanceSize: z.string() }), status: z.object({ state: z.string(), createdAt: z.string(), url: z.string().nullable().optional(), readyReplica: z.number().int().nonnegative(), targetReplica: z.number().int().nonnegative() }) })
const listSchema = z.object({ items: z.array(endpointSchema), totalItems: z.number().int().nonnegative(), nextCursor: z.string().nullable().optional(), prevCursor: z.string().nullable().optional() })
type Hardware = z.infer<typeof computeSchema> & { vendor: string; region: string }
const identity = (namespace: string, name: string): string => 'hf-' + Buffer.from(namespace + '/' + name).toString('base64url')
function parts(id: string): { namespace: string; name: string } {
  const [namespace, name, extra] = Buffer.from(id.slice(3), 'base64url').toString().split('/')
  if (!id.startsWith('hf-') || !namespaceSchema.safeParse(namespace).success || !nameSchema.safeParse(name).success || extra !== undefined || identity(namespace!, name!) !== id) throw new Error('Hugging Face requires a valid endpoint ID.')
  return { namespace: namespace!, name: name! }
}
function hfEndpointRecipeReason(recipe: HostRecipe): string | undefined {
  if ((recipe.nodes ?? 1) !== 1) return 'cluster'
  if (recipe.files && Object.keys(recipe.files).length || recipe.flags.some(value => value.includes('/workspace/'))) return 'files'
  if (recipe.engine === 'llamacpp' && !recipe.weightFile) return 'GGUF'
  return undefined
}

class HostHuggingfaceSignInRequired extends HostVendorHttpError {
  readonly state = 'sign-in-required' as const
  readonly vendor = 'huggingface' as const
  constructor() { super('Hugging Face: sign in again with /logins huggingface', 401) }
}
const rejectedCredentials = new Set<string>()
const credentialId = (key: string): string => createHash('sha256').update(key).digest('hex')
export class HuggingfaceClient implements HostVendor {
  readonly vendor = 'huggingface' as const
  readonly label = HOST_VENDOR_INFO.huggingface.label
  readonly keyHelp = HOST_VENDOR_INFO.huggingface.keyHelp
  readonly capabilities = { managed: true, stop: true, dataCenters: true, persistentDisk: 'none' } as const
  private api!: VendorApi
  private logsApi!: VendorApi
  private hub!: VendorApi
  private namespace?: string
  private hardware?: Hardware[]
  private lastShapes: HostOffer[] = []
  private placements = new WeakMap<HostOffer, { hardware: Hardware; fingerprint: string }>()
  constructor(private key: string, private base = official, private timing: VendorTiming = {}, private credential?: (refresh: boolean) => Promise<{ key: string } | undefined>) {
    this.configure(key)
  }
  private configure(key: string): void {
    this.key = key
    this.namespace = undefined
    this.api = new VendorApi(this.label, key, this.base, official, [400, 401, 403, 404, 409, 422, 429], this.timing)
    const url = new URL(this.api.base)
    const fixture = url.protocol === 'http:'
    this.hub = new VendorApi(this.label, key, (fixture ? url.origin : 'https://huggingface.co') + '/api', 'https://huggingface.co/api', [], this.timing)
    this.logsApi = new VendorApi(this.label, key, url.origin + '/v3', 'https://api.endpoints.huggingface.cloud/v3', [], this.timing)
  }
  rateLimitPolicy(): string { return this.api.policy() ?? 'HF does not publish a fixed endpoint API quota here. Reads honor Retry-After; creates are never retried.' }
  shapes(): readonly HostOffer[] { return this.lastShapes }
  offersNote(): string { return 'HF-managed · per hour · no SSH · personal namespace · live catalogue and quota, placement not guaranteed' }
  private async account(signal?: AbortSignal): Promise<string> {
    const credential = await this.credential?.(false)
    if (this.credential && !credential) throw new HostHuggingfaceSignInRequired()
    if (credential && credential.key !== this.key) this.configure(credential.key)
    if (rejectedCredentials.has(credentialId(this.key))) throw new HostHuggingfaceSignInRequired()
    if (!this.namespace) {
      for (let attempt = 0; ; attempt++) {
        try {
          this.namespace = (await this.hub.request('/whoami-v2', z.object({ type: z.literal('user'), name: namespaceSchema }), 'GET', undefined, signal)).name
          break
        } catch (error) {
          if (!(error instanceof HostVendorHttpError) || ![401, 403].includes(error.status)) throw error
          if (attempt === 0 && error.status === 401) {
            const fresh = await this.credential?.(true)
            if (fresh) { this.configure(fresh.key); continue }
          }
          rejectedCredentials.add(credentialId(this.key))
          throw new HostHuggingfaceSignInRequired()
        }
      }
    }
    return this.namespace
  }
  private async catalogue(signal?: AbortSignal): Promise<Hardware[]> {
    const namespace = await this.account(signal)
    const page = await this.api.request('/provider/' + namespace, catalogueSchema, 'GET', undefined, signal)
    return this.hardware = page.vendors.flatMap(vendor => vendor.regions.flatMap(region => region.computes.map(row => ({ ...row, vendor: vendor.name, region: region.name }))))
  }
  private async search(recipes: readonly HostRecipe[], signal?: AbortSignal): Promise<{ offers: HostOffer[]; shapes: HostOffer[] }> {
    const offers: HostOffer[] = [], shapes: HostOffer[] = []
    for (const hardware of await this.catalogue(signal)) {
      if (hardware.accelerator !== 'gpu' || !hardware.gpuMemoryGb || hardware.pricePerHour <= 0 || hardware.status === 'deprecated') continue
      const count = hardware.numAccelerators
      for (const recipe of recipes) {
        if (hfEndpointRecipeReason(recipe) || count !== recipe.count || !recipeFits(recipe, hardware.architecture, hardware.gpuMemoryGb / count, count)) continue
        const available = ['available', 'low_availability'].includes(hardware.status) && hardware.quota.maxAccelerators - hardware.quota.usedAccelerators >= count
        const offer: HostOffer = { recipe, gpuId: hardware.architecture, price: hardware.pricePerHour, dataCenter: hardware.vendor + '/' + hardware.region, availability: available ? hardware.status === 'low_availability' ? 'LOW' : 'HIGH' : 'NONE' }
        shapes.push(offer)
        if (available) { this.placements.set(offer, { hardware, fingerprint: JSON.stringify(offer) }); offers.push(offer) }
      }
    }
    const sort = (a: HostOffer, b: HostOffer): number => a.price - b.price || a.recipe.id.localeCompare(b.recipe.id) || a.dataCenter!.localeCompare(b.dataCenter!)
    return { offers: offers.sort(sort), shapes: shapes.sort(sort) }
  }
  async offers(signal: AbortSignal): Promise<HostOffer[]> {
    this.lastShapes = []
    const rows = await this.search(currentHostRecipes(), signal)
    this.lastShapes = rows.shapes
    return rows.offers
  }
  async watchOffer(recipe: HostRecipe, maxPrice: number, signal?: AbortSignal): Promise<HostOffer | undefined> {
    const siblings = [recipe, ...currentHostRecipes().filter(row => row.id !== recipe.id && row.label === recipe.label && row.count === recipe.count)]
    return (await this.search(siblings, signal)).offers.find(row => row.price <= maxPrice)
  }
  private pod(row: z.infer<typeof endpointSchema>, namespace: string): HostPod {
    const hardware = this.hardware?.find(hw => hw.vendor === row.provider.vendor && hw.region === row.provider.region && hw.instanceType === row.compute.instanceType && hw.instanceSize === row.compute.instanceSize)
    if (!hardware) throw new Error('HF endpoint hardware price is absent from the catalogue; billing is unknown. Check the HF console.')
    const state = row.status.state
    const status = state === 'running' ? 'RUNNING' : ['failed', 'updateFailed'].includes(state) ? 'ERROR' : ['paused', 'scaledToZero'].includes(state) ? 'EXITED' : 'PROVISIONING'
    return { id: identity(namespace, row.name), name: row.name, status, cost: status === 'EXITED' ? 0 : hardware.pricePerHour * Math.max(1, row.status.readyReplica, row.status.targetReplica), createdAt: row.status.createdAt, startedAt: row.status.createdAt, ssh: { direct: null } }
  }
  async pods(signal?: AbortSignal): Promise<HostPod[]> {
    const namespace = await this.account(signal)
    if (!this.hardware) await this.catalogue(signal)
    const pending = [''], visited = new Set<string>(), rows = new Map<string, z.infer<typeof endpointSchema>>()
    let total: number | undefined
    while (pending.length) {
      const cursor = pending.shift()!
      if (visited.has(cursor)) continue
      visited.add(cursor)
      const page = await this.api.request('/endpoint/' + namespace + '?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), listSchema, 'GET', undefined, signal)
      if (total !== undefined && page.totalItems !== total) throw new Error('HF endpoint list changed while reading; refresh before declaring termination complete.')
      total = page.totalItems
      for (const row of page.items) rows.set(row.name, row)
      for (const next of [page.prevCursor, page.nextCursor]) if (next && !visited.has(next)) pending.push(next)
    }
    if (rows.size !== total) throw new Error('HF returned an incomplete endpoint list; termination is not verified.')
    return [...rows.values()].map(row => this.pod(row, namespace))
  }
  private async row(id: string, signal?: AbortSignal): Promise<z.infer<typeof endpointSchema>> {
    const { namespace, name } = parts(id)
    if (namespace !== await this.account(signal)) throw new Error('This HF endpoint belongs to a different namespace. Nothing was changed.')
    const row = await this.api.request('/endpoint/' + namespace + '/' + name, endpointSchema, 'GET', undefined, signal)
    if (row.name !== name) throw new Error('HF returned a different endpoint name.')
    if (!this.hardware) await this.catalogue(signal)
    return row
  }
  async get(id: string, signal?: AbortSignal): Promise<HostPod> { return this.pod(await this.row(id, signal), parts(id).namespace) }
  async managedEndpoint(id: string, signal?: AbortSignal): Promise<{ pod: HostPod; baseUrl?: string }> {
    const row = await this.row(id, signal)
    const pod = this.pod(row, parts(id).namespace)
    if (pod.status !== 'RUNNING' || !row.status.url) return { pod }
    let url: URL
    try { url = new URL(row.status.url) } catch { throw new Error('HF endpoint URL is invalid; no token was sent.') }
    const fixture = new URL(this.api.base)
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' && !url.port && url.hostname.endsWith('.endpoints.huggingface.cloud') || fixture.protocol === 'http:' && url.origin === fixture.origin)) throw new Error('HF endpoint URL is not an HF-managed address; no token was sent.')
    return { pod, baseUrl: url.origin + '/v1' }
  }
  async create(offer: HostOffer, _publicKey: string, name: string): Promise<HostPod> {
    const placement = this.placements.get(offer)
    if (!placement || placement.fingerprint !== JSON.stringify(offer)) throw new Error('Choose an unchanged offer returned by this Hugging Face client before renting.')
    if (!nameSchema.safeParse(name).success) throw new Error('HF endpoint names need 1–32 lowercase letters, digits or hyphens; no create was sent.')
    const namespace = await this.account()
    await this.api.reconcile(() => this.pods())
    const original = offer.recipe
    const saved = readTunePreferences(original.label.split(' · ')[0]!)
    const recipe = tunedRecipe(original, saved?.quality === original.id ? saved : defaultTune(original))
    if (hfEndpointRecipeReason(recipe)) throw new Error('This recipe needs files or a cluster unavailable on Hugging Face Inference Endpoints; nothing was rented.')
    const engine = recipe.engine === 'vllm' ? 'vLLM' : recipe.engine === 'llamacpp' ? 'llamacpp' : 'sGLang'
    const image = { url: recipe.image, ...(engine === 'llamacpp' ? { modelPath: recipe.weightFile, ...(recipe.mmproj ? { mmprojModelPath: recipe.mmproj } : {}) } : { tensorParallelSize: recipe.count, ...(engine === 'vLLM' ? { dataParallelSize: 1 } : {}) }) }
    const flags = [...recipe.flags]
    const context = recipe.context
    if (context && engine === 'sGLang' && !flags.some(flag => ['--context-length', '--context-length='].some(prefix => flag === prefix || flag.startsWith(prefix + '=')))) flags.push('--context-length', String(context))
    if (context && engine === 'vLLM' && !flags.some(flag => flag === '--max-model-len' || flag.startsWith('--max-model-len='))) flags.push('--max-model-len', String(context))
    const hw = placement.hardware
    try {
      const row = await this.api.request('/endpoint/' + namespace, endpointSchema, 'POST', {
        name, type: 'private', provider: { vendor: hw.vendor, region: hw.region },
        compute: { accelerator: 'gpu', instanceType: hw.instanceType, instanceSize: hw.instanceSize, scaling: { minReplica: 1, maxReplica: 1, scaleToZeroTimeout: null } },
        model: { repository: recipe.model, framework: engine === 'llamacpp' ? 'llamacpp' : 'custom', task: 'text-generation', image: { [engine]: image }, args: flags, ...(recipe.environment ? { env: recipe.environment } : {}) },
      }, undefined, true)
      if (row.name !== name) throw this.api.ambiguous()
    } catch (error) { if (error instanceof HostCreateError && error.outcome === 'ambiguous') this.api.remember(name); throw error }
    return this.api.readBack(identity(namespace, name), () => this.get(identity(namespace, name)))
  }
  private async operation(id: string, action: 'pause' | 'resume'): Promise<HostPod> {
    const { namespace, name } = parts(id)
    if (namespace !== await this.account()) throw new Error('This HF endpoint belongs to a different namespace. Nothing was changed.')
    await this.api.request('/endpoint/' + namespace + '/' + name + '/' + action, endpointSchema, 'POST')
    return this.get(id)
  }
  async stop(id: string): Promise<HostPod> { return this.operation(id, 'pause') }
  async resume(id: string): Promise<HostPod> { return this.operation(id, 'resume') }
  async terminate(id: string, readOnly?: HostReadOnly): Promise<void> {
    const { namespace, name } = parts(id)
    if (namespace !== await this.account()) throw new Error('This HF endpoint belongs to a different namespace. Nothing was changed.')
    await this.api.request('/endpoint/' + namespace + '/' + name, z.object({}), 'DELETE')
    const deadline = Date.now() + (this.timing.readyTimeoutMs ?? 120000)
    for (;;) {
      let rows: HostPod[]
      try { rows = await (readOnly ? readOnly('pod listing', signal => this.pods(signal)) : this.pods()) } catch (error) { throw new HostTerminationUnconfirmed(this.label, error) }
      if (!rows.some(row => row.id === id)) return
      if (Date.now() >= deadline) throw new Error('HF termination is not verified; the endpoint may still bill. Check the HF console.')
      await delay(this.timing.pollMs ?? 1000)
    }
  }
  async logs(id: string, signal?: AbortSignal): Promise<string> {
    const { namespace, name } = parts(id)
    if (namespace !== await this.account(signal)) throw new Error('This HF endpoint belongs to a different namespace.')
    const rows = await this.logsApi.request('/endpoint/' + namespace + '/' + name + '/logs?limit=100&order=desc', z.array(z.object({ timestamp: z.string(), line: z.string(), stream: z.string(), replica_id: z.string() })), 'GET', undefined, signal)
    return this.api.redact(rows.map(row => row.timestamp + ' ' + row.line).join('\n')) || 'HF returned no endpoint logs.'
  }
}
