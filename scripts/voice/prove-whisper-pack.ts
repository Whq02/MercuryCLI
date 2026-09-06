#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'whisper-pack-')))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_VOICE_BACKEND', 'MERCURY_VOICE_FIXTURE_WAV', 'MERCURY_VOICE_PACK_DIR', 'MERCURY_VOICE_DEBUG_WAV_DIR', 'MERCURY_WHISPER_PACK_DIR', 'MERCURY_WHISPER_MODEL', 'MERCURY_VOICE_TRANSCRIBER', 'MERCURY_HOME']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 400) : ''}`)
  if (!cond) failures++
}
const warn = (line: string): void => console.log(`  [WARN] ${line}`)
const finish = (note: string): never => {
  rmSync(SCRATCH, { recursive: true, force: true })
  console.log(failures > 0 ? `\nprove-whisper-pack: RED (${failures})` : `\nprove-whisper-pack: green${note ? ` (${note})` : ''}`)
  process.exit(failures > 0 ? 1 : 0)
}

const pack = await import('../../src/services/voice/whisperPack.js')
const models = await import('../../src/services/voice/whisperModels.js')
const voicePack = await import('../../src/services/voice/voicePack.js')
const transcribe = await import('../../src/services/voice/transcribe.js')
const wav = await import('../../src/services/voice/wav.js')
const capture = await import('../../src/services/voice/capture.js')

const PLATFORM = voicePack.voicePackPlatform()
const PACK_DIR = pack.whisperPackDirFor(ROOT, PLATFORM)
const CACHE_DIR = join(ROOT, 'vendor', 'whisper-models')
const BUN = process.execPath
const tool = (name: string): string | null => {
  const res = spawnSync(name, ['--version'], { encoding: 'utf8', env: process.env })
  return !res.error && res.status === 0 ? (res.stdout.trim().split('\n')[0] ?? '') : null
}
const cargo = tool('cargo')
const cmake = tool('cmake')
console.log(`cargo: ${cargo ?? 'absent'} · cmake: ${cmake ?? 'absent'} · platform ${PLATFORM}`)

