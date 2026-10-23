import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureHostQuestion, captureHostNotice } from './hostLinkFrames.ts'
import type { LlmHostQuestion } from '../../src/services/llmHost/index.ts'

type Reliability = typeof import('../../src/services/host/reliability.ts')
const reliabilityPath = fileURLToPath(new URL('../../src/services/host/reliability.ts', import.meta.url))
if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')

process.env.MERCURY_RECONNECT_SCALE = '0.01'
process.env.MERCURY_RECONNECT_BUDGET_MINUTES = '0.02'
if (process.argv.includes('--fresh-reader')) {
  const [vendor, ...machines] = process.argv.slice(process.argv.indexOf('--fresh-reader') + 1) as ['vast', ...string[]]
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const reliability: Reliability = await import(reliabilityPath)
  const rows = Object.fromEntries(machines.map(machine => [machine, reliability.hostMachineTrouble(vendor, { machineId: Number(machine) })]))
  process.stdout.write(JSON.stringify({ rows, observations: reliability.hostLinkObservations().length }))
  process.exit(0)
}

const { llmhostFixture } = await import('../providers/lib/llmhostFixture.ts')
const { vastFixture } = await import('./vastFixture.mjs')
const { runpodFixture, fakeSshRunner } = await import('./runpodFixture.mjs')
const { lambdaFixture } = await import('./lambdaFixture.mjs')
const f = await llmhostFixture()
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init)
  if (!['127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)) { escaped.push(request.url); throw new Error('Reliability proof permits loopback only') }
  return nativeFetch(request)
}, nativeFetch)
const vast = await vastFixture()
const runpod = await runpodFixture()
const lambda = await lambdaFixture()
let checks = 0
const check = (name: string, truth: unknown, detail = ''): void => { assert.ok(truth, name + (detail ? '\n' + detail : '')); checks++; console.log('PASS ' + name) }
const signal = new AbortController().signal
const closers: (() => void | Promise<unknown>)[] = []
try {
  const { hostMachineOf, noteHostLink, readHostLinkObservation, hostLinkObservations, hostMachineTrouble, hostRentalWords, hostLinkAttemptWords, hostLinkRecoveredWords, hostLinkLossWords }: Reliability = await import(f.root + '/src/services/host/reliability.ts')
  const { vendorClient }: typeof import('../../src/services/host/vendors/client.ts') = await import(f.root + '/src/services/host/vendors/client.ts')
  const { hostDirectory }: typeof import('../../src/services/host/store.ts') = await import(f.root + '/src/services/host/store.ts')
  const byPrice = (a: { price: number }, b: { price: number }): number => a.price - b.price

  console.log('§1 which vendors name the machine behind an offer — read through the real clients from fixture answers')
  const vastApi = vendorClient('vast', { key: vast.key, apiBaseUrl: vast.baseUrl })
  const vastOffers = await vastApi.offers(signal)
  const sameShape = vastOffers.filter(row => row.recipe.id === 'qwen38-27b-rtx-pro-6000').sort(byPrice)
  const [offerA, offerB] = sameShape
  assert.ok(offerA && offerB && sameShape.length === 2, 'the Vast.ai fixture sells the same shape on two machines: ' + sameShape.length)
  check('Vast.ai names the physical machine on every search row (machine_id), and A is the cheaper of two machines selling the same shape', hostMachineOf('vast', offerA) === '9102' && hostMachineOf('vast', offerB) === '9103' && offerA.price < offerB.price, JSON.stringify(sameShape.map(row => [row.machineId, row.price])))
  vast.state.customOffers = [{ id: 901, gpu_name: 'RTX_PRO_6000', gpu_ram: 96 * 1024, num_gpus: 1, dph_total: 1.1, datacenter: true, verification: 'verified', reliability2: 0.999, reliability: 0.999, direct_port_count: 1, rentable: true, rented: false, cuda_max_good: 13, disk_space: 2000 }]
  const unnamed = (await vastApi.offers(signal)).find(row => row.recipe.id === 'qwen38-27b-rtx-pro-6000')!
  vast.state.customOffers = null
  check('a Vast.ai row without machine_id names no machine, so it is never marked', unnamed && unnamed.machineId === undefined && hostMachineOf('vast', unnamed) === undefined)
  const runpodApi = vendorClient('runpod', { key: runpod.key, apiBaseUrl: runpod.baseUrl })
  const runpodOffers = await runpodApi.offers(signal)
  check('Runpod catalogue offers are a GPU type in a data centre, not a machine: none names one', runpodOffers.length > 0 && runpodOffers.every(row => hostMachineOf('runpod', row) === undefined))
  const lambdaApi = vendorClient('lambda', { key: lambda.key, apiBaseUrl: lambda.baseUrl })
  const lambdaOffers = await lambdaApi.offers(signal)
  check('Lambda offers are an instance type in a region, not a machine: none names one', lambdaOffers.length > 0 && lambdaOffers.every(row => hostMachineOf('lambda', row) === undefined))

  console.log('§2 a link outage is remembered per rental, measured in reconnects, and survives a fresh process')
  const rentalA = { vendor: 'vast' as const, id: '610001', name: 'mercury-linkdrop', machineId: hostMachineOf('vast', offerA) }
  const t0 = Date.parse('2026-10-22T10:00:00.000Z')
  check('no observation exists before a drop, and the ranking reads an empty folder as nothing', readHostLinkObservation('vast', '610001') === undefined && hostLinkObservations().length === 0 && hostMachineTrouble('vast', offerA).rank === 0)
  const first = noteHostLink(rentalA, { outcome: 'reconnecting', attempt: 1, why: 'fetch failed' }, t0)
  check('the first attempt opens an outage on the rental with its machine', first.machineId === '9102' && first.outages.length === 1 && first.outages[0]!.outcome === 'reconnecting' && first.outages[0]!.reconnects === 1 && first.outages[0]!.at === '2026-10-22T10:00:00.000Z')
  noteHostLink(rentalA, { outcome: 'reconnecting', attempt: 2, why: 'fixture: link down' }, t0 + 10_000)
  const third = noteHostLink(rentalA, { outcome: 'reconnecting', attempt: 3, why: 'fixture: link down' }, t0 + 30_000)
  check('later attempts update the open outage instead of adding one', third.outages.length === 1 && third.outages[0]!.reconnects === 3 && third.outages[0]!.why === 'fixture: link down')
  const recovered = noteHostLink(rentalA, { outcome: 'recovered', attempt: 3 }, t0 + 70_000)
  check('a recovery closes the outage with the reconnects actually made and when', recovered.outages[0]!.outcome === 'recovered' && recovered.outages[0]!.reconnects === 3 && recovered.outages[0]!.closedAt === '2026-10-22T10:01:10.000Z')
  const stored = JSON.parse(readFileSync(join(hostDirectory(), 'reliability', 'vast-610001.json'), 'utf8'))
  check('the observation is a file under host/reliability, one per rental, holding the vendor, the rental, its name and machine', stored.vendor === 'vast' && stored.rental === '610001' && stored.name === 'mercury-linkdrop' && stored.machineId === '9102' && stored.outages.length === 1)
  const t1 = Date.parse('2026-10-23T08:00:00.000Z')
  for (let attempt = 1; attempt <= 5; attempt++) noteHostLink(rentalA, { outcome: 'reconnecting', attempt, why: 'ssh: connect to host 127.0.0.1 port 2222: Connection refused' }, t1 + attempt * 20_000)
  const lost = noteHostLink(rentalA, { outcome: 'lost', attempt: 5, why: 'ssh: connect to host 127.0.0.1 port 2222: Connection refused' }, t1 + 130_000)
  check('a second drop that never recovers is a second outage, lost after the five reconnects', lost.outages.length === 2 && lost.outages[1]!.outcome === 'lost' && lost.outages[1]!.reconnects === 5 && lost.outages[1]!.at === '2026-10-23T08:00:20.000Z')
  const reader = spawnSync(process.execPath, [process.argv[1]!, '--fresh-reader', 'vast', '9102', '9103', '9101'], { env: { ...process.env, MERCURY_CONFIG_DIR: f.home }, encoding: 'utf8' })
  assert.equal(reader.status, 0, 'the fresh reader exits 0: ' + reader.stderr)
  const fresh = JSON.parse(reader.stdout) as { rows: Record<string, { rank: number; words: string; drops: number }>; observations: number }
  check('a fresh process reads the stored mark with its age and reconnect count', fresh.observations === 1 && fresh.rows['9102']!.rank === 1 && fresh.rows['9102']!.drops === 2 && /^link dropped \d+ min ago · 5 reconnects$/.test(fresh.rows['9102']!.words), reader.stdout)
  check('the fresh process ranks machine B and an unrelated machine as unaffected', fresh.rows['9103']!.rank === 0 && fresh.rows['9103']!.words === '' && fresh.rows['9101']!.rank === 0)

  console.log('§3 the outage words name the rental and the reconnect count actually made')
  check('the rental words are the paid-pods identity plus the machine', hostRentalWords(lost) === 'Vast.ai instance 610001 · mercury-linkdrop · machine 9102')
  const attemptWords = hostLinkAttemptWords(noteHostLink({ vendor: 'vast', id: '610001' }, { outcome: 'reconnecting', attempt: 2, why: 'fetch failed' }, t1 + 200_000), 5)
  check('attempt words keep the row phrase, then name the rental and the error', attemptWords === 'tunnel dropped · reconnecting · attempt 2 of 5 · Vast.ai instance 610001 · mercury-linkdrop · machine 9102 · fetch failed', attemptWords)
  check('a rental noted without its name or machine keeps the ones already on file', readHostLinkObservation('vast', '610001')!.machineId === '9102' && readHostLinkObservation('vast', '610001')!.name === 'mercury-linkdrop')
  const back = noteHostLink(rentalA, { outcome: 'recovered', attempt: 2 }, t1 + 245_000)
  const recoveredWords = hostLinkRecoveredWords(back, 41234)
  check('recovered words keep the log phrase and the port, then the rental, the reconnects and the span', recoveredWords === 'tunnel reconnected on 127.0.0.1:41234 · Vast.ai instance 610001 · mercury-linkdrop · machine 9102 · after 2 reconnects over 45 s', recoveredWords)
  const lossWords = hostLinkLossWords(lost)
  check('loss words name the rental, the five reconnects, the span and the last error; the bill and the actions stay the worker’s', lossWords === 'The SSH tunnel to Vast.ai instance 610001 · mercury-linkdrop · machine 9102 dropped and 5 reconnects failed over 1 min 50 s: ssh: connect to host 127.0.0.1 port 2222: Connection refused', lossWords)
  const runpodRental = noteHostLink({ vendor: 'runpod', id: 'fixture-pod-9', name: 'mercury-nohost' }, { outcome: 'lost', attempt: 5, why: 'HTTP 502 from the tunnel' }, t1)
  check('a vendor that names no machine still gets the rental and the count in its loss words', hostLinkLossWords(runpodRental, t1) === 'The SSH tunnel to Runpod pod fixture-pod-9 · mercury-nohost dropped and 5 reconnects failed over 0 s: HTTP 502 from the tunnel', hostLinkLossWords(runpodRental, t1))
  const open = noteHostLink({ vendor: 'lambda', id: 'inst-1' }, { outcome: 'reconnecting', attempt: 1, why: 'fetch failed' }, t1)
  const interrupted = noteHostLink({ vendor: 'lambda', id: 'inst-1' }, { outcome: 'reconnecting', attempt: 1, why: 'fetch failed' }, t1 + 600_000)
  check('an outage a process left open stays on file as interrupted when the next drop starts', open.outages.length === 1 && interrupted.outages.length === 2 && interrupted.outages[0]!.outcome === 'reconnecting' && interrupted.outages[1]!.at === '2026-10-23T08:10:00.000Z')

  console.log('§4 the ranking: a troubled machine after the unaffected ones, still listed; no-ID vendors and unrelated machines untouched; a corrupt file tolerated')
  const rows = [{ vendor: 'vast' as const, offer: offerA }, { vendor: 'vast' as const, offer: offerB }, ...runpodOffers.slice(0, 1).map(offer => ({ vendor: 'runpod' as const, offer })), ...lambdaOffers.slice(0, 1).map(offer => ({ vendor: 'lambda' as const, offer }))]
  const observations = hostLinkObservations()
  const ranked = [...rows].sort((a, b) => hostMachineTrouble(a.vendor, a.offer, observations).rank - hostMachineTrouble(b.vendor, b.offer, observations).rank || a.offer.price - b.offer.price)
  check('sorted by (trouble, price), machine B leads machine A although A is cheaper, and A is still in the list', ranked.findIndex(row => row.offer === offerB) < ranked.findIndex(row => row.offer === offerA) && ranked.some(row => row.offer === offerA) && ranked.length === rows.length)
  check('A’s row carries the age and reconnect count; unaffected vendors carry none', hostMachineTrouble('vast', offerA, observations, t1 + 800_000).words === 'link dropped 10 min ago · 2 reconnects' && hostMachineTrouble('vast', offerB, observations).words === '' && hostMachineTrouble('runpod', runpodOffers[0]!, observations).rank === 0 && hostMachineTrouble('lambda', lambdaOffers[0]!, observations).rank === 0 && observations.some(row => row.vendor === 'runpod') && observations.some(row => row.vendor === 'lambda'))
  const once = noteHostLink({ vendor: 'vast', id: '610002', machineId: '9104' }, { outcome: 'recovered', attempt: 1 }, t1)
  check('one recovered drop reads its age and single reconnect', once.outages.length === 1 && hostMachineTrouble('vast', { machineId: 9104 }, undefined, t1 + 60_000).words === 'link dropped 1 min ago · 1 reconnect' && hostMachineTrouble('vast', offerB).rank === 0)
  const folder = join(hostDirectory(), 'reliability')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'vast-7999.json'), '{"vendor":"vast","rental":"7999","outages":"not a list"}\n')
  writeFileSync(join(folder, 'vast-7998.json'), '{ not json')
  check('an unreadable observation file is skipped by the ranking and read as nothing by the rental', hostLinkObservations().length === 4 && readHostLinkObservation('vast', '7999') === undefined && readHostLinkObservation('vast', '7998') === undefined && hostMachineTrouble('vast', offerA).rank === 1, String(hostLinkObservations().length))
  const rewritten = noteHostLink({ vendor: 'vast', id: '7998', machineId: '9101' }, { outcome: 'reconnecting', attempt: 1, why: 'fetch failed' }, t1)
  check('a drop on a rental whose file was unreadable starts a fresh observation rather than failing the reconnect', rewritten.outages.length === 1 && readHostLinkObservation('vast', '7998')?.machineId === '9101')
  assert.throws(() => noteHostLink({ vendor: 'vast', id: '../escape' }, { outcome: 'recovered', attempt: 1 }), /Invalid host rental id/)
  check('a rental id that is not a vendor id never names a file outside the folder', !existsSync(join(hostDirectory(), 'vast-..')) && readdirSync(folder).every(name => /^(?:runpod|vast|lambda)-[a-zA-Z0-9_-]+\.json$/.test(name)))
  check('the module’s only writers are the three link outcomes; an engine death has no entry point here', /outcome: 'reconnecting'|outcome: 'recovered'|outcome: 'lost'/.test(readFileSync(reliabilityPath, 'utf8')) && !/engineDeath|HostEngineDied/.test(readFileSync(reliabilityPath, 'utf8')))

  console.log('§5 the worker and the door — the lane’s red-to-green check through the real keep-alive loop')
  {
    const { hostRunner, closeHostTunnel }: typeof import('../../src/services/host/ssh.ts') = await import(f.root + '/src/services/host/ssh.ts')
    const { runHostJob }: typeof import('../../src/services/host/worker.ts') = await import(f.root + '/src/services/host/worker.ts')
    const { queueHostSetup }: typeof import('../../src/services/host/jobs.ts') = await import(f.root + '/src/services/host/jobs.ts')
    const { readHostRecord }: typeof import('../../src/services/host/store.ts') = await import(f.root + '/src/services/host/store.ts')
    const { saveVendorKey }: typeof import('../../src/services/host/vendors/client.ts') = await import(f.root + '/src/services/host/vendors/client.ts')
    const { runModelDoor, modelTitle }: typeof import('../../src/services/host/door.ts') = await import(f.root + '/src/services/host/door.ts')
    saveVendorKey('vast', vast.key)
    const ssh = fakeSshRunner(f.baseUrl, hostRunner)
    closers.push(() => ssh.close())
    let linkDown = false
    let failedTunnels = 0
    const runner = { run: (...args: Parameters<typeof ssh.runner.run>) => ssh.runner.run(...args), tunnel: (args: string[]) => {
      if (linkDown) { failedTunnels++; return { stop() {}, failed: () => 'fixture: link down' } }
      return ssh.runner.tunnel(args)
    } }
    const until = (test: () => boolean, ms: number): Promise<boolean> => new Promise(resolve => { const ceiling = AbortSignal.timeout(ms); const watch = setInterval(() => { if (test() || ceiling.aborted) { clearInterval(watch); resolve(test()) } }, 20) })
    const notices = () => { const dir = join(hostDirectory(), 'notices'); return existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')).words as string) : [] }
    const rent = async (offer: typeof offerA, name: string) => {
      const pod = await vastApi.create(offer, 'ssh-ed25519 Zml4dHVyZQ== fixture', name)
      const record = queueHostSetup({ id: pod.id, vendor: 'vast', name: pod.name, recipe: offer.recipe.id, price: pod.cost, startedAt: pod.createdAt, status: pod.status, apiBaseUrl: vast.baseUrl, sessionId: 'reliability-session', machineId: hostMachineOf('vast', offer) } as Parameters<typeof queueHostSetup>[0])
      const stop = new AbortController()
      const job = runHostJob(record.id, record.generation!, { runner, pauseMs: 20, timeoutMs: 15000, keepAlive: true, signal: stop.signal })
      assert.ok(await until(() => readHostRecord(pod.id)?.jobState === 'ready', 20000), name + ' reaches READY under keep-alive: ' + JSON.stringify(readHostRecord(pod.id)))
      const log = () => readFileSync(record.log!, 'utf8')
      closers.push(() => { stop.abort(new Error('proof done')); closeHostTunnel(pod.id); return job.catch(() => {}) })
      return { pod, record, job, log, stop }
    }
    const a = await rent(offerA, 'mercury-linkdrop-a')
    const port = readHostRecord(a.pod.id)!.localPort!
    const creates = vast.state.creates
    linkDown = true
    closeHostTunnel(a.pod.id)
    assert.ok(await until(() => failedTunnels >= 2, 10000), 'two reconnects fail while the link is down: ' + a.log().slice(-600))
    linkDown = false
    assert.ok(await until(() => a.log().includes('tunnel reconnected on 127.0.0.1:' + port), 10000), 'the tunnel is reopened on the same port once the link is back: ' + a.log().slice(-600))
    await until(() => readHostRecord(a.pod.id)?.step === 'ready', 5000)
    const firstOutage = readHostLinkObservation('vast', a.pod.id)
    check('the worker records the first outage on machine A as recovered after the reconnects it actually made, on the same port, without a terminate or a second rental', firstOutage?.machineId === '9102' && firstOutage.outages.length === 1 && firstOutage.outages[0]!.outcome === 'recovered' && firstOutage.outages[0]!.reconnects >= 3 && readHostRecord(a.pod.id)!.localPort === port && readHostRecord(a.pod.id)!.jobState === 'ready' && vast.state.deletes === 0 && vast.state.creates === creates, JSON.stringify(firstOutage))
    check('the row and the log named the rental on every attempt and on the recovery', a.log().includes('attempt 1 of 5 · Vast.ai instance ' + a.pod.id + ' · mercury-linkdrop-a · machine 9102') && a.log().includes('tunnel reconnected on 127.0.0.1:' + port + ' · Vast.ai instance ' + a.pod.id + ' · mercury-linkdrop-a · machine 9102 · after ' + firstOutage?.outages[0]?.reconnects + ' reconnects'), a.log().slice(-900))
    linkDown = true
    closeHostTunnel(a.pod.id)
    await a.job
    const ended = readHostRecord(a.pod.id)!
    const secondOutage = readHostLinkObservation('vast', a.pod.id)
    const loss = notices().find(words => words.includes(a.pod.id) && words.includes('<status>stopped'))
    check('five failed reconnects pause, never terminate or replace the rental, and close the second outage', ended.jobState === 'paused' && vast.state.deletes === 0 && vast.state.creates === creates && secondOutage?.outages.length === 2 && secondOutage.outages[1]!.outcome === 'lost' && secondOutage.outages[1]!.reconnects === 5, JSON.stringify({ ended: ended.error, secondOutage }))
    check('the outage notice names the rental, machine, reconnects, bill and actions', Boolean(loss) && loss!.includes('The SSH tunnel to Vast.ai instance ' + a.pod.id + ' · mercury-linkdrop-a · machine 9102 dropped and 5 reconnects failed over') && loss!.includes('bills $') && loss!.includes('Resume reconnects, Terminate stops the bill'), loss)
    await captureHostNotice(loss!, 'link-lost-notice')
    const chatAt = f.events.length
    await f.run('compat/' + ended.provider + '/' + f.model)
    const outageRows = f.events.slice(chatAt).filter(event => event.type === 'system' && event.subtype === 'api_error' && event.error?.networkOutage)
    check('chat outage words name the rental and Mercury’s SSH reconnect count separately from request retries', outageRows.length > 0 && outageRows.every(event => event.error.message.includes('Vast.ai instance ' + a.pod.id + ' · mercury-linkdrop-a · machine 9102 · Mercury: 5 reconnects to the machine') && event.errorDetail.message === event.error.message), JSON.stringify(outageRows))
    linkDown = false
    const b = await rent(offerB, 'mercury-enginedeath-b')
    ssh.state.log += 'MERCURY_ENGINE_EXITED\nMERCURY_ENGINE_CAUSE torch.OutOfMemoryError: CUDA out of memory\n'
    closeHostTunnel(b.pod.id)
    await b.job
    const bEnded = readHostRecord(b.pod.id)!
    check('an engine death after READY pauses and writes no link observation for B', bEnded.jobState === 'paused' && /engine died after setup/.test(bEnded.error ?? '') && readHostLinkObservation('vast', b.pod.id) === undefined && hostMachineTrouble('vast', offerB).rank === 0, bEnded.error)
    ssh.state.log = ssh.state.log.replace(/MERCURY_ENGINE_EXITED[\s\S]*$/, '')
    const freshAfterWorker = spawnSync(process.execPath, [process.argv[1]!, '--fresh-reader', 'vast', '9102', '9103'], { env: { ...process.env, MERCURY_CONFIG_DIR: f.home }, encoding: 'utf8' })
    assert.equal(freshAfterWorker.status, 0, freshAfterWorker.stderr)
    const after = JSON.parse(freshAfterWorker.stdout) as { rows: Record<string, { rank: number; words: string }> }
    check('a fresh process reads the worker’s mark and reconnect count', after.rows['9102']!.rank === 1 && /^link dropped \d+ min ago · 5 reconnects$/.test(after.rows['9102']!.words) && after.rows['9103']!.rank === 0, freshAfterWorker.stdout)
    let doorRows: { value: string; label: string }[] = []
    let modelPlan: LlmHostQuestion | undefined
    await runModelDoor(async plan => { if (plan.step === 'door-model') { modelPlan = plan; doorRows = (plan.rows ?? []) as { value: string; label: string }[]; return null } throw new Error('unexpected door step ' + plan.step) }, () => {}, signal, {
      initialModel: modelTitle(offerA.recipe), offers: async () => undefined, pods: async () => [], records: () => [], road: async () => ({ ok: false, words: 'unused' }), vendors: [vastApi as never],
    })
    await captureHostQuestion(modelPlan!, 'machine-link-history')
    const { createHostRoad } = await import('../../src/services/host/index.ts')
    const { rentDoorVendor } = await import('../../src/services/host/door.ts')
    const { queueHostWatch } = await import('../../src/services/host/jobs.ts')
    const { hostRecords } = await import('../../src/services/host/store.ts')
    let queued: import('../../src/services/host/store.ts').HostRecord | undefined
    const rentalRoad = createHostRoad({ rental: { client: vastApi, offer: offerB }, vendorApiBaseUrls: { vast: vast.baseUrl }, runner, sessionId: 'identity-session', startJob: record => { queued = record } })
    await rentDoorVendor(rentalRoad, vastApi, offerB, async question => {
      if (question.step === 'rent-confirm') return 'rent'
      if (question.step === 'pod-controls') return 'close'
      throw new Error('unexpected rental question ' + question.step)
    }, () => {}, signal)
    check('the price-confirmed rental records the final offer’s machine identity', queued?.machineId === '9103' && queued.vendor === 'vast', JSON.stringify(queued))
    const watch = queueHostWatch({ id: 'identity-watch', name: offerA.recipe.label, recipe: offerA.recipe.id, recipeRow: offerA.recipe, price: 100, startedAt: new Date().toISOString(), status: 'WATCHING', watchVendors: ['vast'], vendor: 'vast', apiBaseUrl: vast.baseUrl, pollIntervalMs: 20, pollWindowMs: 10000 })
    await runHostJob(watch.id, watch.generation!, { runner, pauseMs: 20, timeoutMs: 10000, keepAlive: false })
    const watchedRental = hostRecords().find(row => row.watchedFrom === watch.id)
    check('a stock watch copies the rented offer’s physical machine identity too', watchedRental?.vendor === 'vast' && watchedRental.machineId === '9102' && watchedRental.jobState === 'ready', JSON.stringify(watchedRental))
    if (watchedRental) closeHostTunnel(watchedRental.id)
    const rentRows = doorRows.filter(row => row.value.startsWith('rent:'))
    const rowA = rentRows.find(row => row.label.includes('machine 9102'))
    const rowB = rentRows.find(row => row.label.includes('machine 9103'))
    check('the model picker lists B before cheaper A, labels A and keeps it selectable', Boolean(rowA && rowB) && rentRows.indexOf(rowB!) < rentRows.indexOf(rowA!) && /link dropped \d+ min ago · 5 reconnects/.test(rowA!.label) && !/link dropped/.test(rowB!.label), rentRows.map(row => row.label).join('\n'))
  }
  check('reliability proof makes no public requests', escaped.length === 0)
  console.log('HOST RELIABILITY GREEN — ' + checks + ' checks; loopback fixtures and fake runners only, no key, no machine, no network')
} finally {
  globalThis.fetch = nativeFetch
  for (const close of closers.reverse()) await close()
  await lambda.close(); await runpod.close(); await vast.close(); f.close()
}
