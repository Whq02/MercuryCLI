#!/usr/bin/env node
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cmdLauncher, installingDoc, parseEnginesNode, posixLauncher, ps1Launcher, readmeFirst, updatingDoc } from './launcherTemplates.mjs'
import { readCompatFloor, releaseLayoutSection, topAllowlist } from './payloadContract.mjs'
import { collectVerifyReceiptFacts, decideVerifyReceiptBind, readLedgerRows } from './verifyReceiptBind.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argTarget = process.argv.indexOf('--target')
const TARGET = argTarget !== -1 ? process.argv[argTarget + 1] : null
const KNOWN = ['linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64']
if (!TARGET || !KNOWN.includes(TARGET)) {
  console.error(`package.mjs: --target must be one of ${KNOWN.join(', ')}`)
  process.exit(2)
}
const IS_WIN = TARGET === 'windows-x64'
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const VERSION = PKG.version
const NODE_POLICY = parseEnginesNode(PKG.engines?.node)
const NAME = `mercury-v${VERSION}-${TARGET}`

const fail = (msg) => {
  console.error(`✗ ${msg}`)
  process.exit(1)
}
const ok = (msg) => console.log(`  · ${msg}`)

const dist = join(ROOT, 'dist')
if (!existsSync(join(dist, 'mercury.mjs'))) fail('dist/mercury.mjs missing — run bun run build.ts first')
if (!existsSync(join(dist, 'manifest.json'))) fail('dist/manifest.json missing')
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
const degraded = Array.isArray(manifest.degraded) ? manifest.degraded : []
const PUBLISHABLE_DEGRADATIONS = new Set(['voice-input'])
const blocking = degraded.filter(d => !PUBLISHABLE_DEGRADATIONS.has(d))
if (blocking.length > 0 && !process.argv.includes('--allow-degraded')) {
  fail(`dist manifest is DEGRADED (${blocking.join(', ')}) — run the scripts/vendor/fetch-*.ts commands and rebuild, or pass --allow-degraded deliberately`)
}
if (degraded.includes('voice-input')) ok('the voice capture pack is absent from this build — the archive ships without voice input (degraded: voice-input, publishable)')
const rgDirs = existsSync(join(dist, 'vendor', 'ripgrep')) ? readdirSync(join(dist, 'vendor', 'ripgrep')) : []
if (rgDirs.length === 0) fail('dist/vendor/ripgrep missing — the build must vendor the platform rg')
const TARGET_NODE_PACK = { 'linux-x64': 'linux-x64', 'macos-arm64': 'darwin-arm64', 'macos-x64': 'darwin-x64', 'windows-x64': 'win-x64' }[TARGET]
const runtime = manifest.runtime && manifest.runtime.vendored === true ? manifest.runtime : null
if (runtime) {
  if (runtime.platform !== TARGET_NODE_PACK) fail(`dist carries a ${runtime.platform} Node runtime but --target ${TARGET} ships ${TARGET_NODE_PACK} — build on the target platform`)
  const runtimeBinary = join(dist, ...runtime.path.split('/'), ...runtime.binary.split('/'))
  if (!existsSync(runtimeBinary)) fail(`dist manifest declares the vendored runtime at ${runtime.path}/${runtime.binary} but the file is missing — rebuild`)
}
ok(`packaging ${NAME} (rg: ${rgDirs.join(', ')}; runtime: ${runtime ? `node ${runtime.version} ${runtime.platform}` : 'NONE (degraded — the launchers fall back to MERCURY_NODE or a PATH node)'})`)

const LEDGER_FILE = 'scripts/gate/gate-ledger.jsonl'
const verifyReceipts = {}
{
  const ledgerPath = join(ROOT, LEDGER_FILE)
  const rows = existsSync(ledgerPath) ? readLedgerRows(readFileSync(ledgerPath, 'utf8')) : []
  const decision = decideVerifyReceiptBind(collectVerifyReceiptFacts(ROOT, manifest.buildTree, rows))
  if (decision.ok) {
    const b = decision.bound
    verifyReceipts[LEDGER_FILE] = { commit: b.commit, codeTree: b.codeTree, kind: b.kind, runId: b.runId ?? null, recordedAt: b.recordedAt, suites: Array.isArray(b.shardResults) ? b.shardResults.length : undefined }
    ok(`gate-ledger bind: ${b.kind} verdict at ${b.commit.slice(0, 12)} covers the staged tree (${decision.arm})`)
  } else if (decision.reason === 'stale-dist') {
    fail(`the staged dist is STALE: ${decision.detail} — run bun run build.ts first (no escape covers a bundle that is not this checkout's content)`)
  } else if (process.argv.includes('--allow-stale-verify-receipts')) {
    ok(`gate-ledger bind MISSING (allowed): ${decision.detail}`)
  } else {
    fail(`${decision.detail} — run the full pool at this tree and record it (bun scripts/gate/ledger.ts record --kind local --verdict <verdict.json>), or pass --allow-stale-verify-receipts deliberately`)
  }
}

