#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IS_WIN, makeFixtures, makePayload, spawnFixtureReleaseServer } from './journeyFixtures.js'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_JOURNEY_DIST ?? join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.log(`  [FAIL] the built bundle is absent (${DIST}) — run bun run build.ts first`)
  process.exit(1)
}
if (IS_WIN) {
  console.log('  · skipped on this platform: the stub channel commands are POSIX shell scripts')
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

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'updater installer road ')))
const home = join(scratch, 'home')
const configHome = join(home, '.mercury')
const versionsDir = join(scratch, 'versions')
const fixturesRoot = join(scratch, 'fixtures')
const tools = join(scratch, 'tools')
const stubs = join(scratch, 'stubs')
const stubsNoBrew = join(scratch, 'stubs-no-brew')
const npmBin = join(scratch, 'npm', 'bin')
const serverLog = join(scratch, 'channel-requests.log')
const stubLog = join(scratch, 'stub-calls.log')
const stubState = join(scratch, 'stub-installed-version.txt')
for (const p of [home, configHome, versionsDir, fixturesRoot, tools, stubs, stubsNoBrew, npmBin]) mkdirSync(p, { recursive: true })

const which = (globalThis as { Bun?: { which?: (command: string) => string | null } }).Bun?.which
for (const name of ['node', 'tar', 'git', 'sh', 'uname', 'env', 'cat', 'printf']) {
  const found = which?.(name) ?? null
  if (found) symlinkSync(found, join(tools, name))
}
const pathOf = (...front: string[]): string => [...front, tools, '/usr/bin', '/bin'].join(':')

const stub = (dir: string, name: string, body: string): void => {
  const p = join(dir, name)
  writeFileSync(p, `#!/bin/sh\n${body}`)
  chmodSync(p, 0o755)
}
const channelStub = (label: string, lines: string[]): string =>
  [
    `echo "${label} $*" >> "$STUB_LOG"`,
    ...lines.map(l => `echo "${l}"`),
    'if [ "${STUB_MOVE:-1}" = 1 ]; then printf "%s\\n" "$STUB_NEXT" > "$STUB_STATE"; fi',
    'exit "${STUB_EXIT:-0}"',
    '',
  ].join('\n')
stub(stubs, 'brew', channelStub('brew', ['==> Upgrading 1 outdated package:', 'whq02/mercury/mercury $(cat "$STUB_STATE") -> $STUB_NEXT', '==> Pouring mercury--$STUB_NEXT.bottle.tar.gz']))
stub(stubs, 'npm', channelStub('npm', ['changed 1 package in 2s']))
stub(stubs, 'mercury', 'echo "Mercury $(cat "$STUB_STATE")"\n')
stub(stubsNoBrew, 'mercury', 'echo "Mercury $(cat "$STUB_STATE")"\n')

const V_OLD = '9.9.0-beta.1'
const V_NEW = '9.9.0-beta.2'
const fixtures = makeFixtures(fixturesRoot, 'releases', [{ version: V_OLD }, { version: V_NEW }])
const server = await spawnFixtureReleaseServer({ fixtures, log: serverLog })

const env = (path: string, extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: path,
  HOME: home,
  SHELL: '/bin/zsh',
  MERCURY_CONFIG_DIR: configHome,
  MERCURY_VERSIONS_DIR: versionsDir,
  MERCURY_UPDATE_API_BASE_URL: server.url,
  MERCURY_GH_CMD: JSON.stringify(['/usr/bin/false']),
  MERCURY_CREDENTIAL_STORE: 'file',
  BROWSER: '/usr/bin/true',
  CI: '1',
  TERM: 'dumb',
  STUB_LOG: stubLog,
  STUB_STATE: stubState,
  STUB_NEXT: V_NEW,
  ...extra,
})

