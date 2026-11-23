#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rulesIgnore } from '../lib/treeIgnore.ts'

if (!process.env.MERCURY_PROOF_LAYOUT_SCRATCH) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'node-pack ')))
  const userHome = join(scratch, 'home')
  const configDir = join(userHome, '.mercury')
  const localAppData = join(userHome, 'AppData', 'Local')
  const appData = join(userHome, 'AppData', 'Roaming')
  for (const d of [userHome, configDir, localAppData, appData]) mkdirSync(d, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_PROOF_LAYOUT_SCRATCH: scratch,
    HOME: userHome,
    USERPROFILE: userHome,
    LOCALAPPDATA: localAppData,
    APPDATA: appData,
    XDG_CONFIG_HOME: join(userHome, '.config'),
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_VERSIONS_DIR: join(configDir, 'versions'),
  }
  delete env.MERCURY_HOME
  delete env.HOMEDRIVE
  delete env.HOMEPATH
  delete env.MERCURY_NODE
  delete env.MERCURY_UPDATE_FAULT
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env })
    process.exit(child.status ?? 1)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const scratch = process.env.MERCURY_PROOF_LAYOUT_SCRATCH!
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
} = await import('../../src/platform/update-channel/vendoredRuntime.js')
const { resolveLayoutRoots, smokeVersion, validatePayloadDir } = await import('../../src/platform/update-channel/installLayout.js')
const { verifyPayloadDir } = await import('../../src/platform/update-channel/artifactVerify.js')

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
const IS_WIN = process.platform === 'win32'

let failures = 0
const packFixHint = 'change the owner src/platform/update-channel/vendoredRuntime.ts for platform, record and runtime-line checks, src/platform/update-channel/installLayout.ts and artifactVerify.ts for the payload checks of sections 5 and 6, vendor/node.lock.json and scripts/vendor/fetch-node.ts for the lock checks, .github/workflows/private-release.yml for the workflow checks'
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond ? '' : ` — ${detail ? `${detail}; ` : ''}${packFixHint}`}`)
  if (!cond) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

{
  const roots = resolveLayoutRoots()
  const base = resolve(scratch)
  for (const p of [roots.versionsDir, roots.binDir, roots.shimPath, ...(roots.shimSetPaths ?? [])]) {
    const rel = relative(base, resolve(p))
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      console.log(`  [FAIL] SAFETY: resolved layout root escapes scratch: ${p}`)
      process.exit(1)
    }
  }
  check('every resolved layout root lies under scratch', true)
}
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
      const ext = platform.startsWith('win-') ? 'zip' : 'tar.gz'
      const archive = `node-v${calibration}-${platform}.${ext}`
      check(`${platform}: archive is the official ${ext} for the calibration version`, p?.archive === archive, String(p?.archive))
      check(`${platform}: url is the nodejs.org distribution path of that archive`, p?.url === `https://nodejs.org/dist/v${calibration}/${archive}`, String(p?.url))
      check(`${platform}: sha256 is a 64-hex digest`, typeof p?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(p.sha256))
      if (p?.sha256) digests.add(p.sha256)
    }
    check('the five digests are distinct (five different archives)', digests.size === NODE_PACK_PLATFORMS.length)
  }
}

