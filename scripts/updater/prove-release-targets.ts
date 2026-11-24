#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.chdir(join(import.meta.dir, '..', '..'))
const ROOT = process.cwd()
const { RELEASE_TARGETS, archiveNameFor, buildPlatformOf, isReleaseTarget, platformKey, readBuildTargetRecord, releaseTargetFor, ripgrepPackageFor } =
  await import('../../src/platform/update-channel/releaseTarget.ts')
const { assetNameFor, platformNote } = await import('../../src/platform/update-channel/channelCore.ts')
const { nodePackPlatform, readRuntimeRecord } = await import('../../src/platform/update-channel/vendoredRuntime.ts')
const { imagePackPlatform } = await import('../../src/platform/images/imagePackArm.ts')
const { voiceCargoTriple, voicePackPlatform } = await import('../../src/integrations/voice-pack/voicePack.ts')
const { BRUSH_PACK_PATH, brushBinaryFor, brushPackPlatform } = await import('../../src/platform/shell/brushPack.ts')
const { lockedPackage, platformPackagesFor, registryTarballUrl, resolvePlatformPackage } = await import('../vendor/platformPackages.ts')

let failures = 0
const WHERE: Record<string, string> = {
  '§1': 'change RELEASE_TARGETS, releaseTargetFor, archiveNameFor or readBuildTargetRecord in src/platform/update-channel/releaseTarget.ts, or the pack owner that disagrees (nodePackPlatform in src/platform/update-channel/vendoredRuntime.ts, imagePackPlatform in src/platform/images/imagePackArm.ts, voicePackPlatform in src/integrations/voice-pack/voicePack.ts, brushPackPlatform in src/platform/shell/brushPack.ts)',
  '§2': 'change assetNameFor or platformNote in src/platform/update-channel/channelCore.ts so the asset it asks for equals archiveNameFor in src/platform/update-channel/releaseTarget.ts',
  '§5': 'rebuild with bun run build.ts; if it still fails, the manifest record written in build.ts (target, search, runtime and pack records) disagrees with the owners in src/platform/update-channel/releaseTarget.ts',
  '§6': 'bun.lock must pin every package platformPackagesFor names in scripts/vendor/platformPackages.ts (run bun install, or fix platformPackagesFor, lockedPackage or registryTarballUrl there)',
  '§7': 'change the package and bridge-gate matrices or the named steps in .github/workflows/private-release.yml to match what this check expects',
  '§9': 'change bundledVendorPacks or checkBundledVendorPacks in scripts/release/payloadContract.mjs, vendor/brush.lock.json, or the Windows shell engine step in .github/workflows/private-release.yml',
}
let where = ''
const check = (name: string, cond: boolean, detail = ''): void => {
  const hint = cond ? '' : [detail, where].filter(Boolean).join(' · to fix: ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${hint ? ` — ${hint}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => {
  where = WHERE[title.slice(0, 2)] ?? ''
  console.log(`\n── ${title} ──`)
}
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

section('§1 the owner — six targets, the pair each ships for, the archive name, the uname map')
check('exactly these six targets, in this order', JSON.stringify(RELEASE_TARGETS) === JSON.stringify(['linux-x64', 'linux-arm64', 'macos-arm64', 'macos-x64', 'windows-x64', 'windows-arm64']))
for (const target of RELEASE_TARGETS) {
  const p = buildPlatformOf(target)
  check(`${target} round-trips through its pair (${p.platform}/${p.arch})`, releaseTargetFor(p.platform, p.arch) === target && isReleaseTarget(target))
}
check('darwin/x64 is the Intel Mac archive', releaseTargetFor('darwin', 'x64') === 'macos-x64')
check('linux/arm64 and win32/arm64 are the two arm64 archives', releaseTargetFor('linux', 'arm64') === 'linux-arm64' && releaseTargetFor('win32', 'arm64') === 'windows-arm64')
check('a pair no archive is published for still answers null (freebsd/x64, linux/riscv64)', releaseTargetFor('freebsd', 'x64') === null && releaseTargetFor('linux', 'riscv64') === null)
check('archive names: tar.gz on the four POSIX targets, zip on both Windows targets', archiveNameFor('1.0.0-beta.3', 'macos-x64') === 'mercury-v1.0.0-beta.3-macos-x64.tar.gz' && archiveNameFor('1.0.0-beta.3', 'linux-arm64') === 'mercury-v1.0.0-beta.3-linux-arm64.tar.gz' && archiveNameFor('1.0.0-beta.3', 'windows-x64') === 'mercury-v1.0.0-beta.3-windows-x64.zip' && archiveNameFor('1.0.0-beta.3', 'windows-arm64') === 'mercury-v1.0.0-beta.3-windows-arm64.zip')
check('the manifest record decodes when the pair and the release agree', readBuildTargetRecord({ target: { platform: 'darwin', arch: 'x64', release: 'macos-x64', host: 'darwin-arm64' } })?.release === 'macos-x64')
check('the manifest record is refused when the pair and the release disagree', readBuildTargetRecord({ target: { platform: 'darwin', arch: 'arm64', release: 'macos-x64', host: 'darwin-arm64' } }) === null)
check('the manifest record decodes a pair with no archive as release null', readBuildTargetRecord({ target: { platform: 'linux', arch: 'riscv64', release: null, host: 'linux-riscv64' } })?.release === null)
check('an older manifest without the record answers null', readBuildTargetRecord({ version: '1.0.0-beta.2' }) === null)
for (const target of RELEASE_TARGETS) {
  const p = buildPlatformOf(target)
  const key = platformKey(p.platform, p.arch)
  const imageKey = imagePackPlatform(p.platform, p.arch)
  const imageKeyHolds = platformKey(process.platform, process.arch) === key ? /^linux(musl)?-x64$/.test(imageKey) || imageKey === key : imageKey === key
  check(`${target}: every pack owner keys the pair (node ${nodePackPlatform(p.platform, p.arch)}, image ${imageKey}, voice ${voicePackPlatform(p.platform, p.arch)} → ${voiceCargoTriple(voicePackPlatform(p.platform, p.arch))}, shell engine ${brushPackPlatform(p.platform, p.arch)})`,
    nodePackPlatform(p.platform, p.arch) !== null && imageKeyHolds && voicePackPlatform(p.platform, p.arch) === key && voiceCargoTriple(key) !== null && brushPackPlatform(p.platform, p.arch) === nodePackPlatform(p.platform, p.arch))
}

section('§2 the channel — the asset a machine asks for')
for (const target of RELEASE_TARGETS) {
  const p = buildPlatformOf(target)
  check(`${p.platform}/${p.arch} asks for ${archiveNameFor('1.2.0-beta.1', target)}`, assetNameFor('1.2.0-beta.1', p.platform, p.arch) === archiveNameFor('1.2.0-beta.1', target))
}
check('a pair with no archive answers null and the note names the six archives', assetNameFor('1.2.0-beta.1', 'linux', 'riscv64') === null && platformNote('linux', 'riscv64').includes('macos-x64') && platformNote('linux', 'riscv64').includes('linux-arm64') && platformNote('linux', 'riscv64').includes('windows-arm64') && platformNote('linux', 'riscv64').includes('linux/riscv64'))


section('§5 the built dist — the packs follow the declared target')
{
  const manifestPath = join(ROOT, 'dist', 'manifest.json')
  if (!existsSync(manifestPath)) {
    console.log('  [SKIP] dist/manifest.json absent — build first (bun run build.ts); the pool prebuilds it')
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    const record = readBuildTargetRecord(manifest)
    check('the dist manifest declares its target', record !== null, JSON.stringify(manifest.target))
    if (record) {
      const key = platformKey(record.platform, record.arch)
      const hostKey = platformKey(process.platform, process.arch)
      check(`the declaration names the builder (${hostKey}) as the host`, record.host === hostKey, record.host)
      if (record.host === key) check('a build without --target ships for the host and names its archive', record.release === releaseTargetFor(process.platform, process.arch))
      const search = manifest.search as { vendored?: boolean; path?: string }
      check(`the search record follows the target (${key})`, search.vendored !== true || search.path === `vendor/ripgrep/${record.arch}-${record.platform}/${record.platform === 'win32' ? 'rg.exe' : 'rg'}`, search.path)
      const runtime = readRuntimeRecord(manifest)
      check('the runtime record follows the target', runtime === null || !runtime.vendored || runtime.platform === nodePackPlatform(record.platform, record.arch), JSON.stringify(manifest.runtime))
      const image = manifest.imageProcessing as { vendored?: boolean; platform?: string }
      check('the image processor record follows the target', image.vendored !== true || image.platform === imagePackPlatform(record.platform, record.arch), JSON.stringify(image))
      const voice = manifest.voiceInput as { vendored?: boolean; platform?: string }
      check('the voice pack record follows the target', voice.vendored !== true || voice.platform === voicePackPlatform(record.platform, record.arch), JSON.stringify(voice))
      const shell = manifest.shellEngine as { vendored?: boolean; platform?: string }
      check('the shell engine record follows the target', shell.vendored !== true || shell.platform === brushPackPlatform(record.platform, record.arch), JSON.stringify(shell))
      const whisperRecord = manifest.onDeviceTranscriber as { vendored?: boolean; platform?: string } | undefined
      check('the on-device transcriber record follows the target', whisperRecord !== undefined && (whisperRecord.vendored !== true || whisperRecord.platform === voicePackPlatform(record.platform, record.arch)), JSON.stringify(whisperRecord))
      const desktopRecord = manifest.desktopDriver as { vendored?: boolean; platform?: string } | undefined
      check('the desktop driver record follows the target', desktopRecord !== undefined && (desktopRecord.vendored !== true || desktopRecord.platform === voicePackPlatform(record.platform, record.arch)), JSON.stringify(desktopRecord))
      const embedRecord = manifest.semanticEmbedder as { vendored?: boolean; platform?: string; defaultModel?: { vendored?: boolean; path?: string } } | undefined
      check('the semantic embedder record follows the target, its default model riding beside it when vendored', embedRecord !== undefined && (embedRecord.vendored !== true || (embedRecord.platform === voicePackPlatform(record.platform, record.arch) && embedRecord.defaultModel !== undefined && (embedRecord.defaultModel.vendored !== true || (embedRecord.defaultModel.path ?? '').startsWith('vendor/embed-models/')))), JSON.stringify(embedRecord))
    }
  }
}

section('§6 the platform-package fetch — bun.lock is the version owner')
{
  const lock = read('bun.lock')
  for (const target of RELEASE_TARGETS) {
    const p = buildPlatformOf(target)
    const names = platformPackagesFor(p.platform, p.arch)
    const pinned = names.map(n => lockedPackage(lock, n))
    check(`${target}: bun.lock pins ${names.join(' + ')}`, pinned.every(x => x !== null && /^sha512-[A-Za-z0-9+/=]+$/.test(x.integrity) && /^\d+\.\d+\.\d+/.test(x.version)), pinned.map(x => (x ? `${x.name}@${x.version}` : 'MISSING')).join(', '))
  }
  check('the Intel Mac target needs the search binary, the sharp binding and its libvips', JSON.stringify(platformPackagesFor('darwin', 'x64')) === JSON.stringify(['@vscode/ripgrep-darwin-x64', '@img/sharp-darwin-x64', '@img/sharp-libvips-darwin-x64']))
  check('Windows carries the DLLs in the binding package (no libvips package)', platformPackagesFor('win32', 'x64').length === 2)
  const rgX64 = lockedPackage(lock, ripgrepPackageFor('darwin', 'x64'))
  check('the registry tarball grammar: scoped name, unscoped stem', rgX64 !== null && registryTarballUrl(rgX64) === `https://registry.npmjs.org/@vscode/ripgrep-darwin-x64/-/ripgrep-darwin-x64-${rgX64.version}.tgz`)
  const hostRg = resolvePlatformPackage(ROOT, process.platform, process.arch, ripgrepPackageFor(process.platform, process.arch))
  check('the host\'s own search package resolves from node_modules (bun install carried it)', hostRg?.source === 'node_modules', JSON.stringify(hostRg))
}

section('§7 the release workflow — four arms, the Intel one cross-packaged and gated under Rosetta')
{
  const wf = read('.github/workflows/private-release.yml')
  const rowsOf = (job: string): Array<Record<string, string>> => {
    const start = wf.indexOf(`\n  ${job}:\n`)
    const body = wf.slice(start + 1)
    const end = body.slice(1).search(/\n  [a-z-]+:\n/)
    const section = end === -1 ? body : body.slice(0, end + 1)
    const rows: Array<Record<string, string>> = []
    for (const line of section.split('\n')) {
      const t = line.trim()
      if (t.startsWith('#')) continue
      const start = /^- os: (\S+)$/.exec(t)
      if (start) {
        rows.push({ os: start[1]! })
        continue
      }
      const kv = /^([a-z_]+): (\S+)$/.exec(t)
      if (kv && rows.length > 0 && /^\s{12}[a-z_]+:/.test(line)) rows[rows.length - 1]![kv[1]!] = kv[2]!
    }
    return rows
  }
  const pkg = rowsOf('package')
  const triple = (r: Record<string, string>): string => `${r.os}/${r.target}/${r.node_pack}${r.cross ? '/cross' : ''}${r.rust_targets ? `/${r.rust_targets}` : ''}`
  check('the package matrix has SIX arms', pkg.length === 6, pkg.map(triple).join(' · '))
  check('the five native arms (os · target · node_pack, no cross flag): the three of old and the two arm64 runners', JSON.stringify(pkg.filter(r => !r.cross).map(triple)) === JSON.stringify(['ubuntu-latest/linux-x64/linux-x64', 'macos-15/macos-arm64/darwin-arm64', 'windows-latest/windows-x64/win-x64', 'ubuntu-24.04-arm/linux-arm64/linux-arm64', 'windows-11-arm/windows-arm64/win-arm64']))
  const intel = pkg.find(r => r.target === 'macos-x64')
  check('the Intel arm is cross-packaged on the arm64 runner with the darwin-x64 runtime and the x86_64-apple-darwin rustup target', intel !== undefined && intel.os === 'macos-15' && intel.node_pack === 'darwin-x64' && intel.cross === 'true' && intel.rust_targets === 'x86_64-apple-darwin', intel ? triple(intel) : 'absent')
  check('every arm\'s node pack is the owner\'s projection of its target', pkg.every(r => isReleaseTarget(r.target ?? '') && nodePackPlatform(buildPlatformOf(r.target as never).platform, buildPlatformOf(r.target as never).arch) === r.node_pack))
  check('every arm builds, builds the voice pack, fetches its platform packages and its shell engine pack for ITS target', wf.includes('bun run build.ts --target ${{ matrix.target }}') && wf.includes('bun run scripts/vendor/build-voice.ts --target ${{ matrix.target }}') && wf.includes('bun run scripts/vendor/fetch-platform-packages.ts --target ${{ matrix.target }}') && wf.includes('bun run scripts/vendor/fetch-brush.ts --platform ${{ matrix.node_pack }}'))
  check('the shell engine fetch skips the Windows arm, whose pack is built on its own step', /if: runner\.os != 'Windows'\n\s+run: bun run scripts\/vendor\/fetch-brush\.ts --platform/.test(wf) && wf.includes('- name: Build the shell engine pack (Windows)'))
  check('every arm builds and checks its required on-device transcriber pack', wf.includes('bun run scripts/vendor/build-whisper.ts --target ${{ matrix.target }}') && wf.includes('bun run scripts/vendor/build-whisper.ts --check --target ${{ matrix.target }}') && !/name: Build the on-device transcriber pack\n\s+continue-on-error: true/.test(wf))
  check('every arm builds the desktop driver pack for ITS target, optional like the voice pack', wf.includes('bun run scripts/vendor/build-desktop.ts --target ${{ matrix.target }}') && /name: Build the desktop driver pack\n\s+continue-on-error: true/.test(wf))
  check('every arm builds the semantic embedder pack for ITS target, optional like the voice pack', wf.includes('bun run scripts/vendor/build-embed.ts --target ${{ matrix.target }}') && /name: Build the semantic embedder pack\n\s+continue-on-error: true\n\s+run: bun run scripts\/vendor\/build-embed\.ts --target/.test(wf))
  check('every arm fetches the shipped embedding model alone, hash-verified, optional the same way', wf.includes('bun run scripts/vendor/fetch-embed-models.ts --default') && /name: Fetch the shipped embedding model \(hash-verified\)\n\s+continue-on-error: true\n\s+run: bun run scripts\/vendor\/fetch-embed-models\.ts --default/.test(wf) && !wf.includes('fetch-embed-models.ts --all'))
  check('the embedder pack and its model are prepared after the rust toolchain and before the native build, on every arm (no runner.os guard)', wf.includes('- name: Rust toolchain (pinned stable)') && wf.indexOf('- name: Rust toolchain (pinned stable)') < wf.indexOf('- name: Build the semantic embedder pack') && wf.indexOf('- name: Build the semantic embedder pack') < wf.indexOf('- name: Fetch the shipped embedding model (hash-verified)') && wf.indexOf('- name: Fetch the shipped embedding model (hash-verified)') < wf.indexOf('- name: native build') && !/name: Build the semantic embedder pack\n\s+if:/.test(wf) && !/name: Fetch the shipped embedding model \(hash-verified\)\n\s+if:/.test(wf))
  check('the vendor cache key covers the model fetch and its lock', wf.includes("'scripts/vendor/fetch-embed-models.ts'") && wf.includes("'vendor/embed-models.lock.json'"))
  check('the rust toolchain step installs the arm\'s rustup targets', wf.includes("targets: ${{ matrix.rust_targets || '' }}"))
  check('a cross arm ensures Rosetta 2 before the packager\'s smoke', /if: matrix\.cross\n\s+run: \|\n\s+arch -x86_64 \/usr\/bin\/true 2>\/dev\/null \|\| sudo softwareupdate --install-rosetta --agree-to-license\n\s+arch -x86_64 \/usr\/bin\/true/.test(wf))
  check('the vendor cache key covers the platform-package fetch and bun.lock', wf.includes("'scripts/vendor/fetch-platform-packages.ts'") && wf.includes("'bun.lock'"))
  const gate = rowsOf('bridge-gate')
  check('the bridge gate has the same six arms', JSON.stringify([...gate.map(r => r.target)].sort()) === JSON.stringify([...RELEASE_TARGETS].sort()), gate.map(r => r.target).join(', '))
  check('the bridge gate drives the Intel archive under Rosetta and fails on a skip', gate.find(r => r.target === 'macos-x64')?.cross === 'true' && wf.includes('bun run scripts/updater/prove-cross-archive-rosetta.ts --target ${{ matrix.target }} --require'))
  check('the previous-reader bridge gates the arm\'s own target', wf.includes('bun run scripts/updater/prove-release-bridge.ts --target ${{ matrix.target }}'))
  check('the release publishes every tar.gz and zip (the Intel archive rides the same glob)', wf.includes('assets/mercury-*.tar.gz assets/mercury-*.zip assets/SHA256SUMS.txt'))
  check('the dropped-arm words are gone', !wf.includes('DROPPED'))
}

section('§9 the Windows archive carries the bundled shell engine — the contract, the packager, the verifier, the workflow')
{
  type Pack = { name: string; version: string; platform: string; binary: string; degradation: string; manifestKey: string; dir: string; files: string[]; tree?: boolean; record?: Record<string, unknown> }
  type Verdict = { ok: boolean; findings: string[]; packs: Pack[] }
  const contract = (await import('../release/payloadContract.mjs')) as { bundledVendorPacks?: (target: string) => Pack[]; checkBundledVendorPacks?: (payloadDir: string, target: string) => Verdict; vendorPackTreeDigest?: (dir: string) => { fileCount: number; treeDigest: string } }
  const packsOf = (target: string): Pack[] => (typeof contract.bundledVendorPacks === 'function' ? contract.bundledVendorPacks(target) : [])
  const checkAt = (dir: string, target: string): Verdict => (typeof contract.checkBundledVendorPacks === 'function' ? contract.checkBundledVendorPacks(dir, target) : { ok: false, findings: ['checkBundledVendorPacks is not exported'], packs: [] })
  const ofEngine = (verdict: Verdict): string[] => verdict.findings.filter(finding => verdict.packs.some(bundled => finding.startsWith(`${bundled.dir}/`)))
  const win = packsOf('windows-x64')
  const pack = win.find(bundled => bundled.name === 'brush')
  const bashPack = win.find(bundled => bundled.name === 'bash')
  check("windows-x64 bundles two packs beyond the build's own set: the bash Mercury ships, held by its tree, and the shell engine", win.length === 2 && bashPack?.tree === true && bashPack.degradation === 'shell-bash' && bashPack.platform === 'win-x64' && pack?.degradation === 'shell-engine' && pack.manifestKey === 'shellEngine' && pack.platform === 'win-x64', JSON.stringify(win.map(bundled => bundled.name)))
  const packPlatform = brushPackPlatform('win32', 'x64')
  check("the contract's pack directory and binary are the owner's spellings", pack?.dir === `${BRUSH_PACK_PATH}/${packPlatform}` && pack?.binary === brushBinaryFor(packPlatform!), `${pack?.dir} · ${pack?.binary}`)
  check("its files are the binary, the pack's record, the crate inventory and the engine's own licence", pack !== undefined && pack.files.includes(pack.binary) && pack.files.includes('.vendor-manifest.json') && pack.files.includes('NOTICES.json') && pack.files.some(f => /^licenses\/brush-shell-\d+\.\d+\.\d+\/LICENSE$/.test(f)), JSON.stringify(pack?.files))
  const lock = JSON.parse(read('vendor/brush.lock.json')) as { version: string; platforms: Record<string, { crate?: string; crateVersion?: string }> }
  const entry = lock.platforms['win-x64']!
  check('the pinned version and the licence path follow the lock', pack?.version === lock.version && (pack?.files.includes(`licenses/${entry.crate}-${entry.crateVersion}/LICENSE`) ?? false), `${pack?.version} vs ${lock.version}`)
  for (const t of ['linux-x64', 'linux-arm64', 'macos-arm64', 'macos-x64']) {
    const bundled = packsOf(t)
    check(`${t} bundles exactly one pack beyond the build's own set: the bash Mercury ships, and no engine pack`, bundled.length === 1 && bundled[0]?.name === 'bash' && bundled[0].degradation === 'shell-bash' && bundled[0].manifestKey === 'bash' && bundled[0].binary === 'bash', JSON.stringify(bundled))
  }

  const fixture = mkdtempSync(join(tmpdir(), 'bundled-shell-'))
  try {
    const empty = checkAt(fixture, 'windows-x64')
    check('an empty windows-x64 payload fails the check, naming every missing file', !empty.ok && pack !== undefined && pack.files.every(f => empty.findings.some(line => line.includes(f))), JSON.stringify(empty.findings).slice(0, 300))
    check('an empty linux-x64 payload fails for its missing on-device transcriber', !checkAt(fixture, 'linux-x64').ok && checkAt(fixture, 'linux-x64').findings.some(f => f.includes('whisper')))
    const whisperDir = join(fixture, 'vendor', 'whisper', 'win32-x64')
    mkdirSync(join(whisperDir, 'licenses', 'whisper.cpp-1.8.3'), { recursive: true })
    const whisperBytes = Buffer.from('fixture on-device transcriber')
    const whisperRecord = { name: 'mercury-whisper', version: '0.1.0', platform: 'win32-x64', addon: 'mercury_whisper.node', addonSha256: createHash('sha256').update(whisperBytes).digest('hex'), engine: { name: 'whisper.cpp', version: '1.8.3' }, crates: [{ name: 'mercury_whisper', version: '0.1.0', license: 'Mercury' }] }
    writeFileSync(join(whisperDir, whisperRecord.addon), whisperBytes)
    writeFileSync(join(whisperDir, '.vendor-manifest.json'), JSON.stringify(whisperRecord))
    writeFileSync(join(whisperDir, 'NOTICES.json'), JSON.stringify(whisperRecord))
    writeFileSync(join(whisperDir, 'licenses', 'whisper.cpp-1.8.3', 'LICENSE'), 'MIT\n')
    writeFileSync(join(fixture, 'manifest.json'), JSON.stringify({ degraded: [], onDeviceTranscriber: { ...whisperRecord, vendored: true, path: 'vendor/whisper/win32-x64' } }))
    const packDir = join(fixture, ...(pack?.dir ?? 'vendor/brush/win-x64').split('/'))
    const licenceDir = join(packDir, 'licenses', `${entry.crate}-${entry.crateVersion}`)
    mkdirSync(licenceDir, { recursive: true })
    const binary = Buffer.from('MZ not really an engine')
    writeFileSync(join(packDir, 'brush.exe'), binary)
    writeFileSync(join(packDir, 'NOTICES.json'), '{"crates":[]}\n')
    writeFileSync(join(licenceDir, 'LICENSE'), 'MIT\n')
    const record = { name: 'brush', source: 'cargo-build', version: lock.version, platform: 'win-x64', target: 'x86_64-pc-windows-msvc', crate: entry.crate, crateVersion: entry.crateVersion, crateSha256: null, cargo: 'cargo', binary: 'brush.exe', binarySha256: createHash('sha256').update(binary).digest('hex'), license: 'MIT', licenseFiles: ['NOTICES.json'], fileCount: 3, treeDigest: '0'.repeat(64) }
    writeFileSync(join(packDir, '.vendor-manifest.json'), JSON.stringify(record))
    if (bashPack !== undefined) {
      const bashDir = join(fixture, ...bashPack.dir.split('/'))
      for (const file of bashPack.files) {
        mkdirSync(join(bashDir, ...file.split('/'), '..'), { recursive: true })
        writeFileSync(join(bashDir, ...file.split('/')), `fixture ${file}\n`)
      }
      const bashBytes = readFileSync(join(bashDir, ...bashPack.binary.split('/')))
      writeFileSync(join(bashDir, '.vendor-manifest.json'), JSON.stringify({ name: 'bash', platform: bashPack.platform, version: bashPack.version, binary: bashPack.binary, binarySha256: createHash('sha256').update(bashBytes).digest('hex'), ...(bashPack.record ?? {}), ...(contract.vendorPackTreeDigest?.(bashDir) ?? {}) }))
    }
    const laid = checkAt(fixture, 'windows-x64')
    check('a payload with Whisper, the bash pack and the shell binary, records and licence files passes, the records agreeing with the bytes', laid.ok && laid.packs.length === 2, JSON.stringify(laid.findings))
    rmSync(join(whisperDir, whisperRecord.addon))
    const withoutWhisper = checkAt(fixture, 'windows-x64')
    check('a Windows payload with only its shell engine fails for the missing Whisper addon', !withoutWhisper.ok && withoutWhisper.findings.some(f => f.includes('whisper')))
    check('and nothing that payload is refused for is the shell engine\'s or the bash pack\'s: read by their own findings, both are carried', withoutWhisper.packs.length === 2 && ofEngine(withoutWhisper).length === 0, JSON.stringify(ofEngine(withoutWhisper)))
    writeFileSync(join(whisperDir, whisperRecord.addon), whisperBytes)
    const other = Buffer.from('MZ another binary')
    writeFileSync(join(packDir, 'brush.exe'), other)
    const swapped = checkAt(fixture, 'windows-x64')
    check("a binary that no longer matches its record is refused, naming the digest", !swapped.ok && swapped.findings.some(f => /sha256/.test(f)), JSON.stringify(swapped.findings))
    check('and that refusal is the shell engine\'s own finding', ofEngine(swapped).some(f => /sha256/.test(f)), JSON.stringify(ofEngine(swapped)))
    writeFileSync(join(packDir, '.vendor-manifest.json'), JSON.stringify({ ...record, version: '0.0.1', binarySha256: createHash('sha256').update(other).digest('hex') }))
    const stale = checkAt(fixture, 'windows-x64')
    check("a record of another version than the lock's is refused, naming both", !stale.ok && stale.findings.some(f => f.includes('0.0.1') && f.includes(lock.version)), JSON.stringify(stale.findings))
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }

  const wf = read('.github/workflows/private-release.yml')
  const step = wf.indexOf('- name: Build the shell engine pack (Windows)')
  const stepEnd = wf.indexOf('\n      - name:', step + 1)
  check("the release job's Windows pack build is no longer optional", step !== -1 && !wf.slice(step, stepEnd === -1 ? step + 300 : stepEnd).includes('continue-on-error'))

  const manifestPath = join(ROOT, 'dist', 'manifest.json')
  if (existsSync(manifestPath)) {
    const built = readBuildTargetRecord(JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>)
    if (built?.release === 'windows-x64') {
      const onDisk = checkAt(join(ROOT, 'dist'), 'windows-x64')
      const beside = onDisk.findings.filter(finding => !ofEngine(onDisk).includes(finding))
      check('the built Windows dist carries the bundled shell engine', onDisk.packs.length === 1 && ofEngine(onDisk).length === 0, JSON.stringify(onDisk.packs.length === 1 ? ofEngine(onDisk) : onDisk.findings))
      const degraded = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { degraded?: string[] }).degraded ?? []
      if (degraded.includes('on-device-transcriber')) console.log(`  [NOTE] this dist was built without the on-device transcriber and its manifest says so (degraded: ${degraded.join(', ')}): what the payload check finds beside the shell engine is that build's own word and is not asserted here — ${JSON.stringify(beside)}`)
      else check('and the on-device transcriber every archive requires is in it too', beside.length === 0, JSON.stringify(beside))
    } else {
      console.log(`  [SKIP] dist is built for ${built?.release ?? 'an unknown target'} — the bundled-pack check on a built dist runs on a windows-x64 build`)
    }
  } else {
    console.log('  [SKIP] dist/manifest.json absent — the bundled-pack check on a built dist runs where a windows-x64 dist is')
  }
}

console.log('')
if (failures === 0) {
  console.log('PASS prove-release-targets')
  process.exit(0)
}
console.log(`FAIL prove-release-targets (${failures})`)
process.exit(1)
