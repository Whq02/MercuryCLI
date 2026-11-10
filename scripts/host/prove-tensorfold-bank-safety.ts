import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const { llmhostFixture } = await import('../providers/lib/llmhostFixture.ts')
const { runpodFixture, fakeSshRunner } = await import('./runpodFixture.mjs')
const f = await llmhostFixture()
const rp = await runpodFixture()
process.env.HOME = f.home
const nativeFetch = globalThis.fetch
const escaped: string[] = []
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)) { escaped.push(url.href); throw new Error('loopback only') }
  return nativeFetch(input, init)
}, nativeFetch)
let ssh: ReturnType<typeof fakeSshRunner> | undefined
try {
  const { currentHostRecipes } = await import('../../src/services/host/recipesFile.ts')
  const { mirrorToVolume } = await import('../../src/services/host/fastLoad.ts')
  const { bankModelFolder, rememberBankFolder, sealBank, bankState } = await import('../../src/services/host/bank.ts')
  const { pinnedWeightManifest } = await import('../../src/services/host/keptWeights.ts')
  const { RunpodClient } = await import('../../src/services/host/runpod.ts')
  const { hostRunner } = await import('../../src/services/host/ssh.ts')
  const { writeStoredRunpodApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const { keptVolumes } = await import('../../src/services/host/volumes.ts')
  writeStoredRunpodApiKey(rp.key)
  const shipped = currentHostRecipes().filter((row: any) => row.engine === 'tensorfold')
  console.log('SHIPPED', shipped.length, 'WITHOUT_MANIFEST', shipped.filter((row: any) => !pinnedWeightManifest(row)).length)
  const files = {
    'config.json': Buffer.from('{"model_type":"qwen3_5"}'),
    'model.safetensors.index.json': Buffer.from('{"weight_map":{"weight":"model.safetensors"}}'),
    'model.safetensors': Buffer.from('fixture weights'),
    'tokenizer.json': Buffer.from('{"fixture":true}'),
  }
  const bytes = Object.values(files).reduce((n, data) => n + data.length, 0)
  const recipe = { ...shipped[0], id: 'tensorfold-bank-fixture', weightsGb: bytes / 1e9 }
  const folder = rememberBankFolder(join(f.home, 'bank'))
  const path = bankModelFolder(folder, recipe)
  mkdirSync(join(path, '.cache/huggingface/download'), { recursive: true })
  for (const [name, data] of Object.entries(files)) {
    writeFileSync(join(path, name), data)
    writeFileSync(join(path, '.cache/huggingface/download', name + '.metadata'), 'a'.repeat(40) + '\n' + createHash('sha256').update(data).digest('hex') + '\n')
  }
  await sealBank(recipe, folder, new AbortController().signal)
  const manifest = pinnedWeightManifest(recipe)
  console.log('BANKED', bankState(recipe).banked, 'MANIFEST', Boolean(manifest), 'FILES', manifest?.files.length)
  assert.ok(bankState(recipe).banked && manifest)
  ssh = fakeSshRunner(f.baseUrl, hostRunner)
  const options = { runner: ssh.runner, sessionId: 'tensorfold-bank-fixture', apiBaseUrl: rp.baseUrl, startJob: () => {} }
  const steps: string[] = []
  const words: string[] = []
  await mirrorToVolume(new RunpodClient(rp.key, rp.baseUrl), recipe, async (q: any) => {
    steps.push(q.step)
    if (q.step === 'fast-load-how') return 'network'
    if (q.step === 'fast-load-where') return 'EU-NL-1'
    if (q.step === 'fast-load-when') return 'next'
    if (q.step === 'fast-load-confirm') return 'confirm'
    throw new Error('Unexpected step ' + q.step)
  }, (event: any) => words.push(event.words), new AbortController().signal, options)
  console.log(JSON.stringify({ steps, words, volumeCreates: rp.state.volumeCreates, podCreates: rp.state.creates, volumes: keptVolumes().map((row: any) => ({ id: row.id, state: row.state, engine: row.recipeRow?.engine })), escaped }))
  assert.equal(rp.state.volumeCreates, 0, 'a TensorFold bank cannot sell a kept disk that pod setup refuses')
  assert.equal(rp.requests.length, 0, 'the refused mirror makes no vendor request')
  assert.deepEqual(words, ['TensorFold pulls weights from Hugging Face · kept weights disks are not supported. No volume or pod was created.'], 'the refusal names the unsupported source without promising a mirror')
  const { bankAction, bankDoor } = await import('../../src/services/host/fastLoad.ts')
  const { writeKeptVolume, readKeptVolume } = await import('../../src/services/host/volumes.ts')
  const { createHostRoad } = await import('../../src/services/host/index.ts')
  let connections = 0
  const bankOptions = { ...options, api: () => { connections++; return new RunpodClient(rp.key, rp.baseUrl) }, connect: async () => { connections++; return true } }
  await bankAction(recipe, 'mirror', folder, async () => { throw new Error('The unsupported mirror asks no question') }, () => {}, new AbortController().signal, bankOptions)
  assert.equal(connections, 0, 'the Bank mirror key does not connect a vendor')
  assert.equal(rp.requests.length, 0, 'the Bank mirror key makes no vendor request')
  let listed = false
  await bankDoor(async (q: any) => { if (q.step === 'door-bank') listed = q.rows.some((row: any) => row.value === recipe.id && row.label.endsWith('— not supported')); return null }, () => {}, new AbortController().signal, { ...bankOptions, refreshVolumes: async () => {} })
  assert.ok(listed, 'the banked TensorFold row discloses unsupported kept disks')
  const volume = { id: 'old-tensorfold-volume', name: 'old-tensorfold-volume', kind: 'network' as const, model: recipe.model, include: '', dataCenter: 'EU-NL-1', size: 80, price: 5.6, state: 'kept' as const, createdAt: new Date().toISOString(), recipeRow: recipe }
  writeKeptVolume(volume)
  rp.state.volumes.set(volume.id, { id: volume.id, name: volume.name, kind: 'network', size: 80, dataCenter: 'EU-NL-1', type: 'STANDARD' })
  const road = createHostRoad({ ...options })
  let paid = false
  const removed = await road(async (q: any) => {
    if (q.step === 'door-models') return 'pods'
    if (q.step === 'paid-pods') { paid = q.rows.some((row: any) => row.value === 'volume:' + volume.id && row.label.includes('$5.60/month')); return 'volume:' + volume.id }
    if (q.step === 'volume-delete') return 'delete'
    return null
  }, () => {}, new AbortController().signal)
  assert.ok(paid && removed.ok && !rp.state.volumes.has(volume.id) && readKeptVolume(volume.id)?.state === 'gone', 'an older billed TensorFold volume stays listed and is deleted through Machines I’m paying for')
  assert.ok(bankState(recipe).banked, 'deleting the old volume leaves the local bank intact')
  assert.deepEqual(escaped, [], 'no request left the loopback fixtures')
  console.log('TENSORFOLD BANK SAFETY GREEN — 10 checks; vendor requests 0 before legacy-volume cleanup')
} finally { ssh?.close(); await rp.close(); f.close(); globalThis.fetch = nativeFetch }
