#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IS_WIN, makeFixtures, makePayload, spawnFixtureReleaseServer } from './journeyFixtures.js'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.log(`  [FAIL] the built bundle is absent (${DIST}) — run bun run build.ts first`)
  process.exit(1)
}
if (IS_WIN) {
  console.log('  · skipped on this platform: the fixture channel is a POSIX loopback server')
  process.exit(0)
}

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

const versionLine = spawnSync('node', [DIST, '--version'], { encoding: 'utf8', timeout: 60_000 }).stdout ?? ''
const RUNNING = versionLine.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/)?.[0] ?? ''
if (RUNNING === '') {
  console.log(`  [FAIL] the bundle did not print its version (${versionLine.slice(0, 80)})`)
  process.exit(1)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'updater source checkout ')))
const home = join(scratch, 'home')
const configHome = join(home, '.mercury')
const versionsDir = join(scratch, 'versions')
const fixturesRoot = join(scratch, 'fixtures')
const serverLog = join(scratch, 'channel-requests.log')
for (const p of [home, configHome, versionsDir, fixturesRoot]) mkdirSync(p, { recursive: true })

const V_NEW = '9.9.0-beta.2'
const newer = makeFixtures(fixturesRoot, 'newer', [{ version: V_NEW }])
const current = makeFixtures(fixturesRoot, 'current', [{ version: RUNNING }])

