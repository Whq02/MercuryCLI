import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod/v4'
import { recipeFits, type HostRecipe } from '../recipes.js'
import { currentHostRecipes } from '../recipesFile.js'
import type { HostReadOnly } from '../retry.js'
import { HOST_VENDOR_INFO, type HostVendor, type HostOffer, type HostPod } from './vendor.js'
import { VendorApi, HostCreateError, HostVendorHttpError, keyMaterial, type VendorTiming } from './http.js'
import { sortVmOffers, validateVmCreate, verifyVmAbsent, vmKeyName, VmPlacements } from './vm.js'

const BASE = 'https://api.verda.com/v1'
const IMAGE = 'ubuntu-24.04-cuda-13.0-open-docker'
export const VERDA_STORAGE_NOTICE = 'Root disk: $0.20/GiB-month; Terminate deletes it. Other volumes keep billing. Compute prepays ten-minute increments; unused time is refunded. Shutdown keeps compute billing. Egress price unavailable.'
export const VERDA_KEY_NOTICE = 'Adds an SSH key and startup script to your Verda account. Remove them in the console when finished.'
export const VERDA_STARTUP_SCRIPT = '#!/bin/bash\nset -e\nmkdir -p /workspace\nif ! command -v curl >/dev/null || ! command -v setsid >/dev/null; then apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y curl util-linux; fi\ndocker info >/dev/null\ntouch /workspace/.mercury-vm-ready\n'
const idSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/)
const money = z.union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/)]).transform(Number).pipe(z.number().finite().nonnegative())
const typeSchema = z.object({ instance_type: z.string().min(1), model: z.string(), gpu: z.object({ description: z.string(), number_of_gpus: z.number().int().nonnegative() }), gpu_memory: z.object({ size_in_gigabytes: z.number().nonnegative() }), price_per_hour: money, currency: z.string(), supported_os: z.array(z.string()).optional() })
const instanceSchema = z.object({ id: idSchema, hostname: z.string(), status: z.string(), ip: z.string().nullable().optional(), created_at: z.string(), price_per_hour: money, os_volume_id: idSchema.nullable().optional() })
const keySchema = z.object({ id: idSchema, name: z.string(), key: z.string() })
const scriptSchema = z.object({ id: idSchema, name: z.string(), script: z.string() })
const createdId = z.union([idSchema, z.object({ id: idSchema }).transform(row => row.id)])

