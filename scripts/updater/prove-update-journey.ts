#!/usr/bin/env bun
// ============================================================================
//  scripts/updater/prove-update-journey.ts — the PRIVATE update service end
//  to end against the BUILT artifact (PRIVATE BETA RELEASE §9;
//  MERCURY-UPDATE-RELIABILITY U3).
//
//  The driver is `node dist/mercury.mjs update …` — the production call shape
//  — inside a fully hermetic scratch: the fake gh transport rides the
//  registered MERCURY_GH_CMD seam (portable — a PATH-front shim cannot spawn
//  on win32), HOME/MERCURY_CONFIG_DIR/MERCURY_VERSIONS_DIR pinned,
//  MERCURY_UPDATE_CHANNEL_REPO pinned to a fixture slug. Node (unlike bun)
//  honors the HOME override, so nothing here can touch the real machine; a
//  startsWith-scratch guard enforces it anyway. MERCURY_JOURNEY_DIST points
//  the driver at an alternate bundle (the release bridge-gate runs this
//  prover against the CANDIDATE archive's own bundle).
//
//  FIXTURE PROVENANCE (UPD-07): payloads are built through the packager's own
//  member-role authority — scripts/release/payloadContract.mjs + the real
//  launcher templates + the real manifest shapes — never a hand-authored
//  approximation, so a fixture cannot drift from the shipped archive. Shapes:
//  the current release-layout archive and the schema-2 declared-bundle shape
//  (a manifest without a releaseLayout section). Archives are real tarballs
//  on POSIX and real ZIPs (Compress-Archive) on win32, extracted through the
//  production path.
//
//  Covers: happy update → rollback → forward again · current/no-update ·
//  every checksum refusal (missing/duplicate/malformed/mismatch) ·
//  embedded-version mismatch · unexpected layout · staged + post-switch
//  smoke failures (automatic restore) · interrupted download · concurrent
//  refusal · access-unavailable · draft/non-prerelease filtering · accepted
//  payload shapes · the deterministic interruption matrix (promote-fail,
//  pointer-write-fail, unreadable pointer) with idempotent recovery + the
//  local receipt · state preservation · never-leaking tokens · the gh
//  invocation audit.
// ============================================================================
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetNameFor } from '../../src/services/privateChannel/channelCore.js'

// The packager's own member-role authority + REAL launcher templates (plain
// .mjs, shared with package.mjs — one contract, both consumers).
const { readCompatFloor, releaseLayoutSection, topAllowlist } = (await import('../release/payloadContract.mjs')) as {
  readCompatFloor: () => { floorVersion: string; forwarder: string }
  releaseLayoutSection: (dir: string, target: string, floor: unknown) => Record<string, unknown>
  topAllowlist: (target: string, floor: unknown) => string[]
}
const { cmdLauncher, parseEnginesNode, posixLauncher, ps1Launcher } = (await import('../release/launcherTemplates.mjs')) as {
  cmdLauncher: (p: unknown) => string
  parseEnginesNode: (range: string | undefined) => unknown
  posixLauncher: (p: unknown) => string
  ps1Launcher: (p: unknown) => string
}

const ROOT = join(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_JOURNEY_DIST ?? join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  if (process.env.MERCURY_JOURNEY_DIST) {
    console.log(`  [FAIL] MERCURY_JOURNEY_DIST names a missing bundle: ${DIST}`)
    process.exit(1)
  }
  console.log('  [SKIP-BUILD] dist/mercury.mjs absent — building first')
  execFileSync(process.execPath, ['run', 'build.ts'], { cwd: ROOT, stdio: 'inherit' })
}

const IS_WIN = process.platform === 'win32'
const TARGET = IS_WIN ? 'windows-x64' : process.platform === 'darwin' ? 'macos-arm64' : 'linux-x64'
const FLOOR = readCompatFloor()
const NODE_POLICY = parseEnginesNode(
  (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { engines?: { node?: string } }).engines?.node,
)

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

