#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'embed-pack-')))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_EMBED_PACK_DIR', 'MERCURY_EMBED_MODEL', 'MERCURY_HOME']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
  if (!cond) failures++
}
const warn = (line: string): void => console.log(`  [WARN] ${line}`)
const finish = (note: string): never => {
  rmSync(SCRATCH, { recursive: true, force: true })
  console.log(failures > 0 ? `\nprove-embed-pack: RED (${failures})` : `\nprove-embed-pack: green${note ? ` (${note})` : ''}`)
  process.exit(failures > 0 ? 1 : 0)
}

const pack = await import('../../src/mneme/embedPack.js')
const models = await import('../../src/mneme/embedModels.js')

const PLATFORM = (await import('../../src/services/voice/voicePack.js')).voicePackPlatform()
const PACK_DIR = pack.embedPackDirFor(ROOT, PLATFORM)
const CACHE_DIR = join(ROOT, models.EMBED_MODELS_VENDOR_PATH)
const BUN = process.execPath
const tool = (name: string): string | null => {
  const res = spawnSync(name, ['--version'], { encoding: 'utf8', env: process.env })
  return !res.error && res.status === 0 ? (res.stdout.trim().split('\n')[0] ?? '') : null
}
const cargo = tool('cargo')
console.log(`cargo: ${cargo ?? 'absent'} · platform ${PLATFORM}`)

