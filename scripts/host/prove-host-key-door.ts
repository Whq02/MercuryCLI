import assert from 'node:assert/strict'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture } from './runpodFixture.mjs'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
const rp = await runpodFixture()
try {
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { vendorKey, saveVendorKey } = await import('../../src/services/host/vendors/client.ts')
  saveVendorKey('runpod', rp.key)
  const road = createHostRoad({ apiBaseUrl: rp.baseUrl, sessionId: 'key-door' })
  let managed = false, removed = false, returned = false
  await road(async plan => {
    if (plan.step === 'door-models') return 'Qwen3.8-27B'
    if (plan.step === 'door-model') {
      if (removed) { returned = true; assert.ok(plan.rows?.some(row => row.value === 'connect')); assert.ok(!plan.rows?.some(row => row.value === 'key:runpod')); return null }
      assert.ok(plan.rows?.some(row => row.value === 'key:runpod' && row.label === 'Runpod · Replace key / Remove key'), 'a connected vendor exposes its key controls on the model screen')
      return 'key:runpod'
    }
    if (plan.step === 'host-key-manage') { managed = true; return 'remove' }
    if (plan.step === 'host-key-remove') { assert.ok(plan.found.includes('keep billing') || plan.willRun.includes('keep billing')); removed = true; return 'remove' }
    throw new Error('Unexpected screen ' + plan.step)
  }, () => {}, new AbortController().signal)
  assert.ok(managed && removed && returned)
  assert.equal(vendorKey('runpod'), undefined)
  assert.equal(rp.state.creates, 0)
  assert.equal(rp.state.deletes, 0)
  console.log('HOST KEY DOOR GREEN — connected row opens key controls, confirms removal, clears cached client and returns to Connect; no rental changed')
} finally { await rp.close(); f.close() }