const scratch = mkdtempSync(join(tmpdir(), 'updater journey '))  // spaces on purpose
const home = join(scratch, 'home')
const configHome = join(home, '.mercury')
const versionsDir = join(scratch, 'versions')
const binDir = join(scratch, 'bin')
const fixturesRoot = join(scratch, 'fixtures')
const ghLog = join(scratch, 'gh-invocations.log')
for (const p of [home, configHome, versionsDir, binDir, fixturesRoot]) mkdirSync(p, { recursive: true })
for (const p of [home, versionsDir, binDir, fixturesRoot]) {
  if (!p.startsWith(scratch)) {
    console.log(`  [FAIL] SAFETY: path escapes scratch: ${p}`)
    process.exit(1)
  }
}

const SLUG = 'fixture-owner/fixture-private-repo'
const HOST_ASSET = (version: string): string => {
  const name = assetNameFor(version, process.platform, process.arch)
  if (!name) throw new Error(`host platform ${process.platform}/${process.arch} has no channel asset — run this prover on linux-x64/macos-arm64/windows-x64`)
  return name
}

// ── the fake gh (the registered MERCURY_GH_CMD seam — portable) ─────────────
const FAKE_GH = join(ROOT, 'scripts', 'updater', 'fake-gh.mjs')
const GH_CMD = JSON.stringify(['node', FAKE_GH])

// ── fixture payloads + archives (built THROUGH the packager's authority) ────
type PayloadShape = 'release-layout' | 'schema2-single'

interface PayloadOpts {
  manifestVersion?: string
  stagedFail?: boolean
  postSwitchFail?: boolean
  /** manifest shape; the default is the CURRENT floor-shaped release */
  shape?: PayloadShape
}

function makePayload(dir: string, version: string, opts: PayloadOpts = {}): void {
  const shape = opts.shape ?? 'release-layout'
  mkdirSync(join(dir, 'vendor', 'ripgrep', 'stub'), { recursive: true })
  writeFileSync(join(dir, 'vendor', 'ripgrep', 'stub', 'rg'), 'stub\n')
  const body = opts.stagedFail
    ? 'process.exit(1)\n'
    : `import { readFileSync } from 'node:fs'
const m = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'))
${opts.postSwitchFail ? `const dir = decodeURIComponent(new URL('.', import.meta.url).pathname)\nif (/[\\/\\\\]${version.replace(/\./g, '\\.')}[\\/\\\\]$/.test(dir)) process.exit(1)\n` : ''}console.log('Mercury ' + m.version)
`
  writeFileSync(join(dir, 'mercury.mjs'), body)
  // the enter screen rides the payload (friend-path hotfix): update must
  // deliver NEW payload members, not just the bundle — and since ruling 1 it
  // ships as the driver + compose-core PAIR.
  writeFileSync(join(dir, 'splash.mjs'), `// fixture splash ${version}\n`)
  writeFileSync(join(dir, 'splash-core.mjs'), `// fixture splash core ${version}\n`)
  // the REAL launcher templates + the full top-member set the packager ships
  if (IS_WIN) {
    writeFileSync(join(dir, 'mercury.cmd'), cmdLauncher(NODE_POLICY))
    writeFileSync(join(dir, 'mercury.ps1'), ps1Launcher(NODE_POLICY))
    writeFileSync(join(dir, 'install.ps1'), `# fixture installer stub\n`)
  } else {
    writeFileSync(join(dir, 'mercury'), posixLauncher(NODE_POLICY))
    writeFileSync(join(dir, 'install.sh'), `#!/bin/sh\n# fixture installer stub\n`)
  }
  for (const doc of ['README-FIRST.md', 'INSTALLING.md', 'UPDATING.md', 'RELEASE-NOTES.md', 'NOTICES.md']) {
    writeFileSync(join(dir, doc), `# fixture ${doc} ${version}\n`)
  }
  writeFileSync(join(dir, 'mercury-vscode.vsix'), `fixture-vsix ${version}\n`)
  // the shipped provenance verifier is a payload member since LANE LW —
  // the allowlist law (§layout) proves the fixture ships it like the packager
  writeFileSync(join(dir, 'verify-artifact.mjs'), `// fixture provenance verifier ${version}\n`)
  const manifest: Record<string, unknown> = {
    schema: 2,
    name: 'mercury',
    version: opts.manifestVersion ?? version,
    bundle: 'mercury.mjs',
    bundleBytes: statSync(join(dir, 'mercury.mjs')).size,
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest) + '\n')
  if (shape === 'release-layout') {
    // amend the manifest EXACTLY the way package.mjs does — after every
    // member is written, the declared-roles record covers them all
    manifest.releaseLayout = releaseLayoutSection(dir, TARGET, FLOOR)
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  }
  if (!IS_WIN) {
    for (const f of ['mercury', 'install.sh']) {
      if (existsSync(join(dir, f))) chmodSync(join(dir, f), 0o755)
    }
  }
}

