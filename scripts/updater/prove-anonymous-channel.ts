#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closedLoopbackPort, IS_WIN, hostAssetName, makeFixtures as mintFixtures, makePayload, spawnFixtureReleaseServer, type ReleaseFixtureSpec } from './journeyFixtures.js'

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
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

const scratch = mkdtempSync(join(tmpdir(), 'anonymous channel '))
const home = join(scratch, 'home')
const configHome = join(home, '.mercury')
const versionsDir = join(scratch, 'versions')
const binDir = join(scratch, 'bin')
const fixturesRoot = join(scratch, 'fixtures')
const logsDir = join(scratch, 'logs')
for (const p of [home, configHome, versionsDir, binDir, fixturesRoot, logsDir]) mkdirSync(p, { recursive: true })
for (const p of [home, versionsDir, binDir, fixturesRoot, logsDir]) {
  if (!p.startsWith(scratch)) {
    console.log(`  [FAIL] SAFETY: path escapes scratch: ${p}`)
    process.exit(1)
  }
}

const SLUG = 'fixture-owner/mercury-public'
const V_OLD = '9.9.0-beta.1'
const V_NEW = '9.9.0-beta.2'
const NEW_ASSET = hostAssetName(V_NEW)
const ABSENT_GH = JSON.stringify([join(scratch, 'absent', 'gh')])
const FAKE_GH = JSON.stringify(['node', join(ROOT, 'scripts', 'updater', 'fake-gh.mjs')])
const DEAD_BASE = `http://127.0.0.1:${await closedLoopbackPort()}`
const makeFixtures = (name: string, specs: ReleaseFixtureSpec[]): string => mintFixtures(fixturesRoot, name, specs)

type GhPresence = 'absent' | 'signed-out' | 'signed-in'

function runCli(
  args: string[],
  opts: { base: string; gh: GhPresence; ghFixtures?: string; ghLog?: string; env?: Record<string, string> },
): { code: number; stdout: string; stderr: string; all: string } {
  const ghEnv: Record<string, string> =
    opts.gh === 'absent'
      ? { MERCURY_GH_CMD: ABSENT_GH }
      : {
          MERCURY_GH_CMD: FAKE_GH,
          ...(opts.gh === 'signed-out' ? { GH_SHIM_AUTH: 'fail' } : {}),
          ...(opts.ghFixtures ? { GH_SHIM_FIXTURES: opts.ghFixtures } : {}),
          ...(opts.ghLog ? { GH_SHIM_LOG: opts.ghLog } : {}),
        }
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
      MERCURY_UPDATE_API_BASE_URL: opts.base,
      ...ghEnv,
      CI: '1',
      TERM: 'dumb',
      ...(opts.env ?? {}),
    },
  })
  const stdout = res.stdout ?? ''
  const stderr = res.stderr ?? ''
  return { code: res.status ?? -1, stdout, stderr, all: stdout + stderr }
}

const pointer = (name: 'current' | 'previous'): string | null =>
  existsSync(join(versionsDir, `${name}.txt`)) ? readFileSync(join(versionsDir, `${name}.txt`), 'utf8').trim() : null