console.log('\n[M] the model road — the lock, the states, the pin, the download law')
{
  const lockRaw = JSON.parse(readFileSync(join(ROOT, models.EMBED_MODELS_LOCK_PATH), 'utf8')) as unknown
  const catalogue = models.decodeEmbedModelsLock(lockRaw)
  check('the lock is well-formed: a permissive licence, a source, a default that names a row, every row whole', catalogue.models.length >= 4 && typeof catalogue.defaultName === 'string' && catalogue.models.every(r => (r.license === 'MIT' || r.license === 'Apache-2.0') && r.url.startsWith('https://') && r.url.endsWith(r.file) && /^[0-9a-f]{64}$/.test(r.sha256) && r.bytes > 1_000_000 && r.dimension >= 384), catalogue.models.map(r => `${r.name}/${r.license}`).join(','))
  check('the compiled catalogue is the lock', models.EMBED_DEFAULT_MODEL === catalogue.defaultName && models.EMBED_MODELS.length === catalogue.models.length && models.EMBED_MODELS.every((r, i) => r.sha256 === catalogue.models[i]?.sha256))
  const def = models.embedDefaultModel()
  check('the chosen default is the measured winner: bge-base, 118 MB, MIT, 768d', def.name === 'bge-base-en-v1.5-q8_0' && models.mbWords(def.bytes) === '118 MB' && def.license === 'MIT' && def.dimension === 768, JSON.stringify(def))
  check('a ~30 MB class row exists for the lighter road', models.EMBED_MODELS.some(r => r.bytes < 40_000_000 && r.dimension === 384))
  let bad = ''
  try {
    models.decodeEmbedModelsLock({ ...(lockRaw as object), models: [{ name: 'x', file: 'x.gguf', url: 'https://example.invalid/x', bytes: 1, sha256: 'nope', license: 'GPL', dimension: 7, words: 'x' }] })
  } catch (error) {
    bad = error instanceof Error ? error.message : String(error)
  }
  check('a row with half a claim or a non-permissive licence is refused, naming the row', bad.includes('not whole') && bad.includes('"x"'), bad)

  const row = def
  const home = join(SCRATCH, 'model-home')
  mkdirSync(home, { recursive: true })
  let state = models.checkEmbedModel({ kind: 'catalogue', row, pinned: false }, { home, homeOnly: true })
  check('absent ⇒ the note names the file, the size and word match only', state.state === 'absent' && state.note.includes(row.file) && state.note.includes(models.mbWords(row.bytes)) && state.note.includes(models.WORD_MATCH_ONLY_WORDS) && state.path === join(home, 'models', 'embed', row.file), JSON.stringify(state))
  const dir = models.embedModelsDir(home)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, row.file), Buffer.alloc(1234))
  state = models.checkEmbedModel({ kind: 'catalogue', row, pinned: false }, { home })
  check('a file of the wrong size ⇒ mismatch naming both byte counts', state.state === 'mismatch' && state.note.includes('1234 bytes on disk') && state.note.includes(String(row.bytes)), JSON.stringify(state))
  const cached = join(CACHE_DIR, row.file)
  if (existsSync(cached)) {
    rmSync(join(dir, row.file))
    try {
      symlinkSync(cached, join(dir, row.file))
    } catch {
      copyFileSync(cached, join(dir, row.file))
    }
    state = models.checkEmbedModel({ kind: 'catalogue', row, pinned: false }, { home })
    check('present ⇒ the name, the licence, the byte count, the dimension', state.state === 'present' && state.name === row.name && state.bytes === row.bytes && state.dimension === row.dimension && state.license === 'MIT', JSON.stringify(state))
    state = models.checkEmbedModel({ kind: 'catalogue', row, pinned: false }, { home, digest: true })
    check('…and the digest agrees with the lock when asked', state.state === 'present', JSON.stringify(state))
  } else {
    warn(`${models.EMBED_MODELS_VENDOR_PATH}/${row.file} is absent — the present leg is skipped (bun run scripts/vendor/fetch-embed-models.ts fetches it)`)
  }

  models.seedEmbedModelForTest('bge-small-en-v1.5-q8_0')
  let pin = models.resolveEmbedModelPin()
  check('the pin resolves a catalogue name', pin.kind === 'catalogue' && pin.row.name === 'bge-small-en-v1.5-q8_0' && pin.pinned)
  models.seedEmbedModelForTest('ollama:bge-m3')
  pin = models.resolveEmbedModelPin()
  check('…or an ollama:<model> spec', pin.kind === 'ollama' && pin.model === 'bge-m3')
  models.seedEmbedModelForTest('/no/such/model.gguf')
  pin = models.resolveEmbedModelPin()
  check('a path that is absent names itself — no silent fallback', pin.kind === 'broken' && pin.note.includes('/no/such/model.gguf') && pin.note.includes('no silent fallback'))
  models.seedEmbedModelForTest('not-a-model')
  pin = models.resolveEmbedModelPin()
  check('a spec that is neither name, ollama nor path names itself', pin.kind === 'broken' && pin.note.includes('not a catalogue name'))
  models.seedEmbedModelForTest(null)

  const served: string[] = []
  const serveFetch = async (input: string | URL | Request): Promise<Response> => {
    served.push(String(input))
    return new Response('partial bytes')
  }
  const badRow = { ...row, url: 'https://example.invalid/x.gguf', bytes: 64, sha256: 'ab'.repeat(32) }
  let downloadError = ''
  await models.downloadEmbedModel(badRow, join(SCRATCH, 'dl'), { fetchImpl: serveFetch as unknown as typeof fetch, deadlineMs: 5_000 }).catch((error: unknown) => {
    downloadError = error instanceof Error ? error.message : String(error)
  })
  check('a body that ends short of the pinned bytes is refused, naming both counts', downloadError.includes('ended at 13 of 64 bytes'), downloadError)
  check('…and no partial file stays behind', !existsSync(join(SCRATCH, 'dl', badRow.file)) && !existsSync(join(SCRATCH, 'dl', `${badRow.file}.part`)))
  const growRow = { ...row, url: 'https://example.invalid/big.gguf', bytes: 4, sha256: 'cd'.repeat(32) }
  const growStream = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(new Uint8Array(64))
      controller.close()
    },
  })
  let growError = ''
  await models.downloadEmbedModel(growRow, join(SCRATCH, 'dl2'), { fetchImpl: (async () => new Response(growStream)) as unknown as typeof fetch, deadlineMs: 5_000 }).catch((error: unknown) => {
    growError = error instanceof Error ? error.message : String(error)
  })
  check('a body that grows past the pinned size is refused — the file changed upstream', growError.includes('grew past'), growError)
  const goodDir = join(SCRATCH, 'dl3')
  mkdirSync(goodDir, { recursive: true })
  const tinyBody = Buffer.alloc(8, 7)
  writeFileSync(join(goodDir, row.file), tinyBody)
  let reuseError = ''
  const reuse = await models.downloadEmbedModel({ ...row, bytes: tinyBody.length, sha256: require('node:crypto').createHash('sha256').update(tinyBody).digest('hex') }, goodDir, { fetchImpl: serveFetch as unknown as typeof fetch }).catch((error: unknown) => {
    reuseError = error instanceof Error ? error.message : String(error)
    return null
  })
  check('a whole file already on disk is reused without a request', reuseError === '' && reuse !== null && reuse.reused === true, JSON.stringify(reuse ?? reuseError))

  const ollamaHits = await models.probeOllamaEmbeddingModels('http://127.0.0.1:1', (async () => new Response(JSON.stringify({ models: [{ name: 'bge-m3:latest' }, { name: 'llama3:8b' }, { name: 'nomic-embed-text' }] }))) as unknown as typeof fetch)
  check('the Ollama probe lists only embedding models, never a chat model', ollamaHits.length === 2 && ollamaHits.includes('bge-m3:latest') && ollamaHits.includes('nomic-embed-text'), JSON.stringify(ollamaHits))
  const ollamaNone = await models.probeOllamaEmbeddingModels('http://127.0.0.1:1', (async () => {
    throw new Error('connection refused')
  }) as unknown as typeof fetch)
  check('a refused server answers an empty list, never a throw', Array.isArray(ollamaNone) && ollamaNone.length === 0)

  const fetchCheck = spawnSync(BUN, ['run', 'scripts/vendor/fetch-embed-models.ts', '--check'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, BROWSER: '/usr/bin/true' } })
  check("the vendor fetch's --check runs offline (its verdict may be stale, its exit is honest)", fetchCheck.status === 0 || fetchCheck.status === 2, `rc=${String(fetchCheck.status)}`)
}