const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')

interface ReleaseFixtureSpec {
  version: string
  tag?: string
  draft?: boolean
  prerelease?: boolean
  payload?: PayloadOpts
  archiveRoot?: string
  sums?: 'ok' | 'missing-entry' | 'duplicate' | 'malformed' | 'mismatch'
  omitAsset?: boolean
}

/** Archive a staged root — a real tarball on POSIX, a REAL ZIP through
 *  Compress-Archive on win32, so extraction exercises the production path. */
function archiveStage(stage: string, rootName: string, archivePath: string): void {
  if (IS_WIN) {
    execFileSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath $env:MJ_SRC -DestinationPath $env:MJ_DEST -Force'],
      { stdio: 'pipe', timeout: 300_000, env: { ...process.env, MJ_SRC: join(stage, rootName), MJ_DEST: archivePath } },
    )
  } else {
    execFileSync('tar', ['-czf', archivePath, '-C', stage, rootName])
  }
}

/** Build a fixture set (releases.json + per-tag asset dirs) in its own dir. */
function makeFixtures(name: string, specs: ReleaseFixtureSpec[]): string {
  const dir = join(fixturesRoot, name)
  const releases: unknown[] = []
  for (const spec of specs) {
    const tag = spec.tag ?? `v${spec.version}`
    const assetName = HOST_ASSET(spec.version)
    const tagDir = join(dir, 'assets', tag)
    mkdirSync(tagDir, { recursive: true })
    const stage = join(dir, 'stage', tag)
    const rootName = spec.archiveRoot ?? 'mercury'
    makePayload(join(stage, rootName), spec.version, spec.payload ?? {})
    const archivePath = join(tagDir, assetName)
    archiveStage(stage, rootName, archivePath)
    const digest = sha256(archivePath)
    let sumsText: string
    switch (spec.sums ?? 'ok') {
      case 'ok':
        sumsText = `${digest}  ${assetName}\n`
        break
      case 'missing-entry':
        sumsText = `${'0'.repeat(64)}  some-other-file.tar.gz\n`
        break
      case 'duplicate':
        sumsText = `${digest}  ${assetName}\n${'1'.repeat(64)}  ${assetName}\n`
        break
      case 'malformed':
        sumsText = `this is not a checksum manifest\n`
        break
      case 'mismatch':
        sumsText = `${'2'.repeat(64)}  ${assetName}\n`
        break
    }
    writeFileSync(join(tagDir, 'SHA256SUMS.txt'), sumsText)
    releases.push({
      tag_name: tag,
      draft: spec.draft ?? false,
      prerelease: spec.prerelease ?? true,
      assets: [...(spec.omitAsset ? [] : [{ name: assetName }]), { name: 'SHA256SUMS.txt' }],
    })
  }
  writeFileSync(join(dir, 'releases.json'), JSON.stringify(releases, null, 1))
  return dir
}

