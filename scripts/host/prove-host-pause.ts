import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner } from './runpodFixture.mjs'
import type { HostRecord } from '../../src/services/host/store.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
const rp = await runpodFixture()
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  if (!['127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)) { escaped.push(request.url); throw new Error('Pause proof permits only loopback fixtures') }
  return nativeFetch(request)
}, nativeFetch)
const failures: string[] = []
let checks = 0
const check = (name: string, truth: unknown, detail = ''): void => { if (truth) { checks++; console.log('PASS ' + name) } else { failures.push(name + (detail ? ': ' + detail : '')); console.error('FAIL ' + name + (detail ? ': ' + detail : '')) } }
const houseWords = /\b(door|road|seat|fold|lane|ladder|owner|law|pin|prover)s?\b/i
let ssh: ReturnType<typeof fakeSshRunner> | undefined
try {
  const { hostRunner, closeHostTunnel, waitHostEngine } = await import('../../src/services/host/ssh.ts')
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { queueHostSetup } = await import('../../src/services/host/jobs.ts')
  const { readHostRecord, hostDirectory, patchHostRecord, removeHostRecord } = await import('../../src/services/host/store.ts')
  const { vendorClient, saveVendorKey, runpodOnly } = await import('../../src/services/host/vendors/client.ts')
  const { HOST_IDLE_LIMIT_MS, hostIdleHoursWords, hostIdleSince, hostIdleVerdict, hostEndpointLastTurnAt, sweepHostIdle } = await import('../../src/services/host/idle.ts')
  const { pinnedWeightManifest } = await import('../../src/services/host/keptWeights.ts')
  const { writeKeptVolume, readKeptVolume } = await import('../../src/services/host/volumes.ts')
  const { configuredCompatEndpoints } = await import('../../src/services/providers/openaicompat/compatAccounts.ts')
  const { hostMachineName } = await import('../../src/commands/llmhost/words.ts')
  saveVendorKey('runpod', rp.key)
  const api = vendorClient('runpod', { key: rp.key, apiBaseUrl: rp.baseUrl })
  const raw = runpodOnly(api, 'proof')
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const healthyLog = ssh.state.log
  const offers = await api.offers(new AbortController().signal)
  const offer = offers.find(row => row.recipe.id === 'qwen38-27b-rtx-pro-6000')!
  assert.ok(offer, 'the fixture catalogue offers the proof recipe')
  const session = 'pause-session'
  const notices = (id: string): { words: string; status: string }[] => {
    const dir = join(hostDirectory(), 'notices')
    try {
      return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')) as { sessionId: string; words: string })
        .filter(row => row.sessionId === session && row.words.includes(id)).map(row => ({ words: row.words, status: /<status>([a-z]+)<\/status>/.exec(row.words)?.[1] ?? '' }))
    } catch { return [] }
  }
  const queue = (pod: Awaited<ReturnType<typeof api.create>>, extra: Partial<HostRecord> = {}): HostRecord => queueHostSetup({ id: pod.id, vendor: 'runpod', name: pod.name, recipe: offer.recipe.id, price: pod.cost, startedAt: pod.createdAt, status: pod.status, apiBaseUrl: rp.baseUrl, sessionId: session, ...extra })
  const run = async (record: HostRecord, options: { timeoutMs?: number; engineGraceMs?: number } = {}): Promise<HostRecord> => {
    await runHostJob(record.id, record.generation!, { runner: ssh!.runner, pauseMs: 20, timeoutMs: options.timeoutMs ?? 5000, engineGraceMs: options.engineGraceMs, keepAlive: false })
    return readHostRecord(record.id)!
  }
  const tunnels = (): number => ssh!.commands.filter(row => row.command === 'tunnel').length
  const pauseWords = (pod: { id: string; cost: number }, cause: string, notice: string): boolean =>
    notice.includes('setup paused · ' + cause) && notice.includes(hostMachineName('runpod', pod.id)) && notice.includes('$' + pod.cost.toFixed(2) + '/hr still billing') && notice.includes('Resume or Terminate in /llmhost')
  const pausedTrip = (name: string, pod: { id: string; cost: number }, record: HostRecord, cause: string, deletesBefore: number, tunnelsBefore: number): void => {
    const posted = notices(pod.id)
    for (const row of posted) console.log('  notice · ' + (/<summary>([^]*?)<\/summary>/.exec(row.words)?.[1] ?? row.words))
    check(name + ' pauses the setup and leaves the machine up: no terminate call, the pod still listed, the record paused and not TERMINATED', record.jobState === 'paused' && record.status !== 'TERMINATED' && rp.state.deletes === deletesBefore && rp.state.pods.has(pod.id), JSON.stringify({ jobState: record.jobState, status: record.status, deletes: rp.state.deletes - deletesBefore }))
    check(name + ' posts one notice with the cause, the machine, the hourly rate still billing and Resume or Terminate', posted.length === 1 && pauseWords(pod, cause, posted[0]!.words) && posted[0]!.status === 'stopped', posted.map(row => row.words).join('\n'))
    check(name + ' keeps the record truthful: the paused step names where it stopped and the error carries the same line', record.step?.startsWith('paused at ') === true && record.error !== undefined && pauseWords(pod, cause, record.error) && record.advancedAt !== undefined && record.steps?.at(-1)?.step === record.step, record.step)
    check(name + ' opens no tunnel and never puts the vendor key on screen', tunnels() === tunnelsBefore && !posted.some(row => row.words.includes(rp.key)))
    check(name + ' uses no house words on screen', !posted.some(row => houseWords.test(row.words.replace(/<[^>]+>/g, ' '))), posted.map(row => row.words).join('\n'))
  }

  const oomPod = await api.create(offer, 'ssh-ed25519 fixture', 'pause-oom')
  ssh.state.log = 'MERCURY_STEP starting engine\nCUDA out of memory\n'
  const oomDeletes = rp.state.deletes
  const oomTunnels = tunnels()
  const oom = await run(queue(oomPod))
  pausedTrip('engine death (OOM)', oomPod, oom, 'the engine died loading the weights: CUDA out of memory', oomDeletes, oomTunnels)
  check('the OOM pause names the too-small shape and no timeout', oom.error?.includes('the shape was too small for this quality; choose a larger GPU shape') === true && !oom.error.includes('Engine not ready'))

  const silentRunner = { tunnel: ssh.runner.tunnel.bind(ssh.runner), run: async (command: string, args: string[], signal: AbortSignal, timeoutMs?: number) => { if (args.at(-1)?.includes('/health')) throw new Error('fixture model still loading'); return ssh!.runner.run(command, args, signal, timeoutMs) } }
  ssh.state.log = 'MERCURY_STEP starting engine\nloading tensors\n'
  const silentDeadline = Date.now()
  await assert.rejects(waitHostEngine({ host: '127.0.0.1', port: 2222, user: 'root' }, offer.recipe, silentRunner, new AbortController().signal, 5, 60, () => {}, 120), error => /^Engine not ready\. The engine printed nothing new for \d+ s after its \d+ s setup budget; it may still be loading on the machine\. Last engine lines: /.test(String((error as Error).message)))
  check('the engine wait stops at the budget plus the silence grace and says what it saw', Date.now() - silentDeadline < 2000)
  const silentPod = await api.create(offer, 'ssh-ed25519 fixture', 'pause-silent')
  ssh.state.log = 'MERCURY_STEP starting engine\nloading tensors\n'
  ssh.state.holdHealth = true
  const silentDeletes = rp.state.deletes
  const silentTunnels = tunnels()
  const silent = await run(queue(silentPod), { timeoutMs: 300, engineGraceMs: 200 })
  ssh.state.holdHealth = false
  pausedTrip('engine silence', silentPod, silent, 'Engine not ready. The engine printed nothing new for', silentDeletes, silentTunnels)
  check('the silence pause keeps the engine on the machine and tells the user it may still be loading', silent.error?.includes('it may still be loading on the machine') === true && silent.error.includes('loading tensors'))

  const keptOffer = offers.find(row => pinnedWeightManifest(row.recipe))!
  assert.ok(keptOffer, 'a shipped offered recipe has a pinned weights manifest')
  const dataCenter = keptOffer.dataCenter ?? 'EU-NL-1'
  const stalled: { record: HostRecord; pod: { id: string; cost: number }; volumeId: string }[] = []
  for (const prepareOnly of [false, true]) {
    const disk = await raw.createVolume('network', 'pause-weights-' + prepareOnly, keptOffer.recipe.diskGb, dataCenter)
    writeKeptVolume({ ...disk, size: keptOffer.recipe.diskGb, dataCenter, model: keptOffer.recipe.model, include: keptOffer.recipe.include ?? '', price: 14, createdAt: new Date().toISOString(), state: 'preparing' })
    const pod = await api.create({ ...keptOffer, dataCenter }, 'ssh-ed25519 fixture', 'pause-stall-' + (prepareOnly ? 'preparation' : 'rental'), disk)
    ssh.state.log = healthyLog
    ssh.state.stallDownload = 5e9
    const deletes = rp.state.deletes
    const before = tunnels()
    const record = await run(queue(pod, { recipe: keptOffer.recipe.id, volumeId: disk.id, prepareWeightsOnly: prepareOnly }))
    ssh.state.stallDownload = 0
    const label = prepareOnly ? 'download stall on a temporary preparation pod' : 'download stall on a rental with a kept disk'
    pausedTrip(label, pod, record, 'Download stalled at 5.00 GB of ' + (keptOffer.recipe.weightsGb).toFixed(2) + ' GB (under 1 GB in 10 min)', deletes, before)
    const volume = readKeptVolume(disk.id)
    check(label + ' names the kept disk, what it holds and its monthly charge, and keeps the disk failed with its partial bytes', record.error?.includes('weights disk ' + disk.id + ' is kept with 5.00 GB downloaded and bills $14.00/month') === true && volume?.state === 'failed' && volume.partialBytes === 5e9, record.error)
    if (prepareOnly) check(label + ' keeps the temporary pod and its record for Resume instead of releasing it', readHostRecord(pod.id)?.prepareWeightsOnly === true && rp.state.pods.has(pod.id))
    stalled.push({ record, pod, volumeId: disk.id })
  }

  ssh.state.log = healthyLog
  const resumed = queueHostSetup({ ...readHostRecord(oomPod.id)!, status: 'RUNNING' })
  check('Resume re-queues a paused record with a fresh generation and clears the pause', resumed.jobState === 'queued' && resumed.generation !== oom.generation && resumed.error === undefined && resumed.id === oomPod.id)
  const ready = await run(resumed)
  check('the resumed setup completes on the same machine with no terminate and a registered model entry', ready.jobState === 'ready' && ready.provider !== undefined && configuredCompatEndpoints().some(row => row.name === ready.provider) && rp.state.deletes === oomDeletes && rp.state.creates === 4, JSON.stringify({ jobState: ready.jobState, error: ready.error }))
  check('one pause notice and a separate ready notice are delivered', notices(oomPod.id).filter(row => row.words.includes('setup paused')).length === 1 && notices(oomPod.id).some(row => row.words.includes('ready · /model')))

  const readySince = hostIdleSince(ready)!
  check('a ready rental counts from its ready mark and the reply check that registered it', readySince !== undefined && readySince >= (ready.steps?.find(row => row.step === 'ready')?.at ?? Infinity))
  const port = ready.localPort!
  for (let n = 0; n < 3; n++) { const poll = await fetch('http://127.0.0.1:' + port + '/v1/models'); await poll.body?.cancel() }
  check('the keep-alive /models poll does not count as activity', hostIdleSince(readHostRecord(oomPod.id)!) === readySince)
  check('a ready rental is not idle at 1 h 59 min and is idle at 2 h', hostIdleVerdict(ready, readySince + HOST_IDLE_LIMIT_MS - 60_000) === undefined && hostIdleVerdict(ready, readySince + HOST_IDLE_LIMIT_MS)?.kind === 'idle')
  const turn = await f.run('compat/' + ready.provider + '/' + f.model)
  assert.ok(turn.some(row => row.message?.stop_reason), 'the fixture answers one model request through the registered entry')
  const turnAt = hostEndpointLastTurnAt(ready)!
  check('a completed model request moves the idle clock', turnAt !== undefined && turnAt >= readySince && hostIdleSince(ready) === turnAt && hostIdleVerdict(ready, readySince + HOST_IDLE_LIMIT_MS) === undefined && hostIdleVerdict(ready, turnAt + HOST_IDLE_LIMIT_MS - 1) === undefined && hostIdleVerdict(ready, turnAt + HOST_IDLE_LIMIT_MS)?.kind === 'idle')
  const idleDeletes = rp.state.deletes
  const early = await sweepHostIdle({ now: turnAt + HOST_IDLE_LIMIT_MS - 1, records: [readHostRecord(oomPod.id)!] })
  check('the sweep does nothing before two hours', early.length === 0 && rp.state.deletes === idleDeletes && readHostRecord(oomPod.id)?.jobState === 'ready')
  const released = await sweepHostIdle({ now: turnAt + HOST_IDLE_LIMIT_MS, records: [readHostRecord(oomPod.id)!] })
  const idleRecord = readHostRecord(oomPod.id)!
  const idleNotices = notices(oomPod.id).filter(row => row.words.includes(hostIdleHoursWords))
  for (const row of idleNotices) console.log('  notice · ' + (/<summary>([^]*?)<\/summary>/.exec(row.words)?.[1] ?? row.words))
  check('at two idle hours the sweep terminates the ready rental, verifies it absent and removes its model entry', released.length === 1 && released[0]!.kind === 'idle' && rp.state.deletes === idleDeletes + 1 && !rp.state.pods.has(oomPod.id) && idleRecord.status === 'TERMINATED' && !configuredCompatEndpoints().some(row => row.name === ready.provider), JSON.stringify(idleRecord))
  check('idle termination notices retain the reason, rate and end of billing', idleNotices.length === 2 && idleNotices.some(row => row.words.includes('no model request reached it for ' + hostIdleHoursWords + ' · terminating ' + hostMachineName('runpod', oomPod.id) + ' · it bills $' + oomPod.cost.toFixed(2) + '/hr until it is gone')) && idleNotices.some(row => row.words.includes(hostMachineName('runpod', oomPod.id) + ' terminated · nothing more bills')), idleNotices.map(row => row.words).join('\n'))
  check('the idle terminate uses no house words on screen', !idleNotices.some(row => houseWords.test(row.words.replace(/<[^>]+>/g, ' '))))
  closeHostTunnel(oomPod.id)

  const pausedRental = stalled[0]!
  const pausedAt = pausedRental.record.advancedAt!
  const pauseDeletes = rp.state.deletes
  const volumeDeletes = rp.state.volumeDeletes
  const notYet = await sweepHostIdle({ now: pausedAt + HOST_IDLE_LIMIT_MS - 60_000, records: [readHostRecord(pausedRental.pod.id)!] })
  check('an unanswered pause is left alone at 1 h 59 min', notYet.length === 0 && rp.state.deletes === pauseDeletes && readHostRecord(pausedRental.pod.id)?.jobState === 'paused')
  const releasedPause = await sweepHostIdle({ now: pausedAt + HOST_IDLE_LIMIT_MS, records: [readHostRecord(pausedRental.pod.id)!] })
  const endedPause = readHostRecord(pausedRental.pod.id)!
  const pauseNotices = notices(pausedRental.pod.id).filter(row => row.words.includes(hostIdleHoursWords))
  check('at two unanswered hours the sweep terminates the paused rental and verifies it absent', releasedPause.length === 1 && releasedPause[0]!.kind === 'paused' && rp.state.deletes === pauseDeletes + 1 && !rp.state.pods.has(pausedRental.pod.id) && endedPause.status === 'TERMINATED' && endedPause.error?.includes('the setup pause went unanswered for ' + hostIdleHoursWords) === true, JSON.stringify(endedPause))
  check('the sweep never deletes a kept weights disk; it names the disk and its monthly charge instead', rp.state.volumeDeletes === volumeDeletes && pauseNotices.some(row => row.words.includes('weights disk ' + pausedRental.volumeId + ' is kept') && row.words.includes('$14.00/month') && !row.words.includes('nothing more bills')) && readKeptVolume(pausedRental.volumeId)?.preparingPod === undefined, pauseNotices.map(row => row.words).join('\n'))

  const prepared = stalled[1]!
  const watched = new Map<string, { marker: string; at: number }>()
  const firstSight = prepared.record.advancedAt! + 3 * 3600_000
  const unseen = await sweepHostIdle({ now: firstSight, records: [readHostRecord(prepared.pod.id)!], watched })
  const almost = await sweepHostIdle({ now: firstSight + HOST_IDLE_LIMIT_MS - 1, records: [readHostRecord(prepared.pod.id)!], watched })
  check('a freshly started sweep acts only after watching two hours itself, even on an older pause', unseen.length === 0 && almost.length === 0 && readHostRecord(prepared.pod.id)?.jobState === 'paused')
  const watchedDeletes = rp.state.deletes
  const seen = await sweepHostIdle({ now: firstSight + HOST_IDLE_LIMIT_MS, records: [readHostRecord(prepared.pod.id)!], watched })
  check('after two watched hours the temporary preparation pod is released too', seen.length === 1 && rp.state.deletes === watchedDeletes + 1 && readHostRecord(prepared.pod.id)?.status === 'TERMINATED')
  patchHostRecord(silentPod.id, { status: 'EXITED' })
  check('a stopped (EXITED) machine is outside the two-hour rule', hostIdleSince(readHostRecord(silentPod.id)!) === undefined)

  check('pause proof makes no public network calls', escaped.length === 0)
  for (const id of [oomPod.id, silentPod.id, ...stalled.map(row => row.pod.id)]) { closeHostTunnel(id); removeHostRecord(id) }
  if (failures.length) throw new Error(failures.length + ' pause cases failed\n' + failures.join('\n'))
  console.log('HOST PAUSE GREEN · ' + checks + ' checks; every watchdog trip pauses with the machine up, Resume completes, only the two-hour rule terminates; loopback fixtures, zero billable calls')
} finally { globalThis.fetch = nativeFetch; ssh?.close(); await rp.close(); f.close() }
