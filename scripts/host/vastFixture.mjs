import { createServer } from 'node:http'

export async function vastFixture() {
  const key = 'fixture-vast-key'
  const requests = []
  const state = { failNext: null, retryAfter: undefined, noStock: false, stockLoss: false, ambiguousCreate: false, rateLimited: false, creates: 0, deletes: 0, stops: 0, pods: new Map(), customOffers: null, createStatus: 0, holdTerminate: false, badRead: false, logUrl: null, keys: [], keyCreates: 0, ambiguousKey: false, mismatchKey: false, noDirect: false, plainTextError: false, messageOnlyError: false, provisioningRead: false, listResponse: null, volumes: new Map(), volumeCreates: 0, volumeDeletes: 0, volumeOffers: null, volumeCreateStatus: 0, ambiguousVolumeCreate: false, holdVolumeDelete: false, volumeListShape: 'volumes', volumeNameOnly: true, createBodies: [], volumeSearches: [] }
  const defaultVolumeOffers = [
    { id: 701, machine_id: 9103, host_id: 31, disk_space: 2000, storage_cost: 0.2, verification: 'verified', reliability2: 0.999, reliability: 0.999, geolocation: 'NL', datacenter: true, cuda_max_good: 13, disk_bw: 2800, inet_down: 9000, inet_up: 4000 },
    { id: 702, machine_id: 9102, host_id: 32, disk_space: 1000, storage_cost: 0.1, verification: 'verified', reliability2: 0.998, reliability: 0.998, geolocation: 'US', datacenter: false, cuda_max_good: 13, disk_bw: 1500, inet_down: 2000, inet_up: 900 },
    { id: 703, machine_id: 9105, host_id: 33, disk_space: 600, storage_cost: 0.5, verification: 'verified', reliability2: 0.999, reliability: 0.999, geolocation: 'DE', datacenter: true, cuda_max_good: 13, disk_bw: 3000, inet_down: 9500, inet_up: 9500 },
  ]
  const volumeRow = volume => ({ id: volume.id, cluster_id: null, label: volume.label, disk_space: volume.disk_space, status: volume.status, disk_name: 'FIXTURE NVMe 4TB', driver_version: '580.65.06', inet_up: 4000, inet_down: 9000, reliability2: 0.999, machine_id: volume.machine_id, verification: 'verified', host_id: volume.host_id, geolocation: volume.geolocation, start_date: volume.start_date, storage_total_cost: volume.storage_cost * volume.disk_space / 720, instances: [...state.pods.values()].filter(pod => pod.volume_id === volume.id).map(pod => ({ id: pod.id, actual_status: pod.actual_status })) })
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    const url = new URL(req.url, 'http://127.0.0.1')
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: req.method, body, at: Date.now(), socket: req.socket.remotePort, connection: req.headers.connection, authorization: req.headers.authorization })
    const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    const fail = (status, msg) => json({ success: false, error: 'invalid_args', msg: msg + ' ' + key }, status)
    if (url.pathname.startsWith('/fixture-logs/')) { res.writeHead(200); res.end('booted\n' + key + '\nready\n'); return }
    if (req.headers.authorization !== 'Bearer ' + key) { fail(401, 'Invalid user key'); return }
    if (url.pathname === '/api/v0/instances/' && req.method === 'GET') { res.writeHead(410, { 'content-type': 'text/plain' }); res.end('/api/v0/instances/ is deprecated. Use /api/v1/instances/ instead.'); return }
    const failure = [state.failNext].flat().find(row => row && row.times > 0 && row.route === req.method + ' ' + url.pathname)
    if (failure) {
      failure.times--
      if (failure.status === 'disconnect') return req.socket.destroy()
      const retryAfter = failure.retryAfter ?? state.retryAfter
      if (retryAfter !== undefined) res.setHeader('Retry-After', String(retryAfter))
      fail(failure.status, 'fixture route failure'); return
    }
    if (state.plainTextError) { res.writeHead(429, { 'content-type': 'text/plain' }); res.end('API requests too frequent: endpoint threshold=4.5 ' + key); return }
    if (state.messageOnlyError) { json({ message: 'Offer unavailable ' + key }, 400); return }
    const create = req.method === 'PUT' && url.pathname.startsWith('/api/v0/asks/')
    if (create) state.creates++
    if (state.rateLimited) { if (state.rateLimited === 'once') state.rateLimited = false; fail(429, 'API requests too frequent endpoint threshold=4.5'); return }
    if (url.pathname === '/api/v0/bundles/' && req.method === 'POST') {
      const common = { datacenter: true, verification: 'verified', reliability2: 0.999, reliability: 0.999, direct_port_count: 1, rentable: true, rented: false, cuda_max_good: 13, disk_space: 2000 }
      const offers = state.customOffers ?? [
        { ...common, id: 101, gpu_name: 'H200', gpu_ram: 141 * 1024, num_gpus: 1, dph_total: 2.1, datacenter: true, machine_id: 9101 },
        { ...common, id: 102, gpu_name: 'RTX_PRO_6000', gpu_ram: 96 * 1024, num_gpus: 1, dph_total: 1.2, datacenter: false, machine_id: 9102 },
        { ...common, id: 103, gpu_name: 'B200', gpu_ram: 192 * 1024, num_gpus: 4, dph_total: 9.25, machine_id: 9103 },
        { ...common, id: 104, gpu_name: 'B300', gpu_ram: 288 * 1024, num_gpus: 1, dph_total: 5.5, machine_id: 9104 },
        { ...common, id: 105, gpu_name: 'GB300', gpu_ram: 288 * 1024, num_gpus: 4, dph_total: 20, machine_id: 9105 },
        { ...common, id: 106, gpu_name: 'RTX_PRO_6000', gpu_ram: 96 * 1024, num_gpus: 1, dph_total: 1.35, machine_id: 9103 },
      ]
      const wanted = row => (body.num_gpus === undefined || row.num_gpus === body.num_gpus.eq) && (body.machine_id === undefined || row.machine_id === body.machine_id.eq) && (state.customOffers !== null || body.gpu_ram === undefined || row.gpu_ram >= (body.gpu_ram?.gte ?? 0)) && (body.disk_space === undefined || row.disk_space >= body.disk_space.gte)
      json({ offers: state.noStock ? [] : offers.filter(wanted).map(row => ({ ...row, dph_total: row.dph_total + body.allocated_storage / 10000 })) }); return
    }
    if (url.pathname === '/api/v0/volumes/search/' && req.method === 'POST') {
      state.volumeSearches.push(body)
      const offers = (state.volumeOffers ?? defaultVolumeOffers).filter(row => (body.disk_space === undefined || row.disk_space >= body.disk_space.gte) && (body.machine_id === undefined || row.machine_id === body.machine_id.eq) && (body.verified === undefined || body.verified.eq === (row.verification === 'verified')))
      json({ offers: offers.map(row => ({ ...row, storage_total_cost: row.storage_cost * (body.allocated_storage ?? 1) / 720, external: false })) }); return
    }
    if (url.pathname === '/api/v0/volumes' && req.method === 'GET') {
      if (url.searchParams.get('owner') !== 'me' || !['local_volume', 'all_volume', 'network_volume'].includes(url.searchParams.get('type'))) { fail(400, 'Invalid volume query'); return }
      const rows = url.searchParams.get('type') === 'network_volume' ? [] : [...state.volumes.values()].map(volumeRow)
      if (state.volumeListShape === 'array') { json(rows); return }
      if (state.volumeListShape === 'data') { json({ data: rows }); return }
      if (state.volumeListShape === 'bad') { json({ volumes: 'none' }); return }
      json({ volumes: rows }); return
    }
    if (url.pathname === '/api/v0/volumes/' && req.method === 'PUT') {
      state.volumeCreates++
      const offer = (state.volumeOffers ?? defaultVolumeOffers).find(row => row.id === body?.id)
      if (!offer || !Number.isInteger(body.size) || body.size <= 0) { fail(400, 'Invalid args: id must be a volume offer and size an integer'); return }
      if (body.size > offer.disk_space) { fail(400, 'Requested size exceeds the offer'); return }
      if (body.name !== undefined && !/^[A-Za-z0-9_]{1,64}$/.test(body.name)) { fail(400, 'Invalid volume name'); return }
      if (state.volumeCreateStatus) { fail(state.volumeCreateStatus, 'fixture volume refusal'); return }
      const id = 20118480 + state.volumeCreates
      state.volumes.set(id, { id, label: body.name ?? 'V.' + id, status: 'active', machine_id: offer.machine_id, host_id: offer.host_id, disk_space: body.size, storage_cost: offer.storage_cost, geolocation: offer.geolocation, start_date: 1792490400 })
      if (state.ambiguousVolumeCreate === 'disconnect') { req.socket.destroy(); return }
      if (state.ambiguousVolumeCreate === 'unlisted') { state.volumes.delete(id); json({ success: true, volume_name: 'V.' + id }); return }
      json(state.volumeNameOnly ? { success: true, volume_name: 'V.' + id } : { success: true, volume_name: 'V.' + id, volume_id: id }); return
    }
    if (url.pathname === '/api/v0/volumes/' && req.method === 'DELETE') {
      const id = Number(url.searchParams.get('id') ?? body?.id)
      state.volumeDeletes++
      const volume = state.volumes.get(id)
      if (!volume) { json({ success: false, error: 'no_such_volume', msg: 'Volume with that ID does not exist. ' + key }, 404); return }
      if ([...state.pods.values()].some(pod => pod.volume_id === id)) { fail(400, 'Volume is in use by an instance; destroy it first'); return }
      if (!state.holdVolumeDelete) state.volumes.delete(id)
      json({ success: true }); return
    }
    if (url.pathname === '/api/v0/ssh/' && req.method === 'GET') { json(state.keys.map(row => ({ id: row.id, user_id: 1, key: row.key, created_at: '2026-10-20T09:00:00Z', deleted_at: row.deleted_at ?? null }))); return }
    if (url.pathname === '/api/v0/ssh/' && req.method === 'POST') {
      state.keyCreates++
      if (typeof body?.ssh_key !== 'string' || !body.ssh_key.startsWith('ssh-')) { fail(400, 'Invalid ssh key'); return }
      const row = { id: 500 + state.keyCreates, key: state.mismatchKey ? 'ssh-ed25519 ZGlmZmVyZW50' : body.ssh_key }
      state.keys.push(row)
      if (state.ambiguousKey) { req.socket.destroy(); return }
      json({ success: true, key: { id: row.id, user_id: 1, public_key: row.key, created_at: '2026-10-20T09:00:00Z', deleted_at: null } }); return
    }
    if (create) {
      if (state.stockLoss) { fail(410, 'no_such_ask: offer is no longer available'); return }
      if (state.createStatus) { fail(state.createStatus, 'fixture refusal'); return }
      if (body.runtype !== 'ssh_direct' || typeof body.env !== 'object' || body.env === null || !body.image || !body.disk || !body.onstart || 'price' in body) { fail(400, 'Invalid args'); return }
      state.createBodies.push({ ask: Number(url.pathname.split('/')[4]), ...body })
      let volumeId
      if (body.volume_info !== undefined) {
        const info = body.volume_info
        if (info.create_new !== false || !Number.isInteger(info.volume_id) || typeof info.mount_path !== 'string' || !/^(\/)?([^/\0]+(\/)?)+$/.test(info.mount_path)) { fail(400, 'Invalid volume_info'); return }
        const volume = state.volumes.get(info.volume_id)
        if (!volume) { json({ success: false, error: 'no_such_volume', msg: 'Volume with that ID does not exist. ' + key }, 404); return }
        const askMachine = [9101, 9102, 9103, 9104, 9105, 9103][Number(url.pathname.split('/')[4]) - 101]
        if (state.customOffers === null && askMachine !== volume.machine_id) { fail(400, 'Volume ' + volume.id + ' is on machine ' + volume.machine_id + ', not this offer’s machine'); return }
        volumeId = volume.id
      }
      const id = 7000 + state.creates
      state.pods.set(id, { id, label: body.label, actual_status: 'running', start_date: 1792490400, dph_total: 9.315, ssh_host: 'ssh5.fixture.invalid', ssh_port: 10000 + id, public_ipaddr: '127.0.0.1', volume_id: volumeId, mount_path: body.volume_info?.mount_path })
      if (state.ambiguousCreate === 'disconnect') { req.socket.destroy(); return }
      if (state.ambiguousCreate === 'timeout') return
      if (state.ambiguousCreate === 'malformed') { res.writeHead(200); res.end('{'); return }
      if (state.ambiguousCreate === 'unreadable') { json({ success: true, new_contract: key }); return }
      if (state.ambiguousCreate) { fail(503, 'upstream failed after accepting'); return }
      json({ success: true, new_contract: id }); return
    }
    const shown = pod => ({ ...pod, ...(state.provisioningRead ? { actual_status: 'loading', start_date: null } : {}), ports: state.noDirect ? {} : { '22/tcp': [{ HostIp: '0.0.0.0', HostPort: '2222' }] } })
    if (url.pathname === '/api/v1/instances/' && req.method === 'GET') {
      const token = url.searchParams.get('after_token')
      let after = 0
      try { if (token) after = JSON.parse(Buffer.from(token, 'base64').toString()).values.id } catch { fail(400, 'Invalid after_token'); return }
      if (!Number.isInteger(after) || after < 0) { fail(400, 'Invalid after_token'); return }
      const all = [...state.pods.values()].sort((a, b) => a.id - b.id)
      const limit = Math.min(25, Number(url.searchParams.get('limit')) || 25)
      const remaining = all.filter(pod => pod.id > after)
      const instances = remaining.slice(0, limit).map(shown)
      const next_token = remaining.length > instances.length ? Buffer.from(JSON.stringify({ values: { id: instances.at(-1).id } })).toString('base64') : null
      const label_counts = all.reduce((counts, pod) => { const label = pod.label ?? ''; counts[label] = (counts[label] ?? 0) + 1; return counts }, {})
      json(state.listResponse ?? { success: true, instances_found: instances.length, total_instances: all.length, label_counts, next_token, instances }); return
    }
    const log = /^\/api\/v0\/instances\/request_logs\/(\d+)\/$/.exec(url.pathname)
    if (log && req.method === 'PUT') { json({ success: true, result_url: state.logUrl ?? origin + '/fixture-logs/' + log[1] }); return }
    const match = /^\/api\/v0\/instances\/(\d+)\/$/.exec(url.pathname)
    const id = Number(match?.[1])
    const pod = state.pods.get(id)
    if (!pod) { fail(404, 'Instance not found'); return }
    if (req.method === 'GET') { const payload = shown(pod); state.provisioningRead = false; json(state.badRead ? {} : { instances: payload }); return }
    if (req.method === 'PUT' && body.state === 'stopped') { state.stops++; pod.actual_status = 'stopped'; json({ success: true }); return }
    if (req.method === 'DELETE') { state.deletes++; if (!state.holdTerminate) state.pods.delete(id); json({ success: true }); return }
    fail(400, 'unknown request')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  return { key, requests, state, baseUrl: origin + '/api/v0', close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
}
