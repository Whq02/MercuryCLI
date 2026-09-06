#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

process.chdir(join(import.meta.dir, '..', '..'))
const ROOT = process.cwd()
const { RELEASE_TARGETS, archiveNameFor, buildPlatformOf, isReleaseTarget, platformKey, readBuildTargetRecord, releaseTargetFor, releaseTargetForUname, ripgrepPackageFor } =
  await import('../../src/services/privateChannel/releaseTarget.ts')
const { assetNameFor, platformNote } = await import('../../src/services/privateChannel/channelCore.ts')
const { nodePackPlatform, readRuntimeRecord } = await import('../../src/services/privateChannel/vendoredRuntime.ts')
const { imagePackPlatform } = await import('../../src/tools/FileReadTool/imagePackArm.ts')
const { voiceCargoTriple, voicePackPlatform } = await import('../../src/services/voice/voicePack.ts')
const { lockedPackage, platformPackagesFor, registryTarballUrl, resolvePlatformPackage } = await import('../vendor/platformPackages.ts')

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n── ${title} ──`)
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

section('§1 the owner — four targets, the pair each ships for, the archive name, the uname map')
check('exactly these four targets, in this order', JSON.stringify(RELEASE_TARGETS) === JSON.stringify(['linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64']))
for (const target of RELEASE_TARGETS) {
  const p = buildPlatformOf(target)
  check(`${target} round-trips through its pair (${p.platform}/${p.arch})`, releaseTargetFor(p.platform, p.arch) === target && isReleaseTarget(target))
}
check('darwin/x64 is the Intel Mac archive', releaseTargetFor('darwin', 'x64') === 'macos-x64')
check('linux/arm64 and win32/arm64 have no archive', releaseTargetFor('linux', 'arm64') === null && releaseTargetFor('win32', 'arm64') === null)
check('archive names: tar.gz on the three POSIX targets, zip on Windows', archiveNameFor('1.0.0-beta.3', 'macos-x64') === 'mercury-v1.0.0-beta.3-macos-x64.tar.gz' && archiveNameFor('1.0.0-beta.3', 'windows-x64') === 'mercury-v1.0.0-beta.3-windows-x64.zip')
check('uname map: Darwin/x86_64 → macos-x64, Darwin/arm64 → macos-arm64, Linux/x86_64 → linux-x64', releaseTargetForUname('Darwin', 'x86_64') === 'macos-x64' && releaseTargetForUname('Darwin', 'arm64') === 'macos-arm64' && releaseTargetForUname('Linux', 'x86_64') === 'linux-x64')
check('uname map: Linux/aarch64 and FreeBSD/x86_64 have no archive', releaseTargetForUname('Linux', 'aarch64') === null && releaseTargetForUname('FreeBSD', 'x86_64') === null)
check('the manifest record decodes when the pair and the release agree', readBuildTargetRecord({ target: { platform: 'darwin', arch: 'x64', release: 'macos-x64', host: 'darwin-arm64' } })?.release === 'macos-x64')
check('the manifest record is refused when the pair and the release disagree', readBuildTargetRecord({ target: { platform: 'darwin', arch: 'arm64', release: 'macos-x64', host: 'darwin-arm64' } }) === null)
check('the manifest record decodes a pair with no archive as release null', readBuildTargetRecord({ target: { platform: 'linux', arch: 'arm64', release: null, host: 'linux-arm64' } })?.release === null)
check('an older manifest without the record answers null', readBuildTargetRecord({ version: '1.0.0-beta.2' }) === null)
for (const target of RELEASE_TARGETS) {
  const p = buildPlatformOf(target)
  const key = platformKey(p.platform, p.arch)
  const imageKey = imagePackPlatform(p.platform, p.arch)
  const imageKeyHolds = platformKey(process.platform, process.arch) === key ? /^linux(musl)?-x64$/.test(imageKey) || imageKey === key : imageKey === key
  check(`${target}: every pack owner keys the pair (node ${nodePackPlatform(p.platform, p.arch)}, image ${imageKey}, voice ${voicePackPlatform(p.platform, p.arch)} → ${voiceCargoTriple(voicePackPlatform(p.platform, p.arch))})`,
    nodePackPlatform(p.platform, p.arch) !== null && imageKeyHolds && voicePackPlatform(p.platform, p.arch) === key && voiceCargoTriple(key) !== null)
}

section('§2 the channel — the asset a machine asks for')
for (const target of RELEASE_TARGETS) {
  const p = buildPlatformOf(target)
  check(`${p.platform}/${p.arch} asks for ${archiveNameFor('1.2.0-beta.1', target)}`, assetNameFor('1.2.0-beta.1', p.platform, p.arch) === archiveNameFor('1.2.0-beta.1', target))
}
check('a pair with no archive answers null and the note names the four archives', assetNameFor('1.2.0-beta.1', 'linux', 'arm64') === null && platformNote('linux', 'arm64').includes('macos-x64') && platformNote('linux', 'arm64').includes('linux/arm64'))
check('the channel no longer says the Intel Mac has no archive', !read('src/services/privateChannel/channelCore.ts').includes('has no channel archive'))

section('§3 the packager — the same vocabulary, the declared target held')
{
  const packager = read('scripts/release/package.mjs')
  const known = /const KNOWN = \[([^\]]+)\]/.exec(packager)
  const knownTargets = known ? [...known[1]!.matchAll(/'([^']+)'/g)].map(m => m[1]!) : []
  check('--target accepts exactly the owner\'s four targets', JSON.stringify(knownTargets) === JSON.stringify(RELEASE_TARGETS), knownTargets.join(', '))
  const packMap = /const TARGET_NODE_PACK = \{([^}]+)\}/.exec(packager)
  const pairs = packMap ? [...packMap[1]!.matchAll(/'([^']+)': '([^']+)'/g)].map(m => [m[1]!, m[2]!] as const) : []
  check('the node pack per target equals the owner\'s projection', pairs.length === RELEASE_TARGETS.length && pairs.every(([t, pack]) => isReleaseTarget(t) && nodePackPlatform(buildPlatformOf(t).platform, buildPlatformOf(t).arch) === pack), pairs.map(p => p.join('→')).join(' '))
  check('a dist built for another target is refused by its declaration, naming the build flag', packager.includes('dist was built for') && packager.includes('bun run build.ts --target ${TARGET}'))
  check('the runtime-platform refusal names the build flag, not the host', packager.includes('build for the target: bun run build.ts --target') && !packager.includes('build on the target platform'))
}

section('§4 the build — --target, the target\'s packs, the manifest declaration')
{
  const build = read('build.ts')
  check('build.ts reads --target through the owner', build.includes("await import('./src/services/privateChannel/releaseTarget.ts')") && build.includes("process.argv.indexOf('--target')"))
  check('the manifest declares the shipped pair, its release target and the host', build.includes('target: { platform: SHIP.platform, arch: SHIP.arch, release: SHIP_RELEASE, host: HOST_KEY }'))
  check('the search binary, the runtime, the voice pack and the image processor all key the SHIPPED pair', build.includes('vendor/ripgrep/${SHIP.arch}-${SHIP.platform}/') && build.includes('nodePackPlatform(SHIP.platform, SHIP.arch)') && build.includes('voicePackPlatform(SHIP.platform, SHIP.arch)') && build.includes('imagePackPlatform(SHIP.platform, SHIP.arch)'))
  check('the search binary comes from the shipped pair\'s platform package, resolved node_modules-first', build.includes('resolvePlatformPackage(ROOT, SHIP.platform, SHIP.arch, rgPackage)') && build.includes("pkg.source === 'node_modules' ? '@vscode/ripgrep'"))
  check('a cross build never falls back to the host\'s system rg', build.includes('if (!rgSource && !forceNoRg && !CROSS)'))
  const voice = read('scripts/vendor/build-voice.ts')
  check('build-voice.ts cross-compiles through the rustup target the owner names, or skips loudly', voice.includes("run('rustup', ['target', 'list', '--installed']") && voice.includes("...(CROSS && TRIPLE ? ['--target', TRIPLE] : [])") && voice.includes('rustup target add ${TRIPLE}'))
  check('build-voice.ts keys the pack on the shipped pair', voice.includes('voicePackPlatform(SHIP.platform, SHIP.arch)') && voice.includes('voiceCargoTriple(PLATFORM)'))
  const whisper = read('scripts/vendor/build-whisper.ts')
  check('build-whisper.ts keys the pack on the shipped pair through the voice pack owner\'s table and cross-compiles through the same rustup target, or skips loudly', whisper.includes('voicePackPlatform(SHIP.platform, SHIP.arch)') && whisper.includes('voiceCargoTriple(PLATFORM)') && whisper.includes("run('rustup', ['target', 'list', '--installed']") && whisper.includes('rustup target add ${TRIPLE}'))
  check('build.ts vendors the on-device transcriber pack of the SHIPPED pair through the same key', build.includes('whisperPackDirFor(ROOT, packPlatform)') && build.includes("['on-device-transcriber']"))
}

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
      const whisperRecord = manifest.onDeviceTranscriber as { vendored?: boolean; platform?: string } | undefined
      check('the on-device transcriber record follows the target', whisperRecord !== undefined && (whisperRecord.vendored !== true || whisperRecord.platform === voicePackPlatform(record.platform, record.arch)), JSON.stringify(whisperRecord))
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
  const fetcher = read('scripts/vendor/fetch-platform-packages.ts')
  check('the fetch verifies the lock\'s integrity before extraction and refuses a mismatch', fetcher.includes('integrityOf(buf)') && fetcher.includes('artifact identity changed') && fetcher.indexOf('integrityOf(buf)') < fetcher.indexOf('extractTarGz('))
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
  check('the package matrix has FOUR arms', pkg.length === 4, pkg.map(triple).join(' · '))
  check('the three existing arms are unchanged (os · target · node_pack, no cross flag)', JSON.stringify(pkg.filter(r => !r.cross).map(triple)) === JSON.stringify(['ubuntu-latest/linux-x64/linux-x64', 'macos-14/macos-arm64/darwin-arm64', 'windows-latest/windows-x64/win-x64']))
  const intel = pkg.find(r => r.target === 'macos-x64')
  check('the Intel arm is cross-packaged on the arm64 runner with the darwin-x64 runtime and the x86_64-apple-darwin rustup target', intel !== undefined && intel.os === 'macos-14' && intel.node_pack === 'darwin-x64' && intel.cross === 'true' && intel.rust_targets === 'x86_64-apple-darwin', intel ? triple(intel) : 'absent')
  check('every arm\'s node pack is the owner\'s projection of its target', pkg.every(r => isReleaseTarget(r.target ?? '') && nodePackPlatform(buildPlatformOf(r.target as never).platform, buildPlatformOf(r.target as never).arch) === r.node_pack))
  check('every arm builds, builds the voice pack and fetches its platform packages for ITS target', wf.includes('bun run build.ts --target ${{ matrix.target }}') && wf.includes('bun run scripts/vendor/build-voice.ts --target ${{ matrix.target }}') && wf.includes('bun run scripts/vendor/fetch-platform-packages.ts --target ${{ matrix.target }}'))
  check('every arm builds the on-device transcriber pack for ITS target, optional like the voice pack', wf.includes('bun run scripts/vendor/build-whisper.ts --target ${{ matrix.target }}') && /name: Build the on-device transcriber pack\n\s+continue-on-error: true/.test(wf))
  check('the rust toolchain step installs the arm\'s rustup targets', wf.includes("targets: ${{ matrix.rust_targets || '' }}"))
  check('a cross arm ensures Rosetta 2 before the packager\'s smoke', /if: matrix\.cross\n\s+run: \|\n\s+arch -x86_64 \/usr\/bin\/true 2>\/dev\/null \|\| sudo softwareupdate --install-rosetta --agree-to-license\n\s+arch -x86_64 \/usr\/bin\/true/.test(wf))
  check('the vendor cache key covers the platform-package fetch and bun.lock', wf.includes("'scripts/vendor/fetch-platform-packages.ts'") && wf.includes("'bun.lock'"))
  const gate = rowsOf('bridge-gate')
  check('the bridge gate has the same four arms', JSON.stringify(gate.map(r => r.target)) === JSON.stringify([...RELEASE_TARGETS]), gate.map(r => r.target).join(', '))
  check('the bridge gate drives the Intel archive under Rosetta and fails on a skip', gate.find(r => r.target === 'macos-x64')?.cross === 'true' && wf.includes('bun run scripts/updater/prove-cross-archive-rosetta.ts --target ${{ matrix.target }} --require'))
  check('the previous-reader bridge gates the arm\'s own target', wf.includes('bun run scripts/updater/prove-release-bridge.ts --target ${{ matrix.target }}'))
  check('the release publishes every tar.gz and zip (the Intel archive rides the same glob)', wf.includes('assets/mercury-*.tar.gz assets/mercury-*.zip assets/SHA256SUMS.txt'))
  check('the dropped-arm words are gone', !wf.includes('DROPPED'))
}

section('§8 the words — the archive README, the release page, the compatibility table')
{
  const templates = read('scripts/release/launcherTemplates.mjs')
  check('the archive README lists macOS x64 (Intel) and no longer says Intel is not packaged', templates.includes('macOS x64 (Intel') && !templates.includes('macOS Intel is not packaged'))
  const notes = read('docs/releases/1.0.0-beta.3.md')
  const intelItem = /\*\*The Intel Mac build\*\*([\s\S]*?)(?=\n\d+\. \*\*|\n\n)/.exec(notes)?.[1] ?? ''
  check('the beta.3 page carries the Intel Mac build as done, naming the archive', intelItem.includes('`macos-x64`') && /\bDone\.\s*$/.test(intelItem) && !/In progress\./.test(intelItem), intelItem.slice(-80))
  const compat = read('docs/COMPATIBILITY.md')
  check('the compatibility table carries the four archives with the Intel row', compat.includes('| `macos-x64` |') && compat.includes('| `macos-arm64` |') && compat.includes('| `linux-x64` |') && compat.includes('| `windows-x64` |'))
}

console.log('')
if (failures === 0) {
  console.log('PASS prove-release-targets')
  process.exit(0)
}
console.log(`FAIL prove-release-targets (${failures})`)
process.exit(1)