// ── the driver ──────────────────────────────────────────────────────────────
function runCli(
  args: string[],
  opts: { fixtures: string; env?: Record<string, string> } ,
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('node', [DIST, ...args], {
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      // win32 child processes need the system env (SystemRoot, COMSPEC…);
      // POSIX stays minimal-hermetic
      ...(IS_WIN ? process.env : {}),
      PATH: `${binDir}${IS_WIN ? ';' : ':'}${process.env.PATH ?? ''}`,
      HOME: home,
      ...(IS_WIN ? { LOCALAPPDATA: join(home, 'AppData', 'Local') } : {}),
      MERCURY_CONFIG_DIR: configHome,
      MERCURY_VERSIONS_DIR: versionsDir,
      MERCURY_UPDATE_CHANNEL_REPO: SLUG,
      MERCURY_GH_CMD: GH_CMD,
      GH_SHIM_FIXTURES: opts.fixtures,
      GH_SHIM_LOG: ghLog,
      CI: '1',
      TERM: 'dumb',
      ...(opts.env ?? {}),
    },
  })
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

const currentPointer = (): string | null =>
  existsSync(join(versionsDir, 'current.txt')) ? readFileSync(join(versionsDir, 'current.txt'), 'utf8').trim() : null
const previousPointer = (): string | null =>
  existsSync(join(versionsDir, 'previous.txt')) ? readFileSync(join(versionsDir, 'previous.txt'), 'utf8').trim() : null

/** Seed the managed layout with an installed older version (the rollback
 *  target) — a floor-shaped release-layout payload, the shape every managed
 *  install has. */
function seedInstalled(version: string): void {
  rmSync(versionsDir, { recursive: true, force: true })
  mkdirSync(versionsDir, { recursive: true })
  const dir = join(versionsDir, version)
  makePayload(dir, version)
  writeFileSync(join(versionsDir, 'current.txt'), version + '\n')
}

const V_OLD = '9.9.0-beta.1'
const V_NEW = '9.9.0-beta.2'
const stateMarker = join(configHome, 'user-state-marker.json')
writeFileSync(stateMarker, '{"survives":true}\n')
const stableShim = IS_WIN ? join(home, 'AppData', 'Local', 'Mercury', 'bin', 'mercury.cmd') : join(home, '.local', 'bin', 'mercury')

// ════ §0 fixture provenance — the fixture IS the packager's member set ════
console.log('── §0 fixture provenance (UPD-07: one member-role authority) ──')
{
  const provenance = join(scratch, 'provenance-payload')
  makePayload(provenance, '9.9.0-beta.9')
  const built = readdirSync(provenance).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const expected = topAllowlist(TARGET, FLOOR)
  check(
    'the default fixture payload carries EXACTLY the packager allowlist members',
    JSON.stringify(built) === JSON.stringify(expected),
    `built: ${built.join(',')} — expected: ${expected.join(',')}`,
  )
  const layout = (JSON.parse(readFileSync(join(provenance, 'manifest.json'), 'utf8')) as { releaseLayout?: { compatibility?: unknown[] } }).releaseLayout
  const declaredCompat = layout?.compatibility
  check('the floor declares no forwarder and the fixture layout declares no compatibility member', FLOOR.forwarder === 'none' && Array.isArray(declaredCompat) && declaredCompat.length === 0)
}

