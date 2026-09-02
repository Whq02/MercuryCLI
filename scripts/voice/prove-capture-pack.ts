#!/usr/bin/env bun
// ============================================================================
//  scripts/voice/prove-capture-pack.ts — the vendored voice capture pack.
//
//  With cargo on this host: the vendor build (scripts/vendor/build-voice.ts)
//  produces vendor/voice/<platform>/ — the addon, every crate's licence
//  record, the inventory, the manifest (addon sha256 + the source-tree
//  digest); `--check` certifies it without cargo; the addon LOADS through
//  the pack owner and answers its surface; and a one-second take on the
//  default input yields a capture-shaped WAV (16 kHz · mono · 16-bit — the
//  SHAPE is pinned, never the content: the device may be silent). A host
//  with no input device answers the honest refusal instead, and that leg
//  is pinned by its words.
//
//  Without cargo: the build SKIPS LOUDLY (exit 0, the remedy named), the
//  pack owner answers unavailable, the doctor row says none. A cargo that
//  fails to BUILD the addon (Linux without the ALSA headers) is the same
//  honest absence, warned — never a silent pass, never a red for a missing
//  system header on a hosted runner.
//
//  Run: ~/.bun/bin/bun run scripts/voice/prove-capture-pack.ts
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'voice-pack-')))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_VOICE_BACKEND', 'MERCURY_VOICE_FIXTURE_WAV', 'MERCURY_VOICE_PACK_DIR', 'MERCURY_VOICE_DEBUG_WAV_DIR']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 400) : ''}`)
  if (!cond) failures++
}
const warn = (line: string): void => console.log(`  [WARN] ${line}`)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const pack = await import('../../src/services/voice/voicePack.js')
const capture = await import('../../src/services/voice/capture.js')
const wav = await import('../../src/services/voice/wav.js')

const PLATFORM = pack.voicePackPlatform()
const PACK_DIR = join(ROOT, ...pack.VOICE_PACK_PATH.split('/'), PLATFORM)
const BUN = process.execPath

// env passed explicitly: bun's spawnSync resolves executables against the
// process-start PATH otherwise (the cargo shim lives in ~/.cargo/bin).
const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8', env: process.env })
const hasCargo = !cargo.error && cargo.status === 0
console.log(`cargo: ${hasCargo ? cargo.stdout.trim() : 'absent'} · platform ${PLATFORM}`)

console.log('\n[1] the vendor build')
const build = spawnSync(BUN, ['run', 'scripts/vendor/build-voice.ts'], { cwd: ROOT, encoding: 'utf8', env: process.env, timeout: 540_000, maxBuffer: 64 * 1024 * 1024 })
const buildOut = `${build.stdout ?? ''}\n${build.stderr ?? ''}`

async function doctorRowSaysNone(): Promise<boolean> {
  const report = await import('../../src/utils/healthReport.js')
  const cert = await report.runHealthReport({ depth: 'fast' })
  const row = cert.sections.flatMap(s => s.checks).find(c => c.id === 'iface-voice')
  return row !== undefined && String(row.evidence).includes('backend: none')
}

if (!hasCargo) {
  check('no cargo ⇒ the build skips LOUDLY: exit 0 and the remedy named', build.status === 0 && /SKIPPED/.test(buildOut) && /rustup/.test(buildOut), buildOut.slice(-400))
  check('no pack ⇒ the pack owner answers unavailable, naming the platform', pack.resolveVoicePackDir().state === 'unavailable' && (pack.resolveVoicePackDir() as { note: string }).note.includes(PLATFORM))
  process.env.PATH = join(SCRATCH, 'empty-bin')
  check('…and the doctor row says none', await doctorRowSaysNone())
  rmSync(SCRATCH, { recursive: true, force: true })
  console.log(failures > 0 ? `\nprove-capture-pack: RED (${failures})` : '\nprove-capture-pack: green (no cargo — the loud skip)')
  process.exit(failures > 0 ? 1 : 0)
}

if (build.status !== 0) {
  const headerFailure = process.platform === 'linux' && /alsa|libasound/i.test(buildOut)
  if (headerFailure) {
    warn('cargo could not build the addon on this Linux host (no ALSA headers) — the honest absence leg')
    check('the failure names the remedy (libasound2-dev) and the degraded arm', /libasound2-dev/.test(buildOut) && /degraded: voice-input/.test(buildOut), buildOut.slice(-400))
    check('no pack is installed after a failed build', !existsSync(join(PACK_DIR, pack.VOICE_PACK_MANIFEST_FILE)) || pack.checkVoicePackDir(PACK_DIR).state !== 'ok')
    check('…and the doctor row says none', await doctorRowSaysNone())
    rmSync(SCRATCH, { recursive: true, force: true })
    console.log(failures > 0 ? `\nprove-capture-pack: RED (${failures})` : '\nprove-capture-pack: green (cargo present, the audio headers absent — named)')
    process.exit(failures > 0 ? 1 : 0)
  }
  check('cargo builds the addon on this host', false, buildOut.slice(-600))
  rmSync(SCRATCH, { recursive: true, force: true })
  console.log(`\nprove-capture-pack: RED (${failures})`)
  process.exit(1)
}
check('the vendor build ends green (a valid pack is installed or already valid)', /DONE|already valid/.test(buildOut), buildOut.slice(-300))

