import assert from 'node:assert/strict'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { vastFixture } from './vastFixture.mjs'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
const vast = await vastFixture()
try {
  const module = await import(f.root + '/src/services/host/vendors/vast.ts')
  const api = new module.VastClient(vast.key, vast.baseUrl)
  const signal = new AbortController().signal
  const offer = (await api.offers(signal)).find((row: any) => row.recipe.id === 'qwen38-27b-rtx-pro-6000')!
  const common = { datacenter: true, verification: 'verified', reliability2: 0.999, reliability: 0.999, direct_port_count: 1, rentable: true, rented: false, cuda_max_good: 13, disk_space: 2000, gpu_name: 'RTX_PRO_6000', gpu_ram: 96 * 1024, num_gpus: 1 }
  vast.state.customOffers = [{ ...common, id: 102, dph_total: 1.2 }, { ...common, id: 202, dph_total: 1.7 }]
  vast.state.stockLoss = true
  const searches = () => vast.requests.filter(row => row.path === '/api/v0/bundles/').length
  const before = searches()
  let lost: any
  try { await api.create(offer, 'ssh-ed25519 Zml4dHVyZQ== fixture', 'fixture-first') } catch (error) { lost = error }
  assert.ok(lost?.replacement, 'no_such_ask must reread stock and offer another machine')
  assert.equal(searches() - before, 1)
  assert.equal(lost.replacement.recipe, offer.recipe)
  assert.equal(lost.replacement.price, 1.708)
  assert.equal(vast.state.creates, 1)
  assert.equal(vast.state.pods.size, 0)
  const create = module.createVastRental
  assert.equal(typeof create, 'function')
  let confirms = 0
  await create(api, offer, 'ssh-ed25519 Zml4dHVyZQ== fixture', 'fixture-cancel', async (q: any) => { confirms++; assert.ok(q.found.includes('$1.71/hr')); return 'cancel' }, () => {}, signal)
  assert.equal(confirms, 1)
  assert.equal(vast.state.creates, 2)
  const rented = await create(api, offer, 'ssh-ed25519 Zml4dHVyZQ== fixture', 'fixture-confirm', async (q: any) => {
    confirms++
    assert.equal(vast.state.creates, 3)
    assert.ok(q.willRun.includes('Billing starts'))
    vast.state.stockLoss = false
    return 'rent'
  }, () => {}, signal)
  assert.ok(rented?.pod.id)
  assert.equal(rented.offer.price, 1.708)
  assert.equal(vast.state.creates, 4)
  assert.equal(vast.requests.filter(row => row.method === 'PUT' && row.path.startsWith('/api/v0/asks/')).at(-1)?.path, '/api/v0/asks/202/')
  vast.state.stockLoss = true
  vast.state.customOffers = []
  const notices: string[] = []
  const absent = await create(api, offer, 'ssh-ed25519 Zml4dHVyZQ== fixture', 'fixture-empty', async () => { throw new Error('No replacement can be confirmed') }, (event: any) => notices.push(event.words), signal)
  assert.equal(absent, undefined)
  assert.ok(notices.some(text => text.includes('No other machine') && text.includes('nothing was rented')))
  console.log('PASS no_such_ask reads stock once, excludes the lost machine, preserves the recipe, requires confirmation at the new price, and reports empty stock honestly')
} finally { await vast.close(); f.close() }