const run = (bundle: string, args: string[], environment: Record<string, string>, input?: string): { code: number; stdout: string; stderr: string; all: string } => {
  const r = spawnSync('node', [bundle, ...args], { encoding: 'utf8', timeout: 180_000, env: environment, ...(input === undefined ? {} : { input }) })
  const stdout = r.stdout ?? ''
  const stderr = r.stderr ?? ''
  return { code: r.status ?? -1, stdout, stderr, all: stdout + stderr }
}
const parse = (text: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}
const requests = (): number => (existsSync(serverLog) ? readFileSync(serverLog, 'utf8').split('\n').filter(Boolean).length : 0)
const calls = (): string[] => (existsSync(stubLog) ? readFileSync(stubLog, 'utf8').split('\n').filter(Boolean) : [])
const reset = (): void => {
  rmSync(stubLog, { force: true })
  writeFileSync(stubState, `${RUNNING}\n`)
}
const pointer = (): string | null => (existsSync(join(versionsDir, 'current.txt')) ? readFileSync(join(versionsDir, 'current.txt'), 'utf8').trim() : null)
const seedInstalled = (version: string): string => {
  rmSync(versionsDir, { recursive: true, force: true })
  mkdirSync(versionsDir, { recursive: true })
  makePayload(join(versionsDir, version), version, { bundlePath: DIST })
  writeFileSync(join(versionsDir, 'current.txt'), `${version}\n`)
  return join(versionsDir, version, 'mercury.mjs')
}

const BREW_COMMAND = 'brew upgrade Whq02/mercury/mercury'
const NPM_COMMAND = 'npm update -g mercury-tech-cli'
const question = (name: string, command: string): string => `This Mercury was installed by ${name}. Run \`${command}\` now? [y/N] `
const declined = (command: string): string => `update not run — answer y to run \`${command}\`, or run \`mercury update --yes\``
const WRAPPER_WORDS = "installed through npm's wrapper, updated through Mercury's own channel"

