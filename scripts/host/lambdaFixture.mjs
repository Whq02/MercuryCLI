import { createServer } from 'node:http'

const type = (name, gpu, gpus, price, storage = 11264) => ({ name, description: gpus + 'x ' + gpu, gpu_description: gpu, price_cents_per_hour: price, specs: { vcpus: 104, memory_gib: 1440, storage_gib: storage, gpus }, architecture: 'x86_64' })
const regions = [{ name: 'us-west-1', description: 'California, USA' }, { name: 'us-east-1', description: 'Virginia, USA' }]
export async function lambdaFixture() {
  const key = 'fixture-lambda-key'
  const requests = []
  const types = [type('gpu_4x_b200', 'B200 (180 GB SXM6)', 4, 1196), type('gpu_8x_b200', 'B200 (180 GB SXM6)', 8, 2392, 22528), type('gpu_1x_h100_sxm5', 'H100 (80 GB SXM5)', 1, 299, 2816)]
  const state = { noStock: false, stockLoss: false, ambiguousCreate: false, rateLimited: false, creates: 0, deletes: 0, keyCreates: 0, pods: new Map(), keys: [], types, bootReads: 1, createStatus: 0, holdTerminate: false, badRead: false, mismatchKey: false, retryAfter: '1', ambiguousKey: false }
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    requests.push({ path, method: req.method, body, at: Date.now(), socket: req.socket.remotePort, connection: req.headers.connection })
    const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    const fail = (status, code, message) => json({ error: { code, message: message + ' ' + key } }, status)
    if (req.headers.authorization !== 'Bearer ' + key) { fail(401, 'global/invalid-api-key', 'Invalid API key'); return }
    const create = path === '/api/v1/instance-operations/launch' && req.method === 'POST'
    if (create) state.creates++
    if (state.rateLimited) { res.setHeader('Retry-After', state.retryAfter); fail(429, 'global/rate-limited', 'Too many requests'); return }
    if (path === '/api/v1/instance-types' && req.method === 'GET') { json({ data: Object.fromEntries(state.types.map(instance_type => [instance_type.name, { instance_type, regions_with_capacity_available: state.noStock ? [] : regions }])) }); return }
    if (path === '/api/v1/ssh-keys') {
      if (req.method === 'GET') { json({ data: state.keys }); return }
      if (req.method === 'POST') {
        state.keyCreates++
        if (state.keys.some(row => row.name === body.name)) { fail(400, 'ssh-keys/duplicate-name', 'Name exists'); return }
        const row = { id: 'key-1', name: body.name, public_key: state.mismatchKey ? 'ssh-ed25519 ZGlmZmVyZW50' : body.public_key }
        state.keys.push(row); if (state.ambiguousKey) { req.socket.destroy(); return } json({ data: row }); return
      }
    }
    if (create) {
      if (state.stockLoss) { fail(400, 'instance-operations/launch/insufficient-capacity', 'Insufficient capacity'); return }
      if (state.createStatus) { fail(state.createStatus, 'global/invalid-parameters', 'fixture refusal'); return }
      if (body.ssh_key_names?.length !== 1 || body.ssh_key_names[0] !== 'mercury-host' || !state.keys.some(row => row.name === 'mercury-host') || !regions.some(row => row.name === body.region_name)) { fail(400, 'global/invalid-parameters', 'Invalid launch arguments'); return }
      const instance_type = state.types.find(row => row.name === body.instance_type_name)
      if (!instance_type) { fail(404, 'instance-operations/launch/resource-not-found', 'Instance type not found'); return }
      const id = 'lambda-' + state.creates
      state.pods.set(id, { id, name: body.name, status: 'booting', ssh_key_names: body.ssh_key_names, file_system_names: [], region: regions[0], instance_type, first_healthy: null, actions: {}, reads: 0 })
      if (state.ambiguousCreate === 'disconnect') { req.socket.destroy(); return }
      if (state.ambiguousCreate === 'timeout') return
      if (state.ambiguousCreate === 'malformed') { res.writeHead(200); res.end('{'); return }
      if (state.ambiguousCreate === 'unreadable') { json({ data: { instance_ids: [] } }); return }
      if (state.ambiguousCreate) { fail(503, 'provider/internal-unavailable', 'Provider unavailable'); return }
      json({ data: { instance_ids: [id] } }); return
    }
    if (path === '/api/v1/instances' && req.method === 'GET') { json({ data: [...state.pods.values()] }); return }
    if (path === '/api/v1/instance-operations/terminate' && req.method === 'POST') {
      const terminated_instances = []
      state.deletes++
      for (const id of body.instance_ids) { const row = state.pods.get(id); if (row) { terminated_instances.push({ ...row, status: 'terminated' }); if (!state.holdTerminate) state.pods.delete(id) } }
      json({ data: { terminated_instances } }); return
    }
    const id = path.split('/').at(-1)
    const row = state.pods.get(id)
    if (path.startsWith('/api/v1/instances/') && row && req.method === 'GET') {
      row.reads++
      if (row.reads > state.bootReads) { row.status = 'active'; row.ip = '127.0.0.1'; row.first_healthy = '2026-10-20T09:00:00Z' }
      json(state.badRead ? {} : { data: row }); return
    }
    fail(404, 'global/not-found', 'Not found')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/api/v1'
  return { key, requests, state, baseUrl, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
}
