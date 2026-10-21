import assert from 'node:assert/strict'
import { pinSourceRef } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner } from './runpodFixture.mjs'

pinSourceRef()
if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
const rp = await runpodFixture()
let ssh: ReturnType<typeof fakeSshRunner> | undefined
let checks = 0
try {
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { hostRunner } = await import('../../src/services/host/ssh.ts')
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { queueHostSetup } = await import('../../src/services/host/jobs.ts')
  const { hostRecords, readHostRecord, removeHostRecord } = await import('../../src/services/host/store.ts')
  const { vendorClient, saveVendorKey } = await import('../../src/services/host/vendors/client.ts')
  const { configuredCompatEndpoints } = await import('../../src/services/providers/openaicompat/compatAccounts.ts')
  const { namedCompatModelOptions } = await import('../../src/services/providers/openaicompat/compatCatalogue.ts')
  saveVendorKey('runpod', rp.key)
  const api = vendorClient('runpod', { key: rp.key, apiBaseUrl: rp.baseUrl })
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const road = createHostRoad({ apiBaseUrl: rp.baseUrl, runner: ssh.runner, pauseMs: 1 })
  const check = (name: string, truth: unknown): void => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
  const offer = (await api.offers(new AbortController().signal)).find(row => row.recipe.id === 'qwen38-27b-rtx-pro-6000')!
  const create = async () => {
    const pod = await api.create(offer, 'ssh-ed25519 fixture', 'cleanup-reading')
    const record = queueHostSetup({ id: pod.id, vendor: 'runpod', name: pod.name, recipe: offer.recipe.id, price: pod.cost, startedAt: pod.createdAt, status: pod.status, apiBaseUrl: rp.baseUrl })
    await runHostJob(record.id, record.generation!, { runner: ssh!.runner, pauseMs: 5, timeoutMs: 3000, keepAlive: false })
    const ready = readHostRecord(record.id)!
    assert.equal(ready.jobState, 'ready', ready.error)
    assert.ok(configuredCompatEndpoints().some(row => row.name === ready.provider && row.hostPodId === pod.id))
    return ready
  }
  const gone = (id: string, provider: string | undefined): boolean => !readHostRecord(id) && !configuredCompatEndpoints().some(row => row.hostPodId === id || row.name === provider) && !namedCompatModelOptions().some(row => row.value.startsWith('compat/' + provider + '/'))
  for (const loseRecord of [false, true]) {
    const record = await create()
    if (loseRecord) removeHostRecord(record.id)
    let billed = false
    const result = await road(async q => {
      if (q.step === 'door-models') { billed = q.rows?.some(row => row.value === 'pods' && row.label.includes('· 1 ')) ?? false; return 'pods' }
      if (q.step === 'paid-pods') { assert.ok(q.rows?.some(row => row.value === record.id && row.label.includes(record.id))); return record.id }
      if (q.step === 'pod-controls' || q.step === 'pod-confirm') return 'terminate'
      return null
    }, () => {}, new AbortController().signal)
    check('paid list names the live billed pod' + (loseRecord ? ' without a local record' : ''), billed)
    check('termination verifies absence and removes its provider' + (loseRecord ? ' without a local record' : ''), result.ok && !rp.state.pods.has(record.id) && gone(record.id, record.provider))
  }
  for (const loseRecord of [false, true]) {
    const record = await create()
    if (loseRecord) removeHostRecord(record.id)
    await api.terminate(record.id)
    let count = false
    await road(async q => { if (q.step === 'door-models') count = q.rows?.some(row => row.value === 'pods' && row.label.includes('· 0 ')) ?? false; return null }, () => {}, new AbortController().signal)
    check('reopening after vendor-side termination removes the ghost endpoint' + (loseRecord ? ' without a local record' : ''), count && gone(record.id, record.provider))
  }
  check('cleanup leaves no fixture pods or local records', rp.state.pods.size === 0 && hostRecords().length === 0)
  console.log('HOST CLEANUP GREEN · ' + checks + ' checks; live-shaped REST and reply fixtures, zero paid calls')
} finally { ssh?.close(); await rp.close(); f.close() }
