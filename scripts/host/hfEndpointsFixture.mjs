import { createServer } from 'node:http'

export async function hfEndpointsFixture() {
  const key = 'fixture-hf-endpoints-not-a-real-token'
  const requests = []
  const compute = (instanceType, architecture, count, memory, price, status = 'available') => ({ id: 'gcp-us-south1-' + instanceType + '-x' + count, accelerator: 'gpu', numAccelerators: count, gpuMemoryGb: memory * count, memoryGb: 360 * count, instanceType, instanceSize: 'x' + count, architecture, status, pricePerHour: price, quota: { maxAccelerators: 64, usedAccelerators: 0 } })
  const state = { noStock: false, creates: 0, deletes: 0, pauses: 0, resumes: 0, bootReads: 2, neverReady: false, holdDelete: false, ambiguousCreate: false, createStatus: 0, failNext: null, badCursor: false, pageSize: 2, endpointUrl: '', model: 'Qwen/Qwen3.8-27B-FP8', pods: new Map(), computes: [compute('nvidia-h200', 'Nvidia H200', 1, 141, 5), compute('nvidia-h200', 'Nvidia H200', 2, 141, 10), compute('nvidia-h200', 'Nvidia H200', 4, 141, 20), compute('nvidia-h200', 'Nvidia H200', 8, 141, 40), compute('nvidia-rtx-pro-6000', 'Nvidia RTX PRO 6000 Blackwell', 1, 96, 2.75)] }
  let origin = ''
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname
    requests.push({ path, method: req.method, body, at: Date.now(), query: url.search, authorized: req.headers.authorization === 'Bearer ' + key })
    const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.headers.authorization !== 'Bearer ' + key) return json({ error: 'Invalid token' }, 401)
    const failure = [state.failNext].flat().find(row => row && row.times > 0 && row.route === req.method + ' ' + path)
    if (failure) { failure.times--; if (failure.status === 'disconnect') return req.socket.destroy(); res.setHeader('Retry-After', String(failure.retryAfter ?? 0.02)); return json({ error: 'fixture refusal ' + key }, failure.status) }
    if (path === '/api/whoami-v2') return json({ type: 'user', name: 'fixture-owner', orgs: [] })
    if (path === '/v2/provider/fixture-owner' && state.noStock) return json({ vendors: [{ name: 'aws', regions: [{ name: 'us-east-2', computes: state.computes.map(row => ({ ...row, status: 'unavailable' })) }] }] })
    if (path === '/v2/provider/fixture-owner') return json({ vendors: [
      { name: 'gcp', regions: [{ name: 'us-south1', computes: state.computes.filter(row => row.instanceType !== 'nvidia-rtx-pro-6000') }] },
      { name: 'aws', regions: [{ name: 'us-east-2', computes: state.computes.filter(row => row.instanceType === 'nvidia-rtx-pro-6000').map(row => ({ ...row, id: row.id.replace('gcp-us-south1', 'aws-us-east-2') })) }] },
    ] })
    if (path === '/v2/endpoint/fixture-owner') {
      if (req.method === 'GET') {
        const rows = [...state.pods.values()]
        const offset = Number(url.searchParams.get('cursor') ?? 0)
        return json({ items: rows.slice(offset, offset + state.pageSize), totalItems: rows.length, nextCursor: offset ? String(Math.max(0, offset - state.pageSize)) : null, prevCursor: state.badCursor ? null : offset + state.pageSize < rows.length ? String(offset + state.pageSize) : null })
      }
      if (req.method === 'POST') {
        state.creates++
        if (state.createStatus) return json({ error: 'fixture create refused ' + key }, state.createStatus)
        if (state.pods.has(body.name)) return json({ error: 'Endpoint already exists' }, 409)
        const engine = body.model?.image?.sGLang ?? body.model?.image?.vLLM ?? body.model?.image?.llamacpp
        if (body.type !== 'private' || !engine?.url || body.compute?.scaling?.minReplica !== 1 || body.compute?.scaling?.maxReplica !== 1) return json({ error: 'Invalid endpoint configuration' }, 422)
        const row = { ...body, healthRoute: '/health', status: { createdAt: '2026-10-22T20:00:00Z', updatedAt: '2026-10-22T20:00:00Z', state: 'pending', message: 'Starting', url: '', readyReplica: 0, targetReplica: 1 }, reads: 0 }
        state.pods.set(body.name, row)
        if (state.ambiguousCreate) return req.socket.destroy()
        return json(row)
      }
    }
    const match = /^\/v([23])\/endpoint\/fixture-owner\/([^/]+)(?:\/(pause|resume|logs))?$/.exec(path)
    if (match) {
      const row = state.pods.get(match[2])
      if (!row) return json({ error: 'Endpoint not found' }, 404)
      if (match[3] === 'logs') return json([{ timestamp: '2026-10-22T20:00:00Z', line: 'Downloading model ' + key, stream: 'stdout', replica_id: 'fixture-replica' }])
      if (req.method === 'DELETE') { state.deletes++; if (!state.holdDelete) state.pods.delete(match[2]); return json({}) }
      if (req.method === 'POST' && match[3] === 'pause') { state.pauses++; row.status.state = 'paused'; row.status.readyReplica = 0; row.status.targetReplica = 0; return json(row) }
      if (req.method === 'POST' && match[3] === 'resume') { state.resumes++; row.status.state = 'pending'; row.status.targetReplica = 1; row.reads = 0; return json(row) }
      if (req.method === 'GET') {
        if (!['paused', 'failed', 'updateFailed', 'scaledToZero'].includes(row.status.state)) {
          row.reads++
          row.status.state = state.neverReady || row.reads <= state.bootReads ? 'initializing' : 'running'
          if (row.status.state === 'running') { row.status.url = state.endpointUrl || origin; row.status.readyReplica = 1; state.model = row.model.repository }
        }
        return json(row)
      }
    }
    if (path === '/health') { res.writeHead(200); return res.end('ok') }
    if (path === '/v1/models') return json({ data: [{ id: state.model, owned_by: 'sglang', max_model_len: 1048576 }] })
    if (path === '/get_model_info' || path === '/model_info') return json({ model_path: state.model, context_length: 1048576 })
    if (path === '/v1/chat/completions') {
      const chunk = (delta, finish = null, usage) => 'data: ' + JSON.stringify({ model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) }) + '\n\n'
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      return res.end(chunk({ content: 'ready' }) + chunk({}, 'stop', { prompt_tokens: 12, completion_tokens: 1 }) + 'data: [DONE]\n\n')
    }
    return json({ error: 'Unknown fixture route' }, 404)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = 'http://127.0.0.1:' + server.address().port
  return { key, requests, state, origin, baseUrl: origin + '/v2', close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
}
