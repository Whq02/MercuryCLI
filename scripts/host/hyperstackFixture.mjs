import { vmFixture } from './vmFixture.mjs'

export async function hyperstackFixture() {
  const flavors = [
    { name: 'n3-RTX-PRO6000-SEx1', gpu: 'RTX-PRO6000-SE', gpu_count: 1, disk: 100, ephemeral: 3300, cpu: 28, ram: 225 },
    { name: 'n3-H200-SXM5x8', gpu: 'H200-141G-SXM5', gpu_count: 8, disk: 100, ephemeral: 48000, cpu: 176, ram: 1800 },
    { name: 'n3-B200-SXM6x8', gpu: 'B200-SXM', gpu_count: 8, disk: 1000, ephemeral: 40000, cpu: 252, ram: 2048 },
    { name: 'n3-B300-SXM6x8', gpu: 'B300-SXM', gpu_count: 8, disk: 1000, ephemeral: 40000, cpu: 224, ram: 1920 },
  ].map((row, i) => ({ ...row, id: i + 1, region_name: 'CANADA-1', stock_available: true }))
  const prices = [{ name: 'vCPU', value: '0E-9' }, { name: 'RAM', value: '0E-9' }, { name: 'RTX-PRO6000-SE', value: '1.850000000' }, { name: 'H200-141G-SXM5', value: '3.990000000' }, { name: 'B200-SXM', value: '6.000000000' }, { name: 'B300-SXM', value: '7.400000000' }]
  const f = await vmFixture('hyperstack', '/v1', async ({ req, path, method, body, url, json, fail, key, state }) => {
    if (req.headers.api_key !== key || req.headers.authorization) return fail(401, 'Invalid API key')
    const page = rows => {
      const size = Math.min(Number(url.searchParams.get('pageSize') ?? 100), state.pageSize)
      const n = Number(url.searchParams.get('page') ?? 1)
      return { rows: rows.slice((n - 1) * size, n * size), page: n, page_size: size }
    }
    if (path === '/v1/core/flavors') return json({ status: true, data: [{ gpu: '', region_name: 'CANADA-1', flavors: state.flavors.map(row => ({ ...row, stock_available: !state.noStock && row.stock_available })) }] })
    if (path === '/v1/pricebook') return json(state.prices)
    if (path === '/v1/core/images') return json({ status: true, images: [{ region_name: 'CANADA-1', type: 'Ubuntu', images: state.images }] })
    if (path === '/v1/core/environments') {
      if (method === 'POST') { const environment = { id: 1, ...body }; state.environments.push(environment); return json({ status: true, environment }) }
      const p = page(state.environments); return json({ status: true, environments: p.rows, page: p.page, page_size: p.page_size, count: p.rows.length })
    }
    if (path === '/v1/core/keypairs') {
      if (method === 'POST') {
        state.keyCreates++
        const environment = state.environments.find(row => row.name === body.environment_name)
        if (!environment) return fail(400, 'Unknown environment')
        const keypair = { id: state.keyCreates, name: body.name, public_key: state.mismatchKey ? 'ssh-ed25519 ZGlmZmVyZW50' : body.public_key, environment }
        state.keys.push(keypair); return json({ status: true, keypair })
      }
      const p = page(state.keys); return json({ status: true, keypairs: p.rows, page: p.page, page_size: p.page_size, count: p.rows.length })
    }
    if (path === '/v1/core/virtual-machines' && method === 'POST') {
      state.creates++
      if (state.createStatus || state.noStock) return fail(state.createStatus || 400, 'No capacity')
      if (body.count !== 1 || !state.keys.some(row => row.name === body.key_name && row.environment.name === body.environment_name) || !body.assign_floating_ip || body.enable_port_randomization !== false || !body.security_rules?.some(row => row.port_range_min === 22 && row.port_range_max === 22) || !body.user_data?.startsWith('#cloud-config')) return fail(400, 'Invalid VM configuration')
      const flavor = state.flavors.find(row => row.name === body.flavor_name)
      if (!flavor || !state.images.some(row => row.id === body.image_id)) return fail(400, 'Unknown flavor or image')
      const id = 8100 + state.creates
      state.pods.set(String(id), { id, name: body.name, status: 'CREATING', floating_ip: null, created_at: '2026-10-23T09:00:00Z', flavor, environment: state.environments.find(row => row.name === body.environment_name), reads: 0 })
      if (state.ambiguousCreate) return req.socket.destroy()
      return json({ status: true, instances: [{ id }] })
    }
    if (path === '/v1/core/virtual-machines' && method === 'GET') {
      if (state.badList) return json({ status: false })
      const p = page([...state.pods.values()]); return json({ status: true, instances: p.rows, page: p.page, page_size: p.page_size, count: p.rows.length })
    }
    const match = /^\/v1\/core\/virtual-machines\/(\d+)(\/logs)?$/.exec(path)
    const pod = state.pods.get(match?.[1])
    if (!pod) return fail(404, 'VM not found')
    if (match[2]) return json(method === 'POST' ? { request_id: 7 } : { logs: 'ready\n' + key })
    if (method === 'GET') {
      if (++pod.reads > state.bootReads) { pod.status = 'ACTIVE'; pod.floating_ip = '127.0.0.1' }
      return json(state.badRead ? {} : { status: true, instance: pod })
    }
    if (method === 'DELETE') {
      state.deletes++
      if (state.refuseCreating && pod.status === 'CREATING') return fail(400, 'VM is currently being created and cannot be deleted yet')
      if (!state.holdTerminate) state.pods.delete(String(pod.id))
      return json({ status: true, message: 'Instance is being deleted.' })
    }
    fail(404, 'Unknown endpoint')
  })
  Object.assign(f.state, { flavors, prices, environments: [], images: [{ id: 13, name: 'Ubuntu Server 24.04 LTS R595 CUDA 13.2 with Docker', region_name: 'CANADA-1', flavor_restrictions: { has_flavor_restrictions: false, restriction_type: null, compatible_flavors: [] } }], refuseCreating: false })
  return f
}
