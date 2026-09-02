#!/usr/bin/env bun
// ============================================================================
//  scripts/updater/prove-node-pack.ts — the vendored Node runtime: the fifth
//  pack, so a release install needs only git.
//
//    §1 the lock — one nodejs.org archive + sha256 per platform, the version
//       equal to .node-version, the licence carried
//    §2 the owner — platform keys, binary names, the manifest record decoder,
//       the presence/digest check, the running-runtime classifier and its
//       one-line vocabulary
//    §3 the fetch — the shared tar invocation, the zip ladder, the check
//       mode, the owner imported (never a second spelling of the layout)
//    §4 the build row — the fixed path, the staleness guard, the manifest
//       record, the degraded label, the proof seam
//    §5 the install layout — a payload declaring a runtime must carry it;
//       the --version smoke runs the payload's OWN runtime; an older payload
//       without a record still validates (rollback keeps working)
//    §6 the verifier — the runtime bind at every depth: presence always,
//       the digest at deep, stated as unevaluated at fast
//    §7 the packager + the workflows — the runtime precondition, the
//       no-node-on-PATH smoke, the per-row pack fetch
//    §8 the surfaces — the doctor row, update --status, install --dry-run,
//       the registry row, the notices, the docs, the setup script, the
//       ignore row, the operator launcher's rungs
//
//  Fixture-driven: nothing here downloads. Hermetic by construction (the
//  ambient-state law): every path lives under a mkdtemp outside the repo.
// ============================================================================
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'node-pack '))
process.env.HOME = join(scratch, 'home')
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home', '.mercury')
process.env.MERCURY_VERSIONS_DIR = join(scratch, 'home', '.mercury', 'versions')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_NODE
delete process.env.MERCURY_UPDATE_FAULT

const {
  NODE_PACK_PLATFORMS,
  RUNTIME_PACK_PATH,
  checkVendoredRuntime,
  describeRunningRuntime,
  nodePackPlatform,
  packMembersFor,
  payloadRuntimeLine,
  payloadVendoredRuntime,
  readRuntimeRecord,
  runningBundlePayloadDir,
  runtimeBinaryFor,
  runtimeLine,
} = await import('../../src/services/privateChannel/vendoredRuntime.js')
const { smokeVersion, validatePayloadDir } = await import('../../src/services/privateChannel/installLayout.js')
const { verifyPayloadDir } = await import('../../src/services/privateChannel/artifactVerify.js')

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
const IS_WIN = process.platform === 'win32'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

//
section('§1 the lock — one nodejs.org archive + sha256 per platform')
{
  const lockPath = join(ROOT, 'vendor', 'node.lock.json')
  check('vendor/node.lock.json exists', existsSync(lockPath))
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      name?: string
      version?: string
      license?: string
      licenseFiles?: string[]
      checksums?: string
      platforms?: Record<string, { archive?: string; url?: string; sha256?: string }>
    }
    const calibration = read('.node-version').trim()
    check('the lock names node', lock.name === 'node')
    check(`the lock version equals .node-version (${calibration})`, lock.version === calibration, String(lock.version))
    check('the lock carries the MIT licence and its LICENSE file', lock.license === 'MIT' && JSON.stringify(lock.licenseFiles) === JSON.stringify(['LICENSE']))
    check('the checksum source is that version\'s SHASUMS256.txt on nodejs.org', lock.checksums === `https://nodejs.org/dist/v${calibration}/SHASUMS256.txt`, String(lock.checksums))
    const platforms = Object.keys(lock.platforms ?? {}).sort()
    check('the lock pins exactly the five pack platforms', JSON.stringify(platforms) === JSON.stringify([...NODE_PACK_PLATFORMS].sort()), platforms.join(','))
    const digests = new Set<string>()
    for (const platform of NODE_PACK_PLATFORMS) {
      const p = lock.platforms?.[platform]
      const ext = platform === 'win-x64' ? 'zip' : 'tar.gz'
      const archive = `node-v${calibration}-${platform}.${ext}`
      check(`${platform}: archive is the official ${ext} for the calibration version`, p?.archive === archive, String(p?.archive))
      check(`${platform}: url is the nodejs.org distribution path of that archive`, p?.url === `https://nodejs.org/dist/v${calibration}/${archive}`, String(p?.url))
      check(`${platform}: sha256 is a 64-hex digest`, typeof p?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(p.sha256))
      if (p?.sha256) digests.add(p.sha256)
    }
    check('the five digests are distinct (five different archives)', digests.size === NODE_PACK_PLATFORMS.length)
  }
}

