import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { WHISPER_ADDON_EXPORTS } from '../../src/services/voice/whisperPack.ts'
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
    const plan = spawnSync(process.execPath, [join(root, 'scripts/vendor/build-whisper.ts'), '--plan', '--verbose', '--target', target], { cwd: root, env: process.env, encoding: 'utf8' })
    assert.equal(plan.status, 0, plan.stderr)
    const decision = JSON.parse(plan.stdout)
    assert.equal(decision.platform, platform)
    assert.equal(decision.triple, voiceCargoTriple(platform))
    assert.ok(decision.cargoArgs?.includes('--locked'), 'pack builds hold the bindgen lockfile')
    assert.ok(decision.cargoArgs?.includes('-vv'), 'the bench can retain full build-script output')
    assert.equal(decision.env.GGML_NATIVE, 'OFF')
    assert.equal(decision.env.GGML_OPENMP, 'OFF')
    if (target === 'windows-arm64') {
      assert.equal(decision.env.CMAKE_GENERATOR, 'Ninja')
      assert.equal(decision.env.CMAKE_C_COMPILER, 'clang-cl')
      assert.equal(decision.env.CMAKE_CXX_COMPILER, 'clang-cl')
      assert.equal(decision.env.CMAKE_CXX_COMPILER_TARGET, 'aarch64-pc-windows-msvc')
      assert.ok(String(decision.env.CXXFLAGS ?? '').split(/\s+/).includes('/EHsc'), 'clang-cl compiles whisper.cpp with exceptions on (/EHsc): gguf.cpp uses try')
      assert.equal(decision.env.WHISPER_DONT_GENERATE_BINDINGS, undefined, 'the bundled bindings were generated on Linux and their struct layouts fail on Windows: bindgen runs when libclang is present')
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
  const probeText = readFileSync(join(root, '.github/workflows/whisper-pack-probe.yml'), 'utf8')
  const probe = parse(probeText)
  const release = parse(workflow)
  assert.deepEqual(Object.keys(probe.on), ['workflow_dispatch'])
  assert.ok(probe.jobs.probe.strategy.matrix.include.includes("[inputs.target || 'windows-arm64']"))
  assert.deepEqual([...probe.on.workflow_dispatch.inputs.target.options].sort(), [...RELEASE_TARGETS].sort())
  assert.equal(probe.on.workflow_dispatch.inputs.target.default, 'windows-arm64')
  assert.deepEqual(probe.permissions, { contents: 'read' })
  assert.deepEqual(Object.keys(probe.jobs), ['probe'])
  const job = probe.jobs.probe
  assert.equal(job.if, "github.repository == 'Whq02/PreRelease'")
  const rows = JSON.parse(/fromJSON\('([\s\S]+)'\)/.exec(job.strategy.matrix.include)?.[1] ?? 'null')
  assert.deepEqual(Object.keys(rows).sort(), [...RELEASE_TARGETS].sort())
  for (const target of RELEASE_TARGETS) {
    const row = rows[target][0]
    const releaseRow = release.jobs.package.strategy.matrix.include.find((r: { target: string }) => r.target === target)
    assert.deepEqual(row, releaseRow, `${target}: probe uses the release runner and toolchain target`)
  }
  const stepNamed = (steps: Array<{ name?: string }>, name: string): any => steps.find(s => s.name === name)
  for (const name of ['Rust toolchain (pinned stable)', 'cmake for the on-device transcriber pack', 'LLVM toolchain for the on-device transcriber (Windows ARM64)']) {
    assert.deepEqual(stepNamed(job.steps, name), stepNamed(release.jobs.package.steps, name), name)
  }
  const buildStep = stepNamed(job.steps, 'Build the on-device transcriber pack')
  assert.equal(buildStep['continue-on-error'], undefined)
  assert.match(buildStep.run, /build-whisper\.ts --target.*--force --verbose/)
  assert.match(buildStep.run, /build-whisper\.ts --check --target/)
  const loadStep = stepNamed(job.steps, 'Load the pack with host and vendored Node')
  assert.equal(loadStep['continue-on-error'], undefined)
  for (const name of WHISPER_ADDON_EXPORTS) assert.ok(loadStep.run.includes(`'${name}'`), `load checks ${name}`)
  assert.match(loadStep.run, /assert\.equal\(addon\.engineVersion\(\), manifest\.engine\.version\)/)
  assert.match(loadStep.run, /assert\.equal\(addon\.packVersion\(\), manifest\.version\)/)
  assert.match(loadStep.run, /assert\.equal\(manifest\.platform,.*process\.platform/)
  assert.match(loadStep.run, /vendor\/node\/extracted/)
  const upload = job.steps.find((s: { uses?: string }) => s.uses?.startsWith('actions/upload-artifact@'))
  assert.equal(upload.if, 'always()')
  assert.equal(upload.with['include-hidden-files'], true)
  assert.match(upload.with.path, /vendor\/whisper/)
  assert.match(upload.with.path, /bindings\.rs/)
  assert.match(upload.with.path, /whisper-probe/)
  console.log('prove-whisper-archives: green — every release target requires a verified Whisper pack; isolated bench builds and loads it')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
