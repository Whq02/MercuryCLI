#!/usr/bin/env node
/* scripts/release/package.mjs — assemble + SMOKE the friend-ready Mercury
 * archive for ONE platform target.
 *
 * Contents (exactly what a collaborator needs, nothing else):
 *   mercury/mercury.mjs            — the self-contained bundle
 *   mercury/manifest.json         — the build's artifact record
 *   mercury/vendor/ripgrep/...    — the PLATFORM-matched rg (built on this OS)
 *   mercury/vendor/node/...       — the PLATFORM-matched Node runtime (bin/node ·
 *                                   node.exe; a fresh machine needs only git)
 *   mercury/mercury               — POSIX launcher   (or mercury.cmd + mercury.ps1)
 *   mercury/splash.mjs            — the enter screen driver (canonical assets/
 *   mercury/splash-core.mjs         splash/*.mjs — the ruling-1 pair: the driver
 *                                   imports './splash-core.mjs'; launchers chain it on
 *                                   interactive TTY boots — friend-path hotfix)
 *   mercury/install.sh|.ps1       — optional user-local bin install, prints what it changes
 *   mercury/README-FIRST.md       — the three-step start
 *   mercury/NOTICES.md            — the generated third-party inventory
 *                                   (THIRD_PARTY_NOTICES.md verbatim)
 *
 * Then PROVES the friend path on this runner:
 *   · unpack into a directory WITH SPACES
 *   · no node_modules / no repo / no bun anywhere near the launched artifact
 *   · launcher --version prints the release version
 *   · launcher --version with NO node on PATH — the vendored runtime alone
 *   · MERCURY_NODE naming a missing file refuses, naming all three rungs
 *   · launcher --help exits 0 (no account required)
 *   · manifest names this platform's rg + runtime; the archive holds no
 *     dev/test residue
 *
 * Usage: node scripts/release/package.mjs --target <linux-x64|macos-arm64|macos-x64|windows-x64>
 */
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
// The Node policy every launcher + README projects: derived
// from the machine-readable package policy (engines.node ≡ nodePolicy.ts,
// prover-pinned) — never hand-copied. parseEnginesNode REFUSES an
// unrecognized shape, so a policy change cannot silently ship stale checks.
const NODE_POLICY = parseEnginesNode(PKG.engines?.node)
const NAME = `mercury-v${VERSION}-${TARGET}`

const fail = (msg) => {
  console.error(`✗ ${msg}`)
  process.exit(1)
}
const ok = (msg) => console.log(`  · ${msg}`)

// ── preconditions ────────────────────────────────────────────────────────────
const dist = join(ROOT, 'dist')
if (!existsSync(join(dist, 'mercury.mjs'))) fail('dist/mercury.mjs missing — run bun run build.ts first')
if (!existsSync(join(dist, 'manifest.json'))) fail('dist/manifest.json missing')
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
// A release archive must carry the FULL payload set — a degraded manifest
// means a vendor cache was absent at build time (run the scripts/vendor/
// fetch-*.ts commands, rebuild). --allow-degraded is the explicit escape
// for deliberate partial builds; silence is never one.
const degraded = Array.isArray(manifest.degraded) ? manifest.degraded : []
// The voice capture pack is BUILT on the packaging host (cargo, the
// platform audio headers), not fetched: a runner that cannot build it still
// publishes the archive — degraded and honest (the manifest's `voiceInput`
// record names the remedy, the doctor row says so). Every other degradation
// keeps refusing; the tolerance is named here, once.
const PUBLISHABLE_DEGRADATIONS = new Set(['voice-input'])
const blocking = degraded.filter(d => !PUBLISHABLE_DEGRADATIONS.has(d))
if (blocking.length > 0 && !process.argv.includes('--allow-degraded')) {
  fail(`dist manifest is DEGRADED (${blocking.join(', ')}) — run the scripts/vendor/fetch-*.ts commands and rebuild, or pass --allow-degraded deliberately`)
}
if (degraded.includes('voice-input')) ok('the voice capture pack is absent from this build — the archive ships without voice input (degraded: voice-input, publishable)')
const rgDirs = existsSync(join(dist, 'vendor', 'ripgrep')) ? readdirSync(join(dist, 'vendor', 'ripgrep')) : []
if (rgDirs.length === 0) fail('dist/vendor/ripgrep missing — the build must vendor the platform rg')
// The vendored Node runtime: a release archive carries its own, so a fresh
// machine needs only git. The build vendored the HOST platform's pack at the
// fixed path (vendor/node); its record must name the platform this TARGET
// ships, and the binary must be on disk. --allow-degraded (above) is the one
// road to an archive without it — the launchers then run MERCURY_NODE or a
// PATH node, and README-FIRST still promises a runtime, so it is never the
// release road.
const TARGET_NODE_PACK = { 'linux-x64': 'linux-x64', 'macos-arm64': 'darwin-arm64', 'macos-x64': 'darwin-x64', 'windows-x64': 'win-x64' }[TARGET]
const runtime = manifest.runtime && manifest.runtime.vendored === true ? manifest.runtime : null
if (runtime) {
  if (runtime.platform !== TARGET_NODE_PACK) fail(`dist carries a ${runtime.platform} Node runtime but --target ${TARGET} ships ${TARGET_NODE_PACK} — build on the target platform`)
  const runtimeBinary = join(dist, ...runtime.path.split('/'), ...runtime.binary.split('/'))
  if (!existsSync(runtimeBinary)) fail(`dist manifest declares the vendored runtime at ${runtime.path}/${runtime.binary} but the file is missing — rebuild`)
}
ok(`packaging ${NAME} (rg: ${rgDirs.join(', ')}; runtime: ${runtime ? `node ${runtime.version} ${runtime.platform}` : 'NONE (degraded — the launchers fall back to MERCURY_NODE or a PATH node)'})`)