//
section('§2 the owner — platform keys, binaries, the record, the check, the classifier')
{
  check('darwin/arm64 → darwin-arm64', nodePackPlatform('darwin', 'arm64') === 'darwin-arm64')
  check('darwin/x64 → darwin-x64', nodePackPlatform('darwin', 'x64') === 'darwin-x64')
  check('linux/x64 → linux-x64', nodePackPlatform('linux', 'x64') === 'linux-x64')
  check('linux/arm64 → linux-arm64', nodePackPlatform('linux', 'arm64') === 'linux-arm64')
  check('win32/x64 → win-x64', nodePackPlatform('win32', 'x64') === 'win-x64')
  check('unpublished pairs answer null (freebsd/x64 · win32/arm64 · linux/ia32)', nodePackPlatform('freebsd', 'x64') === null && nodePackPlatform('win32', 'arm64') === null && nodePackPlatform('linux', 'ia32') === null)
  check('the pack path is the fixed vendor/node', RUNTIME_PACK_PATH === 'vendor/node')
  check('the binary is bin/node on every POSIX pack and node.exe on win-x64', NODE_PACK_PLATFORMS.every(p => runtimeBinaryFor(p) === (p === 'win-x64' ? 'node.exe' : 'bin/node')))
  check('the pack members are the binary + LICENSE, nothing else (no npm, no headers)', NODE_PACK_PLATFORMS.every(p => JSON.stringify(packMembersFor(p)) === JSON.stringify([runtimeBinaryFor(p), 'LICENSE'])))

  const good = {
    vendored: true,
    path: 'vendor/node',
    binary: 'bin/node',
    name: 'node',
    version: '9.9.0',
    platform: 'linux-x64',
    license: 'MIT',
    archiveSha256: 'a'.repeat(64),
    binarySha256: 'b'.repeat(64),
  }
  check('a vendored record decodes whole', JSON.stringify(readRuntimeRecord({ runtime: good })) === JSON.stringify(good))
  check('an absent-runtime record decodes as vendored:false with its remedy', (() => { const r = readRuntimeRecord({ runtime: { vendored: false, path: 'vendor/node', remedy: 'fetch it' } }); return r !== null && r.vendored === false && r.remedy === 'fetch it' })())
  check('a manifest without a record answers null (an older build)', readRuntimeRecord({ schema: 2, version: '1.0.0' }) === null)
  check('a vendored record with a bad digest answers null (no half claim)', readRuntimeRecord({ runtime: { ...good, binarySha256: 'zz' } }) === null)
  check('a vendored record on an unknown platform answers null', readRuntimeRecord({ runtime: { ...good, platform: 'plan9-mips' } }) === null)
  check('a vendored record with a foreign name answers null', readRuntimeRecord({ runtime: { ...good, name: 'deno' } }) === null)
  check('garbage answers null', readRuntimeRecord(null) === null && readRuntimeRecord('x') === null && readRuntimeRecord({ runtime: 7 }) === null)

  const payload = join(scratch, 'owner-payload')
  const bytes = '#!/bin/sh\necho fixture\n'
  mkdirSync(join(payload, 'vendor', 'node', 'bin'), { recursive: true })
  writeFileSync(join(payload, 'vendor', 'node', 'bin', 'node'), bytes)
  const record = { ...good, binarySha256: sha256(bytes) }
  check('presence check: ok when the binary is on disk', checkVendoredRuntime(payload, record).state === 'ok')
  check('digest check: ok when the bytes match the record', checkVendoredRuntime(payload, record, { digest: true }).state === 'ok')
  const drifted = checkVendoredRuntime(payload, { ...record, binarySha256: 'c'.repeat(64) }, { digest: true })
  check('digest check: mismatch names the runtime and both digests', drifted.state === 'mismatch' && drifted.note.includes('vendor/node/bin/node') && drifted.note.includes('cccccccccccc'))
  check('presence check alone never reads the bytes (a drifted record still passes it)', checkVendoredRuntime(payload, { ...record, binarySha256: 'c'.repeat(64) }).state === 'ok')
  const absent = checkVendoredRuntime(join(scratch, 'nowhere'), record)
  check('presence check: absent names the declared path', absent.state === 'absent' && absent.note.includes('vendor/node/bin/node'))
  writeFileSync(join(payload, 'manifest.json'), JSON.stringify({ version: '9.9.0', runtime: record }) + '\n')
  const carried = payloadVendoredRuntime(payload)
  check('payloadVendoredRuntime reads the manifest and resolves the binary', carried !== null && carried.binaryPath === join(payload, 'vendor', 'node', 'bin', 'node'))
  check('payloadVendoredRuntime answers null for a payload without a manifest', payloadVendoredRuntime(join(scratch, 'nowhere')) === null)
  check('runningBundlePayloadDir: a bundle path answers its directory, a source path answers null', runningBundlePayloadDir('/x/y/mercury.mjs') === '/x/y' && runningBundlePayloadDir('/x/src/entrypoints/cli.tsx') === null && runningBundlePayloadDir(undefined) === null)

  const binaryPath = join(payload, 'vendor', 'node', 'bin', 'node')
  const vendoredRun = describeRunningRuntime({ payloadDir: payload, execPath: binaryPath, execVersion: '9.9.0', explicitNode: null, isWindows: false })
  check('classifier: the vendored binary running ⇒ source vendored, inUse', vendoredRun.source === 'vendored' && vendoredRun.vendored?.inUse === true)
  check('vocabulary: "vendored node <v> (vendor/node)"', runtimeLine(vendoredRun) === 'vendored node 9.9.0 (vendor/node)')
  const explicitRun = describeRunningRuntime({ payloadDir: payload, execPath: '/opt/other/node', execVersion: '9.9.1', explicitNode: '/opt/other/node', isWindows: false })
  check('classifier: MERCURY_NODE running ⇒ source explicit, the vendored one present but not in use', explicitRun.source === 'explicit' && explicitRun.vendored?.inUse === false)
  check('vocabulary: the explicit line names MERCURY_NODE and the idle vendored runtime', runtimeLine(explicitRun) === 'explicit node 9.9.1 (MERCURY_NODE; vendored node 9.9.0 present at vendor/node, not in use)')
  const systemRun = describeRunningRuntime({ payloadDir: payload, execPath: '/usr/local/bin/node', execVersion: '9.9.2', explicitNode: null, isWindows: false })
  check('classifier: a PATH node running beside an idle vendored one ⇒ system, vendored present', systemRun.source === 'system' && systemRun.vendored?.inUse === false)
  check('vocabulary: the system line names the idle vendored runtime', runtimeLine(systemRun) === 'system node 9.9.2 (vendored node 9.9.0 present at vendor/node, not in use)')
  const bare = describeRunningRuntime({ payloadDir: null, execPath: '/usr/local/bin/node', execVersion: '9.9.3', explicitNode: null, isWindows: false })
  check('classifier: no payload ⇒ system, no vendored runtime', bare.source === 'system' && bare.vendored === null)
  check('vocabulary: "system node <v> (no vendored runtime)"', runtimeLine(bare) === 'system node 9.9.3 (no vendored runtime)')
  check('the explicit rung with a MERCURY_NODE that is NOT the running binary is not claimed', describeRunningRuntime({ payloadDir: null, execPath: '/usr/local/bin/node', execVersion: '9.9.3', explicitNode: '/opt/elsewhere/node', isWindows: false }).source === 'system')
  check('payloadRuntimeLine names version, path and platform', payloadRuntimeLine(payload) === 'vendored node 9.9.0 (vendor/node/bin/node, linux-x64)')
  check('payloadRuntimeLine says "none carried" without a record', payloadRuntimeLine(join(scratch, 'nowhere')).startsWith('none carried'))
}