console.log('\n[P] the pack — the manifest, the surface, the honest degrade')
{
  const manifestFile = join(PACK_DIR, pack.EMBED_PACK_MANIFEST_FILE)
  const built = existsSync(manifestFile)
  if (!built) {
    warn(`vendor/embed/${PLATFORM} is absent on this host — the pack legs run against the pack owner's refusal only (bun run scripts/vendor/build-embed.ts builds it)`)
  }
  const resolution = pack.resolveEmbedPackDir()
  check('the pack owner answers ok when the pack is built, unavailable naming the platform when not', built ? resolution.state === 'ok' : resolution.state === 'unavailable' && resolution.note.includes(PLATFORM), JSON.stringify(resolution.state === 'ok' ? resolution.manifest.version : resolution.note))
  const seededDir = join(SCRATCH, 'seeded-pack')
  mkdirSync(seededDir, { recursive: true })
  if (built) {
    copyFileSync(join(PACK_DIR, pack.EMBED_ADDON_FILE), join(seededDir, pack.EMBED_ADDON_FILE))
    copyFileSync(manifestFile, join(seededDir, pack.EMBED_PACK_MANIFEST_FILE))
  } else {
    writeFileSync(join(seededDir, pack.EMBED_ADDON_FILE), 'not an addon')
    writeFileSync(join(seededDir, pack.EMBED_PACK_MANIFEST_FILE), JSON.stringify({ name: pack.EMBED_PACK_NAME, version: '0.1.0', platform: PLATFORM, addon: pack.EMBED_ADDON_FILE, addonSha256: 'ab'.repeat(32), sourceTreeDigest: 'cd'.repeat(32), treeDigest: 'ef'.repeat(32), fileCount: 2, cargo: '', engine: { name: 'gguf-bert', version: '1.0.0' }, cpuFloor: 'arm64 (NEON)', gpu: 'accelerate', crates: [] }))
  }
  pack.seedEmbedPackDirForTest(seededDir)
  const loaded = pack.loadEmbedAddon()
  if (built) {
    check('the addon loads and answers its whole surface', loaded.state === 'ok' && pack.EMBED_ADDON_EXPORTS.every(fn => typeof loaded.addon[fn] === 'function'), loaded.state === 'ok' ? '' : loaded.note)
    check('the manifest names the engine, the CPU floor and the crate licences', loaded.manifest.engine.name === pack.EMBED_ENGINE_NAME && loaded.manifest.crates.length > 0 && loaded.manifest.cpuFloor !== '' && existsSync(join(PACK_DIR, 'NOTICES.json')), JSON.stringify(loaded.manifest.engine))
    const cachedModel = join(CACHE_DIR, models.embedDefaultModel().file)
    if (loaded.state === 'ok' && existsSync(cachedModel)) {
      const handle = loaded.addon.loadModel(cachedModel)
      const info = loaded.addon.modelInfo(handle)
      check('the chosen model loads in-process: bert, 768d, 12 layers', info.architecture === 'bert' && info.dimension === 768 && info.layers === 12, JSON.stringify(info))
      const near = loaded.addon.embed(handle, 'the laptop clock drifts every week', true)
      const nearDoc = loaded.addon.embed(handle, 'the notebook time zone was set wrong', false)
      const far = loaded.addon.embed(handle, 'the build pipeline publishes a tarball', false)
      const cos = (a: number[], b: number[]): number => a.reduce((s, v, i) => s + v * b[i]!, 0)
      check('a related pair outscores an unrelated pair (meaning, not words)', cos(near, nearDoc) > cos(near, far) && near.length === 768, `related ${cos(near, nearDoc).toFixed(3)} vs unrelated ${cos(near, far).toFixed(3)}`)
      const again = loaded.addon.embed(handle, 'the laptop clock drifts every week', true)
      check('the same text embeds to the same vector (determinism)', cos(again, near) > 0.99999)
      const batch = loaded.addon.embedBatch(handle, ['one fact', 'another fact'], false)
      check('the batch road answers one vector per text', batch.length === 2 && batch[0]!.length === 768)
      loaded.addon.unloadModel(handle)
      const floor = loaded.addon.cpuFloor()
      check('the CPU-floor probe answers on this host', typeof floor.arch === 'string' && typeof floor.met === 'boolean')
    } else {
      warn('no model in the provers cache — the in-process legs are skipped (bun run scripts/vendor/fetch-embed-models.ts fetches it)')
    }
  } else {
    check('a pack whose addon is not a real addon refuses to load, naming the file', loaded.state === 'unavailable' && (loaded.note.includes('exports no') || loaded.note.includes('failed to load')), loaded.note)
  }
  pack.seedEmbedPackDirForTest(null)
  pack.resetEmbedAddonForTest()

  const distModels = join(ROOT, 'dist', 'vendor', 'embed-models', models.embedDefaultModel().file)
  const distPack = join(ROOT, 'dist', 'vendor', 'embed', PLATFORM)
  if (existsSync(distModels) && existsSync(join(distPack, pack.EMBED_PACK_MANIFEST_FILE))) {
    const repoCache = join(CACHE_DIR, models.embedDefaultModel().file)
    const stashed = join(SCRATCH, 'stashed-model')
    let moved = false
    if (existsSync(repoCache)) {
      copyFileSync(repoCache, stashed)
      rmSync(repoCache)
      moved = true
    }
    try {
      pack.seedEmbedPackDirForTest(distPack)
      models.seedEmbedModelForTest(null)
      const fromDist = models.checkEmbedModel({ kind: 'catalogue', row: models.embedDefaultModel(), pinned: false }, { home: join(SCRATCH, 'empty-home2') })
      check('a stripped install resolves the model that rides the artifact (no checkout cache, no home copy)', fromDist.state === 'present' && fromDist.path === distModels, JSON.stringify(fromDist))
    } finally {
      pack.seedEmbedPackDirForTest(null)
      pack.resetEmbedAddonForTest()
      if (moved) copyFileSync(stashed, repoCache)
    }
  } else {
    warn('no built dist on this host — the rides-the-artifact leg is skipped (bun run build.ts vendors it)')
  }

  const brokenDir = join(SCRATCH, 'broken-pack')
  mkdirSync(brokenDir, { recursive: true })
  writeFileSync(join(brokenDir, pack.EMBED_PACK_MANIFEST_FILE), JSON.stringify({ name: 'other-pack', version: '0.0.1', platform: 'other' }))
  pack.seedEmbedPackDirForTest(brokenDir)
  const broken = pack.resolveEmbedPackDir()
  check('an override that is not this pack names itself — no silent fallback', broken.state === 'unavailable' && broken.note.includes('no silent fallback'), broken.state === 'unavailable' ? broken.note : '')
  pack.seedEmbedPackDirForTest(null)

  const absentDir = join(SCRATCH, 'absent-pack')
  mkdirSync(absentDir, { recursive: true })
  writeFileSync(join(absentDir, pack.EMBED_PACK_MANIFEST_FILE), JSON.stringify({ name: 'other-pack', version: '0.0.1', platform: 'other' }))
  pack.seedEmbedPackDirForTest(absentDir)
  models.seedEmbedModelForTest(null)
  const words = models.memoryRecallModeWords({ home: join(SCRATCH, 'empty-home'), homeOnly: true })
  check('with no pack and no model the recall-mode words say word match only', words === models.WORD_MATCH_ONLY_WORDS, words)
  pack.seedEmbedPackDirForTest(null)
  pack.resetEmbedAddonForTest()
}

