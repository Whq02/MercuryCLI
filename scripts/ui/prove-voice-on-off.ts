import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'voice-on-off-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
delete process.env.NODE_ENV
for (const key of ['MERCURY_HOME', 'MERCURY_WHISPER_PACK_DIR', 'MERCURY_WHISPER_MODEL', 'MERCURY_VOICE_DEBUG_WAV_DIR', 'MERCURY_VOICE_BOUND_MS']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const models = await import('../../src/services/voice/whisperModels.js')
const pack = await import('../../src/services/voice/whisperPack.js')
const transcribe = await import('../../src/services/voice/transcribe.js')
const session = await import('../../src/services/voice/voiceSession.js')
const pending = await import('../../src/input-core/pending-input.js')
const { call } = await import('../../src/commands/voice/voice.js')
const model = models.whisperDefaultModel()
const modelPath = join(ROOT, 'vendor/whisper-models', model.file)
const addonState = pack.loadWhisperAddon().state
if (!existsSync(modelPath) || addonState !== 'ok') {
  console.log(`  [SKIP] prove-voice-on-off drives the real on-device pack with the vendored model: ${existsSync(modelPath) ? `the pack does not load here (${addonState})` : `${modelPath} is absent`} — a host without the Whisper pack (the hosted gate builds none) cannot read this proof; the Mac pool and the release road do`)
  process.exit(0)
}
const bytes = readFileSync(modelPath)
assert.equal(addonState, 'ok', 'the real on-device pack must load')
const originalFetch = globalThis.fetch
const requests: string[] = []
const words: string[] = []
let body = bytes
let status = 200
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input)
  requests.push(url)
  assert.equal(url, model.url, 'only the pinned model download may use the network')
  return new Response(new Uint8Array(body), { status })
}) as typeof fetch
const command = async (arg: string): Promise<string> => {
  const out = await call(arg, {} as never)
  assert.equal(out.type, 'text')
  const text = out.type === 'text' ? out.value : ''
  words.push(text)
  return text
}
const persisted = (): boolean => {
  const code = `globalThis.MACRO = { VERSION: '1.0.0' }; const c = await import(${JSON.stringify(join(ROOT, 'src/utils/config.js'))}); c.enableConfigs(); console.log('VOICE_STATE=' + String(c.getGlobalConfig().voiceInputEnabled === true))`
  const child = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, env: process.env, encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  return child.stdout.includes('VOICE_STATE=true')
}
const idle = async (): Promise<void> => {
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('voice did not settle')) }, 90_000)
    const unsubscribe = session.subscribeVoice(() => {
      if (session.voiceSnapshot().phase === 'idle') { clearTimeout(timer); unsubscribe(); done() }
    })
    if (session.voiceSnapshot().phase === 'idle') { clearTimeout(timer); unsubscribe(); done() }
  })
}
try {
  pending.initOnce({ text: 'draft', mode: 'prompt', pastedContents: {} })
  assert.match(await command(''), /voice input is off.*\/voice on/)
  assert.equal(session.voiceInputEnabled(), false)
  const on = await command('on')
  assert.equal(requests.length, 1, '/voice on downloads the missing model once')
  assert.match(on, /60 MB/)
  assert.match(on, /voice input ON/)
  assert.equal(models.checkWhisperModel(undefined, { digest: true }).state, 'present')
  assert.equal(persisted(), true, 'on survives a fresh process')
  assert.match(await command('on'), /already on/)
  assert.equal(requests.length, 1, 'on is idempotent with a verified model')
  process.env.MERCURY_VOICE_BACKEND = 'fixture'
  process.env.MERCURY_VOICE_FIXTURE_WAV = join(ROOT, 'scripts/voice/fixtures/on-device-take.wav')
  assert.match(await command(''), /recording/)
  assert.equal(session.voiceSnapshot().phase, 'recording')
  assert.match(await command(''), /transcribing/)
  await idle()
  assert.match(pending.text(), /^draft .*seven ships/i)
  words.push(session.voiceSnapshot().receipt?.text ?? '')
  assert.match(words.at(-1)!, /transcribed on this machine/)
  assert.equal(requests.length, 1, 'the take never uses a network request')
  const ready = session.describeVoiceReadiness()
  assert.equal(ready.ready, true)
  words.push(ready.line, ready.detail, session.describeVoiceStatus())
  assert.match(await command('off'), /voice input OFF/)
  assert.equal(persisted(), false, 'off survives a fresh process')
  assert.match(await command(''), /voice input is off.*\/voice on/)
  assert.equal(session.voiceSnapshot().phase, 'idle')
  for (const arg of ['options', 'download', 'stop', 'loud']) assert.match(await command(arg), /\/voice takes on, off or capture/)
  transcribe.unloadLocalModels()
  rmSync(models.whisperModelsDir(), { recursive: true, force: true })
  body = Buffer.alloc(model.bytes, 7)
  const damaged = await command('on')
  assert.match(damaged, /download failed.*digest/)
  assert.equal(session.voiceInputEnabled(), false)
  assert.equal(existsSync(join(models.whisperModelsDir(), model.file)), false)
  assert.equal(existsSync(join(models.whisperModelsDir(), `${model.file}.part`)), false)
  status = 503
  assert.match(await command('on'), /download failed.*503/)
  assert.equal(session.voiceInputEnabled(), false)
  status = 200
  body = bytes
  assert.match(await command('on'), /voice input ON/)
  await command('off')
  const callsBeforeAbsent = requests.length
  const isolated = join(scratch, 'without-pack')
  mkdirSync(isolated, { recursive: true })
  symlinkSync(join(ROOT, 'node_modules'), join(isolated, 'node_modules'), 'dir')
  const built = await Bun.build({
    entrypoints: [join(ROOT, 'src/commands/voice/voice.ts')], target: 'node', format: 'esm', external: ['jsonc-parser'], outdir: isolated, naming: 'voice.mjs',
    plugins: [{ name: 'source-alias', setup(build) {
      build.onResolve({ filter: /^src\// }, args => {
        const base = join(ROOT, args.path).replace(/\.js$/, '')
        const found = [base, ...['.ts', '.tsx', '.js', '/index.ts', '/index.tsx'].map(ext => base + ext)].find(path => existsSync(path) && statSync(path).isFile())
        return found ? { path: found } : undefined
      })
    } }],
  })
  assert.equal(built.success, true, built.logs.map(String).join('\n'))
  writeFileSync(join(isolated, 'manifest.json'), JSON.stringify({ onDeviceTranscriber: { vendored: false, remedy: 'install the complete archive for this platform' } }))
  const code = `globalThis.MACRO = { VERSION: '1.0.0' }; const { call } = await import(${JSON.stringify(join(isolated, 'voice.mjs'))}); console.log(JSON.stringify(await call('on', {})))`
  const absent = spawnSync('node', ['--input-type=module', '-e', code], { cwd: isolated, env: process.env, encoding: 'utf8' })
  assert.equal(absent.status, 0, absent.stderr)
  words.push(absent.stdout)
  assert.match(absent.stdout, /\/voice on: this build carries no on-device transcriber for/)
  assert.match(absent.stdout, /install the complete archive for this platform/)
  assert.equal(persisted(), false)
  assert.equal(requests.length, callsBeforeAbsent)
  const fake = join(scratch, 'cannot-load')
  mkdirSync(fake, { recursive: true })
  const resolution = pack.resolveWhisperPackDir()
  assert.equal(resolution.state, 'ok')
  if (resolution.state !== 'ok') throw new Error(resolution.note)
  copyFileSync(join(resolution.dir, pack.WHISPER_PACK_MANIFEST_FILE), join(fake, pack.WHISPER_PACK_MANIFEST_FILE))
  writeFileSync(join(fake, resolution.manifest.addon), 'not a native library')
  process.env.MERCURY_WHISPER_PACK_DIR = fake
  pack.resetWhisperAddonForTest()
  assert.match(await command('on'), /failed to load|could not load/)
  assert.equal(session.voiceInputEnabled(), false)
  const unavailable = session.describeVoiceReadiness()
  words.push(unavailable.line, unavailable.detail)
  assert.equal(unavailable.ready, false)
  assert.equal(requests.length, callsBeforeAbsent)
  delete process.env.MERCURY_WHISPER_PACK_DIR
  pack.resetWhisperAddonForTest()
  transcribe.unloadLocalModels()
  rmSync(models.whisperModelsDir(), { recursive: true, force: true })
  let releaseDownload!: () => void
  const waitForDownload = new Promise<void>(done => { releaseDownload = done })
  const fixtureFetch = globalThis.fetch
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    await waitForDownload
    return fixtureFetch(...args)
  }) as typeof fetch
  const starting = command('on')
  await command('off')
  releaseDownload()
  assert.match(await starting, /remains OFF/)
  assert.equal(persisted(), false, 'off during setup must not be undone by the completed download')
  assert.doesNotMatch(words.join('\n'), /API key|\/logins|openai|gemini/i, 'voice words have no cloud door')
  console.log('prove-voice-on-off: green — first on, verified fixture download, real decode, restart persistence, off, absent pack, load failure, download failures, no cloud words')
} finally {
  globalThis.fetch = originalFetch
  transcribe.unloadLocalModels()
  session.resetVoiceForTest()
  rmSync(scratch, { recursive: true, force: true })
}