// ════ §1 the happy journey: check → update → current → rollback → forward ════
console.log('── §1 happy journey (update → current → rollback → forward) ──')
const happyFixtures = makeFixtures('happy', [{ version: V_OLD }, { version: V_NEW }])
seedInstalled(V_OLD)
{
  const r = runCli(['update', '--check'], { fixtures: happyFixtures })
  check('check reports the newer release', r.code === 0 && r.stdout.includes(`update available: v${V_NEW}`) && r.stdout.includes(V_OLD))
}
{
  const r = runCli(['update'], { fixtures: happyFixtures, env: { GH_TOKEN: 'ghp_FAKELEAKSECRET0000' } })
  check('update exits 0', r.code === 0, r.stdout + r.stderr)
  check('update reports from → to', r.stdout.includes(`updated: ${V_OLD} → ${V_NEW}`))
  check('pointer switched', currentPointer() === V_NEW)
  check('previous recorded + previous payload retained', previousPointer() === V_OLD && existsSync(join(versionsDir, V_OLD, 'mercury.mjs')))
  check('update delivered the full payload incl. the enter screen', existsSync(join(versionsDir, V_NEW, 'splash.mjs')))
  check('staging cleaned', !readFileSync(join(versionsDir, 'current.txt'), 'utf8').includes('.download') && !existsSync(join(versionsDir, `.download-${process.pid}`)))
  check('stable command written under the scratch home', existsSync(stableShim), stableShim)
  check('user state survives the update', existsSync(stateMarker))
  const all = r.stdout + r.stderr
  check('output never carries token material', !all.includes('FAKELEAKSECRET'))
}
{
  const r = runCli(['update'], { fixtures: happyFixtures })
  check('second update reports current (exit 0)', r.code === 0 && r.stdout.includes('Mercury is current'))
}
{
  const r = runCli(['update', '--rollback'], { fixtures: happyFixtures })
  check('rollback exits 0 + reports versions', r.code === 0 && r.stdout.includes(`rolled back: ${V_NEW} → ${V_OLD}`))
  check('pointer restored to the previous version', currentPointer() === V_OLD)
  check('newer version retained for diagnosis', existsSync(join(versionsDir, V_NEW, 'mercury.mjs')))
}
{
  const r = runCli(['update'], { fixtures: happyFixtures })
  check('forward again re-activates the newer version', r.code === 0 && currentPointer() === V_NEW)
  check('user state survives the whole journey', existsSync(stateMarker))
}

// ════ §2 discovery filtering ════
console.log('── §2 discovery filtering (drafts · non-prerelease · foreign tags · no asset) ──')
seedInstalled(V_OLD)
{
  const f = makeFixtures('draft-only', [{ version: V_OLD }, { version: V_NEW, draft: true }])
  const r = runCli(['update', '--check'], { fixtures: f })
  check('a draft is never selected', r.code === 0 && r.stdout.includes('Mercury is current'))
}
{
  const f = makeFixtures('non-prerelease', [{ version: V_OLD }, { version: V_NEW, prerelease: false }])
  const r = runCli(['update', '--check'], { fixtures: f })
  check('a non-prerelease newest is refused as malformed (exit 1)', r.code === 1 && (r.stderr + r.stdout).includes('not marked prerelease'))
}
{
  const f = join(fixturesRoot, 'foreign-tags')
  mkdirSync(f, { recursive: true })
  writeFileSync(join(f, 'releases.json'), JSON.stringify([{ tag_name: 'bench-corpus-v1', draft: false, prerelease: true, assets: [] }]))
  const r = runCli(['update', '--check'], { fixtures: f })
  check('foreign tags ⇒ no private releases (exit 0)', r.code === 0 && r.stdout.includes('no private releases found'))
}
{
  const f = makeFixtures('no-platform-asset', [{ version: V_OLD }, { version: V_NEW, omitAsset: true }])
  const r = runCli(['update', '--check'], { fixtures: f })
  check('missing platform asset refused by name (exit 1)', r.code === 1 && (r.stderr + r.stdout).includes('has no mercury-v'))
}

