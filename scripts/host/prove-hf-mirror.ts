import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { PYTHON3 } from '../lib/python3.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hfFixture } from './hfFixture.mjs'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { runpodFixture, fakeSshRunner } from './runpodFixture.mjs'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
if (process.argv.includes('--worker-recipe') || process.argv.includes('--volume-recipe')) {
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const { readHostRecord } = await import('../../src/services/host/store.ts')
  const { hostRecipeOfRecord } = await import('../../src/services/host/recipesFile.ts')
  const { weightManifest } = await import('../../src/services/host/keptWeights.ts')
  const { fastLoadRecipes } = await import('../../src/services/host/fastLoad.ts')
  const row = process.argv.includes('--volume-recipe') ? fastLoadRecipes().find(recipe => recipe.id === process.argv.at(-1))! : hostRecipeOfRecord(readHostRecord('fixture-hf-worker')!)!
  console.log(JSON.stringify(weightManifest(row)))
} else {
  const f = await llmhostFixture()
  const hf = await hfFixture()
  const rp = await runpodFixture()
  process.env.HOME = f.home
  if (process.platform === 'win32') process.env.USERPROFILE = f.home
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname), 'all requests stay on loopback')
    return originalFetch(input, init)
  }, originalFetch)
  let checks = 0
  const check = (name: string, truth: unknown) => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
  let ssh: ReturnType<typeof fakeSshRunner> | undefined
  try {
    const { searchHuggingFace, pickHuggingFaceModel, fetchHuggingFaceRepo } = await import('../../src/services/host/hfRecipes.ts')
    const { hostRecipeSchema } = await import('../../src/services/host/recipesFile.ts')
    const { weightManifest, weightCheckScript } = await import('../../src/services/host/keptWeights.ts')
    const { bankDownloadPlan, rememberBankFolder, bankModelFolder, sealBank, bankState } = await import('../../src/services/host/bank.ts')
    const { mirrorToVolume } = await import('../../src/services/host/fastLoad.ts')
    const { queueHostSetup } = await import('../../src/services/host/jobs.ts')
    const { RunpodClient } = await import('../../src/services/host/runpod.ts')
    const { hostRunner } = await import('../../src/services/host/ssh.ts')
    const { runHostJob } = await import('../../src/services/host/worker.ts')
    const { keptVolumes } = await import('../../src/services/host/volumes.ts')
    const bytes = [Buffer.from('first shard'), Buffer.from('second shard'), Buffer.from('third shard'), Buffer.from('fourth shard')]
    hf.repos.gguf.files = bytes.map((data, index) => ({ path: 'Q4_K_M/tiny-Q4_K_M-' + String(index + 1).padStart(5, '0') + '-of-00004.gguf', size: data.length, sha256: createHash('sha256').update(data).digest('hex') }))
    hf.repos.gguf.files.push(...Array.from({ length: 5 }, (_, index) => ({ path: 'other-' + index + '.json', size: 1 })))
    hf.state.pageSize = 1
    const configBytes = Buffer.from(JSON.stringify(hf.repos.fp8.rawConfig))
    const tensorBytes = Buffer.from('single tensor weights')
    hf.repos.fp8.files = [{ path: 'config.json', size: configBytes.length, git: createHash('sha1').update('blob ' + configBytes.length + '\0').update(configBytes).digest('hex') }, { path: 'model.safetensors', size: tensorBytes.length, sha256: createHash('sha256').update(tensorBytes).digest('hex') }]
    const found = await searchHuggingFace('deepseek', { base: hf.baseUrl })
    assert.equal(found.state, 'ready')
    const model = found.state === 'ready' ? found.models.find(row => row.id === hf.repos.gguf.id)! : undefined!
    const picked = await pickHuggingFaceModel(model, { base: hf.baseUrl })
    assert.ok(picked.ok, JSON.stringify(picked).slice(0, 400))
    const recipe = picked.row.recipe
    let manifest
    try { manifest = weightManifest(recipe) } catch {}
    check('a derived HF recipe carries a trusted file manifest instead of failing at mirror', manifest)
    assert.ok(manifest)
    const revision = createHash('sha1').update(model.id).digest('hex')
    check('the manifest pins the Hub commit, exact quant files, byte counts and SHA256 hashes', manifest.revision === revision && manifest.files.length === 4 && manifest.files.every((file, index) => file.path === hf.repos.gguf.files[index]!.path && file.size === bytes[index]!.length && file.sha256 === createHash('sha256').update(bytes[index]!).digest('hex')))
    check('the tree and config use the resolved immutable commit, not a moving main', hf.requests.some(row => row.path.endsWith('/tree/' + revision)) && !hf.requests.some(row => row.path.endsWith('/tree/main')))
    check('bank downloads use the same exact revision and file list', bankDownloadPlan(recipe).revision === revision && bankDownloadPlan(recipe).include.join() === manifest.files.map(file => file.path).join())
    check('the trusted file list reads beyond five pages rather than sealing a truncated tree', hf.state.trees > 5 && hf.state.trees === hf.repos.gguf.files.length + 1)
    hf.state.repeatPage = true
    const repeated = await fetchHuggingFaceRepo(model.id, { base: hf.baseUrl })
    check('a repeated page cannot produce a partial trusted manifest', !repeated.ok)
    hf.state.repeatPage = false
    const tensor = await pickHuggingFaceModel(found.state === 'ready' ? found.models.find(row => row.id === hf.repos.fp8.id)! : undefined!, { base: hf.baseUrl })
    assert.ok(tensor.ok)
    const tensorManifest = weightManifest(tensor.row.recipe)
    check('a single-file safetensors recipe includes its config git hash and weights SHA256 without requiring an index', tensorManifest.files.length === 2 && tensorManifest.files.some(file => file.path === 'config.json' && file.git) && tensorManifest.files.some(file => file.path === 'model.safetensors' && file.sha256) && Math.round(tensor.row.recipe.weightsGb * 1e9) === configBytes.length + tensorBytes.length)
    const folder = rememberBankFolder(join(f.home, 'mercury-model-bank'))
    const local = bankModelFolder(folder, recipe)
    for (const [index, file] of manifest.files.entries()) { mkdirSync(join(local, file.path, '..'), { recursive: true }); writeFileSync(join(local, file.path), bytes[index]!) }
    await sealBank(recipe, folder, new AbortController().signal)
    check('the downloaded bank is sealed against the Hub hashes, not merely against itself', bankState(recipe).banked && bankState(recipe).check === 'manifest')
    queueHostSetup({ id: 'fixture-hf-worker', name: 'Fixture HF worker', recipe: recipe.id, price: 0, status: 'RUNNING', startedAt: new Date().toISOString() })
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker-recipe'], { env: process.env, encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    check('a fresh worker restores the same trusted manifest from its queued recipe record', JSON.stringify(JSON.parse(child.stdout.trim().split('\n').at(-1)!)) === JSON.stringify(manifest))
    const python = spawnSync(PYTHON3, ['-c', weightCheckScript(manifest, local, false, { fully: true })], { encoding: 'utf8' })
    check('the real volume-verification script accepts the actual trusted bytes', python.status === 0 && python.stdout.includes('MERCURY_WEIGHTS'))
    writeFileSync(join(local, manifest.files[0]!.path), Buffer.alloc(bytes[0]!.length))
    const corrupt = spawnSync(PYTHON3, ['-c', weightCheckScript(manifest, local, false, { fully: true })], { encoding: 'utf8' })
    check('the same verification rejects a same-size corrupt shard', corrupt.status !== 0 && corrupt.stderr.includes('Kept weights failed pinned SHA256/sizes verification'))
    writeFileSync(join(local, manifest.files[0]!.path), bytes[0]!)
    check('an embedded manifest rejects path traversal, missing hashes and a moving revision', !hostRecipeSchema.safeParse({ ...recipe, weightManifest: { ...manifest, files: [{ ...manifest.files[0], path: '../escape.gguf' }] } }).success && !hostRecipeSchema.safeParse({ ...recipe, weightManifest: { ...manifest, files: [{ path: 'empty.gguf', size: 1 }] } }).success && !hostRecipeSchema.safeParse({ ...recipe, weightManifest: { ...manifest, revision: 'main' } }).success)
    ssh = fakeSshRunner(f.baseUrl, hostRunner)
    const { writeStoredRunpodApiKey } = await import('../../src/services/providers/providerSecrets.ts')
    writeStoredRunpodApiKey(rp.key)
    const api = new RunpodClient(rp.key, rp.baseUrl)
    const jobs: Promise<void>[] = []
    const options = { apiBaseUrl: rp.baseUrl, runner: ssh.runner, sessionId: 'hf-mirror-proof', startJob: (record: any) => { jobs.push(runHostJob(record.id, record.generation, { runner: ssh!.runner, pauseMs: 5, timeoutMs: 4000, keepAlive: false })) } }
    rp.state.customGpus = [{ id: 'NVIDIA H100 80GB HBM3', name: 'H100', memory: 80, secure: true, price: { secure: 3.99 }, maxCount: { secure: 8 }, availability: 'HIGH', dataCenters: [{ id: 'EU-NL-1', availability: 'HIGH' }] }]
    const seen: string[] = []
    await mirrorToVolume(api, recipe, async question => {
      seen.push(question.step)
      if (question.step === 'fast-load-how') return 'global'
      if (question.step === 'fast-load-when') return 'now'
      if (question.step === 'fast-load-confirm') { check('a derived mirror still asks for disk and temporary-pod charges before billing', question.willRun?.includes('nothing is uploaded from your drive') && rp.state.volumeCreates === 0 && rp.state.creates === 0); return 'confirm' }
      throw new Error('Unexpected question ' + question.step)
    }, () => {}, new AbortController().signal, options)
    await Promise.all(jobs)
    check('the mirror fills and verifies one volume and terminates its one temporary pod', seen.includes('fast-load-confirm') && rp.state.volumeCreates === 1 && rp.state.creates === 1 && rp.state.deletes === 1 && rp.state.pods.size === 0 && keptVolumes().some(volume => volume.model === recipe.model && volume.state === 'kept'))
    const { writeBankRegistry } = await import('../../src/services/host/bank.ts')
    writeBankRegistry({ folder, models: {} })
    const volumeChild = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--volume-recipe', recipe.id], { env: process.env, encoding: 'utf8' })
    assert.equal(volumeChild.status, 0, volumeChild.stderr)
    check('a volume-only copy retains its recipe and manifest in a fresh session after the fill job is gone', JSON.stringify(JSON.parse(volumeChild.stdout.trim().split('\n').at(-1)!)) === JSON.stringify(manifest))
    const notices: string[] = []
    const untrusted = { ...recipe, id: 'untrusted-hf-mirror', model: 'Fixture/NoTrustedManifest', weightManifest: undefined }
    assert.throws(() => weightManifest(untrusted), 'the refusal fixture has no embedded, shipped, banked or kept-volume manifest')
    await mirrorToVolume(api, untrusted, async () => { throw new Error('an untrusted recipe cannot reach a paid confirmation') }, event => notices.push(event.words), new AbortController().signal, options)
    check('a recipe without trusted hashes gets plain words and stays open without creating anything', notices.some(words => words.includes('cannot be mirrored') && words.includes('trusted')) && rp.state.volumeCreates === 1 && rp.state.creates === 1)
    console.log('HF MIRROR GREEN — ' + checks + ' checks; loopback fixtures, fresh worker and actual hash verification; no billable calls')
  } finally { ssh?.close(); await hf.close(); await rp.close(); f.close(); globalThis.fetch = originalFetch }
}