// ── the verify-receipt bind ─────────────
// There are no concourse-verify matrices; the durable "was THIS tree
// verified?" record is the committed gate ledger (scripts/gate/gate-ledger.jsonl —
// append-only green verdicts keyed by the commit and its content
// tree). A packaged candidate must be covered by a GREEN ledger row whose
// commit tree is the staged dist's buildTree — or a receipt-safe ancestor
// of it (the fold-commit pattern: pool on the candidate tree, then commit
// the ledger row; the diff between the graded tree and the BUILD tree may
// touch only record paths, nothing that could change the bundle or its
// verification inputs). And the staged dist must be this checkout's own
// content first: a bundle built from other content is refused outright —
// the bind used to judge the row against HEAD and certified a stale dist
// (FN-019's pipeline defect). The rule lives in verifyReceiptBind.mjs,
// pinned by scripts/updater/prove-verify-receipt-bind.ts.
// --allow-stale-verify-receipts is the loud dev escape for a MISSING row;
// it never covers a stale dist, and the freeze path never passes it.
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

// ── assemble ────────────────────────────────────────────────────────────────
const stage = mkdtempSync(join(tmpdir(), 'mercury-pkg-'))
const pkgDir = join(stage, 'mercury')
mkdirSync(pkgDir, { recursive: true })
cpSync(join(dist, 'mercury.mjs'), join(pkgDir, 'mercury.mjs'))
cpSync(join(dist, 'manifest.json'), join(pkgDir, 'manifest.json'))
cpSync(join(dist, 'vendor'), join(pkgDir, 'vendor'), { recursive: true })

// Cross-version update contract: an UPDATE archive is consumed by the
// PREVIOUS release's client, and WHAT the previous clients accept is the
// machine-readable compatibility floor (scripts/release/compat-floor.json —
// one owner; the bridge-gate proves the previous shipped reader consumes the
// candidate archive before any publish). The floor stands at the first
// version of the public line: mercury.mjs-only archives, no forwarder, and
// no forwarder arm — a future compat need is a fresh, deliberate design at
// this owner.
const FLOOR = readCompatFloor()

// The enter screen ships beside mercury.mjs:
// the canonical splash is a dependency-free single file the launchers chain
// on interactive TTY boots — before this, the enter screen/boot menu existed
// only on the operator's local launcher path, on every OS.
// the splash ships as a PAIR — the driver
// (splash.mjs) imports its sibling compose core ('./splash-core.mjs'); both
// are syntax-checked or the enter screen dies on import in the field.
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

// The shipped provenance verifier (LANE LW deliverable 1): built by build.ts
// beside the bundle, ships as a payload member so the launchers can verify
// the artifact signature on interactive boots (warn-only) with the SAME
// compiled implementation /health and this packager use. A dist without it
// is a pre-signing build — rebuild first.
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