// ════ §3 acquisition refusals — active install untouched by every one ════
console.log('── §3 checksum / layout / version / smoke refusals ──')
const refusalCases: Array<{ name: string; spec: ReleaseFixtureSpec; needle: string; env?: Record<string, string> }> = [
  { name: 'missing checksum entry', spec: { version: V_NEW, sums: 'missing-entry' }, needle: 'no entry for' },
  { name: 'duplicate checksum entry', spec: { version: V_NEW, sums: 'duplicate' }, needle: '2 times' },
  { name: 'malformed checksum manifest', spec: { version: V_NEW, sums: 'malformed' }, needle: 'malformed' },
  { name: 'checksum mismatch', spec: { version: V_NEW, sums: 'mismatch' }, needle: 'SHA-256 mismatch' },
  { name: 'embedded-version mismatch', spec: { version: V_NEW, payload: { manifestVersion: '0.0.1-beta.9' } }, needle: 'does not equal the selected release' },
  { name: 'unexpected archive layout', spec: { version: V_NEW, archiveRoot: 'payload' }, needle: 'unexpected archive layout' },
  { name: 'staged smoke failure', spec: { version: V_NEW, payload: { stagedFail: true } }, needle: 'staged smoke failed' },
  { name: 'interrupted download (sums never arrives)', spec: { version: V_NEW }, needle: 'absent', env: { GH_SHIM_SKIP_SUMS: '1' } },
]
for (const c of refusalCases) {
  seedInstalled(V_OLD)
  const f = makeFixtures(`refusal-${c.name.replace(/[^a-z0-9]+/gi, '-')}`, [{ version: V_OLD }, c.spec])
  const r = runCli(['update'], { fixtures: f, env: c.env })
  const all = r.stdout + r.stderr
  check(`${c.name}: exit 1 + named`, r.code === 1 && all.includes(c.needle), all.slice(0, 200))
  check(`${c.name}: active install untouched`, currentPointer() === V_OLD && !existsSync(join(versionsDir, V_NEW)))
  check(`${c.name}: staging cleaned`, !existsSync(join(versionsDir)) || !readFileSync(join(versionsDir, 'current.txt'), 'utf8').includes('.download'))
}

// post-switch failure: activation happened, smoke failed, pointer restored
console.log('── §4 post-switch smoke failure ⇒ automatic restore ──')
{
  seedInstalled(V_OLD)
  const f = makeFixtures('post-switch-fail', [{ version: V_OLD }, { version: V_NEW, payload: { postSwitchFail: true } }])
  const r = runCli(['update'], { fixtures: f })
  const all = r.stdout + r.stderr
  check('post-switch failure exits 1 + says restored', r.code === 1 && all.includes('previous version was restored'), all.slice(0, 300))
  check('pointer automatically restored', currentPointer() === V_OLD)
}

// ════ §5 access + concurrency + rollback refusals ════
console.log('── §5 access unavailable · concurrent lock · rollback refusals ──')
{
  seedInstalled(V_OLD)
  const r = runCli(['update', '--check'], { fixtures: happyFixtures, env: { GH_SHIM_AUTH: 'fail' } })
  const all = r.stdout + r.stderr
  check('signed-out gh ⇒ exit 1 + sign-in remedy', r.code === 1 && all.includes('gh auth login'))
}
{
  seedInstalled(V_OLD)
  const r = runCli(['update', '--check'], { fixtures: happyFixtures, env: { GH_SHIM_REPO_ACCESS: 'deny' } })
  const all = r.stdout + r.stderr
  check('no repo access ⇒ exit 1 + collaborator remedy', r.code === 1 && all.includes('collaborator'))
}
{
  seedInstalled(V_OLD)
  mkdirSync(join(versionsDir, '.update.lock'), { recursive: true })
  writeFileSync(join(versionsDir, '.update.lock', 'pid'), String(process.pid))
  const r = runCli(['update'], { fixtures: happyFixtures })
  const all = r.stdout + r.stderr
  check('concurrent update refused (live lock)', r.code === 1 && all.includes('already running'))
  check('lock survives the refusal', existsSync(join(versionsDir, '.update.lock')))
  rmSync(join(versionsDir, '.update.lock'), { recursive: true, force: true })
}
{
  seedInstalled(V_OLD)
  const r = runCli(['update', '--rollback'], { fixtures: happyFixtures })
  const all = r.stdout + r.stderr
  check('rollback without a previous version refused honestly', r.code === 1 && all.includes('no previous installed version'))
}
{
  seedInstalled(V_OLD)
  writeFileSync(join(versionsDir, 'previous.txt'), '9.8.0-beta.1\n')
  const r = runCli(['update', '--rollback'], { fixtures: happyFixtures })
  const all = r.stdout + r.stderr
  check('rollback to a damaged previous refused', r.code === 1 && all.includes('no longer intact'))
  check('active version unchanged after refusal', currentPointer() === V_OLD)
}