console.log('\n[B] the build seam')
{
  const buildCheck = spawnSync(BUN, ['run', 'scripts/vendor/build-embed.ts', '--check'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, BROWSER: '/usr/bin/true' } })
  if (cargo !== null) {
    check("the vendor build's --check certifies the pack on a cargo host", buildCheck.status === 0 && buildCheck.stdout.includes('OK'), `rc=${String(buildCheck.status)} ${buildCheck.stdout.trim().slice(0, 120)}`)
  } else {
    check("the vendor build's --check is honest about a missing pack without cargo", buildCheck.status === 0 || buildCheck.status === 2, `rc=${String(buildCheck.status)}`)
  }
  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
  check('the pack and the model weights stay out of the tree (.gitignore names them)', /vendor\/embed\//.test(gitignore) && /vendor\/embed-models\//.test(gitignore) && /native\/embed\/target\//.test(gitignore))
  const lockTracked = spawnSync('git', ['-C', ROOT, 'ls-files', '--error-unmatch', models.EMBED_MODELS_LOCK_PATH], { encoding: 'utf8' })
  const lockOnDisk = existsSync(join(ROOT, models.EMBED_MODELS_LOCK_PATH))
  check('the lock is on disk to be tracked; the weights never are', lockOnDisk && !spawnSync('git', ['-C', ROOT, 'ls-files', 'vendor/embed-models'], { encoding: 'utf8' }).stdout.trim().split('\n').some(f => f.endsWith('.gguf')) && (lockTracked.status !== 0 || lockTracked.stdout.trim() === models.EMBED_MODELS_LOCK_PATH))
}

finish(cargo !== null ? 'cargo host' : 'no cargo — the pack legs degraded honestly')
