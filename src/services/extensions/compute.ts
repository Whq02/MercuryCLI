import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { acquirePidLockWithRetry } from '../../substrate/pidLock.js'
import { publishAtomicSync } from '../../substrate/fileStore.js'
import { hostDirectory, patchHostRecord, readHostRecord, writeHostRecord, type HostRecord } from '../host/store.js'
import { hostNotice } from '../host/notices.js'
import { hostRecipeSchema } from '../host/recipesFile.js'
import { ensureHostKey, hostRunner } from '../host/ssh.js'
import { vendorClient, vendorStorage, vendorKeyNotice } from '../host/vendors/client.js'
import type { HostVendor } from '../host/vendors/vendor.js'
import type { HostOffer, HostPod } from '../host/runpod.js'
import type { HostRecipe } from '../host/recipes.js'

const id = z.string().regex(/^[a-zA-Z0-9_-]+$/)
const owner = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
const vendor = z.enum(['runpod', 'vast'])
const object = z.record(z.string(), z.unknown())
const recipe = object.transform(value => {
  const weightsGb = z.number().finite().nonnegative().parse(value.weightsGb)
  const verification = z.string().parse(value.verification)
  const parsed = hostRecipeSchema.parse({ ...value, weightsGb: weightsGb || 0.001, verification: verification || 'External compute' })
  if (parsed.nodes !== undefined && parsed.nodes !== 1) throw new Error('External compute requires one machine')
  return { ...parsed, weightsGb, verification }
})
export const computeRequests = [
  z.strictObject({ version: z.literal(1), op: z.literal('host.quote'), vendor, recipe }),
  z.strictObject({ version: z.literal(1), op: z.literal('host.rent'), quote: z.string().uuid(), owner, confirmed: z.literal(true) }),
  z.strictObject({ version: z.literal(1), op: z.literal('host.get'), id, owner }),
  z.strictObject({ version: z.literal(1), op: z.literal('host.update'), id, owner, patch: z.strictObject({ jobState: z.enum(['running', 'ready', 'paused', 'stopped']).optional(), step: z.string().optional(), error: z.string().nullable().optional() }), notice: z.strictObject({ id: z.string().min(1), text: z.string().min(1) }).optional() }),
] as const
type ComputeRequest = z.infer<(typeof computeRequests)[number]>
interface Quote { vendor: 'runpod' | 'vast'; offer: HostOffer; expires: number; state: 'quoted' | 'creating' | 'rented'; owner?: string; connection?: { pod: HostPod; key: string } }
export interface ComputeDeps {
  client?: (vendor: 'runpod' | 'vast') => HostVendor
  key?: (signal: AbortSignal) => Promise<{ path: string; publicKey: string }>
  now?: () => number
}
const save = (path: string, value: unknown): void => { publishAtomicSync(path, JSON.stringify(value) + '\n', { mode: 0o600 }) }
function owned(id: string, owner: string): HostRecord {
  const record = readHostRecord(id)
  if (!record || record.externalJob !== owner) throw new Error('External job does not own this machine')
  return record
}
export async function externalCompute(request: ComputeRequest, signal: AbortSignal, deps: ComputeDeps = {}): Promise<unknown> {
  const now = deps.now ?? Date.now
  const client = deps.client ?? vendorClient
  const quotes = join(hostDirectory(), 'external-quotes')
  if (request.op === 'host.quote') {
    const offer = await client(request.vendor).watchOffer(request.recipe, Number.MAX_SAFE_INTEGER, signal)
    if (!offer) return { quote: null }
    if (!Number.isFinite(offer.price) || offer.price <= 0 || offer.recipe.id !== request.recipe.id) throw new Error('Invalid rental quote')
    const quote = randomUUID()
    mkdirSync(quotes, { recursive: true, mode: 0o700 })
    save(join(quotes, quote + '.json'), { vendor: request.vendor, offer, expires: now() + 5 * 60_000, state: 'quoted' } satisfies Quote)
    return { quote, offer, storage: vendorStorage(request.vendor), keyNotice: vendorKeyNotice(request.vendor) }
  }
  if (request.op === 'host.rent') {
    const path = join(quotes, request.quote + '.json')
    const { release } = await acquirePidLockWithRetry(path + '.lock', randomUUID(), { retries: 0, liveness: 'assume-alive' }).catch(cause => { throw Object.assign(new Error('Lock file is already being held', { cause }), { code: 'ELOCKED', file: path }) })
    try {
      const quote = JSON.parse(readFileSync(path, 'utf8')) as Quote
      if (quote.owner && quote.owner !== request.owner) throw new Error('Rental quote belongs to another external job')
      if (quote.connection) return quote.connection
      if (quote.state !== 'quoted') throw new Error('Rental placement is uncertain; inspect the account before another rental')
      if (now() > quote.expires) throw new Error('Rental quote expired; request a new quote')
      const key = await (deps.key ?? (signal => ensureHostKey(hostRunner, signal)))(signal)
      signal.throwIfAborted()
      quote.owner = request.owner; quote.state = 'creating'; save(path, quote)
      const pod = await client(quote.vendor).create(quote.offer, key.publicKey, request.owner)
      const record: HostRecord = { id: pod.id, name: pod.name, vendor: quote.vendor, recipe: quote.offer.recipe.id, recipeRow: quote.offer.recipe, price: pod.cost, startedAt: pod.startedAt ?? pod.createdAt, status: pod.status, sshKey: key.path, workspace: process.cwd(), externalJob: request.owner, generation: request.owner, jobState: 'running', advancedAt: now() }
      writeHostRecord(record)
      quote.connection = { pod, key: key.path }; quote.state = 'rented'; save(path, quote)
      return quote.connection
    } finally { await release() }
  }
  const record = owned(request.id, request.owner)
  if (request.op === 'host.get') {
    const pod = await client(record.vendor as 'runpod' | 'vast').get(record.id, signal)
    const ssh = pod.ssh?.direct
    patchHostRecord(record.id, { status: pod.status, ...(ssh ? { target: { host: ssh.host, port: ssh.port, user: ssh.username, key: record.sshKey } } : {}) })
    return { pod, key: record.sshKey }
  }
  const { error, ...patch } = request.patch
  const updated = patchHostRecord(record.id, { ...patch, ...(error === undefined ? {} : { error: error ?? undefined }), advancedAt: now() })!
  if (request.notice) hostNotice(updated, request.notice.id, request.notice.text)
  return { id: record.id, updated: true }
}