// ════ §7 accepted payload shapes (end to end) ════
console.log('── §7 accepted payload shapes — every accepted manifest shape UPDATES ──')
{
  // the schema-2 declared-bundle shape: a manifest without a releaseLayout
  // section, mercury.mjs declared as the bundle
  seedInstalled(V_OLD)
  const f = makeFixtures('schema2-single', [{ version: V_OLD }, { version: V_NEW, payload: { shape: 'schema2-single' } }])
  const r = runCli(['update'], { fixtures: f })
  check('the schema-2 declared-bundle shape updates', r.code === 0 && currentPointer() === V_NEW, (r.stdout + r.stderr).slice(0, 300))
  const rerun = runCli(['update'], { fixtures: f })
  check('rerun after the schema-2 update is an honest current (whole-payload identity)', rerun.code === 0 && rerun.stdout.includes('Mercury is current'))
}

// ════ §8 the interruption matrix (deterministic injection, production seam) ════
console.log('── §8 interruption matrix — recovery without hand-cleaning (UPD-08) ──')
{
  // promote-rename failure inside the staged install: refused, typed stage,
  // nothing activated, and the ordinary rerun completes with no cleanup.
  seedInstalled(V_OLD)
  const f = makeFixtures('interrupt-promote', [{ version: V_OLD }, { version: V_NEW }])
  const r = runCli(['update'], { fixtures: f, env: { MERCURY_UPDATE_FAULT: 'promote-rename' } })
  const all = r.stdout + r.stderr
  check('injected promote failure refuses at staging', r.code === 1 && all.includes('refused at staging'), all.slice(0, 300))
  check('promote failure: active pointer untouched, no new version dir', currentPointer() === V_OLD && !existsSync(join(versionsDir, V_NEW)))
  check('promote failure names retry as appropriate', all.includes('retry is appropriate'))
  const r2 = runCli(['update'], { fixtures: f })
  check('ordinary rerun after the interruption succeeds (no hand-cleaning)', r2.code === 0 && currentPointer() === V_NEW, (r2.stdout + r2.stderr).slice(0, 300))
  check('user state survives the interrupted-then-recovered journey', existsSync(stateMarker))
}
{
  // pointer-selection failure BETWEEN the pointer writes: previous.txt may
  // update but current.txt must not — the active version is unchanged.
  seedInstalled(V_OLD)
  const f = makeFixtures('interrupt-pointer', [{ version: V_OLD }, { version: V_NEW }])
  const r = runCli(['update'], { fixtures: f, env: { MERCURY_UPDATE_FAULT: 'pointer-write-current' } })
  const all = r.stdout + r.stderr
  check('injected pointer-write failure refuses at pointer', r.code === 1 && all.includes('refused at pointer'), all.slice(0, 300))
  check('current pointer UNCHANGED through the pointer-stage failure', currentPointer() === V_OLD)
  const r2 = runCli(['update'], { fixtures: f })
  check('rerun after the pointer failure completes', r2.code === 0 && currentPointer() === V_NEW)
}
if (!IS_WIN) {
  // a REAL unreadable pointer (EACCES): the updater refuses by name instead
  // of guessing through filesystem damage (UPD-11)
  seedInstalled(V_OLD)
  const f = makeFixtures('unreadable-pointer', [{ version: V_OLD }, { version: V_NEW }])
  chmodSync(join(versionsDir, 'current.txt'), 0o000)
  const r = runCli(['update'], { fixtures: f })
  const all = r.stdout + r.stderr
  check('unreadable pointer: update refuses by name, changes nothing', r.code === 1 && all.includes('pointer is unreadable'), all.slice(0, 300))
  chmodSync(join(versionsDir, 'current.txt'), 0o644)
  const status = runCli(['update', '--status'], { fixtures: f, env: { MERCURY_UPDATE_FAULT: 'pointer-read' } })
  // FC-121: filesystem damage is a REFUSAL from every read-only verb — the
  // status report exits 1 and rides stderr, agreeing with --check (the
  // agreement prover pins the pair); the state is still NAMED by spelling.
  const statusAll = status.stdout + status.stderr
  check(
    '--status NAMES the unreadable pointer state (and exits 1, agreeing with --check)',
    status.code === 1 && statusAll.includes('pointer file unreadable'),
    `code=${status.code} ${statusAll.slice(0, 300)}`,
  )
}