//
section('§3 the fetch — one tar invocation, the zip ladder, --check, the owner imported')
{
  const fetcher = read('scripts/vendor/fetch-node.ts')
  check('the fetch extracts tarballs through the shared dialect-proof helper', fetcher.includes("from './tarExtract.ts'") && !fetcher.includes("spawnSync('tar'"))
  check('the fetch imports the layout from the owner (never a second spelling)', fetcher.includes("from '../../src/services/privateChannel/vendoredRuntime.ts'") && fetcher.includes('runtimeBinaryFor(') && fetcher.includes('packMembersFor(') && fetcher.includes('nodePackPlatform('))
  check('the fetch carries --check · --force · --platform · --all', ['--check', '--force', '--platform', '--all'].every(f => fetcher.includes(`'${f}'`)))
  check('the zip ladder starts unzip · python3 and reaches tar.exe (a stock Windows host)', fetcher.indexOf("name: 'unzip'") !== -1 && fetcher.indexOf("name: 'unzip'") < fetcher.indexOf("name: 'python3'") && fetcher.includes("name: 'tar.exe'"))
  check('the fetch refuses a lock url off nodejs.org', fetcher.includes("startsWith('https://nodejs.org/dist/')"))
  check('the fetch verifies sha256 BEFORE writing the archive', fetcher.indexOf('digest !== pinned.sha256') !== -1 && fetcher.indexOf('digest !== pinned.sha256') < fetcher.indexOf('writeFileSync(archivePath, buf)'))
  check('an unpublished host is an honest exit 0, never a silent success', fetcher.includes('publishes no runtime archive') && fetcher.includes('process.exit(0)'))
  check('the cache layout: archive/ + extracted/<platform>/ + the vendor manifest', fetcher.includes("join(CACHE_DIR, 'archive')") && fetcher.includes("join(CACHE_DIR, 'extracted')") && fetcher.includes(".vendor-manifest.json"))
  check('the fetch is chained into `bun run setup`', (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts.setup.includes('bun run scripts/vendor/fetch-node.ts'))
  check('the vendor cache is ignored like the other four', read('.gitignore').split('\n').includes('vendor/node/'))
}

//
section('§4 the build row — fixed path, staleness guard, manifest record, degraded label')
{
  const build = read('build.ts')
  check('build.ts imports the owner for the path + platform + binary', build.includes("await import('./src/services/privateChannel/vendoredRuntime.ts')"))
  check('build.ts reads vendor/node.lock.json and the host platform\'s cache', build.includes("'vendor', 'node.lock.json'") && build.includes("'vendor', 'node', 'extracted', hostPlatform"))
  check('a PRESENT-but-stale cache fails the build naming the fetch (the vendor-staleness law)', build.includes('vendor/node cache does not match vendor/node.lock.json') && build.includes('remedy: bun run scripts/vendor/fetch-node.ts'))
  check('the manifest carries the runtime record (version · platform · both digests)', build.includes('runtime: nodeVendored && nodeMeta') && build.includes('binarySha256: createHash') && build.includes('archiveSha256: pinned.sha256'))
  check("absence degrades as 'runtime'", build.includes("...(nodeVendored ? [] : ['runtime'])"))
  check('the proof seam MERCURY_BUILD_NO_VENDOR_NODE forces the degraded arm', build.includes("process.env.MERCURY_BUILD_NO_VENDOR_NODE === '1'"))
  check('the shipped binary is chmod 755 on POSIX', build.includes("if (process.platform !== 'win32') chmodSync(shipped, 0o755)"))
}

//
section('§5 the install layout — carried, smoked on its own runtime, older payloads still valid')
if (IS_WIN) {
  console.log('  [SKIP] sh fixture runtimes — POSIX hosts only (the windows-launcher lane drives the shipped node.exe)')
} else {
  const marker = join(scratch, 'runtime.ran')
  const fixtureRuntime = `#!/bin/sh\nprintf 'ran\\n' >> "${marker}"\nexec "${process.execPath}" "$@"\n`
  const makePayload = (dir: string, version: string, opts: { runtime?: 'carried' | 'declared-but-missing' | 'none' } = {}): void => {
    mkdirSync(join(dir, 'vendor', 'ripgrep', 'stub'), { recursive: true })
    writeFileSync(join(dir, 'vendor', 'ripgrep', 'stub', 'rg'), 'stub\n')
    writeFileSync(join(dir, 'mercury.mjs'), `import { readFileSync } from 'node:fs'\nconst m = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'))\nconsole.log('Mercury ' + m.version)\n`)
    writeFileSync(join(dir, 'mercury'), '#!/bin/sh\nexec node "$(dirname "$0")/mercury.mjs" "$@"\n')
    chmodSync(join(dir, 'mercury'), 0o755)
    const mode = opts.runtime ?? 'carried'
    const manifest: Record<string, unknown> = { schema: 2, version, bundle: 'mercury.mjs' }
    if (mode !== 'none') {
      manifest.runtime = {
        vendored: true,
        path: 'vendor/node',
        binary: 'bin/node',
        name: 'node',
        version: '9.9.0',
        platform: 'linux-x64',
        license: 'MIT',
        archiveSha256: 'a'.repeat(64),
        binarySha256: sha256(fixtureRuntime),
      }
    }
    if (mode === 'carried') {
      mkdirSync(join(dir, 'vendor', 'node', 'bin'), { recursive: true })
      writeFileSync(join(dir, 'vendor', 'node', 'bin', 'node'), fixtureRuntime)
      chmodSync(join(dir, 'vendor', 'node', 'bin', 'node'), 0o755)
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest) + '\n')
  }
  const carried = join(scratch, 'payload-carried')
  makePayload(carried, '9.9.0-beta.1')
  check('a payload that declares AND carries its runtime validates', validatePayloadDir(carried).state === 'ok')
  const missing = join(scratch, 'payload-declared-missing')
  makePayload(missing, '9.9.0-beta.1', { runtime: 'declared-but-missing' })
  const refused = validatePayloadDir(missing)
  check('a payload that declares a runtime it does not carry is refused by name', refused.state === 'invalid' && refused.note.includes('vendored runtime missing') && refused.note.includes('vendor/node/bin/node'))
  const older = join(scratch, 'payload-older')
  makePayload(older, '9.9.0-beta.1', { runtime: 'none' })
  check('a payload without a runtime record still validates (rollback to an older release keeps working)', validatePayloadDir(older).state === 'ok')
  rmSync(marker, { force: true })
  const smoked = smokeVersion(carried, '9.9.0-beta.1')
  check('the --version smoke runs on the payload\'s OWN runtime', smoked.state === 'ok' && existsSync(marker), smoked.state === 'failed' ? smoked.note : '')
  rmSync(marker, { force: true })
  const smokedOlder = smokeVersion(older, '9.9.0-beta.1')
  check('a payload without a runtime smokes on the running process\'s node', smokedOlder.state === 'ok' && !existsSync(marker), smokedOlder.state === 'failed' ? smokedOlder.note : '')
  const broken = join(scratch, 'payload-broken-runtime')
  makePayload(broken, '9.9.0-beta.1')
  writeFileSync(join(broken, 'vendor', 'node', 'bin', 'node'), '#!/bin/sh\necho "this runtime cannot run here" >&2\nexit 3\n')
  check('a carried runtime that cannot run fails the smoke (the release is refused before activation)', smokeVersion(broken, '9.9.0-beta.1').state === 'failed')
  check('the dry-run runtime line reads the carried runtime', payloadRuntimeLine(carried) === 'vendored node 9.9.0 (vendor/node/bin/node, linux-x64)')

  //
  section('§6 the verifier — presence at every depth, the digest at deep')
  {
    const fast = verifyPayloadDir(carried, { depth: 'fast' })
    check('intact + unsigned at fast: unsigned, with the runtime digest named unevaluated', fast.verdict.state === 'unsigned' && fast.unevaluated.some(u => u.includes('vendored runtime')))
    const deep = verifyPayloadDir(carried, { depth: 'deep' })
    check('intact + unsigned at deep: unsigned, nothing left unevaluated', deep.verdict.state === 'unsigned' && deep.unevaluated.length === 0)
    check('an older payload (no record) names no runtime among the unevaluated', !verifyPayloadDir(older, { depth: 'fast' }).unevaluated.some(u => u.includes('vendored runtime')))
    const corrupt = join(scratch, 'payload-corrupt-runtime')
    makePayload(corrupt, '9.9.0-beta.1')
    writeFileSync(join(corrupt, 'vendor', 'node', 'bin', 'node'), fixtureRuntime + '# a flipped byte\n')
    const corruptDeep = verifyPayloadDir(corrupt, { depth: 'deep' })
    check('a runtime whose bytes drift from the record is TAMPERED at deep, naming the runtime', corruptDeep.verdict.state === 'tampered' && corruptDeep.verdict.note.includes('vendor/node/bin/node'))
    check('the same drift passes fast (the stated depth limit — presence only)', verifyPayloadDir(corrupt, { depth: 'fast' }).verdict.state === 'unsigned')
    const gone = verifyPayloadDir(missing, { depth: 'fast' })
    check('a declared runtime that is absent is TAMPERED at fast (presence is bound at every depth)', gone.verdict.state === 'tampered' && gone.verdict.note.includes('absent'))
  }
}