const stage = mkdtempSync(join(tmpdir(), 'mercury-pkg-'))
const pkgDir = join(stage, 'mercury')
mkdirSync(pkgDir, { recursive: true })
cpSync(join(dist, 'mercury.mjs'), join(pkgDir, 'mercury.mjs'))
cpSync(join(dist, 'manifest.json'), join(pkgDir, 'manifest.json'))
cpSync(join(dist, 'vendor'), join(pkgDir, 'vendor'), { recursive: true })

const FLOOR = readCompatFloor()

const splashSrc = join(ROOT, 'assets', 'splash', 'mercury-splash.mjs')
const splashCoreSrc = join(ROOT, 'assets', 'splash', 'splash-core.mjs')
if (!existsSync(splashSrc)) fail('assets/splash/mercury-splash.mjs missing — the enter screen must ship')
if (!existsSync(splashCoreSrc)) fail('assets/splash/splash-core.mjs missing — the splash ships as a pair')
for (const f of [splashSrc, splashCoreSrc]) {
  try {
    execFileSync('node', ['--check', f], { stdio: 'pipe' })
  } catch (e) {
    fail(`splash pair failed node --check (${f}): ${e.stderr?.toString().slice(0, 200) ?? e.message}`)
  }
}
cpSync(splashSrc, join(pkgDir, 'splash.mjs'))
cpSync(splashCoreSrc, join(pkgDir, 'splash-core.mjs'))

const verifierSrc = join(dist, 'verify-artifact.mjs')
if (!existsSync(verifierSrc)) fail('dist/verify-artifact.mjs missing — run bun run build.ts (the build produces the shipped verifier)')
try {
  execFileSync('node', ['--check', verifierSrc], { stdio: 'pipe' })
} catch (e) {
  fail(`verify-artifact.mjs failed node --check: ${e.stderr?.toString().slice(0, 200) ?? e.message}`)
}
cpSync(verifierSrc, join(pkgDir, 'verify-artifact.mjs'))

const POSIX_LAUNCHER = posixLauncher(NODE_POLICY)

const CMD_LAUNCHER = cmdLauncher(NODE_POLICY)

const PS1_LAUNCHER = ps1Launcher(NODE_POLICY)

const INSTALL_SH = `#!/bin/sh
# Optional convenience: runs \`mercury install\` (the user-local installer).
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$dir/mercury" install "$@"
`

const INSTALL_PS1 = `# Optional convenience: runs \`mercury install\` (the user-local installer).
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $dir 'mercury.cmd') install @args
exit $LASTEXITCODE
`

const README_FIRST = readmeFirst(NODE_POLICY, VERSION)
const INSTALLING_MD = installingDoc(NODE_POLICY, VERSION)
const UPDATING_MD = updatingDoc(NODE_POLICY, VERSION)

const { releaseNotesFor } = await import('./notesFromChangelog.mjs')
const RELEASE_NOTES = releaseNotesFor(VERSION, ROOT)
if (!RELEASE_NOTES) fail(`src/constants/changelog.ts carries no ## ${VERSION} section — author the release notes there before packaging`)

const noticesSrc = join(ROOT, 'THIRD_PARTY_NOTICES.md')
if (!existsSync(noticesSrc)) fail('THIRD_PARTY_NOTICES.md missing — run bun run scripts/distribution/generate-third-party-notices.ts')
const NOTICES = readFileSync(noticesSrc, 'utf8')

