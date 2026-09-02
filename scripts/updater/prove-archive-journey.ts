#!/usr/bin/env bun
// ============================================================================
//  scripts/updater/prove-archive-journey.ts — the PACKAGED archive walks the
//  operator's whole journey, through its own launcher and the managed shim.
//
//  prove-update-journey drives `node dist/mercury.mjs` against fixture
//  payloads; the packager's friend-path smoke drives the extracted launcher
//  through install/status/uninstall. Neither walks the release bytes the way
//  a collaborator does: extract → `mercury install --dry-run` → `install` →
//  the STABLE COMMAND answering `--version` → `update --check` / `--status`
//  against the channel → `update` to a newer release → `--rollback` → forward
//  again → `install --uninstall` run by the very bundle whose versions
//  directory it removes. This prover does exactly that, on the host archive
// the packager wrote into release-out/ — the ARCHIVE lane beside the
// NETWORK lane: it skips loudly (exit 0) when no archive is packaged, and
//  prints the packaging command.
//
//  The "newer release" is a fixture payload minted through the packager's
//  own member-role authority (payloadContract + the real launcher templates,
//  the same provenance law prove-update-journey obeys), versioned one patch
//  above the archive, served by fake-gh. Once it is active, the stable
//  command runs ITS bundle (a stub that only knows `--version`), so the
//  rollback verbs run from the extracted archive's launcher — the real
//  bundle, resolving the same layout through the same seams — exactly the
//  bridge-gate's shape. Windows extracts through pwsh and resolves the cmd
//  shim through cmd.exe; that lane is windows-launcher.yml, so win32 skips
//  here by name.
// ============================================================================
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetNameFor, formatPrivateVersion, parsePrivateVersion } from '../../src/services/privateChannel/channelCore.js'