//
section('§7 the packager + the workflows')
{
  const packager = read('scripts/release/package.mjs')
  check('the packager refuses a dist whose runtime platform is not the target\'s', packager.includes('TARGET_NODE_PACK') && packager.includes('runtime.platform !== TARGET_NODE_PACK'))
  check('the packager requires the declared binary on disk', packager.includes('declares the vendored runtime at'))
  check('the smoke boots --version with NO node on PATH (a trap node on POSIX, System32-only on Windows)', packager.includes('with NO node on PATH') && packager.includes('the PATH node must not be used') && packager.includes('System32'))
  check('the smoke drives a missing MERCURY_NODE and requires all three rungs named', packager.includes("MERCURY_NODE: join(smoke, 'no-such-node')") && packager.includes("refusal.includes('MERCURY_NODE')") && packager.includes("refusal.includes('PATH')"))
  check('the smoke asserts the shipped manifest carries the runtime record', packager.includes('does not carry the vendored runtime record'))
  check('the Windows PATH override writes exactly one Path key (the duplicate-key class)', packager.includes("k.toUpperCase() === 'PATH'"))

  const release = read('.github/workflows/private-release.yml')
  check('private-release fetches the node pack per matrix row', release.includes('bun run scripts/vendor/fetch-node.ts --platform ${{ matrix.node_pack }}'))
  for (const [target, pack] of [['linux-x64', 'linux-x64'], ['macos-arm64', 'darwin-arm64'], ['windows-x64', 'win-x64']] as const) {
    check(`private-release row ${target} ships the ${pack} pack`, new RegExp(`target: ${target}\\n\\s+node_pack: ${pack}`).test(release))
  }
  check('private-release fetches js-debug too (a hosted release ships every pack)', release.includes('bun run scripts/vendor/fetch-js-debug.ts'))
  check('the private-release vendor cache key covers the node lock + fetch', release.includes("'scripts/vendor/fetch-node.ts'") && release.includes("'vendor/node.lock.json'"))
  for (const wf of ['windows-launcher.yml', 'windows-ui.yml']) {
    const text = read(`.github/workflows/${wf}`)
    check(`${wf} fetches the win-x64 pack (it packages the shipped archive)`, text.includes('bun run scripts/vendor/fetch-node.ts --platform win-x64') && text.includes("'vendor/node.lock.json'"))
  }
}

