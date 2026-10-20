import { z } from 'zod/v4'
import { HOST_RECIPES, recipeFits, type HostRecipe } from './recipes.js'

const podSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), name: z.string(), status: z.string(), cost: z.number().nonnegative(), createdAt: z.string(), startedAt: z.string().nullable().optional(), ssh: z.object({ direct: z.object({ host: z.string(), port: z.number().int().min(1).max(65535), username: z.string() }).nullable().optional() }).nullable().optional() })
export type HostPod = z.infer<typeof podSchema>
export interface HostOffer { recipe: HostRecipe; gpuId: string; price: number; dataCenter: string }
const gpuSchema = z.object({ id: z.string(), name: z.string(), memory: z.number(), secure: z.boolean(), price: z.object({ secure: z.number().nonnegative() }), maxCount: z.object({ secure: z.number() }), availability: z.string().optional(), dataCenters: z.array(z.object({ id: z.string(), availability: z.string() })).optional() })
const stock = (value?: string): boolean => ['LOW', 'MEDIUM', 'HIGH'].includes(value ?? '')

export class RunpodClient {
  constructor(private key: string, private base = 'https://api.runpod.io/v2') {
    const url = new URL(base)
    if (url.username || url.password || url.search || url.hash || !(url.origin === 'https://api.runpod.io' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Runpod uses its official API or a loopback fixture only.')
  }
  private async response(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(this.base + path, { method, headers: { Authorization: 'Bearer ' + this.key, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error('Runpod ' + method + ' ' + path.split('?')[0] + ' returned HTTP ' + response.status + (response.status === 401 || response.status === 403 ? ' — check the key and its Pods, Catalog and billing read permissions.' : method === 'POST' && path === '/pods' ? ' — no retry was sent. Refresh pods before choosing another fitting shape; creation may have reached the account.' : ''))
    return response
  }
  async offers(signal: AbortSignal): Promise<HostOffer[]> {
    const offers: HostOffer[] = []
    const groups = [...new Set(HOST_RECIPES.map(recipe => recipe.count + ':' + recipe.cuda))]
    for (const group of groups) {
      const [count, cuda] = group.split(':')
      const response = await this.response('/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE&count=' + count + '&minCudaVersion=' + cuda, 'GET', undefined, signal)
      const { gpus } = z.object({ gpus: z.array(gpuSchema) }).parse(await response.json())
      for (const recipe of HOST_RECIPES.filter(recipe => recipe.count === Number(count) && recipe.cuda === cuda)) for (const gpu of gpus) {
        if (!gpu.secure || gpu.price.secure <= 0 || !stock(gpu.availability) || !recipeFits(recipe, gpu.id, gpu.memory, gpu.maxCount.secure)) continue
        const dc = gpu.dataCenters?.find(dc => stock(dc.availability))
        if (dc) offers.push({ recipe, gpuId: gpu.id, price: gpu.price.secure * recipe.count, dataCenter: dc.id })
      }
    }
    return offers.sort((a, b) => a.price - b.price || a.recipe.id.localeCompare(b.recipe.id))
  }
  async pods(signal?: AbortSignal): Promise<HostPod[]> {
    const pods: HostPod[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const response = await this.response('/pods' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), 'GET', undefined, signal)
      const page = z.object({ pods: z.array(podSchema), pagination: z.object({ hasNextPage: z.boolean(), nextCursor: z.string().nullable() }).optional() }).parse(await response.json())
      pods.push(...page.pods)
      cursor = page.pagination?.hasNextPage ? page.pagination.nextCursor ?? undefined : undefined
      if (cursor && seen.has(cursor)) throw new Error('Runpod repeated its pod-list cursor. The paid-pods list is incomplete.')
      if (cursor) seen.add(cursor)
    } while (cursor)
    return pods
  }
  async get(id: string, signal?: AbortSignal): Promise<HostPod> { return podSchema.parse(await (await this.response('/pods/' + encodeURIComponent(id), 'GET', undefined, signal)).json()) }
  async create(offer: HostOffer, publicKey: string, name: string): Promise<HostPod> {
    const args = 'bash -lc ' + JSON.stringify('apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server tmux curl && mkdir -p /root/.ssh /run/sshd && chmod 700 /root/.ssh && printf "%s\n" "$PUBLIC_KEY" >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && ssh-keygen -A && service ssh start && sleep infinity')
    return podSchema.parse(await (await this.response('/pods', 'POST', { name, image: offer.recipe.image, args, disk: 30, cloud: 'SECURE', dataCenterIds: [offer.dataCenter], gpu: { id: offer.gpuId, count: offer.recipe.count, minCudaVersion: offer.recipe.cuda }, mounts: { persistent: { size: offer.recipe.diskGb, path: '/workspace' } }, ports: ['22/tcp'], env: { PUBLIC_KEY: publicKey, HF_HOME: '/workspace/huggingface' } })).json())
  }
  async stop(id: string): Promise<HostPod> { return podSchema.parse(await (await this.response('/pods/' + encodeURIComponent(id) + '/action', 'POST', { action: 'stop' })).json()) }
  async terminate(id: string): Promise<void> { await this.response('/pods/' + encodeURIComponent(id), 'DELETE') }
  async logs(id: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    let text = ''
    try {
      const response = await this.response('/pods/' + encodeURIComponent(id) + '/logs?tail=12', 'GET', undefined, controller.signal)
      const reader = response.body?.getReader()
      if (reader) try { while (text.length < 12000) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value) } } finally { await reader.cancel().catch(() => {}) }
    } catch { if (!text) text = 'Log tail unavailable; open this pod in Runpod to read its container logs.' } finally { clearTimeout(timer) }
    return text.split(this.key).join('[redacted]').split('\n').filter(Boolean).slice(-12).join('\n')
  }
}