// ════ §9 the local receipt (every attempted transaction leaves a record) ════
console.log('── §9 the update receipt — stage + outcome recorded beside the versions ──')
{
  seedInstalled(V_OLD)
  const f = makeFixtures('receipt', [{ version: V_OLD }, { version: V_NEW }])
  const fail = runCli(['update'], { fixtures: f, env: { MERCURY_UPDATE_FAULT: 'promote-rename' } })
  const receiptPath = join(versionsDir, 'last-update.json')
  check('a refused transaction writes the receipt', existsSync(receiptPath))
  const refusedReceipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { outcome?: string; stage?: string; txn?: string }
  check('the receipt records outcome + stage + txn', refusedReceipt.outcome === 'refused' && refusedReceipt.stage === 'staging' && !!refusedReceipt.txn)
  check('the refusal PRINTS the receipt path', (fail.stdout + fail.stderr).includes('receipt:'))
  const ok = runCli(['update'], { fixtures: f })
  const okReceipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { outcome?: string; stage?: string; from?: string; to?: string }
  check('the completed update overwrites the receipt (complete, from → to)', ok.code === 0 && okReceipt.outcome === 'updated' && okReceipt.stage === 'complete' && okReceipt.from === V_OLD && okReceipt.to === V_NEW)
  check('the receipt never appears in the version census', !runCli(['update', '--status'], { fixtures: f }).stdout.includes('last-update'))
}

// ════ §6 the gh invocation audit (never public, never anonymous) ════
console.log('── §6 gh invocation audit ──')
{
  const log = readFileSync(ghLog, 'utf8')
  const lines = log.split('\n').filter(Boolean)
  check('every gh call is auth/api/release only', lines.every(l => /^gh (auth status|api repos\/|release download )/.test(l)), lines.find(l => !/^gh (auth status|api repos\/|release download )/.test(l)) ?? '')
  const apiCalls = lines.filter(l => l.startsWith('gh api'))
  check('every api call targets the configured private slug', apiCalls.every(l => l.includes(SLUG)))
  const downloads = lines.filter(l => l.startsWith('gh release download'))
  check('every download names the configured repo', downloads.length > 0 && downloads.every(l => l.includes(`--repo ${SLUG}`)))
  check('gh is never asked for a token', !log.includes('auth token'))
}

rmSync(scratch, { recursive: true, force: true })
console.log('')
if (failures === 0) {
  console.log('PASS prove-update-journey')
  process.exit(0)
}
console.log(`FAIL prove-update-journey (${failures})`)
process.exit(1)
