import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ggufHeaderBytes } from '../host/hfFixture.mjs'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_LOCAL_BASE_URL
const { runLocalSetupRoad } = await import('../../src/services/localSetup/ggufRoad.ts')
const { listGgufModels } = await import('../../src/services/localSetup/ggufModels.ts')
const { bankState, bankedHostRecipes, rememberBankFolder } = await import('../../src/services/host/bank.ts')
const { reconcileRecord, stopService } = await import('../../src/services/projectServices/serviceManager.ts')
const { discoverLocalServers } = await import('../../src/services/providers/local/localDiscovery.ts')
const { ggufServerRoots } = await import('../../src/services/localSetup/ggufServers.ts')
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { setupSummaryOf } = await import('../../src/commands/localsetup/localsetup.tsx')
const { localSetupSummaryRows } = await import('../../src/components/LocalSetupDialog.tsx')
type SetupStepPlan = import('../../src/services/localSetup/setupTypes.ts').SetupStepPlan
type SetupConsent = import('../../src/services/localSetup/setupTypes.ts').SetupConsent
type SetupSummary = import('../../src/services/localSetup/setupTypes.ts').SetupSummary
type GgufSetupIo = import('../../src/services/localSetup/ggufRoad.ts').GgufSetupIo
const repo = 'fixture/Any-GGUF'
const revision = 'b'.repeat(40)
const bytes = ggufHeaderBytes({ architecture: 'qwen35moe', kv: { 'qwen35moe.block_count': 41, 'qwen35moe.nextn_predict_layers': 1, 'qwen35moe.context_length': 131072, 'qwen35moe.attention.head_count': 16, 'qwen35moe.attention.head_count_kv': 2, 'qwen35moe.embedding_length': 2048, 'qwen35moe.full_attention_interval': 4 }, tensors: ['blk.0.attn_norm.weight', 'blk.40.nextn.eh_proj.weight'] })
const projector = Buffer.from('projector fixture')
const files = [
  { path: 'Any-Q6_K.gguf', data: bytes, size: bytes.length },
  { path: 'Any-BF16.gguf', data: bytes, size: 200e9 },
  { path: 'mmproj-BF16.gguf', data: projector, size: projector.length },
]
const hits: string[] = []
let gated = false
let hostilePage = false
const hub = createServer((req, res) => {
  hits.push(req.url!)
  const url = new URL(req.url!, 'http://127.0.0.1')
  const json = (data: unknown): void => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)) }
  if (gated) { res.writeHead(403).end(); return }
  if (url.pathname === '/api/models/' + repo) { json({ sha: revision }); return }
  if (url.pathname === '/api/models/' + repo + '/tree/' + revision) {
    if (hostilePage) res.setHeader('link', '<http://example.invalid/escape>; rel="next"')
    json(files.map(file => ({ type: 'file', path: file.path, size: file.size, lfs: { size: file.size, oid: createHash('sha256').update(file.data).digest('hex') } })))
    return
  }
  const file = files.find(file => url.pathname === '/' + repo + '/resolve/' + revision + '/' + file.path)
  if (file) { res.writeHead(206); res.end(file.data); return }
  res.writeHead(404).end()
})
await new Promise<void>(resolve => hub.listen(0, '127.0.0.1', resolve))
const hubBase = 'http://127.0.0.1:' + (hub.address() as { port: number }).port
const probe = createServer()
await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
const port = (probe.address() as { port: number }).port
await new Promise<void>(resolve => probe.close(() => resolve()))
const folder = rememberBankFolder(join(proofHome, 'bank'))
const destination = join(folder, repo.replaceAll('/', '--'))
const capture = join(proofHome, 'server.jsonl')
let downloads = 0
let interrupt = true
let switched = ''
const bankRunner: GgufSetupIo['bankRunner'] = {
  tunnel() { throw new Error('no tunnel') },
  async run(_command, args) {
    downloads++
    const script = args.join(' ')
    assert.ok(script.includes('--revision') && script.includes(revision))
    assert.ok(script.includes('Any-Q6_K.gguf') && script.includes('mmproj-BF16.gguf'))
    assert.ok(!script.includes('Any-BF16.gguf'))
    mkdirSync(destination, { recursive: true })
    const partial = join(destination, '.partial')
    if (interrupt) { writeFileSync(partial, bytes.subarray(0, 32)); interrupt = false; throw new Error('fixture connection closed') }
    assert.equal(readFileSync(partial).length, 32)
    writeFileSync(join(destination, files[0]!.path), bytes)
    writeFileSync(join(destination, files[2]!.path), projector)
    return ''
  },
}
const io: GgufSetupIo = { repo, hubBase, bankRunner, home: proofHome, configHome: proofHome, cwd: proofHome, totalMemoryBytes: 48 * 1024 ** 3, availableMemory: async () => 40 * 1024 ** 3, serverCommand: process.execPath, serverArgs: [join(import.meta.dir, 'fixtures/gguf-server.mjs'), '--capture', capture], port, startWaitMs: 5000, currentModel: () => 'local/old', focusedConnector: () => ({ carrier: 'daemon', setModel: async setting => { switched = setting!; return { state: 'applied' } } }), persist: () => ({ sentence: 'saved' }), writeWindow: () => {} }
const choose = (row: SetupStepPlan): SetupConsent => row.rows ? { pick: row.rows.find(row => row.tag === 'Any-Q6_K.gguf')?.tag ?? row.rows[0]!.tag } : 'run'
async function run(consent = choose, overrides: Partial<GgufSetupIo> = {}): Promise<SetupSummary> {
  let summary: SetupSummary | undefined
  for await (const event of runLocalSetupRoad(consent, { ...io, ...overrides })) if (event.type === 'done') summary = event.summary
  assert.ok(summary)
  return summary
}
try {
  const listing = await listGgufModels(repo, { base: hubBase, machineBytes: io.totalMemoryBytes!, platform: 'darwin' })
  assert.equal(listing.models.length, 2)
  const selected = listing.models.find(model => model.recipe.weightFile === 'Any-Q6_K.gguf')!
  assert.equal(selected.recipe.mmproj, 'mmproj-BF16.gguf')
  assert.equal(selected.recipe.weightManifest!.files.length, 2)
  assert.ok(selected.fit?.fits)
  assert.equal(listing.models[0]!.fit?.fits, false)
  assert.ok(hits.every(hit => !hit.includes('/resolve/main/')))
  console.log('PASS pinned repository tree, all GGUF sizes, fit and projector')
  const emptyBank = await run(row => row.label === '1' ? { pick: 'Bank' } : 'run', { repo: undefined })
  assert.equal(emptyBank.reason, 'ended')
  const emptyView = setupSummaryOf(emptyBank)
  assert.deepEqual(emptyView.done, ['1'])
  assert.deepEqual(emptyView.notDone, [])
  const emptyRows = localSetupSummaryRows(emptyView, { '1': 'Local models' })
  assert.equal(emptyRows.filter(row => row.includes('1 Local models')).length, 1)
  assert.ok(emptyRows.includes('done: 1 Local models'))
  assert.ok(emptyRows.includes('not done: nothing'))
  console.log('PASS empty Bank lists Local models in exactly one summary section')
  const skippedEvents: string[] = []
  let skippedSummary: SetupSummary | undefined
  for await (const event of runLocalSetupRoad(row => row.label === '1' ? 'skip' : 'stop', { ...io, repo: undefined })) {
    skippedEvents.push(event.type === 'step' ? `step ${event.plan.label}` : event.type === 'result' ? `result ${event.result.label} ${event.result.outcome}` : event.type === 'done' ? `done ${event.summary.reason}` : event.type)
    if (event.type === 'done') skippedSummary = event.summary
  }
  assert.deepEqual(skippedEvents, ['step 1', 'result 1 skipped', 'step 2', 'done stopped'])
  assert.deepEqual(skippedSummary!.skipped, ['1'])
  assert.deepEqual(skippedSummary!.ran, [])
  const skippedRows = localSetupSummaryRows(setupSummaryOf(skippedSummary!), { '1': 'Local models', '2': 'Hugging Face' })
  assert.ok(skippedRows.includes('skipped: 1 Local models'), skippedRows.join(' | '))
  assert.ok(skippedRows.includes('done: nothing'), skippedRows.join(' | '))
  console.log('PASS s on the source choice skips to the Hugging Face road, step 2 asks for the repository id, and the summary lists step 1 as skipped')
  const denied = await run(() => 'stop')
  assert.equal(denied.reason, 'stopped')
  assert.equal(downloads, 0)
  assert.equal(switched, '')
  const notFit = await run(row => row.rows ? { pick: 'Any-BF16.gguf' } : 'run')
  assert.equal(notFit.reason, 'ended')
  assert.equal(downloads, 0)
  console.log('PASS consent and memory fit precede download and launch')
  const broken = await run()
  assert.equal(broken.reason, 'ended')
  assert.ok(existsSync(join(destination, '.partial')))
  assert.equal(bankState(selected.recipe, folder).banked, false)
  assert.equal(switched, '')
  const ready = await run()
  assert.equal(ready.reason, 'finished', ready.words)
  assert.equal(ready.model, 'local/Any-Q6_K')
  assert.equal(switched, ready.model)
  assert.equal(downloads, 2)
  assert.equal(bankState(selected.recipe, folder).check, 'manifest')
  assert.ok(bankedHostRecipes(folder).some(recipe => recipe.weightFile === 'Any-Q6_K.gguf'))
  const captured = readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(captured[0].args.includes('--mmproj'))
  assert.ok(captured[0].args.includes('draft-mtp'))
  assert.equal(selected.fit!.geometry.attentionLayers, 11)
  assert.equal(selected.fit!.geometry.kvHeads, 22)
  assert.ok(captured[0].args.includes('131072'))
  assert.equal(captured[1].request.model, 'Any-Q6_K')
  assert.equal(captured[1].request.messages[0].content, 'reply with the single word ready')
  assert.ok(ggufServerRoots().includes('http://127.0.0.1:' + port))
  const found = await discoverLocalServers({ env: { MERCURY_LOCAL_PROBE_TARGETS: 'llamacpp=http://127.0.0.1:' + port } })
  assert.equal(found.servers[0]!.models[0]!.id, 'Any-Q6_K')
  console.log('PASS interrupted pull retained, retry sealed, real fixture server served selected context and local model')
  const occupied = await run()
  assert.equal(occupied.reason, 'ended')
  assert.ok(occupied.words.includes('in use'))
  assert.ok(['ready', 'running'].includes(reconcileRecord(proofHome, 'local-gguf')!.state))
  console.log('PASS existing server untouched')
  await stopService(proofHome, 'local-gguf')
  const lowMemory = await run(choose, { availableMemory: async () => 1 })
  assert.equal(lowMemory.reason, 'ended')
  assert.ok(lowMemory.words.includes('available'))
  const cancelled = await run(row => row.label === '6' ? 'stop' : choose(row))
  assert.equal(cancelled.reason, 'stopped')
  assert.equal(reconcileRecord(proofHome, 'local-gguf')!.state, 'stopped')
  console.log('PASS fresh free-memory check and owned-server cleanup on stop')
  const bank = await run(row => row.label === '1' ? { pick: 'Bank' } : row.rows ? { pick: row.rows[0]!.tag } : row.label === '5' ? 'stop' : 'run', { repo: undefined })
  assert.equal(bank.reason, 'stopped')
  const bankView = setupSummaryOf(bank)
  const bankListed = [...bankView.done, ...(bankView.skipped ?? []), ...bankView.notDone]
  assert.equal(new Set(bankListed).size, bankListed.length)
  assert.equal(bankView.notDone.filter(step => bankView.done.includes(step)).length, 0)
  assert.equal(downloads, 2)
  const original = Buffer.from(readFileSync(join(destination, 'Any-Q6_K.gguf')))
  const corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 1
  writeFileSync(join(destination, 'Any-Q6_K.gguf'), corrupt)
  const mismatched = await run()
  assert.equal(mismatched.reason, 'ended')
  assert.ok(mismatched.words.includes('hash differs'))
  assert.equal(reconcileRecord(proofHome, 'local-gguf')!.state, 'stopped')
  writeFileSync(join(destination, 'Any-Q6_K.gguf'), original)
  console.log('PASS Bank selection needs no download; changed bytes never reach server')
  const failed = await run(choose, { serverArgs: [...io.serverArgs!, '--fail'] })
  assert.equal(failed.reason, 'ended')
  assert.ok(['failed', 'stopped'].includes(reconcileRecord(proofHome, 'local-gguf')!.state))
  gated = true
  await assert.rejects(listGgufModels(repo, { base: hubBase, machineBytes: io.totalMemoryBytes!, platform: 'darwin' }), /no access/)
  gated = false; hostilePage = true
  await assert.rejects(listGgufModels(repo, { base: hubBase, machineBytes: io.totalMemoryBytes!, platform: 'darwin' }))
  await assert.rejects(listGgufModels('../escape', { base: hubBase, machineBytes: io.totalMemoryBytes!, platform: 'darwin' }), /repository id/)
  console.log('PASS failed server, gated repository, unsafe pagination and invalid repository refuse')
} finally {
  await stopService(proofHome, 'local-gguf')
  await new Promise<void>(resolve => hub.close(() => resolve()))
  rmSync(proofHome, { recursive: true, force: true })
}