if (IS_WIN) {
  writeFileSync(join(pkgDir, 'mercury.cmd'), CMD_LAUNCHER)
  writeFileSync(join(pkgDir, 'mercury.ps1'), PS1_LAUNCHER)
  writeFileSync(join(pkgDir, 'install.ps1'), INSTALL_PS1)
} else {
  writeFileSync(join(pkgDir, 'mercury'), POSIX_LAUNCHER)
  chmodSync(join(pkgDir, 'mercury'), 0o755)
  writeFileSync(join(pkgDir, 'install.sh'), INSTALL_SH)
  chmodSync(join(pkgDir, 'install.sh'), 0o755)
}
writeFileSync(join(pkgDir, 'README-FIRST.md'), README_FIRST)
writeFileSync(join(pkgDir, 'INSTALLING.md'), INSTALLING_MD)
writeFileSync(join(pkgDir, 'UPDATING.md'), UPDATING_MD)
writeFileSync(join(pkgDir, 'RELEASE-NOTES.md'), RELEASE_NOTES)
writeFileSync(join(pkgDir, 'NOTICES.md'), NOTICES)

try {
  execSync('bash scripts/vscode/build-vsix.sh', { cwd: ROOT, stdio: 'pipe' })
} catch (e) {
  fail(`vsix build failed: ${e.stderr?.toString().slice(0, 300) ?? e.message}`)
}
const vsixSrc = join(ROOT, 'dist', 'mercury-vscode.vsix')
if (!existsSync(vsixSrc)) fail('dist/mercury-vscode.vsix missing after the build')
cpSync(vsixSrc, join(pkgDir, 'mercury-vscode.vsix'))

const FORBIDDEN = ['node_modules', '.git', 'src', 'scripts', 'tests', '.claude']
for (const f of FORBIDDEN) if (existsSync(join(pkgDir, f))) fail(`dev residue in package: ${f}`)

{
  const stagedManifestPath = join(pkgDir, 'manifest.json')
  const stagedManifest = JSON.parse(readFileSync(stagedManifestPath, 'utf8'))
  stagedManifest.releaseLayout = releaseLayoutSection(pkgDir, TARGET, FLOOR)
  writeFileSync(stagedManifestPath, JSON.stringify(stagedManifest, null, 2) + '\n')
  ok(`releaseLayout: primary ${stagedManifest.releaseLayout.primary.path}, ${stagedManifest.releaseLayout.compatibility.length} compat member(s), floor ${FLOOR.floorVersion}`)
}

