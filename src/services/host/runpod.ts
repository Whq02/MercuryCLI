import { z } from 'zod/v4'
import { recipeFits, type HostRecipe } from './recipes.js'
import { currentHostRecipes, refreshHostRecipes } from './recipesFile.js'
import { retryAfterSeconds } from './vendors/http.js'

const podSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), name: z.string(), status: z.string(), cost: z.number().nonnegative(), createdAt: z.string(), startedAt: z.string().nullable().optional(), ssh: z.object({ direct: z.object({ host: z.string(), port: z.number().int().min(1).max(65535), username: z.string() }).nullable().optional() }).nullable().optional(), mounts: z.object({ network: z.array(z.object({ volumeId: z.string() })).optional(), global: z.array(z.object({ volumeId: z.string() })).optional() }).nullish() })
const clusterMemberSchema = z.object({ id: z.string(), rank: z.number().int().nonnegative().nullable(), ip: z.string().optional() })
const clusterPodSchema = podSchema.extend({ cluster: clusterMemberSchema, cudaVersion: z.string().nullable().optional() })
const clusterSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), name: z.string(), type: z.enum(['APPLICATION', 'TRAINING', 'SLURM', 'RAY']), compute: z.object({ gpuTypeId: z.string(), gpuCountPerPod: z.number().int().positive(), podCount: z.number().int().min(2).max(250) }), createdAt: z.string(), primary: z.object({ podId: z.string(), status: z.string() }).optional() })
export type HostCluster = z.infer<typeof clusterSchema>
export type HostPod = z.infer<typeof podSchema> & { family?: HostCluster; nodes?: HostClusterPod[] }
export type HostClusterPod = z.infer<typeof clusterPodSchema>
export interface HostOffer { recipe: HostRecipe; gpuId: string; price: number; dataCenter?: string; availability?: string; hostingType?: 'datacenter' | 'community host' | 'host'; machineId?: number }
const gpuSchema = z.object({ id: z.string(), name: z.string(), memory: z.number(), secure: z.boolean(), price: z.object({ secure: z.number().nonnegative() }), maxCount: z.object({ secure: z.number() }), availability: z.string().optional(), dataCenters: z.array(z.object({ id: z.string(), availability: z.string() })).optional() })
const stockRank = (value?: string): number => value === 'HIGH' ? 3 : value === 'MEDIUM' ? 2 : value === 'LOW' ? 1 : 0
const stock = (value?: string): boolean => stockRank(value) > 0
const unverifiedRank = (recipe: HostRecipe): number => recipe.verified?.by === 'unverified' ? 1 : 0
const refusalStatuses = [400, 401, 402, 403, 413, 422, 429]
const clusterRefusalStatuses = [400, 401, 403, 422, 429]

export class RunpodHttpError extends Error {
  constructor(message: string, readonly status: number, readonly detail: string, readonly retryAfterSeconds?: number) { super(message) }
}
export const createRefusal = (error: unknown): RunpodHttpError | undefined => error instanceof RunpodHttpError && refusalStatuses.includes(error.status) ? error : undefined
export const clusterCreateRefusal = (error: unknown): RunpodHttpError | undefined => error instanceof RunpodHttpError && clusterRefusalStatuses.includes(error.status) ? error : undefined
export const cents = (amount: number): number => Math.round(amount * 100)

export function podLogLines(stream: string): string[] {
  const lines: string[] = []
  for (const frame of stream.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter(row => row.startsWith('data:')).map(row => row.slice(5).trim()).join('\n')
    if (!data) continue
    if (!data.startsWith('{')) { lines.push(data); continue }
    try {
      const event = JSON.parse(data) as { source?: unknown; line?: unknown }
      if (typeof event.line === 'string') lines.push((event.source === 'system' ? 'system: ' : '') + event.line)
    } catch {}
  }
  return lines
}

