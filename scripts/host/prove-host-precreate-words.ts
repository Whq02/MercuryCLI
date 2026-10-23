import assert from 'node:assert/strict'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { vastFixture } from './vastFixture.mjs'
import { fakeSshRunner } from './runpodFixture.mjs'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
const vast = await vastFixture()
let ssh: ReturnType<typeof fakeSshRunner> | undefined
try {
  const { VastClient } = await import('../../src/services/host/vendors/vast.ts')
  const { HostCreateError } = await import('../../src/services/host/vendors/http.ts')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  const { rentDoorVendor } = await import('../../src/services/host/door.ts')
  const { hostRunner } = await import('../../src/services/host/ssh.ts')
  const { saveVendorKey } = await import('../../src/services/host/vendors/client.ts')
  saveVendorKey('vast', vast.key)
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const api = new VastClient(vast.key, vast.baseUrl)
  const offer = (await api.offers(new AbortController().signal)).find(row => row.recipe.id === 'qwen38-27b-rtx-pro-6000')!
  assert.ok(offer)
  vast.state.failNext = { route: 'GET /api/v0/ssh/', status: 503, times: 1 }
  const failure = await api.create(offer, 'ssh-ed25519 Zml4dHVyZQ== fixture', 'before-create').catch(error => error)
  assert.equal(vast.state.creates, 0, 'a failed SSH-key read sends no rent')
  assert.ok(failure instanceof HostCreateError && failure.outcome === 'refused', 'the pre-create failure is definitively refused, not ambiguous')
  assert.match(failure.message, /no instance was created — the SSH key step failed: .*HTTP 503/)
  assert.ok(!failure.message.includes(vast.key))
  vast.state.failNext = { route: 'GET /api/v0/ssh/', status: 503, times: 1 }
  const road = createHostRoad({ rental: { client: api, offer }, vendorApiBaseUrls: { vast: vast.baseUrl }, runner: ssh.runner, sessionId: 'precreate-words', startJob: () => { throw new Error('No setup should start') } })
  const result = await rentDoorVendor(road, api, offer, async plan => {
    if (plan.step === 'rent-confirm') return 'rent'
    return null
  }, () => {}, new AbortController().signal)
  assert.match(result.words, /no instance was created — the SSH key step failed/)
  assert.ok(!result.words.includes('may exist'), result.words)
  assert.equal(vast.state.creates, 0)
  vast.state.failNext = null
  vast.state.ambiguousCreate = true
  const ambiguous = await api.create(offer, 'ssh-ed25519 Zml4dHVyZQ== fixture', 'ambiguous-create').catch(error => error)
  assert.ok(ambiguous instanceof HostCreateError && ambiguous.outcome === 'ambiguous')
  assert.match(ambiguous.message, /may exist/)
  assert.equal(vast.state.creates, 1, 'an ambiguous paid request is never retried')
  console.log('HOST PRECREATE WORDS GREEN — key failure names zero creation; popup never says may-exist; ambiguous paid create stays ambiguous and is sent once')
} finally { ssh?.close(); await vast.close(); f.close() }
