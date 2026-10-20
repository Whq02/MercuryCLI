import { createServer } from 'node:http'

export async function vastFixture() {
  const key = 'fixture-vast-key'
  const requests = []
  const state = { noStock: false, stockLoss: false, ambiguousCreate: false, rateLimited: false, creates: 0, deletes: 0, stops: 0, pods: new Map(), customOffers: null, createStatus: 0, holdTerminate: false, badRead: false, logUrl: null }
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    const url = new URL(req.url, 'http://127.0.0.1')
    requests.push({ path: url.pathname, method: req.method, body, at: Date.now(), socket: req.socket.remotePort, connection: req.headers.connection, authorization: req.headers.authorization })
    const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    const fail = (status, msg) => json({ success: false, error: 'invalid_args', msg: msg + ' ' + key }, status)
    if (url.pathname.startsWith('/fixture-logs/')) { res.writeHead(200); res.end('booted\n' + key + '\nready\n'); return }
    if (req.headers.authorization !== 'Bearer ' + key) { fail(401, 'Invalid user key'); return }
    const create = req.method === 'PUT' && url.pathname.startsWith('/api/v0/asks/')
    if (create) state.creates++
    if (state.rateLimited) { if (state.rateLimited === 'once') state.rateLimited = false; fail(429, 'API requests too frequent endpoint threshold=4.5'); return }
    if (url.pathname === '/api/v0/bundles/' && req.method === 'POST') {
      const common = { verification: 'verified', reliability2: 0.999, reliability: 0.999, direct_port_count: 1, rentable: true, rented: false, cuda_max_good: 13, disk_space: 2000 }
      const offers = state.customOffers ?? [
        { ...common, id: 101, gpu_name: 'H200', gpu_ram: 141 * 1024, num_gpus: 1, dph_total: 2.1 },
        { ...common, id: 102, gpu_name: 'RTX_PRO_6000', gpu_ram: 96 * 1024, num_gpus: 1, dph_total: 1.2 },
        { ...common, id: 103, gpu_name: 'B200', gpu_ram: 192 * 1024, num_gpus: 4, dph_total: 9.25 },
        { ...common, id: 104, gpu_name: 'B300', gpu_ram: 288 * 1024, num_gpus: 1, dph_total: 5.5 },
        { ...common, id: 105, gpu_name: 'GB300', gpu_ram: 288 * 1024, num_gpus: 4, dph_total: 20 },
      ]
      json({ offers: state.noStock ? [] : offers.filter(row => row.num_gpus === body.num_gpus.eq).map(row => ({ ...row, dph_total: row.dph_total + body.allocated_storage / 10000 })) }); return
    }
    if (create) {
      if (state.stockLoss) { fail(410, 'no_such_ask: offer is no longer available'); return }
      if (state.createStatus) { fail(state.createStatus, 'fixture refusal'); return }
      if (body.runtype !== 'ssh_direct' || !body.env?.PUBLIC_KEY || typeof body.env !== 'object' || !body.image || !body.disk || !body.onstart || 'price' in body) { fail(400, 'Invalid args'); return }
      const id = 7000 + state.creates
      state.pods.set(id, { id, label: body.label, actual_status: 'running', start_date: 1792490400, dph_total: 9.315, ssh_host: '127.0.0.1', ssh_port: 2222 })
      if (state.ambiguousCreate === 'disconnect') { req.socket.destroy(); return }
      if (state.ambiguousCreate === 'timeout') return
      if (state.ambiguousCreate === 'malformed') { res.writeHead(200); res.end('{'); return }
      if (state.ambiguousCreate === 'unreadable') { json({ success: true, new_contract: key }); return }
      if (state.ambiguousCreate) { fail(503, 'upstream failed after accepting'); return }
      json({ success: true, new_contract: id }); return
    }
    if (url.pathname === '/api/v0/instances/' && req.method === 'GET') { json({ instances_found: state.pods.size, instances: [...state.pods.values()] }); return }
    const log = /^\/api\/v0\/instances\/request_logs\/(\d+)\/$/.exec(url.pathname)
    if (log && req.method === 'PUT') { json({ success: true, result_url: state.logUrl ?? origin + '/fixture-logs/' + log[1] }); return }
    const match = /^\/api\/v0\/instances\/(\d+)\/$/.exec(url.pathname)
    const id = Number(match?.[1])
    const pod = state.pods.get(id)
    if (!pod) { fail(404, 'Instance not found'); return }
    if (req.method === 'GET') { json(state.badRead ? {} : { instances: pod }); return }
    if (req.method === 'PUT' && body.state === 'stopped') { state.stops++; pod.actual_status = 'stopped'; json({ success: true }); return }
    if (req.method === 'DELETE') { state.deletes++; if (!state.holdTerminate) state.pods.delete(id); json({ success: true }); return }
    fail(400, 'unknown request')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  return { key, requests, state, baseUrl: origin + '/api/v0', close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
}
