import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { bundledVendorPacks, checkBundledVendorPacks } from '../release/payloadContract.mjs'
import { RELEASE_TARGETS, buildPlatformOf } from '../../src/services/privateChannel/releaseTarget.ts'
import { voiceCargoTriple, voicePackPlatform } from '../../src/services/voice/voicePack.ts'

const root = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'whisper-archives-'))
const digest = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')
const write = (file: string, bytes: string): void => { mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, bytes) }
try {
  for (const target of RELEASE_TARGETS) {
    const payload = join(scratch, target)
    mkdirSync(payload)
    write(join(payload, 'manifest.json'), JSON.stringify({ degraded: [], onDeviceTranscriber: { vendored: false } }))
    for (const pack of bundledVendorPacks(target)) {
      for (const file of pack.files) write(join(payload, pack.dir, file), 'fixture')
      write(join(payload, pack.dir, '.vendor-manifest.json'), JSON.stringify({ platform: pack.platform, version: pack.version, binary: pack.binary, binarySha256: digest('fixture') }))
    }
    assert.equal(checkBundledVendorPacks(payload, target).ok, false, `${target}: an archive without Whisper must fail`)
    const ship = buildPlatformOf(target)
    const platform = voicePackPlatform(ship.platform, ship.arch)
    const path = `vendor/whisper/${platform}`
    const addon = join(payload, path, 'mercury_whisper.node')
    const record = { name: 'mercury-whisper', platform, version: '0.1.0', addon: 'mercury_whisper.node', addonSha256: digest('fixture'), engine: { name: 'whisper.cpp', version: '1.8.3' }, crates: [{ name: 'mercury_whisper', version: '0.1.0', license: 'Mercury' }, { name: 'whisper-rs', version: '0.16.0', license: 'Unlicense' }] }
    write(addon, 'fixture')
    write(join(payload, path, '.vendor-manifest.json'), JSON.stringify(record))
    write(join(payload, path, 'NOTICES.json'), JSON.stringify(record))
    write(join(payload, path, 'licenses/whisper.cpp-1.8.3/LICENSE'), 'fixture licence')
    write(join(payload, path, 'licenses/whisper-rs-0.16.0.txt'), 'fixture licence')
    write(join(payload, 'manifest.json'), JSON.stringify({ degraded: [], onDeviceTranscriber: { ...record, path, vendored: true } }))
    assert.equal(checkBundledVendorPacks(payload, target).ok, true, JSON.stringify(checkBundledVendorPacks(payload, target)))
    write(addon, 'corrupt')
    assert.equal(checkBundledVendorPacks(payload, target).ok, false, `${target}: changed addon bytes fail`)
    write(addon, 'fixture')
    rmSync(join(payload, path, 'licenses/whisper.cpp-1.8.3/LICENSE'))
    assert.equal(checkBundledVendorPacks(payload, target).ok, false, `${target}: missing engine licence fails`)
    const plan = spawnSync(process.execPath, [join(root, 'scripts/vendor/build-whisper.ts'), '--plan', '--target', target], { cwd: root, env: process.env, encoding: 'utf8' })
    assert.equal(plan.status, 0, plan.stderr)
    const decision = JSON.parse(plan.stdout)
    assert.equal(decision.platform, platform)
    assert.equal(decision.triple, voiceCargoTriple(platform))
    assert.equal(decision.env.GGML_NATIVE, 'OFF')
    assert.equal(decision.env.GGML_OPENMP, 'OFF')
    if (target === 'windows-arm64') {
      assert.equal(decision.env.CMAKE_GENERATOR, 'Ninja')
      assert.equal(decision.env.CMAKE_C_COMPILER, 'clang-cl')
      assert.equal(decision.env.CMAKE_CXX_COMPILER, 'clang-cl')
      assert.equal(decision.env.CMAKE_CXX_COMPILER_TARGET, 'aarch64-pc-windows-msvc')
      assert.ok(String(decision.env.CXXFLAGS ?? '').split(/\s+/).includes('/EHsc'), 'clang-cl compiles whisper.cpp with exceptions on (/EHsc): gguf.cpp uses try')
    }
    console.log(`${target}: absent, present, corrupt, missing licence and toolchain decision verified`)
  }
  const builtManifest = JSON.parse(readFileSync(join(root, 'dist/manifest.json'), 'utf8'))
  if ((builtManifest.degraded as string[] | undefined)?.includes('on-device-transcriber')) {
    console.log(`  [SKIP] this build carries no on-device transcriber pack (dist/manifest.json degraded: on-device-transcriber) — the built-payload row reads a build made with the pack; the release workflow builds it`)
  } else {
    const built = checkBundledVendorPacks(join(root, 'dist'), builtManifest.target.release)
    assert.equal(built.ok, true, JSON.stringify(built.findings))
    console.log(`${builtManifest.target.release}: the real built payload carries its verified Whisper pack`)
  }
  const workflow = readFileSync(join(root, '.github/workflows/private-release.yml'), 'utf8')
  const step = workflow.split('- name: Build the on-device transcriber pack')[1]?.split('- name:')[0] ?? ''
  assert.ok(step.includes('build-whisper.ts --check --target'))
  assert.ok(!step.includes('continue-on-error'))
  assert.match(workflow, /LLVM toolchain for the on-device transcriber/)
  assert.match(workflow, /windows-11-arm/)
  assert.doesNotMatch(readFileSync(join(root, 'scripts/release/package.mjs'), 'utf8'), /new Set\(\[[^\]]*'on-device-transcriber'/)
  console.log('prove-whisper-archives: green — every release target requires a verified Whisper pack')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