const env = (serverUrl: string): Record<string, string> => ({
  PATH: `/usr/bin:/bin:${process.env.PATH ?? ''}`,
  HOME: home,
  SHELL: '/bin/zsh',
  MERCURY_CONFIG_DIR: configHome,
  MERCURY_VERSIONS_DIR: versionsDir,
  MERCURY_UPDATE_API_BASE_URL: serverUrl,
  MERCURY_GH_CMD: JSON.stringify(['/usr/bin/false']),
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  CI: '1',
  TERM: 'dumb',
})
const run = (args: string[], environment: Record<string, string>): { code: number; stdout: string; stderr: string } => {
  const r = spawnSync('node', [DIST, ...args], { encoding: 'utf8', timeout: 180_000, env: environment })
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
const parse = (text: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}
const requests = (): string[] => (existsSync(serverLog) ? readFileSync(serverLog, 'utf8').split('\n').filter(Boolean) : [])
const versionsPresent = (): string[] => (existsSync(versionsDir) ? readdirSync(versionsDir) : [])
const CHECKOUT_WORDS = `a source checkout at ${join(ROOT, 'dist')} — rebuild it with \`git pull && bun run build.ts\``
const REASON = `this Mercury is a source checkout at ${join(ROOT, 'dist')} and no managed install lives under ${versionsDir}; \`mercury update\` manages installs made by \`mercury install\` or the install script`

section('§0 THE BUNDLE UNDER TEST IS A SOURCE CHECKOUT (build.ts + src/ + .git above dist/)')
{
  const serverA = await spawnFixtureReleaseServer({ fixtures: current, log: serverLog })
  const s = run(['update', '--status', '--json'], env(serverA.url))
  const record = parse(s.stdout)
  const provenance = (record?.provenance ?? {}) as Record<string, unknown>
  check('--status --json reads provenance kind development, update owner source-build', s.code === 0 && provenance.kind === 'development' && provenance.updateOwner === 'source-build', `${s.code} · ${JSON.stringify(provenance)}`)
  const text = run(['update', '--status'], env(serverA.url))
  check('--status names the checkout and the rebuild', text.code === 0 && text.stdout.includes(`this Mercury:      ${CHECKOUT_WORDS}`), text.stdout.slice(0, 400))
  check('…and no managed install under this home\'s versions dir', text.stdout.includes('installed version: (no managed install)'), text.stdout.slice(0, 400))

  section('§1 --check WHEN THE CHANNEL HAS NOTHING NEWER: current, and the same checkout line')
  const c = run(['update', '--check'], env(serverA.url))
  check('exit 0, "Mercury is current"', c.code === 0 && c.stdout.startsWith(`Mercury is current: ${RUNNING}`), `${c.code} · ${c.stdout.slice(0, 200)}`)
  check('…followed by the checkout line --status prints', c.stdout.includes(`\n  this Mercury: ${CHECKOUT_WORDS}`), c.stdout.slice(0, 400))
  check('…and never by `run mercury update`', !c.stdout.includes('run `mercury update`'), c.stdout.slice(0, 400))
  await serverA.close()
}

rmSync(serverLog, { force: true })
const server = await spawnFixtureReleaseServer({ fixtures: newer, log: serverLog })

section('§2 --check WHEN THE CHANNEL HAS A NEWER RELEASE: the road is the rebuild, never the installer')
{
  const c = run(['update', '--check'], env(server.url))
  check('exit 0, the newer tag named', c.code === 0 && c.stdout.includes(`update available: v${V_NEW} (installed: ${RUNNING})`), `${c.code} · ${c.stdout.slice(0, 300)}`)
  check('the next step is the checkout\'s own road', c.stdout.trim().endsWith(`this Mercury: ${CHECKOUT_WORDS}`), c.stdout.slice(-240))
  check('…and not `run mercury update to install it`', !c.stdout.includes('run `mercury update`'), c.stdout.slice(-240))
  const j = run(['update', '--check', '--json'], env(server.url))
  const record = parse(j.stdout)
  check('--check --json: state update-available with provenance development / source-build', j.code === 0 && record?.state === 'update-available' && (record?.provenance as Record<string, unknown> | undefined)?.updateOwner === 'source-build', `${j.code} · ${j.stdout.slice(0, 300)}`)
}

section('§3 A BARE `update` ON A SOURCE CHECKOUT REFUSES BEFORE ANY WRITE OR DOWNLOAD')
{
  const before = requests().length
  const u = run(['update'], env(server.url))
  check('exit 1 with the refusal', u.code === 1 && u.stderr.includes(`update refused: ${REASON}`), `${u.code} · ${(u.stdout + u.stderr).slice(0, 400)}`)
  check('…naming the rebuild and that nothing changed', u.stderr.includes('rebuild it with `git pull && bun run build.ts`') && u.stderr.includes('the active installation was not changed'), u.stderr.slice(0, 400))
  check('no asset was downloaded (the channel saw no new request)', requests().length === before, requests().slice(before).join(' | '))
  check('no version landed under the versions dir', versionsPresent().length === 0, versionsPresent().join(', '))
  const j = run(['update', '--json'], env(server.url))
  const record = parse(j.stderr.trim() || j.stdout.trim())
  check('--json: a refused record naming stage provenance, the reason and the remedy', j.code === 1 && record?.mode === 'update' && record?.state === 'refused' && record?.stage === 'provenance' && record?.reason === REASON && record?.remedy === 'rebuild it with `git pull && bun run build.ts`', `${j.code} · ${j.stdout.slice(0, 400)}`)
  check('…still no download, still no version dir', requests().length === before && versionsPresent().length === 0, `${requests().length - before} request(s) · ${versionsPresent().join(', ')}`)
}

section('§4 --rollback ON A SOURCE CHECKOUT REFUSES THE SAME WAY')
{
  const r = run(['update', '--rollback'], env(server.url))
  check('exit 1, the refusal names the checkout and the road', r.code === 1 && r.stderr.includes(`rollback refused: ${REASON}`) && r.stderr.includes('rebuild it with `git pull && bun run build.ts`'), `${r.code} · ${(r.stdout + r.stderr).slice(0, 400)}`)
  const j = run(['update', '--rollback', '--json'], env(server.url))
  const record = parse(j.stderr.trim() || j.stdout.trim())
  check('--json: mode rollback, state refused, the reason', j.code === 1 && record?.mode === 'rollback' && record?.state === 'refused' && record?.reason === REASON, `${j.code} · ${j.stdout.slice(0, 300)}`)
}

section('§5 A MANAGED INSTALL BESIDE THE CHECKOUT: the checkout\'s bundle manages it as before')
{
  const V_OLD = '9.9.0-beta.1'
  makePayload(join(versionsDir, V_OLD), V_OLD, { bundlePath: DIST })
  writeFileSync(join(versionsDir, 'current.txt'), `${V_OLD}\n`)
  const s = run(['update', '--status'], env(server.url))
  check('--status names the checkout AND the managed install it manages', s.code === 0 && s.stdout.includes(`this Mercury:      ${CHECKOUT_WORDS}`) && s.stdout.includes(`installed version: ${V_OLD}`), s.stdout.slice(0, 400))
  const c = run(['update', '--check'], env(server.url))
  check('--check ends on the channel road, as every managed install does', c.code === 0 && c.stdout.trim().endsWith('run `mercury update` to install it'), c.stdout.slice(-200))
  const j = run(['update', '--status', '--json'], env(server.url))
  const record = parse(j.stdout)
  const provenance = (record?.provenance ?? {}) as Record<string, unknown>
  check('--status --json: still kind development, update owner source-build', provenance.kind === 'development' && provenance.updateOwner === 'source-build', JSON.stringify(provenance))
}

await server.close()
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-update-source-checkout: all green' : `\nprove-update-source-checkout: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
