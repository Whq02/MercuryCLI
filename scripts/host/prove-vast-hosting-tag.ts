import assert from 'node:assert/strict'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { vastFixture } from './vastFixture.mjs'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const f = await llmhostFixture()
const vast = await vastFixture()
try {
  const { VastClient } = await import('../../src/services/host/vendors/vast.ts')
  const shape = { gpu_name: 'B200', gpu_ram: 192 * 1024, num_gpus: 4, dph_total: 9.25, verification: 'verified', reliability2: 0.999, reliability: 0.999, direct_port_count: 1, rentable: true, rented: false, cuda_max_good: 13, disk_space: 10000 }
  vast.state.customOffers = [{ ...shape, id: 201 }, { ...shape, id: 202, datacenter: true }, { ...shape, id: 203, datacenter: false }, { ...shape, id: 204, datacenter: null }]
  const rows = await new VastClient(vast.key, vast.baseUrl).offers(new AbortController().signal)
  assert.ok(rows.length > 0 && rows.every(row => row.recipe.count === 4))
  assert.deepEqual(new Set(rows.map(row => row.hostingType)), new Set(['host', 'datacenter', 'community host']), 'missing datacenter does not claim an unknown hosting type or invent a datacenter')
  assert.ok(rows.every(row => !row.hostingType?.includes('unknown')))
  assert.equal(vast.state.creates, 0)
  console.log('VAST HOSTING TAG GREEN — absent/null datacenter says host; true and false retain their supplied classification; 4× B200 fixture; no rental')
} finally { await vast.close(); f.close() }
