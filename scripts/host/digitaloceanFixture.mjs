import { vmFixture } from './vmFixture.mjs'

export async function digitaloceanFixture() {
  const sizes = [
    { slug: 'gpu-h100x1-80gb', count: 1, model: 'nvidia_h100', memory: 80, price: 4.41 },
    { slug: 'gpu-h200x1-141gb', count: 1, model: 'nvidia_h200', memory: 141, price: 4.47 },
    { slug: 'gpu-h200x8-1128gb', count: 8, model: 'nvidia_h200', memory: 141, price: 35.76 },
    { slug: 'gpu-b300x8-2304gb-spot', count: 8, model: 'nvidia_b300', memory: 288, price: 49.36 },
  ].map(row => ({ slug: row.slug, available: true, regions: ['nyc2', 'atl1'], price_hourly: row.price, disk: 720, disk_info: [{ type: 'boot', size: { amount: 720, unit: 'gib' } }, { type: 'scratch', size: { amount: 5120 * row.count, unit: 'gib' } }], gpu_info: { count: row.count, model: row.model, vram: { amount: row.memory, unit: 'gib' } } }))
  const f = await vmFixture('digitalocean', '/v2', async ({ req, res, path, method, body, url, json, text, fail, key, state }) => {
    if (req.headers.authorization !== 'Bearer ' + key) return fail(401, 'Invalid API token')
    const page = (rows, field) => {
      const size = Math.min(Number(url.searchParams.get('per_page') ?? 200), state.pageSize)
      const n = Number(url.searchParams.get('page') ?? 1)
      const next = new URL(url); next.searchParams.set('page', String(n + 1)); next.searchParams.set('per_page', String(size))
      next.host = req.headers.host
      if (state.linkOrigin) { const origin = new URL(state.linkOrigin); next.protocol = origin.protocol; next.hostname = origin.hostname; next.port = origin.port }
      return { [field]: rows.slice((n - 1) * size, n * size), meta: { total: rows.length }, links: { pages: n * size < rows.length ? { next: String(next) } : {} } }
    }
    if (path === '/v2/sizes') return json(page(state.sizes.map(row => ({ ...row, available: !state.noStock && row.available })), 'sizes'))
    if (path === '/v2/account/keys') {
      if (method === 'POST') {
        state.keyCreates++
        const ssh_key = { id: state.keyCreates, name: body.name, public_key: state.mismatchKey ? 'ssh-ed25519 ZGlmZmVyZW50' : body.public_key }
        state.keys.push(ssh_key); return json({ ssh_key }, 201)
      }
      return json(page(state.keys, 'ssh_keys'))
    }
    if (path === '/v2/droplets' && method === 'POST') {
      state.creates++
      if (state.createStatus || state.noStock) return fail(state.createStatus || 422, 'No capacity')
      const size = state.sizes.find(row => row.slug === body.size)
      if (!size || !size.regions.includes(body.region) || body.ssh_keys?.length !== 1 || !state.keys.some(row => row.id === body.ssh_keys[0]) || !['gpu-h100x1-base', 'gpu-h100x8-base'].includes(body.image) || !body.user_data?.includes('LABEL=DOSCRATCH')) return fail(422, 'Invalid Droplet configuration')
      const id = 8200 + state.creates
      const droplet = { id, name: body.name, status: 'new', networks: { v4: [] }, size, created_at: '2026-10-23T09:00:00Z', reads: 0 }
      state.pods.set(String(id), droplet)
      if (state.ambiguousCreate) return req.socket.destroy()
      return json({ droplet }, 202)
    }
    if (path === '/v2/droplets' && method === 'GET') {
      if (state.badList) return json({ droplets: [], meta: { total: 999 }, links: {} })
      return json(page(url.searchParams.get('type') === 'gpus' ? [...state.pods.values()] : [], 'droplets'))
    }
    const match = /^\/v2\/droplets\/(\d+)$/.exec(path)
    const pod = state.pods.get(match?.[1])
    if (!pod) return fail(404, 'Droplet not found')
    if (method === 'GET') {
      if (++pod.reads > state.bootReads) { pod.status = 'active'; pod.networks.v4 = [{ type: 'public', ip_address: '127.0.0.1' }] }
      return json(state.badRead ? {} : { droplet: pod })
    }
    if (method === 'DELETE') { state.deletes++; if (!state.holdTerminate) state.pods.delete(String(pod.id)); res.writeHead(204); res.end(); return }
    fail(404, 'Unknown endpoint')
  })
  f.state.sizes = sizes
  return f
}
