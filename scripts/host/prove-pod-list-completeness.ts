import assert from 'node:assert/strict'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
let mode: 'null' | 'empty' | 'repeat' | 'complete' | 'gone' = 'null'
let deletes = 0
const requests: string[] = []
const pod = (id: string) => ({ id, name: id, status: 'RUNNING', cost: 1, createdAt: new Date().toISOString() })
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const url = new URL(request.url)
  requests.push(request.method + ' ' + url.pathname + url.search)
  if (request.method === 'DELETE') { deletes++; return new Response(null, { status: 204 }) }
  assert.equal(url.pathname, '/v2/pods')
  const cursor = url.searchParams.get('cursor')
  if (mode === 'null' || mode === 'empty') return Response.json({ pods: [], pagination: { hasNextPage: true, nextCursor: mode === 'null' ? null : '' } })
  if (mode === 'repeat') return Response.json({ pods: [], pagination: { hasNextPage: true, nextCursor: 'same' } })
  if (mode === 'gone') return Response.json({ pods: [], pagination: { hasNextPage: false, nextCursor: null } })
  return Response.json({ pods: [pod(cursor ? 'second-pod' : 'first-pod')], pagination: { hasNextPage: !cursor, nextCursor: cursor ? null : 'page two' } })
} })
let checks = 0
const check = (name: string, truth: unknown) => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
try {
  const { RunpodClient } = await import('../../src/services/host/runpod.ts')
  const { terminateVerified } = await import('../../src/services/host/keptWeights.ts')
  const { HostTerminationUnconfirmed } = await import('../../src/services/host/retry.ts')
  const api = new RunpodClient('fixture-paging-key', 'http://127.0.0.1:' + server.port + '/v2')
  for (const invalid of ['null', 'empty', 'repeat'] as const) {
    mode = invalid
    const before = requests.length
    await assert.rejects(api.pods(), /incomplete/)
    check(invalid + ' pagination refuses an incomplete paid-pods list', requests.length > before)
  }
  mode = 'complete'
  const listed = await api.pods()
  check('valid pagination returns every pod and encodes the next cursor', listed.map(row => row.id).join() === 'first-pod,second-pod' && requests.some(row => row.endsWith('?cursor=page%20two')))
  mode = 'null'
  const signal = new AbortController().signal
  let uncertain: unknown
  try { await terminateVerified(api, 'unseen-paid-pod', (_operation, read) => read(signal)) } catch (error) { uncertain = error }
  check('termination cannot declare a pod absent from an incomplete list', uncertain instanceof HostTerminationUnconfirmed && deletes === 1 && String(uncertain).includes('did not confirm'))
  mode = 'gone'
  await terminateVerified(api, 'gone-pod', (_operation, read) => read(signal))
  check('a complete empty list still verifies a terminated pod', deletes === 2)
  console.log('POD LIST COMPLETENESS GREEN — ' + checks + ' checks; only loopback responses, no real pods')
} finally { server.stop(true); f.close() }
