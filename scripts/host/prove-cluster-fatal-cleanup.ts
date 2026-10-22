import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture } from './runpodFixture.mjs'
import type { HostRunner } from '../../src/services/host/ssh.ts'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
const rp = await runpodFixture()
const originalFetch = globalThis.fetch
let checks = 0
const check = (name: string, truth: unknown) => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname), 'only loopback requests are permitted')
  return originalFetch(input, init)
}, originalFetch)
try {
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { queueHostSetup } = await import('../../src/services/host/jobs.ts')
  const { readHostRecord, removeHostRecord } = await import('../../src/services/host/store.ts')
  const { saveVendorKey } = await import('../../src/services/host/vendors/client.ts')
  const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
  saveVendorKey('runpod', rp.key)
  const recipe = HOST_RECIPES.find(row => row.nodes === 2 && row.gpu === 'B200')!
  assert.ok(recipe)
  const notices = (id: string): string[] => readdirSync(join(f.home, 'host/notices')).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(f.home, 'host/notices', name), 'utf8'))).filter(row => row.sessionId === id).map(row => row.words)
  for (const mode of ['tunnel-failed', 'tunnel-delete-held', 'tunnel-listing-unavailable', 'head-oom', 'node-launch', 'worker-exit', 'delete-held', 'listing-unavailable', 'read-paused'] as const) {
    const id = 'cluster-' + mode
    const at = new Date().toISOString()
    const cluster = { id, name: id, type: 'APPLICATION', compute: { podCount: 2, gpuCountPerPod: recipe.count, gpuTypeId: 'NVIDIA B200' }, primary: { podId: id + '-0', status: 'RUNNING' }, createdAt: at }
    const nodes = [0, 1].map(rank => ({ id: id + '-' + rank, name: id + '-' + rank, cost: 10, status: 'RUNNING', cudaVersion: '13.0', createdAt: at, cluster: { id, rank, ip: '10.65.0.' + (rank + 2) }, ssh: { direct: { host: '127.0.0.1', port: 22000 + rank, username: 'root' } } }))
    rp.state.clusters.set(id, cluster)
    rp.state.clusterNodes.set(id, nodes)
    rp.state.holdClusterDelete = mode.endsWith('delete-held')
    rp.state.failNext = mode.endsWith('listing-unavailable') ? { route: 'GET /v2/clusters', status: 503, times: 100 } : mode === 'read-paused' ? { route: 'GET /v2/clusters/' + id, status: 503, times: 100 } : null
    const queued = queueHostSetup({ id, name: id, recipe: recipe.id, recipeRow: recipe, price: 20, status: 'RUNNING', startedAt: at, cluster, nodes, sessionId: id, apiBaseUrl: rp.baseUrl })
    let health = 0
    const runner: HostRunner = {
      tunnel() { throw new Error(mode.startsWith('tunnel-') ? 'fixture tunnel failed after engine readiness' : 'a failed cluster never opens a tunnel') },
      async run(_command, args) {
        const remote = args.at(-1)!
        const rank = Number(args[args.indexOf('-p') + 1]) - 22000
        if (mode === 'node-launch' && rank === 1 && remote.includes('nohup setsid')) throw new Error('Engine launch failed; failed to load model: fixture node')
        if (remote.includes('/health')) { health++; if (mode.startsWith('tunnel-')) return '{}'; throw new Error('fixture head is still loading') }
        if (remote.includes('MERCURY_ENGINE_GONE')) return 'MERCURY_ENGINE_GONE\nfixture worker exited: CUDA out of memory'
        if (remote.startsWith('tail -n 8')) return mode === 'worker-exit' || mode.startsWith('tunnel-') ? 'MERCURY_STEP starting engine\n' : 'CUDA out of memory\nMERCURY_ENGINE_EXITED\n'
        return ''
      },
    }
    const before = rp.requests.length
    await runHostJob(id, queued.generation!, { runner, pauseMs: 2, timeoutMs: mode === 'read-paused' || mode.endsWith('listing-unavailable') ? 120 : 2000, keepAlive: false })
    const calls = rp.requests.slice(before)
    const deletes = calls.filter(row => row.method === 'DELETE')
    const words = notices(id)
    if (mode === 'read-paused') {
      check('transient vendor-read exhaustion pauses the cluster without terminating it', deletes.length === 0 && rp.state.clusters.has(id) && readHostRecord(id)?.jobState === 'failed' && words.length === 1 && words[0]!.includes('setup paused'))
    } else {
      check(mode + ' terminates the cluster once rather than individual member pods', deletes.length === 1 && deletes[0]!.path === '/v2/clusters/' + id)
      const deletion = calls.findIndex(row => row.method === 'DELETE')
      check(mode + ' checks cluster absence after sending termination', calls.slice(deletion + 1).some(row => row.method === 'GET' && row.path === '/v2/clusters'))
      check(mode + ' emits one final notice without credentials', words.length === 1 && !words[0]!.includes(rp.key))
      if (mode.endsWith('delete-held') || mode.endsWith('listing-unavailable')) {
        check(mode + ' retains the failed record and does not claim verified termination', readHostRecord(id)?.jobState === 'failed' && readHostRecord(id)?.status !== 'TERMINATED' && !words[0]!.includes('Runpod no longer lists it') && /may still bill|still bills|did not confirm/.test(words[0]!))
      } else {
        check(mode + ' removes the ended rental and names its cause and verified cluster termination', !readHostRecord(id) && !rp.state.clusters.has(id) && !rp.state.clusterNodes.has(id) && words[0]!.includes(mode.startsWith('tunnel-') ? 'fixture tunnel failed' : mode === 'node-launch' ? 'failed to load model' : 'out of memory') && words[0]!.includes('Runpod no longer lists it'))
        check(mode + ' ends promptly instead of consuming the setup timeout', health < 30)
      }
    }
    rp.state.holdClusterDelete = false
    rp.state.failNext = null
    rp.state.clusters.delete(id)
    rp.state.clusterNodes.delete(id)
    removeHostRecord(id)
  }
  console.log('CLUSTER FATAL CLEANUP GREEN — ' + checks + ' checks; loopback provider, no real instances')
} finally { globalThis.fetch = originalFetch; await rp.close(); f.close() }