const ROOT = join(import.meta.dir, '..', '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string; engines?: { node?: string } }
const VERSION = pkg.version

if (process.platform === 'win32') {
  console.log('  [SKIP] archive journey — POSIX hosts only (windows-launcher.yml drives the shipped mercury.cmd on a real ConPTY)')
  process.exit(0)
}
const ASSET = assetNameFor(VERSION, process.platform, process.arch)
const ARCHIVE = ASSET ? join(ROOT, 'release-out', ASSET) : null
if (!ASSET || !ARCHIVE || !existsSync(ARCHIVE)) {
  const target = process.platform === 'darwin' ? 'macos-arm64' : 'linux-x64'
  console.log(`  [SKIP] archive journey — no packaged host archive at release-out/${ASSET ?? '(unsupported host)'}; package one first: node scripts/release/package.mjs --target ${target}`)
  process.exit(0)
}
const TARGET = ASSET.slice(`mercury-v${VERSION}-`.length).replace(/\.tar\.gz$/, '')

const { readCompatFloor, releaseLayoutSection } = (await import('../release/payloadContract.mjs')) as {
  readCompatFloor: () => { floorVersion: string; forwarder: string }
  releaseLayoutSection: (dir: string, target: string, floor: unknown) => Record<string, unknown>
}
const { parseEnginesNode, posixLauncher } = (await import('../release/launcherTemplates.mjs')) as {
  parseEnginesNode: (range: string | undefined) => unknown
  posixLauncher: (p: unknown) => string
}
const FLOOR = readCompatFloor()
const NODE_POLICY = parseEnginesNode(pkg.engines?.node)

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

// ── the hermetic estate (every path under one mkdtemp; spaces on purpose) ──
const scratch = mkdtempSync(join(tmpdir(), 'archive journey '))
const home = join(scratch, 'home')
const versionsDir = join(home, 'versions')
const binDir = join(home, '.local', 'bin')
const shim = join(binDir, 'mercury')
const extractDir = join(scratch, 'extract')
const fixtures = join(scratch, 'fixtures')
const ghLog = join(scratch, 'gh.log')
mkdirSync(home, { recursive: true })
mkdirSync(extractDir, { recursive: true })
const stateMarker = join(home, 'user-state-marker.json')
writeFileSync(stateMarker, '{"survives":true}\n')
for (const p of [home, versionsDir, binDir, extractDir, fixtures]) {
  if (!p.startsWith(scratch)) {
    console.log(`  [FAIL] SAFETY: a path escapes the scratch: ${p}`)
    process.exit(1)
  }
}

console.log(`archive: release-out/${ASSET} (target ${TARGET}, version ${VERSION})`)
execFileSync('tar', ['-xzf', ARCHIVE, '-C', extractDir])
const launcher = join(extractDir, 'mercury', 'mercury')
check('the archive extracts to one mercury/ root with its launcher', existsSync(launcher) && existsSync(join(extractDir, 'mercury', 'mercury.mjs')))

// ── the newer release: one patch above the archive, packager-shaped ────────
const parsed = parsePrivateVersion(VERSION)
if (!parsed) {
  console.log(`  [FAIL] package.json version ${VERSION} is not a private-channel version`)
  process.exit(1)
}
const NEXT = formatPrivateVersion({ ...parsed, patch: parsed.patch + 1, counter: 1 })
const NEXT_ASSET = assetNameFor(NEXT, process.platform, process.arch)!
{
  const stage = join(fixtures, 'stage', 'mercury')
  mkdirSync(join(stage, 'vendor', 'ripgrep', 'stub'), { recursive: true })
  writeFileSync(join(stage, 'vendor', 'ripgrep', 'stub', 'rg'), 'stub\n')
  writeFileSync(
    join(stage, 'mercury.mjs'),
    `import { readFileSync } from 'node:fs'\nconst m = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'))\nconsole.log('Mercury ' + m.version)\n`,
  )
  writeFileSync(join(stage, 'splash.mjs'), `// fixture splash ${NEXT}\n`)
  writeFileSync(join(stage, 'splash-core.mjs'), `// fixture splash core ${NEXT}\n`)
  writeFileSync(join(stage, 'verify-artifact.mjs'), `// fixture provenance verifier ${NEXT}\n`)
  writeFileSync(join(stage, 'mercury-vscode.vsix'), `fixture-vsix ${NEXT}\n`)
  writeFileSync(join(stage, 'mercury'), posixLauncher(NODE_POLICY))
  writeFileSync(join(stage, 'install.sh'), '#!/bin/sh\n# fixture installer stub\n')
  for (const doc of ['README-FIRST.md', 'INSTALLING.md', 'UPDATING.md', 'RELEASE-NOTES.md', 'NOTICES.md']) {
    writeFileSync(join(stage, doc), `# fixture ${doc} ${NEXT}\n`)
  }
  for (const f of ['mercury', 'install.sh']) chmodSync(join(stage, f), 0o755)
  const manifest: Record<string, unknown> = { schema: 2, name: 'mercury', version: NEXT, bundle: 'mercury.mjs', bundleBytes: statSync(join(stage, 'mercury.mjs')).size }
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest) + '\n')
  manifest.releaseLayout = releaseLayoutSection(stage, TARGET, FLOOR)
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  const tagDir = join(fixtures, 'assets', `v${NEXT}`)
  mkdirSync(tagDir, { recursive: true })
  const archivePath = join(tagDir, NEXT_ASSET)
  execFileSync('tar', ['-czf', archivePath, '-C', join(fixtures, 'stage'), 'mercury'])
  const digest = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
  writeFileSync(join(tagDir, 'SHA256SUMS.txt'), `${digest}  ${NEXT_ASSET}\n`)
  writeFileSync(
    join(fixtures, 'releases.json'),
    JSON.stringify([{ tag_name: `v${NEXT}`, draft: false, prerelease: true, assets: [{ name: NEXT_ASSET }, { name: 'SHA256SUMS.txt' }] }], null, 1),
  )
}