//
section('§8 the surfaces — doctor, status, dry-run, registry, notices, docs, launcher')
{
  const health = read('src/utils/healthReport.ts')
  check('the doctor runtime row classifies the running node through the owner', health.includes("const { runningRuntime } = await import('../services/privateChannel/updateService.js')") && health.includes('runtimeLine(which)'))
  const update = read('src/cli/update.ts')
  check('update --status prints the runtime line', update.includes('`runtime:           ${statusRuntimeLine(status)}`'))
  const install = read('src/cli/installVerb.ts')
  check('install --dry-run prints the runtime the payload carries', install.includes('`runtime:               ${described.runtime}`'))
  const service = read('src/services/privateChannel/updateService.ts')
  check('the running runtime reads MERCURY_NODE through the registry reader', service.includes("flagEnv('MERCURY_NODE')"))
  const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.js')
  const row = FLAG_REGISTRY.find(f => f.env === 'MERCURY_NODE')
  check('MERCURY_NODE is registered as a value knob naming the three rungs', row !== undefined && row.kind === 'value' && row.summary.includes('vendor/node') && row.summary.includes('PATH'))
  const notices = read('THIRD_PARTY_NOTICES.md')
  check('THIRD_PARTY_NOTICES names the Node.js runtime with its receipt', notices.includes('**Node.js runtime**') && notices.includes('vendor/node.lock.json'))
  check('the notices generator reads the node lock', read('scripts/distribution/generate-third-party-notices.ts').includes("vendorLock('node.lock.json')"))
  const readme = read('README.md')
  check('README: a release install needs git only', readme.includes('A release install needs git only'))
  check('README: five vendored packs', readme.includes('the five vendored packs'))
  const agents = read('AGENTS.md')
  check('AGENTS.md: a release install needs git only, and stays under 80 lines', agents.includes('A release install needs `git` only') && agents.split('\n').length <= 80, `${agents.split('\n').length} split parts`)
  check('CONTRIBUTING: five vendored packs', read('CONTRIBUTING.md').includes('the five vendored packs'))
  check('the Windows guide lists the node fetch', read('docs/INSTALL-WINDOWS-FROM-SOURCE.md').includes('bun run scripts/vendor/fetch-node.ts'))
  const terminal = read('docs/TERMINAL-RUNTIME.md')
  check('TERMINAL-RUNTIME names the three rungs', terminal.includes('MERCURY_NODE') && terminal.includes('vendor/node/bin/node'))
  check('BUILD-NOTES documents the pack and its proof seam', read('BUILD-NOTES.md').includes('MERCURY_BUILD_NO_VENDOR_NODE'))
  const ops = read('scripts/ops/launcher-mercury.sh')
  const opsLive = ops.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
  check('the operator launcher resolves the three rungs in order', opsLive.indexOf('MERCURY_NODE') !== -1 && opsLive.indexOf('MERCURY_NODE') < opsLive.indexOf('vendor/node/bin/node') && opsLive.indexOf('vendor/node/bin/node') < opsLive.indexOf('command -v node'))
  check('the operator launcher boots every node start through the resolved binary', !/^\s*node /m.test(opsLive) && !opsLive.includes(' node "$MERCURY_DIST"') && opsLive.includes('"$MERCURY_NODE_BIN" "$MERCURY_DIST"'))
  check('the operator launcher\'s no-rung refusal names all three', ops.includes('none of the three rungs answered'))
}

rmSync(scratch, { recursive: true, force: true })
console.log('')
if (failures === 0) {
  console.log('PASS prove-node-pack')
  process.exit(0)
}
console.log(`FAIL prove-node-pack (${failures})`)
process.exit(1)