const argLicense = process.argv.indexOf('--license-id')
const LICENSE_ID = argLicense !== -1 && process.argv[argLicense + 1] ? process.argv[argLicense + 1] : null
let shippedSignatureState = 'unsigned'
{
  const signingLib = await import(pathToFileURL(join(pkgDir, 'verify-artifact.mjs')).href)
  const stagedManifestPath = join(pkgDir, 'manifest.json')
  const stagedManifest = JSON.parse(readFileSync(stagedManifestPath, 'utf8'))
  const rl = stagedManifest.releaseLayout
  const statement = {
    schema: 1,
    name: stagedManifest.name,
    version: VERSION,
    channel: 'private',
    target: TARGET,
    packagedAt: new Date().toISOString(),
    buildTree: stagedManifest.buildTree ?? null,
    primarySha256: rl.primary.sha256,
    payloadDigest: rl.payloadDigest,
    licenseId: LICENSE_ID,
  }
  const keyFile = process.env.MERCURY_SIGNING_KEY_FILE
  if (keyFile) {
    if (!existsSync(keyFile)) fail(`MERCURY_SIGNING_KEY_FILE names ${keyFile} — no such file`)
    let block
    try {
      block = signingLib.signStatement(statement, readFileSync(keyFile, 'utf8'))
    } catch (e) {
      fail(`signing failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    stagedManifest.signing = block
    writeFileSync(stagedManifestPath, JSON.stringify(stagedManifest, null, 2) + '\n')
    const check = signingLib.verifyPayloadDir(pkgDir, { depth: 'deep' })
    if (check.verdict.state === 'signed') {
      shippedSignatureState = 'signed'
      ok(`signed: key ${block.keyId} (${check.verdict.keyLabel})${LICENSE_ID ? ` · license-id ${LICENSE_ID}` : ''}`)
    } else if (check.verdict.state === 'unrecognized-key' && process.argv.includes('--allow-unrosterred-signature')) {
      shippedSignatureState = 'unrecognized-key'
      ok(`signed with key ${block.keyId} OUTSIDE the compiled trust roster (allowed by flag — every verifier will report unrecognized-key)`)
    } else if (check.verdict.state === 'unrecognized-key') {
      fail(
        `signing key ${block.keyId} is not in the compiled trust roster — fill PRODUCTION_SIGNING_KEY (src/services/privateChannel/signingTrust.ts), rebuild, then sign; or pass --allow-unrosterred-signature deliberately`,
      )
    } else {
      fail(`post-sign self-verification returned ${check.verdict.state}${check.verdict.note ? `: ${check.verdict.note}` : ''} — the signing step is broken; nothing was published`)
    }
  } else {
    if (LICENSE_ID) fail('--license-id given without MERCURY_SIGNING_KEY_FILE — the license attribution seam is signature-covered by design; sign or drop the id')
    ok('UNSIGNED — MERCURY_SIGNING_KEY_FILE not set; the archive ships without a provenance signature (operator key ceremony pending; launcher and /health report the fact plainly)')
  }
}

const TOP_ALLOWLIST = new Set(topAllowlist(TARGET, FLOOR))
for (const entry of readdirSync(pkgDir)) {
  if (!TOP_ALLOWLIST.has(entry)) fail(`archive member outside the allowlist: ${entry}`)
}
const walkFiles = (dir, base = '') => {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const rel = base ? `${base}/${name}` : name
    if (statSync(full).isDirectory()) out.push(...walkFiles(full, rel))
    else out.push({ path: rel, bytes: statSync(full).size })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
const files = walkFiles(pkgDir)
const bytesByFamily = {}
for (const f of files) {
  const family = f.path.startsWith('vendor/') ? `vendor/${f.path.split('/')[1]}` : f.path
  bytesByFamily[family] = (bytesByFamily[family] ?? 0) + f.bytes
}
const vendorFamilies = existsSync(join(pkgDir, 'vendor')) ? readdirSync(join(pkgDir, 'vendor')) : []
for (const v of vendorFamilies) {
  if (!NOTICES.toLowerCase().includes(v.toLowerCase())) fail(`vendor payload '${v}' missing from NOTICES.md`)
}
const dryRunRecord = {
  schema: 1,
  name: NAME,
  version: VERSION,
  target: TARGET,
  buildTree: manifest.buildTree,
  bundleSha256: createHash('sha256').update(readFileSync(join(pkgDir, 'mercury.mjs'))).digest('hex'),
  verifyReceipts,
  signing: { state: shippedSignatureState, licenseId: LICENSE_ID },
  fileCount: files.length,
  totalBytes: files.reduce((n, f) => n + f.bytes, 0),
  bytesByFamily,
  noticesCoverVendors: vendorFamilies,
  files,
}
mkdirSync(join(ROOT, 'release-out'), { recursive: true })
writeFileSync(join(ROOT, 'release-out', `${NAME}.dryrun.json`), JSON.stringify(dryRunRecord, null, 1) + '\n')
ok(`dry-run record: release-out/${NAME}.dryrun.json (${files.length} files, notices cover ${vendorFamilies.length} vendor payloads)`)

const outDir = join(ROOT, 'release-out')
mkdirSync(outDir, { recursive: true })
const archive = join(outDir, IS_WIN ? `${NAME}.zip` : `${NAME}.tar.gz`)
rmSync(archive, { force: true })
const resolvePwshExe = () => {
  for (const exe of ['pwsh', 'powershell']) {
    try {
      execFileSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'pipe', timeout: 30_000 })
      return exe
    } catch {
    }
  }
  fail('no PowerShell available (pwsh or powershell) — required for zip packaging')
}
const runPwsh = (command, envPaths) =>
  execFileSync(resolvePwshExe(), ['-NoProfile', '-NonInteractive', '-Command', command], {
    stdio: 'inherit',
    env: { ...process.env, ...envPaths },
  })
if (IS_WIN) {
  runPwsh('Compress-Archive -LiteralPath $env:MPKG_SRC -DestinationPath $env:MPKG_DEST -Force', { MPKG_SRC: pkgDir, MPKG_DEST: archive })
} else {
  execFileSync('tar', ['-czf', archive, '-C', stage, 'mercury'], { stdio: 'inherit' })
}
ok(`archive: ${archive}`)

const smoke = mkdtempSync(join(tmpdir(), 'mercury smoke '))
if (IS_WIN) {
  runPwsh('Expand-Archive -LiteralPath $env:MPKG_SRC -DestinationPath $env:MPKG_DEST -Force', { MPKG_SRC: archive, MPKG_DEST: smoke })
} else {
  execFileSync('tar', ['-xzf', archive, '-C', smoke], { stdio: 'inherit' })
}
const launched = IS_WIN ? join(smoke, 'mercury', 'mercury.cmd') : join(smoke, 'mercury', 'mercury')
if (existsSync(join(smoke, 'mercury', 'node_modules'))) fail('smoke: node_modules leaked into the archive')
if (!existsSync(join(smoke, 'mercury', 'splash.mjs'))) fail('smoke: splash.mjs (the enter screen) missing from the archive')
if (!existsSync(join(smoke, 'mercury', 'splash-core.mjs'))) fail('smoke: splash-core.mjs (the enter-screen compose core) missing from the archive')

const smokeHome = join(smoke, 'home')
const smokeVersions = join(smokeHome, 'versions')
const smokeLocalAppData = join(smokeHome, 'AppData', 'Local')
const smokeEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: smokeHome,
  HOME: smokeHome,
  LOCALAPPDATA: smokeLocalAppData,
  MERCURY_VERSIONS_DIR: smokeVersions,
  CI: '1',
}
const run = (args) =>
  IS_WIN
    ? execSync(['"' + launched + '"', ...args].join(' '), {
        encoding: 'utf8',
        env: smokeEnv,
        timeout: 120_000,
      })
    : execFileSync(launched, args, {
        encoding: 'utf8',
        env: smokeEnv,
        timeout: 120_000,
      })

const versionOut = run(['--version']).trim()
if (!versionOut.includes(VERSION)) fail(`smoke: --version printed "${versionOut}" (expected to include ${VERSION})`)
ok(`--version → ${versionOut} (from a spaced path, clean home, no repo)`)

const withPath = (env, value) => {
  const out = { ...env }
  for (const k of Object.keys(out)) if (k.toUpperCase() === 'PATH') delete out[k]
  out[IS_WIN ? 'Path' : 'PATH'] = value
  return out
}
const runLauncher = (args, env) =>
  IS_WIN
    ? spawnSync(['"' + launched + '"', ...args].join(' '), { shell: true, encoding: 'utf8', env, timeout: 120_000 })
    : spawnSync(launched, args, { encoding: 'utf8', env, timeout: 120_000 })
if (runtime) {
  const extractedBinary = join(smoke, 'mercury', ...runtime.path.split('/'), ...runtime.binary.split('/'))
  if (!existsSync(extractedBinary)) fail(`smoke: the vendored runtime ${runtime.path}/${runtime.binary} is missing from the archive`)
  let noNodePath
  if (IS_WIN) {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    noNodePath = `${systemRoot}\\System32;${systemRoot}`
  } else {
    const trap = join(smoke, 'trap')
    mkdirSync(trap, { recursive: true })
    writeFileSync(join(trap, 'node'), '#!/bin/sh\necho "smoke trap: the PATH node must not be used" >&2\nexit 86\n')
    chmodSync(join(trap, 'node'), 0o755)
    noNodePath = `${trap}:/usr/bin:/bin`
  }
  const bare = runLauncher(['--version'], withPath(smokeEnv, noNodePath))
  if (bare.status !== 0 || !(bare.stdout ?? '').includes(VERSION)) {
    fail(`smoke: with no node on PATH the launcher did not boot on the vendored runtime (exit ${bare.status}): ${(bare.stderr ?? '').slice(0, 300)}`)
  }
  ok(`--version → ${(bare.stdout ?? '').trim()} with NO node on PATH (the vendored runtime alone)`)
  const bogus = runLauncher(['--version'], { ...smokeEnv, MERCURY_NODE: join(smoke, 'no-such-node') })
  const refusal = bogus.stderr ?? ''
  if (bogus.status === 0 || !refusal.includes('MERCURY_NODE') || !/vendor[\\/]node/.test(refusal) || !refusal.includes('PATH')) {
    fail(`smoke: MERCURY_NODE naming a missing file must refuse naming all three rungs (exit ${bogus.status}): ${refusal.slice(0, 300)}`)
  }
  ok('MERCURY_NODE naming a missing file refuses, naming all three rungs')
}
const helpOut = run(['--help'])
if (!helpOut.includes('update') || !helpOut.includes('install')) fail('smoke: --help does not surface the update/install verbs')
ok('--help exits clean without an account (update/install discoverable)')

const mf = JSON.parse(readFileSync(join(smoke, 'mercury', 'manifest.json'), 'utf8'))
if (!JSON.stringify(mf).includes('ripgrep')) fail('smoke: manifest has no ripgrep entry')
ok('manifest names the vendored search binary')
if (runtime && !(mf.runtime && mf.runtime.vendored === true && mf.runtime.version === runtime.version && mf.runtime.platform === runtime.platform)) {
  fail('smoke: the shipped manifest does not carry the vendored runtime record the build wrote')
}
if (runtime) ok(`manifest names the vendored runtime (node ${mf.runtime.version} ${mf.runtime.platform})`)

{
  const verifierPath = join(smoke, 'mercury', 'verify-artifact.mjs')
  if (!existsSync(verifierPath)) fail('smoke: verify-artifact.mjs missing from the archive')
  let out = ''
  let status = 0
  try {
    out = execFileSync('node', [verifierPath, '--json', '--deep'], { encoding: 'utf8', env: smokeEnv, timeout: 120_000 })
  } catch (e) {
    out = String(e.stdout ?? '')
    status = typeof e.status === 'number' ? e.status : -1
  }
  let verdictState = null
  try {
    verdictState = JSON.parse(out).verdict.state
  } catch {
    fail(`smoke: verifier printed unparseable JSON (exit ${status}): ${out.slice(0, 200)}`)
  }
  if (verdictState !== shippedSignatureState) {
    fail(`smoke: verifier reports '${verdictState}' but this packaging produced '${shippedSignatureState}'`)
  }
  const expectedExit = { signed: 0, unsigned: 3, 'unrecognized-key': 4 }[shippedSignatureState]
  if (status !== expectedExit) fail(`smoke: verifier exit ${status} (expected ${expectedExit} for '${shippedSignatureState}')`)
  ok(`shipped verifier answers '${verdictState}' at full depth (exit ${status})`)
}

const stateMarker = join(smokeHome, 'user-state-marker.json')
mkdirSync(smokeHome, { recursive: true })
writeFileSync(stateMarker, '{"survives":true}\n')

const dryOut = run(['install', '--dry-run'])
if (!dryOut.includes(`would install version: ${VERSION}`)) fail(`smoke: install --dry-run did not name ${VERSION}: ${dryOut.slice(0, 200)}`)
if (existsSync(join(smokeVersions, VERSION))) fail('smoke: install --dry-run wrote a version directory')
ok('install --dry-run describes without changing')

const installOut = run(['install'])
if (!existsSync(join(smokeVersions, VERSION, 'mercury.mjs'))) fail('smoke: install did not stage the version payload')
if (!installOut.includes(`installed: ${VERSION}`)) fail(`smoke: install output unexpected: ${installOut.slice(0, 300)}`)
const shim = IS_WIN ? join(smokeLocalAppData, 'Mercury', 'bin', 'mercury.cmd') : join(smokeHome, '.local', 'bin', 'mercury')
if (!existsSync(shim)) fail(`smoke: stable command missing at ${shim}`)
const shimVersion = (IS_WIN
  ? execSync(['"' + shim + '"', '--version'].join(' '), { encoding: 'utf8', env: smokeEnv, timeout: 120_000 })
  : execFileSync(shim, ['--version'], { encoding: 'utf8', env: smokeEnv, timeout: 120_000 })
).trim()
if (!shimVersion.includes(VERSION)) fail(`smoke: stable command printed "${shimVersion}" (expected ${VERSION})`)
ok(`user-local install + stable command → ${shimVersion}`)

const repeatOut = run(['install'])
if (!repeatOut.includes('already present')) fail(`smoke: repeat install was not a truthful no-op: ${repeatOut.slice(0, 300)}`)
ok('repeat install is a truthful no-op (idempotent)')

const statusOut = run(['update', '--status'])
if (!statusOut.includes(`installed version: ${VERSION}`)) fail(`smoke: update --status missing installed version: ${statusOut.slice(0, 300)}`)
ok('update --status reads the managed layout')

run(['install', '--uninstall'])
if (existsSync(smokeVersions)) fail('smoke: uninstall left the versions directory')
if (existsSync(shim)) fail('smoke: uninstall left the managed stable command')
if (!existsSync(stateMarker)) fail('smoke: uninstall deleted user state from the config home')
ok('uninstall removes managed binaries only — user state preserved')

const sizeMb = (statSync(archive).size / 1024 / 1024).toFixed(1)
console.log(`✓ ${NAME} packaged + friend-path smoked (${sizeMb} MiB)`)
if (process.argv.includes('--keep-stage')) {
  console.log(`  · inspectable stage kept: ${pkgDir}`)
} else {
  rmSync(stage, { recursive: true, force: true })
}
rmSync(smoke, { recursive: true, force: true })