console.log('\n[M] the model road — the lock, the three states, the pin, the download law')
{
  const lockRaw = JSON.parse(readFileSync(join(ROOT, models.WHISPER_MODELS_LOCK_PATH), 'utf8')) as unknown
  const catalogue = models.decodeWhisperModelsLock(lockRaw)
  check('the lock is well-formed: a licence, a source, a default that names a row, every row whole', catalogue.models.length >= 4 && catalogue.defaultName === 'base.en-q5_1' && catalogue.license === 'MIT' && catalogue.models.every(r => r.url.startsWith('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/') && r.url.endsWith(r.file) && /^[0-9a-f]{64}$/.test(r.sha256) && r.bytes > 1_000_000), catalogue.models.map(r => r.name).join(','))
  check('the compiled catalogue is the lock', models.WHISPER_DEFAULT_MODEL === catalogue.defaultName && models.WHISPER_MODELS.length === catalogue.models.length && models.WHISPER_MODELS.every((r, i) => r.sha256 === catalogue.models[i]?.sha256))
  check('the default is English-only and about 60 MB; a multilingual row exists for other speech', models.whisperDefaultModel().language === 'en' && models.mbWords(models.whisperDefaultModel().bytes) === '60 MB' && models.WHISPER_MODELS.some(r => r.language === 'multilingual'))
  let bad = ''
  try {
    models.decodeWhisperModelsLock({ ...(lockRaw as object), models: [{ name: 'x', file: 'ggml-x.bin', url: 'https://example.invalid/x', bytes: 1, sha256: 'nope', language: 'en', words: 'x' }] })
  } catch (error) {
    bad = error instanceof Error ? error.message : String(error)
  }
  check('a row with half a claim is refused, naming the row', bad.includes('not whole') && bad.includes('"x"'), bad)
  const home = join(SCRATCH, 'model-home')
  mkdirSync(home, { recursive: true })
  const row = models.whisperDefaultModel()
  let state = models.checkWhisperModel({ kind: 'catalogue', row, pinned: false }, { home })
  check('absent ⇒ the note names the download door, the file and the size', state.state === 'absent' && state.note === `pack present, model missing — /speak download fetches ${row.file} (60 MB)` && state.path === join(home, 'models', 'whisper', row.file), JSON.stringify(state))
  const dir = models.whisperModelsDir(home)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, row.file), Buffer.alloc(1234))
  state = models.checkWhisperModel({ kind: 'catalogue', row, pinned: false }, { home })
  check('a file of the wrong size ⇒ mismatch naming both byte counts and the door', state.state === 'mismatch' && state.note.includes('1234 bytes on disk') && state.note.includes(String(row.bytes)) && state.note.includes('/speak download'), JSON.stringify(state))
  const cached = join(CACHE_DIR, row.file)
  const tiny = models.whisperModelByName('tiny.en-q5_1')
  const cachedTiny = tiny ? join(CACHE_DIR, tiny.file) : ''
  const cacheHasDefault = existsSync(cached)
  if (cacheHasDefault) {
    rmSync(join(dir, row.file))
    try {
      symlinkSync(cached, join(dir, row.file))
    } catch {
      copyFileSync(cached, join(dir, row.file))
    }
    state = models.checkWhisperModel({ kind: 'catalogue', row, pinned: false }, { home })
    check('present ⇒ the name, the language, the byte count', state.state === 'present' && state.name === row.name && state.language === 'en' && state.bytes === row.bytes, JSON.stringify(state))
    state = models.checkWhisperModel({ kind: 'catalogue', row, pinned: false }, { home, digest: true })
    check('…and the digest agrees with the lock when asked', state.state === 'present', JSON.stringify(state))
  } else {
    warn(`${models.WHISPER_MODELS_VENDOR_PATH}/${row.file} is absent — the present leg is skipped (bun run scripts/vendor/fetch-whisper-models.ts fetches it)`)
  }
  process.env.MERCURY_WHISPER_MODEL = 'tiny.en-q5_1'
  let pin = models.resolveWhisperModelPin()
  check('the pin resolves a catalogue name', pin.kind === 'catalogue' && pin.row.name === 'tiny.en-q5_1' && pin.pinned)
  process.env.MERCURY_WHISPER_MODEL = 'ggml-base-q5_1.bin'
  pin = models.resolveWhisperModelPin()
  check('…or a catalogue file name', pin.kind === 'catalogue' && pin.row.name === 'base-q5_1')
  const own = join(SCRATCH, 'ggml-own-model.bin')
  writeFileSync(own, Buffer.alloc(4096, 1))
  process.env.MERCURY_WHISPER_MODEL = own
  pin = models.resolveWhisperModelPin()
  check('…or the path of a ggml file on disk (its stem is the name)', pin.kind === 'path' && pin.path === own && pin.name === 'own-model')
  process.env.MERCURY_WHISPER_MODEL = join(SCRATCH, 'missing.bin')
  pin = models.resolveWhisperModelPin()
  check('a path that is absent names itself', pin.kind === 'broken' && pin.note.includes('MERCURY_WHISPER_MODEL names') && pin.note.includes('the pin names itself, no silent fallback'))
  process.env.MERCURY_WHISPER_MODEL = 'bogus'
  pin = models.resolveWhisperModelPin()
  check('a name outside the catalogue names itself and the catalogue', pin.kind === 'broken' && pin.note.startsWith('MERCURY_WHISPER_MODEL=bogus is not a catalogue name (base.en-q5_1'), pin.kind === 'broken' ? pin.note : pin.kind)
  delete process.env.MERCURY_WHISPER_MODEL
  check('unset ⇒ the default, unpinned', models.resolveWhisperModelPin().kind === 'catalogue' && !(models.resolveWhisperModelPin() as { pinned: boolean }).pinned)
  const fake = (bytes: Buffer | null, status = 200): typeof fetch =>
    (async () => new Response(bytes === null ? null : new Blob([new Uint8Array(bytes)]), { status })) as unknown as typeof fetch
  const target = join(SCRATCH, 'downloads')
  const small: import('../../src/services/voice/whisperModels.js').WhisperModelRow = { name: 'fixture', file: 'ggml-fixture.bin', url: 'https://127.0.0.1:9/ggml-fixture.bin', bytes: 4096, sha256: '', language: 'en', words: 'a fixture' }
  const good = Buffer.alloc(4096, 7)
  small.sha256 = (await import('node:crypto')).createHash('sha256').update(good).digest('hex')
  let refusal = ''
  try {
    await models.downloadWhisperModel(small, target, { fetchImpl: fake(Buffer.alloc(4096, 8)) })
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error)
  }
  check('a body that does not match the lock digest is refused, and nothing is left behind', refusal.includes('does not match the lock digest') && !existsSync(join(target, small.file)) && !existsSync(join(target, `${small.file}.part`)), `${refusal} · ${existsSync(target) ? readdirSync(target).join(',') : 'no dir'}`)
  refusal = ''
  try {
    await models.downloadWhisperModel(small, target, { fetchImpl: fake(good.subarray(0, 100)) })
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error)
  }
  check('a short body is refused naming the counts, nothing left behind', refusal.includes('ended at 100 of 4096 bytes') && !existsSync(join(target, small.file)) && !existsSync(join(target, `${small.file}.part`)), refusal)
  refusal = ''
  try {
    await models.downloadWhisperModel(small, target, { fetchImpl: fake(null, 503) })
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error)
  }
  check('an HTTP refusal is named', refusal.includes('HTTP 503'), refusal)
  let calls = 0
  const counting: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++
    return fake(good)(input, init)
  }) as typeof fetch
  const got = await models.downloadWhisperModel(small, target, { fetchImpl: counting })
  check('the right bytes land under their name, verified, through a .part file that is gone after', got.bytes === 4096 && got.sha256 === small.sha256 && !got.reused && existsSync(join(target, small.file)) && !existsSync(join(target, `${small.file}.part`)) && calls === 1, JSON.stringify(got))
  const again = await models.downloadWhisperModel(small, target, { fetchImpl: counting })
  check('a whole file already there is reused without a request', again.reused && calls === 1)
  const offline = spawnSync(BUN, ['run', 'scripts/vendor/fetch-whisper-models.ts', '--check'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, https_proxy: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' }, timeout: 120_000 })
  const offlineOut = `${offline.stdout ?? ''}${offline.stderr ?? ''}`
  check('the vendor fetch --check is offline: no download line, exit 0 (cache valid) or 2 (absent, the remedy named)', !offlineOut.includes('downloading') && ((offline.status === 0 && offlineOut.includes('--check: OK')) || (offline.status === 2 && offlineOut.includes('remedy: bun run scripts/vendor/fetch-whisper-models.ts'))), `${String(offline.status)}: ${offlineOut.slice(0, 300)}`)
  if (offline.status === 2) warn('the provers\' model cache is absent on this host — the decode legs below are skipped')
  void cachedTiny
}

console.log('\n[1] the vendor build')
const build = spawnSync(BUN, ['run', 'scripts/vendor/build-whisper.ts'], { cwd: ROOT, encoding: 'utf8', env: process.env, timeout: 540_000, maxBuffer: 64 * 1024 * 1024 })
const buildOut = `${build.stdout ?? ''}\n${build.stderr ?? ''}`

if (cargo === null || cmake === null) {
  const missing = cargo === null ? 'rustup' : 'cmake'
  check(`no ${cargo === null ? 'cargo' : 'cmake'} ⇒ the build skips LOUDLY: exit 0, the remedy (${missing}) and the degraded arm named`, build.status === 0 && /SKIPPED/.test(buildOut) && buildOut.includes(missing) && buildOut.includes('degraded: on-device-transcriber'), buildOut.slice(-400))
  const resolved = pack.resolveWhisperPackDir()
  if (resolved.state === 'ok') {
    warn(`a pack is present at ${resolved.dir} from an earlier build — the absence legs are skipped`)
  } else {
    check('no pack ⇒ the pack owner answers unavailable, naming the platform', resolved.note.includes(PLATFORM), resolved.note)
    const local = transcribe.localTranscriberRead()
    check('…and the transcriber\'s on-device read says absent with the remedy that fits a checkout', local.state === 'absent' && local.reason === 'pack' && local.note === pack.whisperPackAbsentNote() && local.note.includes('build-whisper.ts') && local.short === 'no on-device pack (bun run setup)', JSON.stringify(local))
    check('a release install\'s words never name the checkout\'s build', pack.whisperPackAbsentNote(null) === 'absent — this build shipped without it')
  }
  finish(`no ${cargo === null ? 'cargo' : 'cmake'} — the loud skip`)
}

if (build.status !== 0) {
  check('cargo and cmake build the addon on this host', false, buildOut.slice(-600))
  finish('')
}
check('the vendor build ends green (a valid pack is installed or already valid)', /DONE|already valid/.test(buildOut), buildOut.slice(-300))

console.log('\n[2] the pack on disk')
const checkRun = spawnSync(BUN, ['run', 'scripts/vendor/build-whisper.ts', '--check'], { cwd: ROOT, encoding: 'utf8', env: process.env, timeout: 120_000 })
check('--check certifies the pack without cargo (exit 0, OK, the engine named)', checkRun.status === 0 && /--check: OK/.test(checkRun.stdout ?? '') && /whisper\.cpp \d/.test(checkRun.stdout ?? ''), `${checkRun.status}: ${(checkRun.stdout ?? '') + (checkRun.stderr ?? '')}`.slice(0, 300))
const manifest = pack.readWhisperPackManifest(PACK_DIR)
check('the manifest is whole: name · version · platform · addon sha256 · source-tree digest · engine · CPU floor · GPU road · tree digest', manifest !== null && manifest.name === pack.WHISPER_PACK_NAME && manifest.platform === PLATFORM && manifest.addon === pack.WHISPER_ADDON_FILE && manifest.engine.name === 'whisper.cpp' && /^\d+\.\d+\.\d+$/.test(manifest.engine.version) && manifest.cpuFloor === pack.whisperCpuFloorWords() && manifest.gpu === pack.whisperGpuFor(process.platform, process.arch) && manifest.crates.length > 0, JSON.stringify(manifest)?.slice(0, 300))
const onDisk = pack.checkWhisperPackDir(PACK_DIR, { digest: true })
check('the addon bytes match the manifest digest', onDisk.state === 'ok', onDisk.state === 'ok' ? '' : onDisk.note)
check('the manifest records the Rust sources the addon was built from', manifest !== null && manifest.sourceTreeDigest === pack.whisperSourceTreeDigest(join(ROOT, 'native', 'whisper')))
const licenses = existsSync(join(PACK_DIR, 'licenses')) ? readdirSync(join(PACK_DIR, 'licenses')) : []
check('the licence records ride beside the addon: whisper-rs, whisper-rs-sys, napi and whisper.cpp itself', licenses.some(l => l.startsWith('whisper-rs-0')) && licenses.some(l => l.startsWith('whisper-rs-sys-')) && licenses.some(l => l.startsWith('napi-')) && manifest !== null && existsSync(join(PACK_DIR, 'licenses', `whisper.cpp-${manifest.engine.version}`, 'LICENSE')), licenses.join(','))
check('whisper.cpp\'s LICENSE is the MIT text of the ggml authors', manifest !== null && /MIT License/.test(readFileSync(join(PACK_DIR, 'licenses', `whisper.cpp-${manifest.engine.version}`, 'LICENSE'), 'utf8')) && /ggml authors/.test(readFileSync(join(PACK_DIR, 'licenses', `whisper.cpp-${manifest.engine.version}`, 'LICENSE'), 'utf8')))
const notices = existsSync(join(PACK_DIR, 'NOTICES.json')) ? (JSON.parse(readFileSync(join(PACK_DIR, 'NOTICES.json'), 'utf8')) as { crates?: Array<{ name: string; license: string }>; engine?: { name: string; version: string; license: string } }) : null
check('NOTICES.json inventories every crate with its licence and the engine', notices !== null && (notices.crates ?? []).length === (manifest?.crates.length ?? -1) && (notices.crates ?? []).some(c => c.name === 'whisper-rs' && /Unlicense/.test(c.license)) && notices.engine?.name === 'whisper.cpp' && notices.engine.license === 'MIT', JSON.stringify(notices?.engine))
check('a pack of another platform reads as a mismatch, never ok', pack.checkWhisperPackDir(PACK_DIR, { platform: 'fixture-os-fixture-arch' }).state === 'mismatch')

console.log('\n[3] the addon loads and answers')
const load = pack.loadWhisperAddon()
check('the pack owner resolves the checkout pack and loads the addon', load.state === 'ok' && load.source === 'workspace', load.state === 'ok' ? load.dir : load.note)
if (load.state === 'ok') {
  check('packVersion() is the manifest version', load.addon.packVersion() === load.manifest.version, `${load.addon.packVersion()} vs ${load.manifest.version}`)
  check('engineVersion() is the manifest\'s whisper.cpp version', load.addon.engineVersion() === load.manifest.engine.version, `${load.addon.engineVersion()} vs ${load.manifest.engine.version}`)
  const info = load.addon.systemInfo()
  check('systemInfo() answers ggml\'s feature line', typeof info === 'string' && /CPU|NEON|AVX/.test(info), info.slice(0, 120))
  const floor = load.addon.cpuFloor()
  const probe = pack.probeCpuFloor()
  check('cpuFloor() answers the floor and whether this CPU has it; the JS probe agrees or says unknown', typeof floor.floor === 'string' && Array.isArray(floor.missing) && (probe.state === 'unknown' || (probe.state === 'met') === floor.met), `${JSON.stringify(floor)} · ${JSON.stringify(probe)}`)
  console.log(`  · engine ${load.addon.engineVersion()} · floor ${floor.floor} (${floor.met ? 'met' : 'unmet'}) · probe ${probe.state} · ${info.trim()}`)
  const local = transcribe.localTranscriberRead()
  check('with the pack present and no model in the home, the on-device read names the download door', local.state === 'absent' && local.reason === 'model' && local.short === 'no on-device model (/speak download)' && local.download?.name === models.WHISPER_DEFAULT_MODEL, JSON.stringify(local))
  const door = models.whisperDownloadDoor()
  check('the download door names the size, the model, the licence, the directory and the verb', door.startsWith('on-device transcription needs a one-time 60 MB download — Whisper base.en') && door.includes('(MIT)') && door.includes(models.whisperModelsDir()) && door.includes('/speak download starts it') && door.endsWith('until then the cloud road serves'), door)

  const empty = join(SCRATCH, 'no-pack')
  mkdirSync(empty, { recursive: true })
  process.env.MERCURY_WHISPER_PACK_DIR = empty
  pack.resetWhisperAddonForTest()
  const pinned = pack.resolveWhisperPackDir()
  check('a pack pin at an empty directory names itself, no silent fallback', pinned.state === 'unavailable' && pinned.note.startsWith('MERCURY_WHISPER_PACK_DIR set but') && pinned.note.endsWith('the pin names itself, no silent fallback'), pinned.state === 'unavailable' ? pinned.note : 'ok')
  const pinnedRead = transcribe.localTranscriberRead()
  check('…and the on-device read says so in one row', pinnedRead.state === 'absent' && pinnedRead.reason === 'pin' && pinnedRead.short === 'on-device pack pin broken (see /speak)', JSON.stringify(pinnedRead))
  delete process.env.MERCURY_WHISPER_PACK_DIR
  pack.resetWhisperAddonForTest()

  console.log('\n[4] a decode — a tone answers a string, the speech fixture answers its words')
  const tiny = models.whisperModelByName('tiny.en-q5_1')
  const cachedTiny = tiny ? join(CACHE_DIR, tiny.file) : ''
  if (tiny && existsSync(cachedTiny)) {
    const modelsDir = models.whisperModelsDir(HOME)
    mkdirSync(modelsDir, { recursive: true })
    try {
      symlinkSync(cachedTiny, join(modelsDir, tiny.file))
    } catch {
      copyFileSync(cachedTiny, join(modelsDir, tiny.file))
    }
    process.env.MERCURY_WHISPER_MODEL = tiny.name
    const ready = transcribe.localTranscriberRead()
    check('with the model in the home the on-device read is ok, naming the model and the pack', ready.state === 'ok' && ready.model === tiny.name && ready.label === `on-device transcriber (${tiny.name})` && ready.pack.engine.startsWith('whisper.cpp ') && ready.pack.where === 'the checkout', JSON.stringify(ready))
    const choice = { kind: 'local' as const, label: `on-device transcriber (${tiny.name})`, model: tiny.name }
    const t0 = Date.now()
    const tone = await transcribe.transcribeWav(wav.synthesizeToneWav({ seconds: 1, hz: 440 }), { choice })
    check('a synthesized tone through the addon answers a string (content never pinned), the on-device kind, the model, its own wall time', typeof tone.text === 'string' && tone.kind === 'local' && tone.family === null && tone.model === tiny.name && typeof tone.ms === 'number', JSON.stringify(tone))
    console.log(`  · tone ⇒ ${JSON.stringify(tone.text)} in ${tone.ms} ms (${Date.now() - t0} ms round trip)`)
    const fixture = readFileSync(join(import.meta.dir, 'fixtures', 'on-device-take.wav'))
    const speech = await transcribe.transcribeWav(fixture, { choice })
    const words = speech.text.toLowerCase()
    check('the synthesized speech fixture answers its words, loosely (lighthouse · seven · ships)', ['lighthouse', 'seven', 'ships'].filter(w => words.includes(w)).length >= 2, speech.text)
    console.log(`  · fixture ⇒ ${JSON.stringify(speech.text)} in ${speech.ms} ms`)
    let bound = ''
    try {
      await transcribe.transcribeWav(fixture, { choice, deadlineMs: 1 })
    } catch (error) {
      bound = error instanceof Error ? error.message : String(error)
    }
    check('the decode rides its own bound and names it', bound.includes('did not answer within') && bound.includes(tiny.name), bound)
    await new Promise(r => setTimeout(r, 1500))
    let shape = ''
    try {
      await transcribe.transcribeWav(wav.encodeWav(new Int16Array(8000), { sampleRate: 8000 }), { choice })
    } catch (error) {
      shape = error instanceof Error ? error.message : String(error)
    }
    check('a take of another shape is refused naming both shapes', shape.includes('8000 Hz') && shape.includes('16000 Hz'), shape)
    transcribe.resetLocalTranscriberForTest()
    delete process.env.MERCURY_WHISPER_MODEL
  } else {
    warn(`${models.WHISPER_MODELS_VENDOR_PATH}/${tiny?.file ?? 'ggml-tiny.en-q5_1.bin'} is absent — the decode legs are skipped (bun run scripts/vendor/fetch-whisper-models.ts fetches it)`)
  }

  console.log('\n[5] the addon loads on the vendored Node and a PATH Node alike (Node-API is ABI-stable)')
  const loader = [
    'const a = require(process.argv[1])',
    `const fns = ${JSON.stringify(pack.WHISPER_ADDON_EXPORTS)}`,
    "const missing = fns.filter(f => typeof a[f] !== 'function')",
    "if (missing.length > 0) { console.log('MISSING ' + missing.join(',')); process.exit(3) }",
    "console.log('LOADED ' + process.version + ' pack ' + a.packVersion() + ' engine ' + a.engineVersion())",
  ].join('; ')
  const addonPath = join(load.dir, load.manifest.addon)
  const vendoredNode = (): string | null => {
    for (const rel of [join('bin', 'node'), 'node.exe', 'node']) {
      const candidate = join(ROOT, 'vendor', 'node', 'extracted', PLATFORM, rel)
      if (existsSync(candidate)) return candidate
    }
    return null
  }
  const hosts: Array<[string, string | null]> = [
    ['a PATH node', capture.findOnPath('node')],
    ['the vendored node', vendoredNode()],
  ]
  for (const [label, exe] of hosts) {
    if (exe === null) {
      warn(`${label} is absent on this host — that load leg is skipped`)
      continue
    }
    const res = spawnSync(exe, ['-e', loader, addonPath], { encoding: 'utf8', env: process.env, timeout: 60_000 })
    const line = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim().split('\n').slice(-1)[0] ?? ''
    check(`${label} loads the addon and answers its whole surface`, res.status === 0 && /^LOADED v\d+/.test(line), `${exe}: ${String(res.status)} ${line}`)
    console.log(`  · ${label}: ${line}`)
  }
}

finish('')