export class RunpodClient {
  private lastShapes: HostOffer[] = []
  private policy: string | undefined
  private clusterFailure: string | undefined
  constructor(private key: string, private base = 'https://api.runpod.io/v2') {
    const url = new URL(base)
    if (url.username || url.password || url.search || url.hash || !(url.origin === 'https://api.runpod.io' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Runpod uses its official API URL only.')
  }
  private async response(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<Response> {
    const create = method === 'POST' && ['/pods', '/network-volumes', '/global-volumes', '/clusters'].includes(path)
    const resource = path === '/clusters' ? 'cluster' : path === '/pods' ? 'pod' : 'volume'
    const refused = path === '/clusters' ? clusterRefusalStatuses : refusalStatuses
    const response = await fetch(this.base + path, { method, headers: { Authorization: 'Bearer ' + this.key, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(create ? { keepalive: false } : {}), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
    this.policy = response.headers.get('ratelimit-policy') ?? undefined
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let detail = ''
      try { const problem = JSON.parse(text) as { detail?: unknown; error?: unknown; title?: unknown; errors?: unknown }; detail = [problem.detail ?? problem.error ?? problem.title ?? '', ...(Array.isArray(problem.errors) ? problem.errors : [])].map(String).filter(Boolean).join(' · ') } catch { detail = text.trimStart().startsWith('<') ? '' : text }
      detail = detail.split(this.key).join('[redacted]').replace(/\s+/g, ' ').trim().slice(0, 240)
      const wait = retryAfterSeconds(response.headers.get('retry-after'))
      throw new RunpodHttpError('Runpod ' + method + ' ' + path.split('?')[0] + ' returned HTTP ' + response.status + (detail ? ' · ' + detail : '') + (response.status === 401 || response.status === 403 ? ' — check the key and its Pods, Catalog and billing read permissions.' : create && refused.includes(response.status) ? ' · Runpod refused it; no ' + resource + ' was created.' : create ? ' — no retry was sent. Refresh ' + resource + 's before retrying; creation may have reached the account.' : ''), response.status, detail, wait)
    }
    return response
  }
  rateLimitPolicy(): string | undefined { return this.policy }
  shapes(): readonly HostOffer[] { return this.lastShapes }
  clusterReadError(): string | undefined { return this.clusterFailure }
  async offers(signal: AbortSignal): Promise<HostOffer[]> {
    void refreshHostRecipes()
    const allRecipes = currentHostRecipes()
    const recipes = allRecipes.filter(recipe => (recipe.nodes ?? 1) === 1)
    const offers: HostOffer[] = []
    const shapes: HostOffer[] = []
    const groups = [...new Set(recipes.map(recipe => recipe.count + ':' + recipe.cuda))].sort((a, b) => Number(a.split(':')[0]) - Number(b.split(':')[0]))
    for (const group of groups) {
      const [count, cuda] = group.split(':')
      const response = await this.response('/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE&count=' + count + '&minCudaVersion=' + cuda, 'GET', undefined, signal)
      const { gpus } = z.object({ gpus: z.array(gpuSchema) }).parse(await response.json())
      for (const recipe of recipes.filter(recipe => recipe.count === Number(count) && recipe.cuda === cuda)) for (const gpu of gpus) {
        if (!gpu.secure || gpu.price.secure <= 0 || !recipeFits(recipe, gpu.id, gpu.memory, gpu.maxCount.secure)) continue
        const price = gpu.price.secure * recipe.count
        shapes.push({ recipe, gpuId: gpu.id, price, availability: gpu.availability })
        if (!stock(gpu.availability)) continue
        if (gpu.dataCenters) {
          for (const dc of gpu.dataCenters) if (stock(dc.availability)) offers.push({ recipe, gpuId: gpu.id, price, dataCenter: dc.id, availability: dc.availability })
        } else offers.push({ recipe, gpuId: gpu.id, price, availability: gpu.availability })
      }
    }
    let clusters: { offers: HostOffer[]; shapes: HostOffer[] } = { offers: [], shapes: [] }
    this.clusterFailure = undefined
    try { clusters = await this.clusterOffers(allRecipes.filter(recipe => (recipe.nodes ?? 1) > 1), signal) } catch (error) { if (signal.aborted) throw error; this.clusterFailure = String(error) }
    offers.push(...clusters.offers)
    shapes.push(...clusters.shapes)
    this.lastShapes = shapes.sort((a, b) => unverifiedRank(a.recipe) - unverifiedRank(b.recipe) || a.price - b.price || a.recipe.id.localeCompare(b.recipe.id))
    return offers.sort((a, b) => unverifiedRank(a.recipe) - unverifiedRank(b.recipe) || stockRank(b.availability) - stockRank(a.availability) || a.price - b.price || a.recipe.id.localeCompare(b.recipe.id) || (a.dataCenter ?? '').localeCompare(b.dataCenter ?? ''))
  }
  async watchOffer(recipe: HostRecipe, maxPrice: number, signal?: AbortSignal): Promise<HostOffer | undefined> {
    if ((recipe.nodes ?? 1) > 1) {
      const candidates = [recipe, ...currentHostRecipes().filter(row => row.id !== recipe.id && (row.label === recipe.label && row.nodes === recipe.nodes && row.count === recipe.count && row.cuda === recipe.cuda))]
      const result = await this.clusterOffers(candidates.length ? candidates : [recipe], signal)
      return result.offers.filter(row => cents(row.price) <= cents(maxPrice)).sort((a, b) => Number(b.recipe.id === recipe.id) - Number(a.recipe.id === recipe.id) || stockRank(b.availability) - stockRank(a.availability) || a.price - b.price)[0]
    }
    const response = await this.response('/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE&count=' + recipe.count + '&minCudaVersion=' + recipe.cuda, 'GET', undefined, signal)
    const { gpus } = z.object({ gpus: z.array(gpuSchema) }).parse(await response.json())
    const model = recipe.label.split(' · ')[0]
    const candidates = [recipe, ...currentHostRecipes().filter(row => row.id !== recipe.id && (row.label.split(' · ')[0] === model && row.count === recipe.count && row.cuda === recipe.cuda))]
    const offers: HostOffer[] = []
    for (const candidate of candidates.length ? candidates : [recipe]) for (const gpu of gpus) {
      if (!gpu.secure || gpu.price.secure <= 0 || !stock(gpu.availability) || !recipeFits(candidate, gpu.id, gpu.memory, gpu.maxCount.secure)) continue
      const price = gpu.price.secure * candidate.count
      if (cents(price) > cents(maxPrice)) continue
      if (gpu.dataCenters) {
        for (const dc of gpu.dataCenters) if (stock(dc.availability)) offers.push({ recipe: candidate, gpuId: gpu.id, price, dataCenter: dc.id, availability: dc.availability })
      } else offers.push({ recipe: candidate, gpuId: gpu.id, price, availability: gpu.availability })
    }
    return offers.sort((a, b) => Number(b.recipe.id === recipe.id) - Number(a.recipe.id === recipe.id) || stockRank(b.availability) - stockRank(a.availability) || a.price - b.price || (a.dataCenter ?? '').localeCompare(b.dataCenter ?? ''))[0]
  }
  async pods(signal?: AbortSignal): Promise<HostPod[]> {
    const pods: HostPod[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const response = await this.response('/pods' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), 'GET', undefined, signal)
      const page = z.object({ pods: z.array(podSchema), pagination: z.object({ hasNextPage: z.boolean(), nextCursor: z.string().nullable() }) }).parse(await response.json())
      pods.push(...page.pods)
      cursor = page.pagination.hasNextPage ? page.pagination.nextCursor ?? undefined : undefined
      if (page.pagination.hasNextPage && !cursor || cursor && seen.has(cursor)) throw new Error('Runpod returned an invalid pod-list cursor. The paid-pods list is incomplete.')
      if (cursor) seen.add(cursor)
    } while (cursor)
    return pods
  }
  async get(id: string, signal?: AbortSignal): Promise<HostPod> { return podSchema.parse(await (await this.response('/pods/' + encodeURIComponent(id), 'GET', undefined, signal)).json()) }
  async create(offer: HostOffer, publicKey: string, name: string, volume?: HostVolumeMount): Promise<HostPod> {
    if (volume?.kind === 'vast') throw new Error('A Vast.ai volume lives on one Vast.ai machine; it cannot be attached to a Runpod pod. Nothing was created.')
    if (volume?.kind === 'network' && offer.dataCenter && offer.dataCenter !== volume.dataCenter) throw new Error('The kept weights disk requires a pod in ' + volume.dataCenter + '. Choose a fitting shape in that data centre.')
    const script = 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server tmux curl && mkdir -p /root/.ssh /run/sshd && chmod 700 /root/.ssh && printf "%s\n" "$PUBLIC_KEY" >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && ssh-keygen -A && service ssh start && sleep infinity'
    const args = offer.recipe.engine === 'vllm' ? JSON.stringify({ entrypoint: ['bash', '-lc'], cmd: [script] }) : 'bash -lc ' + JSON.stringify(script)
    return podSchema.parse(await (await this.response('/pods', 'POST', { name, image: offer.recipe.image, args, disk: 30, cloud: 'SECURE', ...(volume?.kind === 'network' ? { dataCenterIds: [volume.dataCenter] } : offer.dataCenter ? { dataCenterIds: [offer.dataCenter] } : {}), gpu: { id: offer.gpuId, count: offer.recipe.count, minCudaVersion: offer.recipe.cuda }, mounts: volume ? { [volume.kind]: [{ volumeId: volume.id, path: '/workspace' }] } : { persistent: { size: offer.recipe.diskGb, path: '/workspace' } }, ports: ['22/tcp'], env: { PUBLIC_KEY: publicKey, HF_HOME: '/workspace/huggingface' } })).json())
  }
  async stop(id: string): Promise<HostPod> { return podSchema.parse(await (await this.response('/pods/' + encodeURIComponent(id) + '/action', 'POST', { action: 'stop' })).json()) }
  async terminate(id: string): Promise<void> { await this.response('/pods/' + encodeURIComponent(id), 'DELETE') }
  async logs(id: string, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new DOMException('Log read timed out', 'TimeoutError')), 3000)
    let text = ''
    try {
      const response = await this.response('/pods/' + encodeURIComponent(id) + '/logs?tail=12', 'GET', undefined, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
      const reader = response.body?.getReader()
      if (reader) try { const decoder = new TextDecoder(); while (text.length < 12000) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }) } } finally { await reader.cancel().catch(() => {}) }
    } catch (error) { if (signal) { signal.throwIfAborted(); if (!text) throw error } else if (!text) text = 'Log tail unavailable; open this pod in Runpod to read its container logs.' } finally { clearTimeout(timer) }
    const lines = /^(?:data|id|event):/m.test(text) ? podLogLines(text) : text.split('\n')
    return lines.map(line => line.split(this.key).join('[redacted]')).filter(Boolean).slice(-12).join('\n')
  }
  async volumes(signal?: AbortSignal): Promise<HostVolume[]> {
    const result: HostVolume[] = []
    for (const kind of ['network', 'global'] as const) {
      let cursor: string | undefined
      const seen = new Set<string>()
      do {
        const response = await this.response('/' + kind + '-volumes' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), 'GET', undefined, signal)
        const page = z.object({ networkVolumes: z.array(networkVolumeSchema).optional(), globalVolumes: z.array(globalVolumeSchema).optional(), pagination: z.object({ hasNextPage: z.boolean(), nextCursor: z.string().nullable() }) }).parse(await response.json())
        const rows = kind === 'network' ? page.networkVolumes : page.globalVolumes
        if (!rows) throw new Error('Runpod returned an incomplete ' + kind + ' volume list.')
        result.push(...rows.map(row => ({ ...row, kind })))
        cursor = page.pagination.hasNextPage ? page.pagination.nextCursor ?? undefined : undefined
        if (page.pagination.hasNextPage && !cursor || cursor && seen.has(cursor)) throw new Error('Runpod volume pagination is incomplete. Storage may still bill.')
        if (cursor) seen.add(cursor)
      } while (cursor)
    }
    return result
  }
  async dataCenters(signal?: AbortSignal): Promise<{ id: string; name: string; networkVolumeTypes: string[] }[]> {
    return z.object({ dataCenters: z.array(z.object({ id: z.string(), name: z.string(), networkVolumeTypes: z.array(z.string()) })) }).parse(await (await this.response('/catalog/datacenters', 'GET', undefined, signal)).json()).dataCenters
  }
  async createVolume(kind: HostVolumeMount['kind'], name: string, size: number, dataCenter: string): Promise<HostVolume> {
    const body = kind === 'network' ? { name, size, dataCenter, type: 'STANDARD' } : { name }
    const response = await this.response('/' + kind + '-volumes', 'POST', body)
    return { ...(kind === 'network' ? networkVolumeSchema.parse(await response.json()) : globalVolumeSchema.parse(await response.json())), kind }
  }
  async deleteVolume(kind: HostVolumeMount['kind'], id: string): Promise<void> { await this.response('/' + kind + '-volumes/' + encodeURIComponent(id), 'DELETE') }
  async clusterOffers(recipes: readonly HostRecipe[], signal?: AbortSignal): Promise<{ offers: HostOffer[]; shapes: HostOffer[] }> {
    const offers: HostOffer[] = []
    const shapes: HostOffer[] = []
    const groups = [...new Set(recipes.map(row => row.count * (row.nodes ?? 1) + ':' + row.cuda))]
    for (const group of groups) {
      const [count, cuda] = group.split(':')
      const response = await this.response('/catalog/gpus?include=AVAILABILITY&product=CLUSTER&cloud=SECURE&count=' + count + '&minCudaVersion=' + cuda, 'GET', undefined, signal)
      const { gpus } = z.object({ gpus: z.array(gpuSchema) }).parse(await response.json())
      for (const recipe of recipes.filter(row => row.count * (row.nodes ?? 1) === Number(count) && row.cuda === cuda)) for (const gpu of gpus) {
        if (!gpu.secure || gpu.price.secure <= 0 || !recipeFits(recipe, gpu.id, gpu.memory, gpu.maxCount.secure, recipe.nodes)) continue
        const price = gpu.price.secure * recipe.count * (recipe.nodes ?? 1)
        shapes.push({ recipe, gpuId: gpu.id, price, availability: gpu.availability })
        if (!stock(gpu.availability)) continue
        for (const dc of gpu.dataCenters ?? []) if (stock(dc.availability)) offers.push({ recipe, gpuId: gpu.id, price, dataCenter: dc.id, availability: dc.availability })
      }
    }
    return { offers, shapes }
  }
  async createCluster(offer: HostOffer, publicKey: string, name: string): Promise<HostCluster> {
    if (!Number.isInteger(offer.recipe.nodes) || offer.recipe.nodes! < 2 || offer.recipe.nodes! > 250 || !offer.dataCenter) throw new Error('Choose a fitting cluster offer in one data center before creating it.')
    const args = JSON.stringify({ entrypoint: ['bash', '-lc'], cmd: ['apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server tmux curl iproute2 && mkdir -p /root/.ssh /run/sshd && chmod 700 /root/.ssh && printf "%s\n" "$PUBLIC_KEY" >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && ssh-keygen -A && service ssh start && sleep infinity'] })
    return clusterSchema.parse(await (await this.response('/clusters', 'POST', { name, type: 'APPLICATION', compute: { gpuTypeId: offer.gpuId, gpuCountPerPod: offer.recipe.count, podCount: offer.recipe.nodes }, image: offer.recipe.image, args, disk: 30, dataCenterIds: [offer.dataCenter], mounts: { persistent: { size: offer.recipe.diskGb, path: '/workspace' } }, ports: ['22/tcp'], env: { PUBLIC_KEY: publicKey, HF_HOME: '/workspace/huggingface' } })).json())
  }
  async clusters(signal?: AbortSignal): Promise<HostCluster[]> {
    const clusters: HostCluster[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const response = await this.response('/clusters' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), 'GET', undefined, signal)
      const page = z.object({ clusters: z.array(clusterSchema), pagination: z.object({ hasNextPage: z.boolean(), nextCursor: z.string().nullable() }) }).parse(await response.json())
      clusters.push(...page.clusters)
      cursor = page.pagination.hasNextPage ? page.pagination.nextCursor ?? undefined : undefined
      if (page.pagination.hasNextPage && !cursor || cursor && seen.has(cursor)) throw new Error('Runpod returned an invalid cluster-list cursor. The paid-clusters list is incomplete.')
      if (cursor) seen.add(cursor)
    } while (cursor)
    return clusters
  }
  async getCluster(id: string, signal?: AbortSignal): Promise<HostCluster> { return clusterSchema.parse(await (await this.response('/clusters/' + encodeURIComponent(id), 'GET', undefined, signal)).json()) }
  async clusterPods(id: string, signal?: AbortSignal): Promise<HostClusterPod[]> { return z.object({ pods: z.array(clusterPodSchema) }).parse(await (await this.response('/clusters/' + encodeURIComponent(id) + '/pods', 'GET', undefined, signal)).json()).pods }
  async terminateCluster(id: string): Promise<void> { await this.response('/clusters/' + encodeURIComponent(id), 'DELETE') }
}

const volumeId = z.string().regex(/^[A-Za-z0-9_-]+$/)
const networkVolumeSchema = z.object({ id: volumeId, name: z.string(), size: z.number().int().positive(), dataCenter: z.string(), type: z.string() })
const globalVolumeSchema = z.object({ id: volumeId, name: z.string(), createdAt: z.string() })
export interface HostVolumeMount { id: string; kind: 'network' | 'global' | 'vast'; dataCenter?: string; machineId?: number }
export interface HostVolume extends HostVolumeMount { name: string; size?: number; type?: string; createdAt?: string }