section('§1 A HOMEBREW KEG — consent, the run, its streamed lines, the re-read')
const keg = join(scratch, 'homebrew', 'Cellar', 'mercury', RUNNING)
const libexec = join(keg, 'libexec')
makePayload(libexec, RUNNING, { bundlePath: DIST })
const kegBundle = join(libexec, 'mercury.mjs')
{
  reset()
  const n = run(kegBundle, ['update'], env(pathOf(stubs)), 'n\n')
  check('n: exit 1, the question was asked, the update was not run', n.code === 1 && n.stderr.includes(question('Homebrew', BREW_COMMAND)) && n.stderr.includes(declined(BREW_COMMAND)), n.all.slice(0, 400))
  check('n: brew was never called and the channel was never read', calls().length === 0 && requests() === 0, calls().join(' | '))

  reset()
  const y = run(kegBundle, ['update'], env(pathOf(stubs)), 'y\n')
  check('y: exit 0 and the result names the versions, the installer and its command', y.code === 0 && y.stdout.includes(`updated: ${RUNNING} → ${V_NEW} (Homebrew: \`${BREW_COMMAND}\`)`), y.all.slice(0, 500))
  check('y: the stub brew ran the upgrade of the formula', calls().join('\n') === `brew upgrade Whq02/mercury/mercury`, calls().join(' | '))
  check("y: brew's own lines streamed through before the result line", y.stdout.indexOf('==> Upgrading 1 outdated package:') >= 0 && y.stdout.indexOf('==> Pouring') < y.stdout.indexOf('updated:'), y.stdout.slice(0, 400))
  check('y: the running command is announced on stderr and the re-read names the `mercury` the shell runs', y.stderr.includes(`running: ${BREW_COMMAND}`) && y.stdout.includes(`the \`mercury\` your shell runs is ${join(stubs, 'mercury')}`), y.all.slice(0, 500))
  check('y: no channel request was made for the brew road', requests() === 0)

  reset()
  const yes = run(kegBundle, ['update', '--yes'], env(pathOf(stubs)))
  check('--yes: no question, the upgrade runs, exit 0', yes.code === 0 && !yes.stderr.includes('[y/N]') && yes.stdout.includes(`updated: ${RUNNING} → ${V_NEW}`) && calls().length === 1, yes.all.slice(0, 400))

  reset()
  const eof = run(kegBundle, ['update'], env(pathOf(stubs)))
  check('no answer at all (stdin closed): declined, exit 1, nothing run', eof.code === 1 && eof.stderr.includes(declined(BREW_COMMAND)) && calls().length === 0, eof.all.slice(0, 400))

  reset()
  const bad = run(kegBundle, ['update', '--yes'], env(pathOf(stubs), { STUB_EXIT: '2' }))
  check('a failing upgrade: exit 1 naming the command and its exit code', bad.code === 1 && bad.stderr.includes(`update not completed: \`${BREW_COMMAND}\` exited 2`), bad.all.slice(0, 400))

  reset()
  const still = run(kegBundle, ['update', '--yes'], env(pathOf(stubs), { STUB_MOVE: '0' }))
  check('an upgrade that moved nothing: exit 0 saying the version is still the same', still.code === 0 && still.stdout.includes(`Mercury is still ${RUNNING} after \`${BREW_COMMAND}\``), still.all.slice(0, 400))

  reset()
  const missing = run(kegBundle, ['update', '--yes'], env(pathOf(stubsNoBrew)))
  check('brew absent from PATH: exit 1 saying so', missing.code === 1 && missing.stderr.includes('update not run: `brew` is not on PATH'), missing.all.slice(0, 400))

  reset()
  const j = run(kegBundle, ['update', '--yes', '--json'], env(pathOf(stubs)))
  const record = parse(j.stdout)
  check('--yes --json: one machine record on stdout, the installer lines on stderr', j.code === 0 && record?.state === 'installer-ran' && record?.installer === 'Homebrew' && record?.from === RUNNING && record?.to === V_NEW && record?.exitCode === 0 && j.stderr.includes('==> Upgrading'), j.all.slice(0, 500))
  reset()
  const jq = run(kegBundle, ['update', '--json'], env(pathOf(stubs)))
  const refused = parse(jq.stderr)
  check('--json without --yes: refused at the consent stage, naming --yes, nothing run', jq.code === 1 && refused?.state === 'refused' && refused?.stage === 'consent' && String(refused?.remedy).includes('mercury update --yes') && calls().length === 0, jq.all.slice(0, 400))

  reset()
  const c = run(kegBundle, ['update', '--check'], env(pathOf(stubs)))
  check('--check: the installed and newest versions, then the road in one line', c.code === 0 && c.stdout.includes(`update available: v${V_NEW} (installed: ${RUNNING})`) && c.stdout.trim().endsWith(`this Mercury was installed by Homebrew; \`mercury update\` runs \`${BREW_COMMAND}\``), c.all.slice(0, 400))
  const s = run(kegBundle, ['update', '--status'], env(pathOf(stubs)))
  check('--status: the provenance line names the road', s.code === 0 && s.stdout.includes(`this Mercury:      installed by Homebrew at ${libexec} — \`mercury update\` runs \`${BREW_COMMAND}\``), s.stdout.slice(0, 600))
  const rb = run(kegBundle, ['update', '--rollback'], env(pathOf(stubs)))
  check('--rollback: still refused, its remedy names the road', rb.code === 1 && rb.stderr.includes(`Homebrew manages this install's versions; \`mercury update\` runs \`${BREW_COMMAND}\``), rb.stderr.slice(0, 300))
}

section('§2 THE NPM PACKAGE SHAPE — the same road with npm\'s command')
const pkg = join(scratch, 'npm', 'lib', 'node_modules', 'mercury-tech-cli')
mkdirSync(pkg, { recursive: true })
copyFileSync(DIST, join(pkg, 'mercury.mjs'))
{
  reset()
  const n = run(join(pkg, 'mercury.mjs'), ['update'], env(pathOf(stubs)), 'n\n')
  check('n: the question names npm and its command; nothing ran', n.code === 1 && n.stderr.includes(question('npm', NPM_COMMAND)) && n.stderr.includes(declined(NPM_COMMAND)) && calls().length === 0, n.all.slice(0, 400))
  reset()
  const yes = run(join(pkg, 'mercury.mjs'), ['update', '--yes'], env(pathOf(stubs)))
  check('--yes: npm update runs and the result names npm', yes.code === 0 && calls().join('\n') === 'npm update -g mercury-tech-cli' && yes.stdout.includes(`updated: ${RUNNING} → ${V_NEW} (npm: \`${NPM_COMMAND}\`)`) && yes.stdout.includes('changed 1 package'), yes.all.slice(0, 400))
  const c = run(join(pkg, 'mercury.mjs'), ['update', '--check'], env(pathOf(stubs)))
  check('--check ends on the road with npm\'s command', c.code === 0 && c.stdout.trim().endsWith(`this Mercury was installed by npm; \`mercury update\` runs \`${NPM_COMMAND}\``), c.stdout.slice(-200))
}

