#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closedLoopbackPort, FLOOR, IS_WIN, hostAllowlist, makeFixtures as mintFixtures, makePayload, spawnFixtureReleaseServer, type ReleaseFixtureSpec } from './journeyFixtures.js'

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

let failures = 0
{
  const { readFileSync: readSource } = await import('node:fs')
  const { join: joinPath, resolve: resolvePath } = await import('node:path')
  const svc = readSource(joinPath(resolvePath(import.meta.dir, '..', '..'), 'src', 'services', 'privateChannel', 'updateService.ts'), 'utf8')
  const { NOTHING_ACTIVATED_WORDS } = await import('../../src/services/privateChannel/updateService.ts')
  const spellings = svc.match(/nothing was activated/g) ?? []
  const remedies = svc.match(/remedy: [^\n]*(?:activated|NOTHING_ACTIVATED_WORDS)[^\n]*/g) ?? []
  const handSpelled = remedies.filter(r => !r.includes('${NOTHING_ACTIVATED_WORDS}'))
  const ok = NOTHING_ACTIVATED_WORDS === 'nothing was activated — the active installation was not changed' && spellings.length === 1 && handSpelled.length === 0 && remedies.length >= 8
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] the activation sentence has one spelling in the source (the exported owner) and every 'activated' remedy interpolates it (${remedies.length} remedies, ${spellings.length} spelling(s))${handSpelled.length ? ` — hand-spelled: ${handSpelled[0]!.slice(0, 120)}` : ''}`)
  if (!ok) failures++
}
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

const scratch = mkdtempSync(join(tmpdir(), 'updater journey '))
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

const FAKE_GH = join(ROOT, 'scripts', 'updater', 'fake-gh.mjs')
const GH_CMD = JSON.stringify(['node', FAKE_GH])
const DEAD_API_BASE = `http://127.0.0.1:${await closedLoopbackPort()}`

const makeFixtures = (name: string, specs: ReleaseFixtureSpec[]): string => mintFixtures(fixturesRoot, name, specs)

