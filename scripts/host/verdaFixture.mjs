import { vmFixture } from './vmFixture.mjs'

export async function verdaFixture() {
  const types = [
    { instance_type: '1RTXPRO6000.30V', model: 'RTX PRO 6000', count: 1, memory: 96, price: '2.492' },
    { instance_type: '1H200.24V', model: 'H200 SXM5', count: 1, memory: 141, price: '5.888' },
    { instance_type: '8B200.240V', model: 'B200 SXM6', count: 8, memory: 180, price: '66.84' },
    { instance_type: '8B300.240V', model: 'B300 SXM6', count: 8, memory: 268, price: '85.52' },
    { instance_type: '8GB300.256V', model: 'GB300 SXM6', count: 8, memory: 288, price: '98.32' },
  ].map(row => ({ instance_type: row.instance_type, model: row.model, gpu: { description: row.model, number_of_gpus: row.count }, gpu_memory: { size_in_gigabytes: row.memory * row.count }, price_per_hour: row.price, currency: 'USD', supported_os: ['ubuntu-24.04-cuda-13.0-open-docker'] }))
  const f = await vmFixture('verda', '/v1', async ({ req, res, path, method, body, url, json, text, fail, state }) => {
    if (path === '/v1/oauth2/token') {
      state.tokenReads++
      if (body.grant_type !== 'client_credentials' || body.client_id !== 'fixture-client' || body.client_secret !== 'fixture-secret') return json({ message: 'Invalid credential fixture-client fixture-secret' }, 401)
      return json({ access_token: 'fixture-access-token', token_type: 'Bearer', expires_in: state.expiresIn })
    }
    if (req.headers.authorization !== 'Bearer fixture-access-token') return fail(401, 'Invalid access token fixture-access-token')
    if (path === '/v1/instance-types') return json(state.types)
    if (path.startsWith('/v1/instance-types/')) return json(state.types.find(row => row.instance_type === decodeURIComponent(path.split('/').at(-1))))
    if (path === '/v1/instance-availability') return json([{ location_code: 'FIN-01', availabilities: state.noStock ? [] : state.types.map(row => row.instance_type) }])
    if (path === '/v1/images') return json([{ id: 'image-1', image_type: 'ubuntu-24.04-cuda-13.0-open-docker', name: 'Ubuntu CUDA Docker' }])
    if (path === '/v1/ssh-keys') {
      if (method === 'GET') return json(state.keys)
      state.keyCreates++
      const row = { id: 'key-' + state.keyCreates, name: body.name, key: state.mismatchKey ? 'ssh-ed25519 ZGlmZmVyZW50' : body.key }
      state.keys.push(row); return text(row.id, 201)
    }
    if (path === '/v1/scripts') {
      if (method === 'GET') return json(state.scripts)
      const row = { id: 'script-' + (state.scripts.length + 1), name: body.name, script: body.script }
      state.scripts.push(row); return text(row.id, 201)
    }
    if (path === '/v1/volumes') return json([...state.volumes.values()])
    if (path === '/v1/volumes/trash') return json(state.trash)
    if (path === '/v1/instances' && method === 'GET') return json(state.badList ? {} : [...state.pods.values()])
    if (path === '/v1/instances' && method === 'POST') {
      state.creates++
      if (state.createStatus || state.noStock) return fail(state.createStatus || 400, 'No capacity')
      if (body.contract !== 'PAY_AS_YOU_GO' || body.pricing !== 'FIXED_PRICE' || body.is_spot !== false || body.location_code !== 'FIN-01' || !body.os_volume?.size || !state.keys.some(row => row.id === body.ssh_key_ids?.[0]) || !state.scripts.some(row => row.id === body.startup_script_id) || body.image !== 'ubuntu-24.04-cuda-13.0-open-docker') return fail(400, 'Invalid instance configuration')
      const type = state.types.find(row => row.instance_type === body.instance_type)
      if (!type) return fail(400, 'Unknown type')
      const id = 'verda-' + state.creates
      const os_volume_id = 'os-' + id
      state.volumes.set(os_volume_id, { id: os_volume_id, name: body.os_volume.name, size: body.os_volume.size })
      state.pods.set(id, { id, hostname: body.hostname, status: 'provisioning', ip: null, created_at: '2026-10-23T09:00:00Z', price_per_hour: type.price_per_hour, os_volume_id, volume_ids: ['external-volume'], reads: 0 })
      if (state.ambiguousCreate) return req.socket.destroy()
      return state.jsonCreate ? json({ id }) : text(id, 201)
    }
    if (path === '/v1/instances' && method === 'PUT') {
      state.deletes++
      if (body.action !== 'delete' || body.delete_permanently !== true) return fail(400, 'Permanent deletion required')
      const pod = state.pods.get(body.id[0])
      if (!pod) return fail(404, 'Instance not found')
      if (JSON.stringify(body.volume_ids) !== JSON.stringify([pod.os_volume_id])) return fail(400, 'Delete only the OS volume')
      if (!state.holdTerminate) { state.pods.delete(pod.id); if (!state.holdVolume) state.volumes.delete(pod.os_volume_id) }
      res.writeHead(204); res.end(); return
    }
    const match = /^\/v1\/instances\/([a-zA-Z0-9-]+)$/.exec(path)
    const pod = state.pods.get(match?.[1])
    if (!pod) return fail(404, 'Instance not found')
    if (++pod.reads > state.bootReads) { pod.status = 'running'; pod.ip = '127.0.0.1' }
    return json(state.badRead ? {} : pod)
  })
  f.key = 'fixture-client:fixture-secret'
  Object.assign(f.state, { types, scripts: [], volumes: new Map(), trash: [], holdVolume: false, tokenReads: 0, expiresIn: 3600, jsonCreate: false })
  return f
}