section('§3 A MANAGED INSTALL — the channel road is unchanged; an npm wrapper on PATH is named truthfully')
const doctorRow = (bundle: string, id: string, environment: Record<string, string>): { status?: string; evidence?: string; fix?: string } | null => {
  const r = spawnSync('node', [bundle, 'doctor', '--only', id, '--json'], { encoding: 'utf8', timeout: 180_000, env: environment })
  const cert = parse(r.stdout ?? '') as { sections?: Array<{ checks: Array<{ id: string; status: string; evidence: string; fix?: string }> }> } | null
  return cert?.sections?.flatMap(s => s.checks).find(c => c.id === id) ?? null
}
{
  const bundle = seedInstalled(V_OLD)
  const c = run(bundle, ['update', '--check'], env(pathOf()))
  check('--check on a managed install ends on the private channel\'s own words, byte for byte', c.code === 0 && c.stdout.trim().endsWith('run `mercury update` to install it'), c.stdout.slice(-200))

  const wrapperDir = join(pkg, 'bin')
  mkdirSync(wrapperDir, { recursive: true })
  stub(wrapperDir, 'mercury.js', 'echo "Mercury wrapper"\n')
  symlinkSync(join(wrapperDir, 'mercury.js'), join(npmBin, 'mercury'))
  const cw = run(bundle, ['update', '--check'], env(pathOf(npmBin)))
  check('--check with npm\'s wrapper as the shell\'s `mercury`: the same road plus the truth of the install', cw.code === 0 && cw.stdout.trim().endsWith(`run \`mercury update\` to install it (${WRAPPER_WORDS})`), cw.stdout.slice(-240))
  const sw = run(bundle, ['update', '--status'], env(pathOf(npmBin)))
  check('--status says it too', sw.code === 0 && sw.stdout.includes(`\`mercury update\` manages it (${WRAPPER_WORDS})`), sw.stdout.slice(0, 500))
  const prov = doctorRow(bundle, 'install-provenance', env(pathOf(npmBin)))
  check('the doctor\'s provenance row carries the same words', prov?.status === 'ok' && (prov?.evidence ?? '').includes(WRAPPER_WORDS), JSON.stringify(prov))
  const onPath = doctorRow(bundle, 'command-on-path', env(pathOf(npmBin)))
  check('the doctor\'s command-on-path row is ok and names the wrapper handing over to the stable command', onPath?.status === 'ok' && (onPath?.evidence ?? '').includes(`npm's wrapper at ${join(npmBin, 'mercury')}`) && (onPath?.evidence ?? '').includes('hands over to the stable command'), JSON.stringify(onPath))
  const plain = doctorRow(bundle, 'install-provenance', env(pathOf()))
  check('without the wrapper on PATH the provenance row says nothing of npm', plain?.status === 'ok' && !(plain?.evidence ?? '').includes('npm'), JSON.stringify(plain))

  const before = pointer()
  const yes = run(bundle, ['update', '--yes', '--allow-unsigned'], env(pathOf()))
  check('--yes on a managed install is accepted and the channel road runs as before', yes.code === 0 && yes.stdout.includes(`updated: ${V_OLD} → ${V_NEW}`) && before === V_OLD && pointer() === V_NEW, yes.all.slice(0, 500))
}

await server.close()
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-update-installer-road: all green' : `\nprove-update-installer-road: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