// ONE installer: both convenience scripts run the runtime's own self-adopt
// verb (`mercury install` — src/services/privateChannel/), never a second
// symlink/copy implementation. The old symlink form broke self-location
// anyway (the POSIX launcher resolves dirname($0), which for a symlink is
// the bin dir, not the payload).
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

// RELEASE-NOTES.md ships from the bundled changelog (the repository carries
// the product; the channel release carries its own notes) — a release
// without an authored `## <version>` section must not package.
const { releaseNotesFor } = await import('./notesFromChangelog.mjs')
const RELEASE_NOTES = releaseNotesFor(VERSION, ROOT)
if (!RELEASE_NOTES) fail(`src/constants/changelog.ts carries no ## ${VERSION} section — author the release notes there before packaging`)

// The canonical third-party inventory ships verbatim: the
// generated THIRD_PARTY_NOTICES.md covers every bundled runtime package AND
// every vendor payload — the old inline text named only ripgrep while the
// archive had grown debugpy/pyright/typescript/tree-sitter.
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

// ── the VS Code bridge.vsix ────────────────────────────────────
// A first-party build product (hand-built stable-OPC zip from
// integrations/vscode/ — no downloads, no third-party code inside; its own
// licence inventory rides inside the archive). Built fresh here so the
// collaborator package always carries the bridge matching this tree.
try {
  execSync('bash scripts/vscode/build-vsix.sh', { cwd: ROOT, stdio: 'pipe' })
} catch (e) {
  fail(`vsix build failed: ${e.stderr?.toString().slice(0, 300) ?? e.message}`)
}
const vsixSrc = join(ROOT, 'dist', 'mercury-vscode.vsix')
if (!existsSync(vsixSrc)) fail('dist/mercury-vscode.vsix missing after the build')
cpSync(vsixSrc, join(pkgDir, 'mercury-vscode.vsix'))

// residue guard: nothing dev-only may ship
const FORBIDDEN = ['node_modules', '.git', 'src', 'scripts', 'tests', '.claude']
for (const f of FORBIDDEN) if (existsSync(join(pkgDir, f))) fail(`dev residue in package: ${f}`)

// ── the packager-owned releaseLayout manifest section ───────────────────────
// The STAGED manifest gains the declared-roles record (payloadContract.mjs
// schema 1): every member's path/role/bytes/sha256, the primary, the launcher
// and the deterministic whole-payload digest. The reader's arm-1 decoder
// consumes it as authority: the declared primary is the one runtime bundle,
// never a filename census. The build manifest (dist/manifest.json, build.ts
// schema 2) stays untouched: the packager owns release-layout facts because
// the packager creates the layout. Amended AFTER every member is written so
// the record is complete.
{
  const stagedManifestPath = join(pkgDir, 'manifest.json')
  const stagedManifest = JSON.parse(readFileSync(stagedManifestPath, 'utf8'))
  stagedManifest.releaseLayout = releaseLayoutSection(pkgDir, TARGET, FLOOR)
  writeFileSync(stagedManifestPath, JSON.stringify(stagedManifest, null, 2) + '\n')
  ok(`releaseLayout: primary ${stagedManifest.releaseLayout.primary.path}, ${stagedManifest.releaseLayout.compatibility.length} compat member(s), floor ${FLOOR.floorVersion}`)
}

// ── artifact signing
// Ed25519 over the release-manifest tuple (version · channel · target ·
// packaging date · buildTree · primary sha256 · whole-payload digest ·
// license id), through the ONE built implementation (dist/verify-artifact.mjs
// — the same code the launchers and /health run). The signature block lives
// in manifest.json, which the payload digest excludes by the twin law, so
// signing payloadDigest covers every other shipped byte.
//
// KEY CUSTODY (binding): the private key is operator-held and enters only
// through MERCURY_SIGNING_KEY_FILE at packaging time — never the repo, never
// this script's output. Absent ⇒ the archive ships UNSIGNED and says so
// loudly; verifiers state the fact without gating anything (warn-dont-block).
//
// --license-id <id> is the delivery-time attribution seam: it rides INSIDE
// the signed statement (semantics land later; the coverage exists now), so
// an unsigned license-id is refused — an attribution nothing vouches for is
// not an attribution.
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
    // Post-sign self-verification with the SHIPPED implementation, at full
    // depth — a packager that cannot verify its own signature publishes
    // nothing.
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