function runCli(
  args: string[],
  opts: { fixtures: string; env?: Record<string, string> } ,
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync('node', [DIST, ...args], {
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...(IS_WIN ? process.env : {}),
      PATH: `${binDir}${IS_WIN ? ';' : ':'}${process.env.PATH ?? ''}`,
      HOME: home,
      ...(IS_WIN ? { LOCALAPPDATA: join(home, 'AppData', 'Local') } : {}),
      MERCURY_CONFIG_DIR: configHome,
      MERCURY_VERSIONS_DIR: versionsDir,
      MERCURY_UPDATE_CHANNEL_REPO: SLUG,
      MERCURY_UPDATE_API_BASE_URL: DEAD_API_BASE,
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

console.log('── §0 fixture provenance (UPD-07: one member-role authority) ──')
{
  const provenance = join(scratch, 'provenance-payload')
  makePayload(provenance, '9.9.0-beta.9')
  const built = readdirSync(provenance).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const expected = hostAllowlist()
  check(
    'the default fixture payload carries EXACTLY the packager allowlist members',
    JSON.stringify(built) === JSON.stringify(expected),
    `built: ${built.join(',')} — expected: ${expected.join(',')}`,
  )
  const layout = (JSON.parse(readFileSync(join(provenance, 'manifest.json'), 'utf8')) as { releaseLayout?: { compatibility?: unknown[] } }).releaseLayout
  const declaredCompat = layout?.compatibility
  check('the floor declares no forwarder and the fixture layout declares no compatibility member', FLOOR.forwarder === 'none' && Array.isArray(declaredCompat) && declaredCompat.length === 0)
}

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
  check('foreign tags ⇒ no releases (exit 0)', r.code === 0 && r.stdout.includes('no releases found'))
}
{
  const f = makeFixtures('no-platform-asset', [{ version: V_OLD }, { version: V_NEW, omitAsset: true }])
  const r = runCli(['update', '--check'], { fixtures: f })
  check('missing platform asset refused by name (exit 1)', r.code === 1 && (r.stderr + r.stdout).includes('has no mercury-v'))
}

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

console.log('── §3b tampered provenance ⇒ refused at verify, nothing staged; unsigned still activates ──')
{
  seedInstalled(V_OLD)
  const f = makeFixtures('tampered', [{ version: V_OLD }, { version: V_NEW, payload: { tampered: true } }])
  const r = runCli(['update'], { fixtures: f })
  const all = r.stdout + r.stderr
  check('a signing block that does not verify refuses at verify, naming the signed sha256 mismatch', r.code === 1 && all.includes('refused at verify') && all.includes('differ from the signed sha256'), all.slice(0, 300))
  check('nothing was staged: the active install untouched, no new version directory', currentPointer() === V_OLD && !existsSync(join(versionsDir, V_NEW)))
  const unsigned = makeFixtures('unsigned-activates', [{ version: V_OLD }, { version: V_NEW }])
  const ok = runCli(['update'], { fixtures: unsigned })
  check('an unsigned release still activates and its verdict is said (the ruled tolerance)', ok.code === 0 && currentPointer() === V_NEW && (ok.stdout + ok.stderr).includes('unsigned'), (ok.stdout + ok.stderr).slice(0, 300))
}

console.log('── §4 post-switch smoke failure ⇒ automatic restore ──')
{
  seedInstalled(V_OLD)
  const f = makeFixtures('post-switch-fail', [{ version: V_OLD }, { version: V_NEW, payload: { postSwitchFail: true } }])
  const r = runCli(['update'], { fixtures: f })
  const all = r.stdout + r.stderr
  check('post-switch failure exits 1 + says restored', r.code === 1 && all.includes('previous version was restored'), all.slice(0, 300))
  check('pointer automatically restored', currentPointer() === V_OLD)
}

console.log('── §5 access unavailable · concurrent lock · rollback refusals ──')
{
  seedInstalled(V_OLD)
  const privateChannel = await spawnFixtureReleaseServer({ fixtures: happyFixtures, visibility: 'private' })
  const r = runCli(['update', '--check'], { fixtures: happyFixtures, env: { GH_SHIM_AUTH: 'fail', MERCURY_UPDATE_API_BASE_URL: privateChannel.url } })
  await privateChannel.close()
  const all = r.stdout + r.stderr
  check('signed-out gh + a private channel ⇒ exit 1 + the not-visible words with the sign-in remedy', r.code === 1 && all.includes('not visible') && all.includes('gh auth login'), all.slice(0, 300))
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

console.log('── §7 accepted payload shapes — every accepted manifest shape UPDATES ──')
{
  seedInstalled(V_OLD)
  const f = makeFixtures('schema2-single', [{ version: V_OLD }, { version: V_NEW, payload: { shape: 'schema2-single' } }])
  const r = runCli(['update'], { fixtures: f })
  check('the schema-2 declared-bundle shape updates', r.code === 0 && currentPointer() === V_NEW, (r.stdout + r.stderr).slice(0, 300))
  const rerun = runCli(['update'], { fixtures: f })
  check('rerun after the schema-2 update is an honest current (whole-payload identity)', rerun.code === 0 && rerun.stdout.includes('Mercury is current'))
}

console.log('── §8 interruption matrix — recovery without hand-cleaning (UPD-08) ──')
{
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
  seedInstalled(V_OLD)
  const f = makeFixtures('unreadable-pointer', [{ version: V_OLD }, { version: V_NEW }])
  chmodSync(join(versionsDir, 'current.txt'), 0o000)
  const r = runCli(['update'], { fixtures: f })
  const all = r.stdout + r.stderr
  check('unreadable pointer: update refuses by name, changes nothing', r.code === 1 && all.includes('pointer is unreadable'), all.slice(0, 300))
  chmodSync(join(versionsDir, 'current.txt'), 0o644)
  const status = runCli(['update', '--status'], { fixtures: f, env: { MERCURY_UPDATE_FAULT: 'pointer-read' } })
  const statusAll = status.stdout + status.stderr
  check(
    '--status NAMES the unreadable pointer state (and exits 1, agreeing with --check)',
    status.code === 1 && statusAll.includes('pointer file unreadable'),
    `code=${status.code} ${statusAll.slice(0, 300)}`,
  )
}

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