console.log('\n[2] the pack on disk')
const checkRun = spawnSync(BUN, ['run', 'scripts/vendor/build-voice.ts', '--check'], { cwd: ROOT, encoding: 'utf8', env: process.env, timeout: 120_000 })
check('--check certifies the pack without cargo (exit 0, OK)', checkRun.status === 0 && /--check: OK/.test(checkRun.stdout ?? ''), `${checkRun.status}: ${(checkRun.stdout ?? '') + (checkRun.stderr ?? '')}`.slice(0, 300))
const manifest = pack.readVoicePackManifest(PACK_DIR)
check('the manifest is whole: name · version · platform · addon sha256 · source-tree digest · tree digest', manifest !== null && manifest.name === pack.VOICE_PACK_NAME && manifest.platform === PLATFORM && manifest.addon === pack.VOICE_ADDON_FILE && manifest.crates.length > 0, JSON.stringify(manifest))
const onDisk = pack.checkVoicePackDir(PACK_DIR, { digest: true })
check('the addon bytes match the manifest digest', onDisk.state === 'ok', onDisk.state === 'ok' ? '' : onDisk.note)
check('the manifest records the Rust sources the addon was built from', manifest !== null && manifest.sourceTreeDigest === pack.voiceSourceTreeDigest(join(ROOT, ...pack.VOICE_NATIVE_PATH.split('/'))))
const licenses = existsSync(join(PACK_DIR, 'licenses')) ? readdirSync(join(PACK_DIR, 'licenses')) : []
check('the licence records ride beside the addon: cpal and napi among them', licenses.some(l => l.startsWith('cpal-')) && licenses.some(l => l.startsWith('napi-')), licenses.join(','))
const notices = existsSync(join(PACK_DIR, 'NOTICES.json')) ? (JSON.parse(readFileSync(join(PACK_DIR, 'NOTICES.json'), 'utf8')) as { crates?: Array<{ name: string; license: string }> }) : null
check('NOTICES.json inventories every crate with its licence', notices !== null && (notices.crates ?? []).length === (manifest?.crates.length ?? -1) && (notices.crates ?? []).some(c => c.name === 'cpal' && /MIT|Apache/.test(c.license)), JSON.stringify(notices?.crates?.slice(0, 3)))
check('a stale pack (other sources) reads as a mismatch, never ok', pack.checkVoicePackDir(PACK_DIR, { platform: 'fixture-os-fixture-arch' }).state === 'mismatch')

console.log('\n[3] the addon loads and answers')
const load = pack.loadVoiceAddon()
check('the pack owner resolves the checkout pack and loads the addon', load.state === 'ok' && load.source === 'workspace', load.state === 'ok' ? load.dir : load.note)
if (load.state === 'ok') {
  check('packVersion() is the manifest version', load.addon.packVersion() === load.manifest.version, `${load.addon.packVersion()} vs ${load.manifest.version}`)
  const devices = load.addon.listInputDevices()
  const fallback = load.addon.defaultInputDevice()
  check('listInputDevices() answers a list; defaultInputDevice() a name or null', Array.isArray(devices) && (fallback === null || typeof fallback === 'string'), `${devices.length} devices, default ${String(fallback)}`)
  const described = capture.describeVendoredPack()
  check('the capture owner describes the pack for the doctor', described.state === 'ok' && described.platform === PLATFORM, described.state === 'ok' ? described.dir : described.note)
  const resolved = capture.resolveCaptureBackend()
  check('the ladder resolves the vendored pack first', resolved.state === 'ok' && resolved.kind === 'vendored', resolved.state === 'ok' ? resolved.detail : resolved.note)

  console.log('\n[4] a one-second take')
  try {
    const handle = await capture.startCapture({ backend: resolved })
    await sleep(1000)
    const take = await handle.stop()
    const read = wav.readWav(take.wav)
    check('the take is a WAV of the capture shape (16 kHz · mono · 16-bit)', read.ok && wav.isVoiceWavShape(read.header), read.ok ? JSON.stringify(read.header) : read.reason)
    check('the take carries about a second of samples (the device rate resampled)', take.durationMs >= 500 && take.durationMs <= 2500, `${take.durationMs}ms`)
    console.log(`  · ${take.durationMs}ms on ${fallback ?? 'the default input'}, ${take.silent ? 'silent' : 'not silent'} (content is never pinned)`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warn(`no take on this host: ${message}`)
    check('a host that cannot open an input answers the honest refusal with the permission words', message.includes('microphone') || message.includes('input device'), message)
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
if (failures > 0) {
  console.log(`\nprove-capture-pack: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-capture-pack: green')
process.exit(0)