// ── the driver: the launcher or the stable command, under the channel seams ──
const SLUG = 'fixture/mercury'
const GH_CMD = JSON.stringify(['node', join(ROOT, 'scripts', 'updater', 'fake-gh.mjs')])
function run(cmd: string, args: string[]): { code: number; stdout: string; stderr: string; all: string } {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HOME: home,
      MERCURY_CONFIG_DIR: home,
      MERCURY_VERSIONS_DIR: versionsDir,
      MERCURY_UPDATE_CHANNEL_REPO: SLUG,
      MERCURY_GH_CMD: GH_CMD,
      GH_SHIM_FIXTURES: fixtures,
      GH_SHIM_LOG: ghLog,
      CI: '1',
      TERM: 'dumb',
    },
  })
  const stdout = res.stdout ?? ''
  const stderr = res.stderr ?? ''
  return { code: res.status ?? -1, stdout, stderr, all: stdout + stderr }
}
const pointer = (name: 'current' | 'previous'): string | null =>
  existsSync(join(versionsDir, `${name}.txt`)) ? readFileSync(join(versionsDir, `${name}.txt`), 'utf8').trim() : null

console.log('── 1 · install --dry-run describes without changing ──')
{
  const r = run(launcher, ['install', '--dry-run'])
  check('dry-run exits 0 and names the archive version', r.code === 0 && r.stdout.includes(`would install version: ${VERSION}`), r.all.slice(0, 300))
  check('dry-run names the versions dir it would use and the stable command', r.stdout.includes(`would install to:      ${join(versionsDir, VERSION)}`) && r.stdout.includes(`stable command:        ${shim}`))
  check('dry-run wrote no version directory', !existsSync(join(versionsDir, VERSION)))
}

console.log('── 2 · install lands the payload, the pointer and the stable command ──')
{
  const r = run(launcher, ['install'])
  check('install exits 0 and reports the version + active pointer', r.code === 0 && r.stdout.includes(`installed: ${VERSION} → ${join(versionsDir, VERSION)}`) && r.stdout.includes(`active version: ${VERSION}`), r.all.slice(0, 400))
  check('the stable command exists and carries the managed marker', existsSync(shim) && readFileSync(shim, 'utf8').includes('mercury-managed-shim'))
  check('current.txt names the archive version, no previous yet', pointer('current') === VERSION && pointer('previous') === null)
  check('the payload is complete under versions/<v> (bundle · manifest · vendor/ripgrep · launcher · splash pair · verifier)',
    ['mercury.mjs', 'manifest.json', 'vendor/ripgrep', 'mercury', 'splash.mjs', 'splash-core.mjs', 'verify-artifact.mjs'].every(m => existsSync(join(versionsDir, VERSION, m))))
  const again = run(launcher, ['install'])
  check('a second install is a truthful no-op', again.code === 0 && again.stdout.includes('already present — no bytes changed'), again.all.slice(0, 300))
}

console.log('── 3 · the stable command answers ──')
{
  const r = run(shim, ['--version'])
  check('`mercury --version` through the stable command prints the archive version', r.code === 0 && r.stdout.trim() === `Mercury ${VERSION}`, r.all.slice(0, 200))
}

console.log('── 4 · update --check / --status against the channel ──')
{
  const c = run(shim, ['update', '--check'])
  check('--check sees the newer release', c.code === 0 && c.stdout.includes(`update available: v${NEXT} (installed: ${VERSION})`) && c.stdout.includes(`asset: ${NEXT_ASSET}`), c.all.slice(0, 300))
  const s = run(shim, ['update', '--status'])
  check('--status reads the managed layout (installed · versions dir · managed stable command · channel ok)',
    s.code === 0 && s.stdout.includes(`installed version: ${VERSION}`) && s.stdout.includes(`versions dir:      ${versionsDir}`) && s.stdout.includes(`stable command:    ${shim} (managed)`) && s.stdout.includes('channel access:    ok'),
    s.all.slice(0, 500))
  check('--check and --status changed nothing', pointer('current') === VERSION && !existsSync(join(versionsDir, NEXT)))
}