section('§2 the owner — platform keys, binaries, the record, the check, the classifier')
{
  check('darwin/arm64 → darwin-arm64', nodePackPlatform('darwin', 'arm64') === 'darwin-arm64')
  check('darwin/x64 → darwin-x64', nodePackPlatform('darwin', 'x64') === 'darwin-x64')
  check('linux/x64 → linux-x64', nodePackPlatform('linux', 'x64') === 'linux-x64')
  check('linux/arm64 → linux-arm64', nodePackPlatform('linux', 'arm64') === 'linux-arm64')
  check('win32/x64 → win-x64', nodePackPlatform('win32', 'x64') === 'win-x64')
  check('win32/arm64 → win-arm64', nodePackPlatform('win32', 'arm64') === 'win-arm64')
  check('unpublished pairs answer null (freebsd/x64 · linux/ia32 · linux/riscv64)', nodePackPlatform('freebsd', 'x64') === null && nodePackPlatform('linux', 'ia32') === null && nodePackPlatform('linux', 'riscv64') === null)
  check('the pack path is the fixed vendor/node', RUNTIME_PACK_PATH === 'vendor/node')
  check('the binary is bin/node on every POSIX pack and node.exe on both Windows packs', NODE_PACK_PLATFORMS.every(p => runtimeBinaryFor(p) === (p.startsWith('win-') ? 'node.exe' : 'bin/node')))
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
  check('runningBundlePayloadDir: a bundle path answers its directory, a source path answers null', runningBundlePayloadDir('/x/y/mercury.mjs') === '/x/y' && runningBundlePayloadDir('/x/src/boot/entrypoints/cli.tsx') === null && runningBundlePayloadDir(undefined) === null)

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

section('§3 the fetch — one tar invocation, the zip ladder, --check, the owner imported')
{
  check('the fetch is chained into `bun run setup`', (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts.setup.includes('bun run scripts/vendor/fetch-node.ts'))
  check('the vendor cache is ignored like the other four', rulesIgnore(join(ROOT, '.gitignore'), ['vendor/node'])[0] === true)
}


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

section('§7 the packager + the workflows')
{

  const release = read('.github/workflows/private-release.yml')
  check('private-release fetches the node pack per matrix row', release.includes('bun run scripts/vendor/fetch-node.ts --platform ${{ matrix.node_pack }}'))
  for (const [target, pack] of [['linux-x64', 'linux-x64'], ['macos-arm64', 'darwin-arm64'], ['macos-x64', 'darwin-x64'], ['windows-x64', 'win-x64']] as const) {
    check(`private-release row ${target} ships the ${pack} pack`, new RegExp(`target: ${target}\\n\\s+node_pack: ${pack}`).test(release))
  }
  check('private-release fetches js-debug too (a hosted release ships every pack)', release.includes('bun run scripts/vendor/fetch-js-debug.ts'))
  check('the private-release vendor cache key covers the node lock + fetch', release.includes("'scripts/vendor/fetch-node.ts'") && release.includes("'vendor/node.lock.json'"))
  for (const wf of ['windows-launcher.yml', 'windows-ui.yml']) {
    const text = read(`.github/workflows/${wf}`)
    check(`${wf} fetches the win-x64 pack (it packages the shipped archive)`, text.includes('bun run scripts/vendor/fetch-node.ts --platform win-x64') && text.includes("'vendor/node.lock.json'"))
  }
}

section('§8 the surfaces — health, status, dry-run, registry, notices, docs, launcher')
{
  const { runtimeChecks } = await import('../../src/platform/health/sections/runtime.ts')
  const { runningRuntime: runningNow } = await import('../../src/platform/update-channel/updateService.ts')
  const { runtimeLine: lineOfRuntime } = await import('../../src/platform/update-channel/vendoredRuntime.ts')
  const nodeSays = await runtimeChecks().find(row => row.id === 'runtime')?.run()
  check('/health runtime row classifies the running node through the owner', nodeSays?.evidence.startsWith(lineOfRuntime(runningNow())) === true, nodeSays?.evidence)
  const { FLAG_REGISTRY } = await import('../../src/platform/substrate/flagRegistry.js')
  const row = FLAG_REGISTRY.find(f => f.env === 'MERCURY_NODE')
  check('MERCURY_NODE is registered as a value knob naming the three rungs', row !== undefined && row.kind === 'value' && row.summary.includes('vendor/node') && row.summary.includes('PATH'))
  const notices = read('THIRD_PARTY_NOTICES.md')
  check('THIRD_PARTY_NOTICES names the Node.js runtime with its receipt', notices.includes('**Node.js runtime**') && notices.includes('vendor/node.lock.json'))
}

rmSync(scratch, { recursive: true, force: true })
console.log('')
if (failures === 0) {
  console.log('PASS prove-node-pack')
  process.exit(0)
}
console.log(`FAIL prove-node-pack (${failures})`)
process.exit(1)