const readReceipt = (): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(join(versionsDir, 'last-update.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}
const readLog = (path: string): string[] => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [])
const parseJson = (text: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

function seedInstalled(version: string): void {
  rmSync(versionsDir, { recursive: true, force: true })
  mkdirSync(versionsDir, { recursive: true })
  makePayload(join(versionsDir, version), version)
  writeFileSync(join(versionsDir, 'current.txt'), version + '\n')
}

const stateMarker = join(configHome, 'user-state-marker.json')
writeFileSync(stateMarker, '{"survives":true}\n')
const happyFixtures = makeFixtures('happy', [{ version: V_OLD }, { version: V_NEW }])

console.log('── §1 no gh: check → update → status → rollback → forward, anonymously ──')
{
  const log = join(logsDir, 'happy-requests.log')
  const server = await spawnFixtureReleaseServer({ fixtures: happyFixtures, log })
  seedInstalled(V_OLD)
  const c = runCli(['update', '--check'], { base: server.url, gh: 'absent' })
  check('--check sees the newer release and names the anonymous road', c.code === 0 && c.stdout.includes(`update available: v${V_NEW} (installed: ${V_OLD})`) && c.stdout.includes('read anonymously — no sign-in needed'), c.all.slice(0, 300))
  const cj = runCli(['update', '--check', '--json'], { base: server.url, gh: 'absent' })
  const cjson = parseJson(cj.stdout)
  check('--check --json carries the road and the record\'s own download URL', cj.code === 0 && cjson?.state === 'update-available' && cjson?.road === 'anonymous' && typeof cjson?.assetUrl === 'string' && (cjson.assetUrl as string).startsWith(server.url), cj.stdout.slice(0, 300))

  const u = runCli(['update'], { base: server.url, gh: 'absent', env: { GH_TOKEN: 'ghp_FAKELEAKSECRET0000' } })
  check('update exits 0 and reports from → to over the anonymous road', u.code === 0 && u.stdout.includes(`updated: ${V_OLD} → ${V_NEW} (read anonymously`), u.all.slice(0, 400))
  check('the signature verdict is SAID at activation (unsigned fixture) on the result and the progress', u.stdout.includes('signature: unsigned') && u.stderr.includes('signature: unsigned —'), u.all.slice(0, 400))
  check('pointer switched, previous retained', pointer('current') === V_NEW && pointer('previous') === V_OLD && existsSync(join(versionsDir, V_OLD, 'mercury.mjs')))
  check('the full payload landed (the enter-screen pair rides the update)', existsSync(join(versionsDir, V_NEW, 'splash.mjs')) && existsSync(join(versionsDir, V_NEW, 'splash-core.mjs')))
  const receipt = readReceipt()
  check('the receipt records the road and the verdict', receipt.outcome === 'updated' && receipt.road === 'anonymous' && receipt.signature === 'unsigned' && receipt.from === V_OLD && receipt.to === V_NEW, JSON.stringify(receipt))
  check('output never carries token material', !u.all.includes('FAKELEAKSECRET'))
  check('user state survives the update', existsSync(stateMarker))

  const requests = readLog(log)
  check('every request was a plain GET carrying no credential', requests.length > 0 && requests.every(l => l.startsWith('GET ') && l.includes('authorization=absent')), requests.join(' | ').slice(0, 400))
  check('every request names the product in its user-agent', requests.every(l => /user-agent=mercury\//.test(l)))
  check('the listing is GitHub\'s public release list of the configured slug', requests.some(l => l.startsWith(`GET /repos/${SLUG}/releases?per_page=50 `)))
  check('the archive came from the record\'s download URL and the redirect was followed', requests.some(l => l.startsWith(`GET /${SLUG}/releases/download/v${V_NEW}/${NEW_ASSET} `)) && requests.some(l => l.startsWith(`GET /objects/v${V_NEW}/${NEW_ASSET} `)))
  check('the checksum manifest came from the same release', requests.some(l => l.startsWith(`GET /objects/v${V_NEW}/SHA256SUMS.txt `)))
  check('a check is ONE listing request — no separate repository probe', !requests.some(l => l.startsWith(`GET /repos/${SLUG} `)))

  const s = runCli(['update', '--status'], { base: server.url, gh: 'absent' })
  check('--status reads ok over the anonymous road and says so', s.code === 0 && s.stdout.includes('channel access:    ok (read anonymously — no sign-in needed)') && s.stdout.includes(`installed version: ${V_NEW}`), s.all.slice(0, 500))
  const sj = runCli(['update', '--status', '--json'], { base: server.url, gh: 'absent' })
  const sjson = parseJson(sj.stdout)
  const access = (sjson?.access ?? {}) as Record<string, unknown>
  check('--status --json carries access.road', sj.code === 0 && access.state === 'ok' && access.road === 'anonymous', sj.stdout.slice(0, 300))

  const again = runCli(['update'], { base: server.url, gh: 'absent' })
  check('a second update is an honest current, naming the road', again.code === 0 && again.stdout.includes('Mercury is current') && again.stdout.includes('read anonymously'), again.all.slice(0, 300))

  const before = readLog(log).length
  const r = runCli(['update', '--rollback'], { base: server.url, gh: 'absent' })
  check('rollback exits 0 and restores the previous version', r.code === 0 && r.stdout.includes(`rolled back: ${V_NEW} → ${V_OLD}`) && pointer('current') === V_OLD, r.all.slice(0, 300))
  check('rollback touches the channel not at all', readLog(log).length === before)
  const fwd = runCli(['update'], { base: server.url, gh: 'absent' })
  check('forward again re-activates the newer version', fwd.code === 0 && pointer('current') === V_NEW, fwd.all.slice(0, 300))
  check('user state survives the whole journey', existsSync(stateMarker))
  await server.close()
}

console.log('── §2 refusals over the anonymous road: corrupted archive · incomplete publish ──')
{
  const corrupted = makeFixtures('corrupted', [{ version: V_OLD }, { version: V_NEW, sums: 'mismatch' }])
  const server = await spawnFixtureReleaseServer({ fixtures: corrupted })
  seedInstalled(V_OLD)
  const r = runCli(['update'], { base: server.url, gh: 'absent' })
  check('a corrupted archive is refused by its checksum with the words', r.code === 1 && r.all.includes('refused at checksum') && r.all.includes('SHA-256 mismatch'), r.all.slice(0, 300))
  check('the active installation is untouched', pointer('current') === V_OLD && !existsSync(join(versionsDir, V_NEW)))
  check('the refusal receipt names the road', readReceipt().outcome === 'refused' && readReceipt().road === 'anonymous', JSON.stringify(readReceipt()))
  await server.close()
}
{
  const server = await spawnFixtureReleaseServer({ fixtures: happyFixtures, skipSums: true })
  seedInstalled(V_OLD)
  const r = runCli(['update'], { base: server.url, gh: 'absent' })
  check('an incomplete publish (no SHA256SUMS.txt) is refused at download, by name', r.code === 1 && r.all.includes('refused at download') && r.all.includes('SHA256SUMS.txt') && r.all.includes('HTTP 404'), r.all.slice(0, 300))
  check('nothing was activated', pointer('current') === V_OLD && !existsSync(join(versionsDir, V_NEW)))
  await server.close()
}

console.log('── §3 rate limited: the reset in minutes and the sign-in remedy ──')
{
  const server = await spawnFixtureReleaseServer({ fixtures: happyFixtures, rateLimit: true, rateResetSeconds: 1500 })
  seedInstalled(V_OLD)
  const c = runCli(['update', '--check'], { base: server.url, gh: 'absent' })
  check('--check exits 1 with the limit words: the reset in minutes', c.code === 1 && c.all.includes('anonymous request limit') && c.all.includes('resets in 25 minutes'), c.all.slice(0, 300))
  check('…and the remedy: sign in the GitHub CLI to raise the limit', c.all.includes('sign in the GitHub CLI to raise the limit'))
  check('…never a generic network error', !c.all.includes('could not be reached'))
  const cj = runCli(['update', '--check', '--json'], { base: server.url, gh: 'absent' })
  const access = ((parseJson(cj.stderr) ?? {}).access ?? {}) as Record<string, unknown>
  check('--json names the state and the minutes', cj.code === 1 && access.state === 'rate-limited' && access.resetMinutes === 25, cj.stderr.slice(0, 300))
  const u = runCli(['update'], { base: server.url, gh: 'absent' })
  check('update says the same and changes nothing', u.code === 1 && u.all.includes('resets in 25 minutes') && pointer('current') === V_OLD, u.all.slice(0, 300))
  await server.close()
}

console.log('── §4 a private channel answers 404 anonymously: named, with the sign-in remedy ──')
{
  const server = await spawnFixtureReleaseServer({ fixtures: happyFixtures, visibility: 'private' })
  seedInstalled(V_OLD)
  const c = runCli(['update', '--check'], { base: server.url, gh: 'absent' })
  check('--check exits 1 naming the not-visible case and why gh did not answer', c.code === 1 && c.all.includes('not visible without a sign-in') && c.all.includes('gh) is not installed'), c.all.slice(0, 300))
  check('…with the sign-in remedy', c.all.includes('gh auth login'))
  const s = runCli(['update', '--status'], { base: server.url, gh: 'absent' })
  check('--status names the same state', s.code === 0 && s.stdout.includes('channel access:    not-visible'), s.all.slice(0, 400))
  await server.close()
}

console.log('── §5 an unreachable channel is named, not guessed ──')
{
  seedInstalled(V_OLD)
  const c = runCli(['update', '--check'], { base: DEAD_BASE, gh: 'absent' })
  check('--check exits 1 with the socket\'s reason', c.code === 1 && c.all.includes('could not be reached') && c.all.includes('ECONNREFUSED'), c.all.slice(0, 300))
  const cj = runCli(['update', '--check', '--json'], { base: DEAD_BASE, gh: 'absent' })
  const access = ((parseJson(cj.stderr) ?? {}).access ?? {}) as Record<string, unknown>
  check('--json names the state', cj.code === 1 && access.state === 'unreachable' && access.road === 'anonymous', cj.stderr.slice(0, 300))
  check('nothing changed', pointer('current') === V_OLD)
}

console.log('── §6 gh installed but signed out: the anonymous road answers ──')
{
  const log = join(logsDir, 'signed-out-requests.log')
  const ghLog = join(logsDir, 'signed-out-gh.log')
  const server = await spawnFixtureReleaseServer({ fixtures: happyFixtures, log })
  seedInstalled(V_OLD)
  const c = runCli(['update', '--check'], { base: server.url, gh: 'signed-out', ghLog })
  check('--check answers over the anonymous road', c.code === 0 && c.stdout.includes(`update available: v${V_NEW}`) && c.stdout.includes('read anonymously'), c.all.slice(0, 300))
  const u = runCli(['update'], { base: server.url, gh: 'signed-out', ghLog })
  check('update completes over the anonymous road', u.code === 0 && pointer('current') === V_NEW && readReceipt().road === 'anonymous', u.all.slice(0, 300))
  const ghCalls = readLog(ghLog)
  check('gh was asked only whether it is signed in', ghCalls.length > 0 && ghCalls.every(l => l === 'gh auth status'), ghCalls.join(' | '))
  check('the listing and the download went to the fixture channel', readLog(log).some(l => l.includes(`/repos/${SLUG}/releases`)) && readLog(log).some(l => l.includes(`/objects/v${V_NEW}/${NEW_ASSET}`)))
  await server.close()
}

console.log('── §7 gh signed in: the gh road answers; the anonymous channel sees no request ──')
{
  const log = join(logsDir, 'signed-in-requests.log')
  const ghLog = join(logsDir, 'signed-in-gh.log')
  const server = await spawnFixtureReleaseServer({ fixtures: happyFixtures, log })
  seedInstalled(V_OLD)
  const c = runCli(['update', '--check'], { base: server.url, gh: 'signed-in', ghFixtures: happyFixtures, ghLog })
  check('--check names the gh road', c.code === 0 && c.stdout.includes(`update available: v${V_NEW}`) && c.stdout.includes('read through your signed-in GitHub CLI'), c.all.slice(0, 300))
  const u = runCli(['update'], { base: server.url, gh: 'signed-in', ghFixtures: happyFixtures, ghLog })
  check('update completes over the gh road with the same verdict said', u.code === 0 && u.stdout.includes('(read through your signed-in GitHub CLI)') && u.stdout.includes('signature: unsigned') && pointer('current') === V_NEW, u.all.slice(0, 400))
  check('the receipt names the gh road and the same verdict', readReceipt().road === 'gh' && readReceipt().signature === 'unsigned', JSON.stringify(readReceipt()))
  check('the anonymous channel received no request at all', readLog(log).length === 0, readLog(log).join(' | '))
  const ghCalls = readLog(ghLog)
  check('gh did the listing and the download', ghCalls.some(l => l.startsWith(`gh api repos/${SLUG}/releases`)) && ghCalls.some(l => l.startsWith(`gh release download v${V_NEW}`)), ghCalls.join(' | '))
  await server.close()
}

rmSync(scratch, { recursive: true, force: true })
console.log('')
if (failures === 0) {
  console.log('PASS prove-anonymous-channel')
  process.exit(0)
}
console.log(`FAIL prove-anonymous-channel (${failures})`)
process.exit(1)