console.log('── 5 · update activates the newer release, keeps the previous ──')
{
  const r = run(shim, ['update'])
  check('update exits 0 and reports from → to with the previous kept', r.code === 0 && r.stdout.includes(`updated: ${VERSION} → ${NEXT}`) && r.stdout.includes('previous version kept'), r.all.slice(0, 500))
  check('pointers: current = newer, previous = archive version', pointer('current') === NEXT && pointer('previous') === VERSION)
  check('both payloads stay installed', existsSync(join(versionsDir, VERSION, 'mercury.mjs')) && existsSync(join(versionsDir, NEXT, 'mercury.mjs')))
  const receiptPath = join(versionsDir, 'last-update.json')
  let receipt: { outcome?: string; from?: string; to?: string; stage?: string } = {}
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  } catch {
    /* asserted below */
  }
  check('the update receipt records the transaction (outcome updated, stage complete, from → to)', receipt.outcome === 'updated' && receipt.stage === 'complete' && receipt.from === VERSION && receipt.to === NEXT, JSON.stringify(receipt))
  const v = run(shim, ['--version'])
  check('the stable command now runs the newer release', v.code === 0 && v.stdout.trim() === `Mercury ${NEXT}`, v.all.slice(0, 200))
  check('no transient residue lingers in the versions dir (.download-* / .staging-* / .replaced-* / lock)',
    !existsSync(join(versionsDir, '.update.lock')) && !readdirNames(versionsDir).some(n => n.startsWith('.download-') || n.startsWith('.staging-') || n.startsWith('.replaced-')))
}

console.log('── 6 · rollback returns to the archive version, forward again, and back ──')
{
  const r = run(launcher, ['update', '--rollback'])
  check('rollback exits 0 and names the switch', r.code === 0 && r.stdout.includes(`rolled back: ${NEXT} → ${VERSION}`), r.all.slice(0, 300))
  check('pointer back on the archive version; the newer payload stays for diagnosis', pointer('current') === VERSION && existsSync(join(versionsDir, NEXT, 'mercury.mjs')))
  const v = run(shim, ['--version'])
  check('the stable command runs the archive version again', v.code === 0 && v.stdout.trim() === `Mercury ${VERSION}`, v.all.slice(0, 200))
  const fwd = run(shim, ['update'])
  check('update forward again re-activates the newer release (already-installed payload, no re-download needed)', fwd.code === 0 && fwd.stdout.includes(`updated: ${VERSION} → ${NEXT}`), fwd.all.slice(0, 300))
  const back = run(launcher, ['update', '--rollback'])
  check('second rollback returns to the archive version', back.code === 0 && pointer('current') === VERSION, back.all.slice(0, 300))
}

console.log('── 7 · install --uninstall, run by the bundle whose directory it removes ──')
{
  const r = run(shim, ['install', '--uninstall'])
  check('uninstall exits 0', r.code === 0, r.all.slice(0, 400))
  check('report: the versions dir line', r.stdout.includes(`removed: ${versionsDir}`), r.stdout)
  check('report: the stable command line', r.stdout.includes(`removed: ${shim}`), r.stdout)
  check('report: the preserved home line', r.stdout.includes(`preserved: ${home} (configuration, sessions, extensions`), r.stdout)
  check('the versions dir is gone (every version, both pointers, the receipt)', !existsSync(versionsDir))
  check('the stable command is gone', !existsSync(shim))
  check('user state in the config home survives', existsSync(stateMarker) && readFileSync(stateMarker, 'utf8').includes('survives'))
  const again = run(launcher, ['install', '--uninstall'])
  check('a second uninstall is honest: nothing to remove, home still preserved', again.code === 0 && again.stdout.includes(`nothing to remove at ${versionsDir}`) && again.stdout.includes(`nothing to remove at ${shim} (absent)`), again.all.slice(0, 300))
}

console.log('── 8 · the channel transport audit ──')
{
  const log = existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : ''
  check('every channel read went through the gh seam (auth · repo probe · releases · download)',
    log.includes('gh auth status') && log.includes(`gh api repos/${SLUG}`) && log.includes(`gh release download v${NEXT}`), log.slice(0, 400))
  check('the download asked only for the asset and SHA256SUMS.txt', log.split('\n').filter(l => l.startsWith('gh release download')).every(l => l.includes(`--pattern ${NEXT_ASSET}`) && l.includes('--pattern SHA256SUMS.txt')))
}

function readdirNames(dir: string): string[] {
  try {
    return execFileSync('ls', ['-A', dir], { encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch {
    return []
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log('')
if (failures === 0) {
  console.log('PASS prove-archive-journey')
  process.exit(0)
}
console.log(`FAIL prove-archive-journey (${failures})`)
process.exit(1)