// ── dry-run distribution record ─────────────────────────────
// Every archive member must sit under the explicit allowlist — derived from
// the ONE member-role authority (payloadContract.mjs) under the current
// compatibility floor; the record is the deterministic sorted manifest +
// sizes by family + the artifact identity, written to release-out/
// (gitignored, never published).
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
  // Byte-order sort (not localeCompare): deterministic across machines/locales.
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
const files = walkFiles(pkgDir)
const bytesByFamily = {}
for (const f of files) {
  const family = f.path.startsWith('vendor/') ? `vendor/${f.path.split('/')[1]}` : f.path
  bytesByFamily[family] = (bytesByFamily[family] ?? 0) + f.bytes
}
// notice coverage: every vendored payload family must appear in the notices.
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
  // The freeze record's tuple naming (artifact-sha-naming): the CANDIDATE
  // TUPLE's artifact digest is releaseLayout.primary.sha256 in the staged
  // manifest; bundleSha256 above is the same bytes recomputed here; and
  // verifyReceipts binds the committed gate-ledger verdict that graded
  // this tree (there are no concourse-verify matrices).
  verifyReceipts,
  // LANE LW: what provenance state these bytes shipped in, and the
  // delivery-time license attribution (inside the signed statement when set).
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

// ── archive ─────────────────────────────────────────────────────────────────
const outDir = join(ROOT, 'release-out')
mkdirSync(outDir, { recursive: true })
const archive = join(outDir, IS_WIN ? `${NAME}.zip` : `${NAME}.tar.gz`)
rmSync(archive, { force: true })
// PowerShell invocations pass paths as ENVIRONMENT DATA into -LiteralPath,
// never interpolated into command text (an apostrophe in a path broke the
// quoted string; `[ ]` glob-expanded under -Path), and prefer PowerShell 7
// (pwsh) over legacy powershell — same class as the reader-side fix in
// updateService.extractArchive.
const resolvePwshExe = () => {
  for (const exe of ['pwsh', 'powershell']) {
    try {
      execFileSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'pipe', timeout: 30_000 })
      return exe
    } catch {
      // try the next shell
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

// ── friend-path smoke (on THIS runner) ──────────────────────────────────────
const smoke = mkdtempSync(join(tmpdir(), 'mercury smoke '))  // spaces on purpose
if (IS_WIN) {
  runPwsh('Expand-Archive -LiteralPath $env:MPKG_SRC -DestinationPath $env:MPKG_DEST -Force', { MPKG_SRC: archive, MPKG_DEST: smoke })
} else {
  execFileSync('tar', ['-xzf', archive, '-C', smoke], { stdio: 'inherit' })
}
const launched = IS_WIN ? join(smoke, 'mercury', 'mercury.cmd') : join(smoke, 'mercury', 'mercury')
if (existsSync(join(smoke, 'mercury', 'node_modules'))) fail('smoke: node_modules leaked into the archive')
if (!existsSync(join(smoke, 'mercury', 'splash.mjs'))) fail('smoke: splash.mjs (the enter screen) missing from the archive')
if (!existsSync(join(smoke, 'mercury', 'splash-core.mjs'))) fail('smoke: splash-core.mjs (the enter-screen compose core) missing from the archive')

// Windows: execFileSync with shell:true does NOT quote the file path — the
// deliberately-spaced smoke dir ("mercury smoke XXXX") made cmd.exe split at
// the space and try to run '...\Temp\mercury' (release run 29173514189,
// first-ever windows-x64 build). Quote the whole command explicitly there;
// POSIX keeps the direct, shell-free execFileSync.
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

// ── the runtime rungs, driven on the extracted archive ──────────────────────
// A machine WITHOUT Node: PATH holds only the system directories and, on
// POSIX, a trap `node` that fails loudly — so --version can succeed only
// through the vendored runtime beside the bundle. And an explicit
// MERCURY_NODE naming a file that does not exist must refuse, naming all
// three rungs, never fall through silently. Both legs skip honestly when
// this packaging shipped no runtime (--allow-degraded).
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

// The shipped verifier answers from inside the extracted archive with the
// exact state this run produced — the provenance surface is smoked on every
// packaging, not only on signed ones (law 1: the unsigned fact must also be
// stated correctly).
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

// ── installer/updater platform contract (§7/§8 — runs on EVERY packaging OS)
// The hermetic layout rides smokeEnv (MERCURY_VERSIONS_DIR + redirected
// HOME/LOCALAPPDATA), so this never touches the packing machine's real
// install or the operator's launcher.
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