export class VerdaClient implements HostVendor {
  readonly vendor = 'verda' as const
  readonly label = HOST_VENDOR_INFO.verda.label
  readonly keyHelp = HOST_VENDOR_INFO.verda.keyHelp
  readonly capabilities = { stop: false, dataCenters: true, persistentDisk: 'root', vm: true } as const
  private api: VendorApi
  private lastShapes: HostOffer[] = []
  private placements = new VmPlacements<{ type: string; region: string; disk: number }>()
  private roots = new Map<string, string>()
  constructor(key: string, base = BASE, private timing: VendorTiming = {}) {
    const colon = key.indexOf(':')
    if (colon <= 0 || colon === key.length - 1) throw new Error('Verda needs Client ID:Client Secret from Cloud API Credentials, not an inference key.')
    const clientId = key.slice(0, colon), clientSecret = key.slice(colon + 1)
    let token = '', expires = 0, pending: Promise<void> | undefined
    const secrets = () => [clientId, clientSecret, token]
    const auth = new VendorApi(this.label, key, base, BASE, [], timing, false, { headers: () => ({}), secrets })
    this.api = new VendorApi(this.label, key, base, BASE, [400, 401, 403, 404, 422, 429], timing, false, {
      secrets, textResponses: true,
      headers: async signal => {
        if (Date.now() >= expires) {
          pending ??= (async () => {
            const answer = await auth.request('/oauth2/token', z.object({ access_token: z.string().min(1), expires_in: z.number().positive(), token_type: z.string().regex(/^Bearer$/i) }), 'POST', { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }, signal)
            token = answer.access_token; expires = Date.now() + Math.max(0, answer.expires_in - 30) * 1000
          })().finally(() => { pending = undefined })
          await pending
        }
        return { Authorization: 'Bearer ' + token }
      },
    })
  }
  rateLimitPolicy(): string { return this.api.policy() ?? 'Verda read failures use bounded backoff. Creates are never retried; access tokens refresh before expiry.' }
  shapes(): readonly HostOffer[] { return this.lastShapes }
  offersNote(): string { return 'Prices are fixed on-demand compute in USD; root disk is extra. B300 advertised at 268 GB does not fit recipes requiring 288 GB per GPU. Network egress price is not published.' }
  private async search(recipes: readonly HostRecipe[], signal?: AbortSignal): Promise<{ offers: HostOffer[]; shapes: HostOffer[] }> {
    const types = await this.api.request('/instance-types?currency=USD', z.array(typeSchema), 'GET', undefined, signal)
    const stock = await this.api.request('/instance-availability?is_spot=false', z.array(z.object({ location_code: z.string().min(1), availabilities: z.array(z.string()) })), 'GET', undefined, signal)
    const offers: HostOffer[] = [], shapes: HostOffer[] = []
    for (const type of types) {
      const count = type.gpu.number_of_gpus
      if (!count || type.currency !== 'USD' || !type.price_per_hour || type.supported_os && !type.supported_os.includes(IMAGE)) continue
      const gpuId = /RTX\s+PRO\s*6000/i.test(type.gpu.description) ? 'NVIDIA RTX PRO 6000 Blackwell' : type.gpu.description
      const fits = recipes.filter(recipe => count === recipe.count && Number(recipe.cuda) <= 13 && recipeFits(recipe, gpuId, type.gpu_memory.size_in_gigabytes / count, count))
      if (!fits.length) continue
      const regions = stock.filter(region => region.availabilities.includes(type.instance_type))
      if (!regions.length) for (const recipe of fits) shapes.push({ recipe, gpuId, price: type.price_per_hour, availability: 'NONE' })
      for (const region of regions) {
        const regional = await this.api.request('/instance-types/' + encodeURIComponent(type.instance_type) + '?is_spot=false&currency=USD&location_code=' + encodeURIComponent(region.location_code), typeSchema, 'GET', undefined, signal)
        if (regional.instance_type !== type.instance_type || regional.currency !== 'USD' || !regional.price_per_hour) continue
        for (const recipe of fits) {
          if (regional.gpu.number_of_gpus !== count || !recipeFits(recipe, regional.gpu.description.replace(/RTX\s+PRO\s*6000/i, 'RTX PRO 6000 Blackwell'), regional.gpu_memory.size_in_gigabytes / count, count)) continue
          const offer: HostOffer = { recipe, gpuId, price: regional.price_per_hour, dataCenter: region.location_code, availability: 'HIGH' }
          this.placements.add(offer, { type: type.instance_type, region: region.location_code, disk: Math.ceil(recipe.diskGb) }); shapes.push(offer); offers.push(offer)
        }
      }
    }
    return { offers: offers.sort(sortVmOffers), shapes: shapes.sort(sortVmOffers) }
  }
  async offers(signal: AbortSignal): Promise<HostOffer[]> { this.lastShapes = []; const found = await this.search(currentHostRecipes(), signal); this.lastShapes = found.shapes; return found.offers }
  async watchOffer(recipe: HostRecipe, maxPrice: number, signal?: AbortSignal): Promise<HostOffer | undefined> { return (await this.search([recipe], signal)).offers.find(row => row.price <= maxPrice) }
  private pod(row: z.infer<typeof instanceSchema>): HostPod {
    if (row.os_volume_id) this.roots.set(row.id, row.os_volume_id)
    const running = row.status === 'running'
    return { id: row.id, name: this.api.redact(row.hostname), status: running ? 'RUNNING' : row.status === 'error' || row.status === 'no_capacity' ? 'ERROR' : row.status.toUpperCase(), cost: row.price_per_hour, createdAt: row.created_at, startedAt: row.created_at, ssh: { direct: running && row.ip && isIP(row.ip) === 4 ? { host: row.ip, port: 22, username: 'root' } : null } }
  }
  async pods(signal?: AbortSignal): Promise<HostPod[]> { return (await this.api.request('/instances', z.array(instanceSchema), 'GET', undefined, signal)).map(row => this.pod(row)) }
  async get(id: string, signal?: AbortSignal): Promise<HostPod> {
    if (!idSchema.safeParse(id).success) throw new Error('Verda requires a valid instance ID.')
    const row = await this.api.request('/instances/' + encodeURIComponent(id), instanceSchema, 'GET', undefined, signal)
    if (row.id !== id) throw new Error('Verda returned a different instance ID.')
    return this.pod(row)
  }
  private prepare(publicKey: string): Promise<{ key: string; script: string }> {
    return this.api.serial(async () => {
      const material = keyMaterial(publicKey), name = vmKeyName(publicKey)
      const keys = () => this.api.request('/ssh-keys', z.array(keySchema))
      let existing = (await keys()).find(row => row.name === name)
      if (existing && keyMaterial(existing.key) !== material) throw new Error('Verda has a different public key with Mercury’s key name; no instance was created.')
      if (!existing) {
        try { await this.api.request('/ssh-keys', createdId, 'POST', { name, key: publicKey.trim() }) } catch (error) {
          if (!(await keys()).some(row => row.name === name && keyMaterial(row.key) === material)) throw error
        }
        existing = (await keys()).find(row => row.name === name && keyMaterial(row.key) === material)
      }
      if (!existing) throw new Error('Verda did not confirm Mercury’s SSH public key; no instance was created.')
      const scriptName = 'mercury-host-' + createHash('sha256').update(VERDA_STARTUP_SCRIPT).digest('hex').slice(0, 16)
      const scripts = () => this.api.request('/scripts', z.array(scriptSchema))
      let script = (await scripts()).find(row => row.name === scriptName)
      if (script && script.script !== VERDA_STARTUP_SCRIPT) throw new Error('Verda has a different startup script with Mercury’s script name; no instance was created.')
      if (!script) {
        try { await this.api.request('/scripts', createdId, 'POST', { name: scriptName, script: VERDA_STARTUP_SCRIPT }) } catch (error) {
          if (!(await scripts()).some(row => row.name === scriptName && row.script === VERDA_STARTUP_SCRIPT)) throw error
        }
        script = (await scripts()).find(row => row.name === scriptName && row.script === VERDA_STARTUP_SCRIPT)
      }
      if (!script) throw new Error('Verda did not confirm the startup script; no instance was created.')
      return { key: existing.id, script: script.id }
    })
  }
  async create(offer: HostOffer, publicKey: string, name: string): Promise<HostPod> {
    const placement = this.placements.get(offer)
    validateVmCreate(publicKey, name)
    await this.api.reconcile(() => this.pods())
    const images = await this.api.request('/images?instance_type=' + encodeURIComponent(placement.type), z.array(z.object({ image_type: z.string() })))
    if (!images.some(row => row.image_type === IMAGE)) throw new Error('Verda does not list the required CUDA 13 Docker image for this instance; nothing was rented.')
    const prepared = await this.prepare(publicKey)
    let id: string
    try {
      id = await this.api.request('/instances', createdId, 'POST', { instance_type: placement.type, location_code: placement.region, image: IMAGE, hostname: name, description: name, contract: 'PAY_AS_YOU_GO', pricing: 'FIXED_PRICE', is_spot: false, ssh_key_ids: [prepared.key], startup_script_id: prepared.script, os_volume: { name: name + '-root', size: placement.disk } }, undefined, true)
    } catch (error) { if (error instanceof HostCreateError && error.outcome === 'ambiguous') this.api.remember(name); throw error }
    return this.api.readBack(id, () => this.get(id))
  }
  async stop(_id: string): Promise<HostPod> { throw new Error('Verda shutdown keeps compute billing. Use terminate to delete the instance and its root disk.') }
  async terminate(id: string, readOnly?: HostReadOnly): Promise<void> {
    if (!idSchema.safeParse(id).success) throw new Error('Verda requires a valid instance ID.')
    let exists = true
    try { await (readOnly ? readOnly('instance', signal => this.get(id, signal)) : this.get(id)) } catch (error) { if (!(error instanceof HostVendorHttpError && error.status === 404)) throw error; exists = false }
    const root = this.roots.get(id)
    if (!root) throw new Error('Verda root disk could not be identified; termination and storage deletion are not verified. Check the instance and volumes in the console.')
    if (exists) await this.api.request('/instances', z.unknown(), 'PUT', { action: 'delete', id: [id], volume_ids: [root], delete_permanently: true })
    const storageGone = async (signal?: AbortSignal): Promise<boolean> => {
      for (const path of ['/volumes', '/volumes/trash']) if ((await this.api.request(path, z.array(z.object({ id: idSchema })), 'GET', undefined, signal)).some(row => row.id === root)) return false
      return true
    }
    await verifyVmAbsent(this.label, id, signal => this.pods(signal), this.timing, readOnly, storageGone)
  }
  async logs(_id: string): Promise<string> { return 'Verda has no instance log-read API here. Use SSH to read the startup output and /workspace/mercury-host.' }
}
