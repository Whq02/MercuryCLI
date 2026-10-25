import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pinSourceRef } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner } from './runpodFixture.mjs'
import { vastFixture } from './vastFixture.mjs'
import { lambdaFixture } from './lambdaFixture.mjs'

pinSourceRef()
if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
const rp = await runpodFixture()
let ssh: ReturnType<typeof fakeSshRunner> | undefined
let checks = 0
const check = (name: string, truth: unknown = true) => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
try {
  const { hostRunner, closeHostTunnel } = await import('../../src/services/host/ssh.ts')
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { queueHostSetup } = await import('../../src/services/host/jobs.ts')
  const { readHostRecord, hostDirectory, patchHostRecord } = await import('../../src/services/host/store.ts')
  const { vendorClient, saveVendorKey, runpodOnly } = await import('../../src/services/host/vendors/client.ts')
  saveVendorKey('runpod', rp.key)
  const api = vendorClient('runpod', { key: rp.key, apiBaseUrl: rp.baseUrl })
  const raw = runpodOnly(api, 'proof')
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const offers = await api.offers(new AbortController().signal)
  const offer = offers.find(row => row.recipe.id === 'qwen38-27b-rtx-pro-6000')!
  const queue = (pod: Awaited<ReturnType<typeof api.create>>, extra = {}) => queueHostSetup({ id: pod.id, vendor: 'runpod', name: pod.name, recipe: offer.recipe.id, price: pod.cost, startedAt: pod.createdAt, status: pod.status, apiBaseUrl: rp.baseUrl, sessionId: 'hiccups-session', ...extra })
  const run = async (record: ReturnType<typeof queue>, timeoutMs = 5000) => {
    await runHostJob(record.id, record.generation!, { runner: ssh!.runner, pauseMs: 20, timeoutMs, keepAlive: false })
    closeHostTunnel(record.id)
    return readHostRecord(record.id)
  }
  const notices = () => readdirSync(join(hostDirectory(), 'notices')).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(hostDirectory(), 'notices', name), 'utf8')).words as string)
  const podReads = (id: string) => rp.requests.filter(row => row.method === 'GET' && row.path === '/v2/pods/' + id)
  const pod = await api.create(offer, 'ssh-ed25519 fixture', 'hiccups-reading')
  const record = queue(pod)
  rp.state.failNext = { route: 'GET /v2/pods/' + pod.id, status: 503, times: 2 }
  const ready = (await run(record))!
  assert.equal(ready.jobState, 'ready', 'two transient pod-read 503s must reach READY without Resume: ' + ready.error)
  assert.equal(ready.steps?.filter(row => /Runpod read failed \(HTTP 503\) · retrying in \d+ s · attempt [12]/.test(row.step)).length, 2)
  assert.equal(rp.state.creates, 1, 'read recovery never creates a second pod')
  assert.equal(rp.state.deletes, 0, 'read recovery never terminates the pod')
  check('two pod-read 503s reach READY with both retry steps and no pause notice', notices().length === 1 && !notices()[0]!.includes('<status>failed'))
  const times = podReads(pod.id).map(row => row.at)
  check('backoff doubles from the job poll interval', times[1]! - times[0]! >= 40 && times[2]! - times[1]! >= 80)

  const { hostJobReadOnly, hostReadFailureWords, HostTerminationUnconfirmed } = await import('../../src/services/host/retry.ts')
  const { RunpodHttpError } = await import('../../src/services/host/runpod.ts')
  const { terminateVerified, pinnedWeightManifest } = await import('../../src/services/host/keptWeights.ts')
  const readSteps: string[] = []
  const readOnly = (timeoutMs = 5000, label = 'Runpod', signal = new AbortController().signal) => hostJobReadOnly({ label, pauseMs: 20, timeoutMs, signal, mark: step => readSteps.push(step) })
  for (const retryAfter of ['1', new Date(Date.now() + 2000).toUTCString()]) {
    rp.state.failNext = { route: 'GET /v2/pods/' + pod.id, status: 429, times: 1, retryAfter }
    const before = podReads(pod.id).length
    const expected = retryAfter === '1' ? 1000 : Date.parse(retryAfter) - Date.now()
    await readOnly()('pod', signal => api.get(pod.id, signal))
    const requests = podReads(pod.id).slice(before)
    check('429 honours Retry-After ' + (retryAfter === '1' ? 'seconds' : 'HTTP date'), requests.length === 2 && requests[1]!.at - requests[0]!.at >= expected - 5)
  }
  for (const status of [401, 403, 404]) {
    const stopped = await api.create(offer, 'ssh-ed25519 fixture', 'permanent-' + status)
    rp.state.failNext = { route: 'GET /v2/pods/' + stopped.id, status, times: 10 }
    const failed = (await run(queue(stopped)))!
    const pausesUp = status !== 404
    check(status + (pausesUp ? ' pauses the setup on the first read without retry words, the pod left up and billing' : ' stops the setup on the first read without retry words'), failed.jobState === (pausesUp ? 'paused' : 'failed') && podReads(stopped.id).length === 1 && !failed.steps?.some(row => row.step.includes('retrying')) && (!pausesUp || String(failed.error).includes('/hr still billing') && String(failed.error).includes('Resume or Terminate in /llmhost')) && rp.state.deletes === 0)
  }
  const failing = await api.create(offer, 'ssh-ed25519 fixture', 'budget-reading')
  rp.state.failNext = { route: 'GET /v2/pods/' + failing.id, status: 503, times: 1000 }
  const beforeBudget = Date.now()
  const paused = (await run(queue(failing), 350))!
  const count = podReads(failing.id).length
  const counted = 'paused at Runpod read failed (HTTP 503) · retrying in 1 s · attempt ' + count
  const billing = failing.id + ' · $' + paused.price.toFixed(2) + '/hr still billing · Resume or Terminate in /llmhost'
  check('the read spends its budget, then pauses with the exact failed-read count on the step and says the pod stays up and bills', Date.now() - beforeBudget >= 350 && count > 1 && paused.jobState === 'paused' && String(paused.error).startsWith('setup paused · ') && String(paused.error).includes(billing) && paused.step === counted && paused.price > 0 && rp.state.deletes === 0)
  check('one pause notice, no early stall notice', notices().filter(words => words.includes('budget-reading')).length === 1 && notices().some(words => words.includes(billing)))
  const original = new RunpodHttpError('original vendor error', 503, 'fixture')
  await assert.rejects(readOnly(100)('pod', async () => { throw original }), error => error === original && Boolean(hostReadFailureWords(error)))
  check('exhaustion throws the original error, not an invented replacement')
  for (const error of [new Error('unreadable response'), new SyntaxError('bad JSON')]) {
    let calls = 0
    await assert.rejects(readOnly()('pod', async () => { calls++; throw error }), observed => observed === error)
    check('non-network ' + error.name + ' is not retried', calls === 1)
  }
  const abort = new AbortController()
  const abortTimer = setTimeout(() => abort.abort(new Error('cancelled fixture')), 25)
  let calls = 0
  try { await assert.rejects(readOnly(5000, 'Runpod', abort.signal)('pod', async () => { calls++; throw original }), /cancelled fixture/) } finally { clearTimeout(abortTimer) }
  check('cancellation interrupts backoff without a second read', calls === 1)
  let hungCalls = 0
  await assert.rejects(readOnly(150)('pod', async signal => { if (++hungCalls === 1) throw original; await new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })); return undefined }), error => error === original)
  check('an in-flight read cannot outlive the budget or lose the original failure', hungCalls === 2)

  rp.state.failNext = { route: 'GET /v2/pods/' + pod.id, status: 'disconnect', times: 3 }
  const networkBefore = readSteps.length
  await readOnly()('pod', signal => api.get(pod.id, signal))
  check('network disconnects retry to a real pod answer', readSteps.slice(networkBefore).some(step => step.includes('network error')))
  for (const [operation, route, read] of [
    ['log', 'GET /v2/pods/' + pod.id + '/logs', (signal: AbortSignal) => api.logs(pod.id, signal)],
    ['offer', 'GET /v2/catalog/gpus', (signal: AbortSignal) => api.offers(signal)],
    ['volume', 'GET /v2/network-volumes', (signal: AbortSignal) => raw.volumes(signal)],
  ] as const) {
    rp.state.failNext = { route, status: 503, times: 2 }
    const stepsBefore = readSteps.length
    await readOnly()(operation, read as (signal: AbortSignal) => Promise<unknown>)
    check(operation + ' reads use the same retry law', readSteps.slice(stepsBefore).filter(step => step.includes('retrying')).length === 2 && rp.state.failNext.times === 0)
  }
  const exited = await api.create(offer, 'ssh-ed25519 fixture', 'log-reading')
  rp.state.pods.get(exited.id)!.status = 'EXITED'
  rp.state.failNext = { route: 'GET /v2/pods/' + exited.id + '/logs', status: 503, times: 2 }
  const logged = (await run(queue(exited)))!
  check('setup reads the actual logs after two 503s before reporting the exited pod', logged.error?.includes('Pod is EXITED') && logged.error.includes('fixture image pull pending') && logged.steps?.filter(row => row.step.includes('retrying')).length === 2)
  for (const exhaust of [false, true]) {
    const doomed = await api.create(offer, 'ssh-ed25519 fixture', 'verification-' + exhaust)
    rp.state.failNext = { route: 'GET /v2/pods', status: 503, times: exhaust ? 1000 : 2 }
    const before = rp.requests.filter(row => row.path === '/v2/pods' && row.method === 'GET').length
    const deletes = rp.state.deletes
    const work = terminateVerified(api, doomed.id, readOnly(exhaust ? 350 : 5000))
    if (exhaust) {
      await assert.rejects(work, error => error instanceof HostTerminationUnconfirmed && error.message === 'termination sent; Runpod did not confirm (HTTP 503 ×' + (rp.requests.filter(row => row.path === '/v2/pods' && row.method === 'GET').length - before) + ') — check Machines I’m paying for')
    } else await work
    check(exhaust ? 'unanswered termination listing reports the exact count, not a false billing verdict' : 'termination confirms after two failed listings', rp.state.deletes === deletes + 1 && !rp.state.pods.has(doomed.id))
  }
  rp.state.failNext = null
  const failedCleanup = await api.create(offer, 'ssh-ed25519 fixture', 'worker-cleanup')
  ssh.state.failEngine = true
  rp.state.failNext = { route: 'GET /v2/pods', status: 503, times: 2 }
  const cleanupDeletes = rp.state.deletes
  await run(queue(failedCleanup, { prepareWeightsOnly: true }))
  ssh.state.failEngine = false
  rp.state.failNext = null
  check('a weights preparation whose install fails pauses with the pod up and billing; no terminate is sent', readHostRecord(failedCleanup.id)?.jobState === 'paused' && rp.state.deletes === cleanupDeletes && notices().some(words => words.includes('worker-cleanup') && words.includes(failedCleanup.id + ' · $' + failedCleanup.cost.toFixed(2) + '/hr still billing') && words.includes('Resume or Terminate in /llmhost')))

  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { LLM_HOST_WORDS } = await import('../../src/commands/llmhost/words.ts')
  const manual = async (id: string, action: 'stop' | 'terminate', readyTimeoutMs: number, arm: () => void) => {
    const events: string[] = []
    const steps: string[] = []
    let controls = 0
    const road = createHostRoad({ apiBaseUrl: rp.baseUrl, runner: ssh!.runner, pauseMs: 5, readyTimeoutMs, sessionId: 'hiccups-session' })
    const result = await road(async q => {
      if (q.step === 'door-models') return 'other'
      if (q.step === 'where') return 'pod:' + id
      if (q.step === 'pod-controls') return ++controls === 1 ? action : 'close'
      if (q.step === 'pod-confirm') { arm(); return action }
      if (q.step === 'terminate-weights') return 'keep'
      throw new Error('Unexpected manual-control step ' + q.step)
    }, event => { events.push(event.words); if (event.host?.step) steps.push(event.host.step) }, new AbortController().signal)
    return { result, events, steps }
  }
  for (const action of ['terminate', 'stop'] as const) {
    const manualPod = await api.create(offer, 'ssh-ed25519 fixture', 'manual-' + action)
    await run(queue(manualPod))
    const deletes = rp.state.deletes
    const stops = rp.state.stops
    const { result, events, steps } = await manual(manualPod.id, action, 5000, () => { rp.state.failNext = { route: action === 'stop' ? 'GET /v2/pods/' + manualPod.id : 'GET /v2/pods', status: 503, times: 2 } })
    const waiting = action === 'terminate' ? 'terminating' : 'stopping'
    check('manual ' + action + ' shows the wait on the pod row and retries two listing 503s with words, then confirms', steps.some(step => step === waiting) && steps.filter(step => /Runpod read failed \(HTTP 503\) · retrying in \d+ s · attempt [12]/.test(step)).length === 2 && rp.state.failNext.times === 0 && (action === 'terminate'
      ? result.ok && /^Machine terminated · its disk is deleted · ~\$\d+\.\d{2} \+ storage\.$/.test(result.words) && rp.state.deletes === deletes + 1 && !rp.state.pods.has(manualPod.id) && !readHostRecord(manualPod.id)
      : result.ok && rp.state.stops === stops + 1 && rp.state.pods.get(manualPod.id)?.status === 'EXITED' && readHostRecord(manualPod.id)?.status === 'EXITED' && !events.some(words => words.includes('compute may still bill'))))
    rp.state.failNext = null
    closeHostTunnel(manualPod.id)
  }
  const unconfirmedPod = await api.create(offer, 'ssh-ed25519 fixture', 'manual-unconfirmed')
  await run(queue(unconfirmedPod))
  const unconfirmedDeletes = rp.state.deletes
  let listingsBefore = 0
  const unconfirmed = await manual(unconfirmedPod.id, 'terminate', 350, () => { listingsBefore = rp.requests.filter(row => row.path === '/v2/pods' && row.method === 'GET').length; rp.state.failNext = { route: 'GET /v2/pods', status: 503, times: 1000 } })
  const listings = rp.requests.filter(row => row.path === '/v2/pods' && row.method === 'GET').length - listingsBefore
  const unconfirmedWords = unconfirmedPod.id + ' · termination sent; Runpod did not confirm (HTTP 503 ×' + listings + ') — check Machines I’m paying for · it may still bill; Terminate again once Runpod answers'
  check('manual terminate whose listing never answers says the termination was sent, counts the failed reads, says it may still bill, sends no second DELETE and keeps the pod on the controls', !unconfirmed.result.ok && unconfirmed.events.includes(unconfirmedWords) && rp.state.deletes === unconfirmedDeletes + 1 && listings > 1 && readHostRecord(unconfirmedPod.id) !== undefined && !unconfirmed.events.some(words => words.includes('Set-up stopped')))
  rp.state.failNext = null
  closeHostTunnel(unconfirmedPod.id)

  const livePod = await api.create(offer, 'ssh-ed25519 fixture', 'tunnel-drop')
  const liveRecord = queue(livePod)
  const liveStop = new AbortController()
  const liveJob = runHostJob(liveRecord.id, liveRecord.generation!, { runner: ssh.runner, pauseMs: 20, timeoutMs: 5000, keepAlive: true, signal: liveStop.signal })
  const until = (test: () => boolean, ms: number): Promise<boolean> => new Promise(resolve => { const ceiling = AbortSignal.timeout(ms); const watch = setInterval(() => { if (test() || ceiling.aborted) { clearInterval(watch); resolve(test()) } }, 20) })
  assert.ok(await until(() => readHostRecord(livePod.id)?.jobState === 'ready', 10000), 'the live pod reaches READY under keep-alive')
  const livePort = readHostRecord(livePod.id)!.localPort!
  const liveDeletes = rp.state.deletes
  closeHostTunnel(livePod.id)
  const liveLog = () => readFileSync(liveRecord.log!, 'utf8')
  assert.ok(await until(() => liveLog().includes('tunnel reconnected on 127.0.0.1:' + livePort), 10000), 'a dropped tunnel is reopened on the same port: ' + liveLog().slice(-400))
  await until(() => readHostRecord(livePod.id)?.step === 'ready', 2000)
  const live = readHostRecord(livePod.id)!
  check('a tunnel that drops after READY is reconnected on the same port with words on the row, the job stays READY and nothing is terminated', live.jobState === 'ready' && live.step === 'ready' && live.localPort === livePort && liveLog().includes('tunnel dropped · reconnecting · attempt 1 of 5') && rp.state.deletes === liveDeletes && !notices().some(words => words.includes('tunnel-drop') && words.includes('<status>failed')))
  const reconnectReads = rp.requests.filter(row => row.method === 'GET' && row.path === '/v2/pods/' + livePod.id).length
  const health = await fetch('http://127.0.0.1:' + livePort + '/v1/models').then(response => response.ok).catch(() => false)
  check('the reconnected tunnel answers and the reconnect read nothing from the vendor', health && rp.requests.filter(row => row.method === 'GET' && row.path === '/v2/pods/' + livePod.id).length === reconnectReads)
  patchHostRecord(livePod.id, { jobState: 'stopped' })
  liveStop.abort(new Error('proof done'))
  await liveJob.catch(() => {})
  closeHostTunnel(livePod.id)

  const keptOffer = offers.find(row => pinnedWeightManifest(row.recipe))!
  assert.ok(keptOffer, 'a shipped offered recipe has a pinned weights manifest')
  const { writeKeptVolume } = await import('../../src/services/host/volumes.ts')
  const dataCenter = keptOffer.dataCenter ?? 'EU-NL-1'
  const disk = await raw.createVolume('network', 'hiccups-weights', keptOffer.recipe.diskGb, dataCenter)
  writeKeptVolume({ ...disk, size: keptOffer.recipe.diskGb, dataCenter, model: keptOffer.recipe.model, include: keptOffer.recipe.include ?? '', price: 1, createdAt: new Date().toISOString(), state: 'preparing' })
  const preparation = await api.create({ ...keptOffer, dataCenter }, 'ssh-ed25519 fixture', 'kept-cleanup', disk)
  const kept = queue(preparation, { recipe: keptOffer.recipe.id, volumeId: disk.id, prepareWeightsOnly: true })
  rp.state.failNext = { route: 'GET /v2/pods', status: 503, times: 2 }
  const preparationDeletes = rp.state.deletes
  await run(kept)
  check('kept-weight preparation retries verification and sends only one termination', !readHostRecord(kept.id) && rp.state.deletes === preparationDeletes + 1 && notices().some(words => words.includes('temporary pod ' + kept.id + ' terminated')))

  const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
  const { createHostResource, hostClusterRecord } = await import('../../src/services/host/cluster.ts')
  const clusterRecipe = HOST_RECIPES.find(row => row.id === 'kimi-k3-b200')!
  rp.state.clusterGpus = [{ id: 'NVIDIA B200', name: 'B200', memory: 180, secure: true, price: { secure: 7.99 }, maxCount: { secure: 8 }, availability: 'HIGH', dataCenters: [{ id: 'FIXTURE-DC', availability: 'HIGH' }] }]
  const clusterOffer = (await api.offers(new AbortController().signal)).find(row => row.recipe.id === clusterRecipe.id)!
  for (const failNode of [false, true]) {
    const family = await createHostResource(api, clusterOffer, 'ssh-ed25519 fixture', 'cluster-hiccups-' + failNode)
    const clusterRecord = queue(family, { recipe: clusterRecipe.id, ...hostClusterRecord(family) })
    if (failNode) rp.state.clusterNodes.get(family.id)![1]!.status = 'ERROR'
    rp.state.failNext = failNode
      ? [{ route: 'GET /v2/pods/' + family.id + '-node-1/logs', status: 503, times: 2 }, { route: 'GET /v2/clusters', status: 503, times: 2 }]
      : [{ route: 'GET /v2/clusters/' + family.id, status: 503, times: 2 }, { route: 'GET /v2/clusters/' + family.id + '/pods', status: 503, times: 2 }]
    const deletes = rp.state.clusterDeletes
    const settled = await run(clusterRecord, 10000)
    check(failNode ? 'a lost node pauses the cluster, which stays listed with no delete sent' : 'cluster metadata and node-list hiccups recover to READY', failNode
      ? settled?.jobState !== 'ready' && rp.state.clusters.has(family.id) && rp.state.clusterDeletes === deletes && readHostRecord(clusterRecord.id)?.jobState === 'paused'
      : settled?.jobState === 'ready' && settled.steps?.filter(row => row.step.includes('retrying')).length === 4 && rp.state.clusterDeletes === deletes)
  }
  for (const retryAfter of [undefined, 90]) {
    const steps: string[] = []
    const capped = hostJobReadOnly({ label: 'Runpod', pauseMs: 40000, timeoutMs: 100, signal: new AbortController().signal, mark: step => steps.push(step) })
    let calls = 0
    await assert.rejects(capped('pod', async () => { calls++; throw new RunpodHttpError('backoff proof', 503, '', retryAfter) }))
    check(retryAfter ? 'Retry-After can exceed the 60-second exponential cap' : 'exponential backoff is capped at 60 seconds', calls === 1 && steps[0]?.includes('retrying in ' + (retryAfter ?? 60) + ' s'))
  }

  for (const vendor of ['vast', 'lambda'] as const) {
    const fixture = await (vendor === 'vast' ? vastFixture() : lambdaFixture())
    try {
      saveVendorKey(vendor, fixture.key)
      const client = vendorClient(vendor, { key: fixture.key, apiBaseUrl: fixture.baseUrl })
      const vendorOffer = (await client.offers(new AbortController().signal))[0]!
      const rented = await client.create(vendorOffer, 'ssh-ed25519 Zml4dHVyZQ==', 'hiccups-' + vendor)
      const path = new URL(fixture.baseUrl).pathname + '/instances/' + rented.id + (vendor === 'vast' ? '/' : '')
      const reads = () => fixture.requests.filter(row => row.path === path && row.method === 'GET')
      fixture.state.failNext = { route: 'GET ' + path, status: 503, times: 2, retryAfter: '0' }
      const setup = queue(rented, { vendor, recipe: vendorOffer.recipe.id, apiBaseUrl: fixture.baseUrl })
      const recovered = (await run(setup, 15000))!
      check(client.label + ' reaches READY after two 503s without cleanup', recovered.jobState === 'ready' && fixture.state.creates === 1 && fixture.state.deletes === 0 && recovered.steps?.filter(row => row.step.includes('read failed (HTTP 503)')).length === 2)
      fixture.state.failNext = { route: 'GET ' + path, status: 429, times: 1, retryAfter: '1' }
      const offset = reads().length
      await readOnly(10000, client.label)('pod', signal => client.get(rented.id, signal))
      const throttled = reads().slice(offset)
      check(client.label + ' honours Retry-After on pod reads', throttled.length === 2 && throttled[1]!.at - throttled[0]!.at >= 1000)
      for (const status of [401, 404]) {
        fixture.state.failNext = { route: 'GET ' + path, status, times: 10 }
        const before = reads().length
        await assert.rejects(readOnly(5000, client.label)('pod', signal => client.get(rented.id, signal)), new RegExp('HTTP ' + status))
        check(client.label + ' does not retry HTTP ' + status, reads().length === before + 1)
      }
      fixture.state.failNext = { route: 'GET ' + path, status: 'disconnect', times: 3 }
      const steps = readSteps.length
      await readOnly(10000, client.label)('pod', signal => client.get(rented.id, signal))
      check(client.label + ' retries network errors', readSteps.slice(steps).some(step => step.includes('network error')))
      const listing = vendor === 'vast' ? '/api/v1/instances/' : '/api/v1/instances'
      fixture.state.failNext = { route: 'GET ' + listing, status: 503, times: 2, retryAfter: '0' }
      const stepsBefore = readSteps.length
      await terminateVerified(client, rented.id, readOnly(10000, client.label), client.label)
      check(client.label + ' cleanup retries its internal verification list with the same law', fixture.state.deletes === 1 && readSteps.slice(stepsBefore).filter(step => step.includes('retrying')).length === 2)
    } finally { await fixture.close() }
  }
  check('fixture credentials never enter job records or retry steps', !JSON.stringify({ ready, paused, readSteps }).includes(rp.key))
  console.log('HOST HICCUPS GREEN · ' + checks + ' checks; loopback vendor/engine fixtures only, no billable calls')
} finally { ssh?.close(); await rp.close(); f.close() }
