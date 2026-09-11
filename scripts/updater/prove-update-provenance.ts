#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IS_WIN, makeFixtures as mintFixtures, makePayload, spawnFixtureReleaseServer } from './journeyFixtures.js'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_JOURNEY_DIST ?? join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.log(`  [FAIL] the built bundle is absent (${DIST}) — run bun run build.ts first`)
  process.exit(1)
}
const RUNNING = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'updater provenance ')))
const home = join(scratch, 'home')
const configHome = join(home, '.mercury')
const versionsDir = join(scratch, 'versions')
const fixturesRoot = join(scratch, 'fixtures')
const tools = join(scratch, 'tools')
const otherBin = join(scratch, 'other-bin')
const serverLog = join(scratch, 'channel-requests.log')
const ghLog = join(scratch, 'gh-invocations.log')
for (const p of [home, configHome, versionsDir, fixturesRoot, tools, otherBin]) mkdirSync(p, { recursive: true })

const binDir = IS_WIN ? join(home, 'AppData', 'Local', 'Mercury', 'bin') : join(home, '.local', 'bin')
const shim = join(binDir, IS_WIN ? 'mercury.cmd' : 'mercury')

const which = (globalThis as { Bun?: { which?: (command: string) => string | null } }).Bun?.which
if (!IS_WIN) {
  for (const name of ['node', 'tar', 'git', 'sh', 'uname', 'env']) {
    const found = which?.(name) ?? null
    if (found) symlinkSync(found, join(tools, name))
  }
}
const systemDirs = IS_WIN ? (process.env.PATH ?? '').split(';').filter(Boolean) : ['/usr/bin', '/bin']
const pathOf = (...front: string[]): string => [...front, tools, ...systemDirs].join(IS_WIN ? ';' : ':')

const FAKE_GH = join(ROOT, 'scripts', 'updater', 'fake-gh.mjs')
const V_OLD = '9.9.0-beta.1'
const V_NEW = '9.9.0-beta.2'
const fixtures = mintFixtures(fixturesRoot, 'releases', [{ version: V_OLD }, { version: V_NEW }])
const server = await spawnFixtureReleaseServer({ fixtures, log: serverLog })

const env = (path: string, extra: Record<string, string> = {}): Record<string, string> => ({
  ...(IS_WIN ? (process.env as Record<string, string>) : {}),
  PATH: path,
  HOME: home,
  ...(IS_WIN ? { LOCALAPPDATA: join(home, 'AppData', 'Local') } : {}),
  SHELL: '/bin/zsh',
  MERCURY_CONFIG_DIR: configHome,
  MERCURY_VERSIONS_DIR: versionsDir,
  MERCURY_UPDATE_API_BASE_URL: server.url,
  MERCURY_GH_CMD: JSON.stringify(['node', FAKE_GH]),
  GH_SHIM_FIXTURES: fixtures,
  GH_SHIM_LOG: ghLog,
  MERCURY_CREDENTIAL_STORE: 'file',
  BROWSER: '/usr/bin/true',
  CI: '1',
  TERM: 'dumb',
  ...extra,
})

const run = (bundle: string, args: string[], environment: Record<string, string>): { code: number; stdout: string; stderr: string; all: string } => {
  const r = spawnSync('node', [bundle, ...args], { encoding: 'utf8', timeout: 180_000, env: environment })
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
const listing = (): string => (existsSync(versionsDir) ? readdirSync(versionsDir).sort().join(',') : '')
const pointer = (): string | null => (existsSync(join(versionsDir, 'current.txt')) ? readFileSync(join(versionsDir, 'current.txt'), 'utf8').trim() : null)
const seedInstalled = (version: string, opts: { realBundle?: boolean } = {}): string => {
  rmSync(versionsDir, { recursive: true, force: true })
  mkdirSync(versionsDir, { recursive: true })
  makePayload(join(versionsDir, version), version, opts.realBundle ? { bundlePath: DIST } : {})
  writeFileSync(join(versionsDir, 'current.txt'), `${version}\n`)
  return join(versionsDir, version, 'mercury.mjs')
}

const SCOPE_WORDS = '`mercury update` manages installs made by `mercury install` or the install script'
const BREW_COMMAND = 'brew upgrade Whq02/mercury/mercury'
const NPM_COMMAND = 'npm update -g mercury-tech-cli'

section('§1 A HOMEBREW KEG — the update verb declines before it reads the channel, and names brew')
const keg = join(scratch, 'homebrew', 'Cellar', 'mercury', '1.0.0-beta.4')
const libexec = join(keg, 'libexec')
makePayload(libexec, '1.0.0-beta.4', { bundlePath: DIST })
const kegBundle = join(libexec, 'mercury.mjs')
seedInstalled(V_NEW)
{
  const before = listing()
  const pointerBefore = pointer()
  const r = run(kegBundle, ['update'], env(pathOf()))
  check('the bare update exits 1', r.code === 1, r.all.slice(0, 300))
  check(
    'it names who installed this Mercury, the brew command, what the verb manages, and that nothing was downloaded',
    r.stderr.includes(`update refused: this Mercury was installed by Homebrew; update it with \`${BREW_COMMAND}\``) &&
      r.stderr.includes(`  ${SCOPE_WORDS}`) &&
      r.stderr.includes('nothing was downloaded; the active installation was not changed'),
    r.stderr.slice(0, 400),
  )
  check('no request reached the release server and gh was never called', requests() === 0 && !existsSync(ghLog), `requests=${requests()}`)
  check('the versions layout and the stable command path are untouched', listing() === before && pointer() === pointerBefore && !existsSync(shim))
  const a = run(kegBundle, ['update', '--allow-unsigned'], env(pathOf()))
  check('--allow-unsigned changes nothing about it', a.code === 1 && a.stderr.includes(`installed by Homebrew; update it with \`${BREW_COMMAND}\``) && requests() === 0, a.stderr.slice(0, 200))
  const j = run(kegBundle, ['update', '--json'], env(pathOf()))
  const record = parse(j.stderr)
  const jp = record?.provenance as { kind?: string; updateCommand?: string } | undefined
  check(
    '--json: refused at stage provenance, carrying the provenance record',
    j.code === 1 && record?.state === 'refused' && record?.stage === 'provenance' && jp?.kind === 'homebrew' && jp?.updateCommand === BREW_COMMAND,
    j.stderr.slice(0, 300),
  )
  const rb = run(kegBundle, ['update', '--rollback'], env(pathOf()))
  check(
    '--rollback declines with the same fact and the pointer stays',
    rb.code === 1 &&
      rb.stderr.includes('rollback refused: this Mercury was installed by Homebrew; `mercury update --rollback` manages installs made by `mercury install` or the install script') &&
      rb.stderr.includes(`  Homebrew manages this install; \`${BREW_COMMAND}\` updates it`) &&
      pointer() === pointerBefore,
    rb.stderr.slice(0, 300),
  )
  const c = run(kegBundle, ['update', '--check'], env(pathOf()))
  check(
    '--check still reads the channel and compares the running version, not the pointer of the layout beside it',
    c.code === 0 && c.stdout.includes(`update available: v${V_NEW} (installed: ${RUNNING})`) && requests() > 0,
    c.all.slice(0, 300),
  )
  check(
    '--check ends on the brew command, never on `mercury update`',
    c.stdout.trim().endsWith(`this Mercury was installed by Homebrew; update it with \`${BREW_COMMAND}\``) && !c.stdout.includes('run `mercury update` to install it'),
    c.stdout.slice(-200),
  )
  const s = run(kegBundle, ['update', '--status'], env(pathOf()))
  check(
    '--status names the provenance beside the running and the installed version',
    s.code === 0 &&
      s.stdout.includes(`this Mercury:      installed by Homebrew at ${libexec} — update it with \`${BREW_COMMAND}\`; ${SCOPE_WORDS}`) &&
      s.stdout.includes(`running version:   ${RUNNING}`) &&
      s.stdout.includes(`installed version: ${V_NEW}`),
    s.stdout.slice(0, 700),
  )
  const sj = run(kegBundle, ['update', '--status', '--json'], env(pathOf()))
  const sp = parse(sj.stdout)?.provenance as { kind?: string; updateCommand?: string } | undefined
  check('--status --json carries the provenance record', sj.code === 0 && sp?.kind === 'homebrew' && sp?.updateCommand === BREW_COMMAND, sj.stdout.slice(0, 200))
}

section('§2 THE NPM PACKAGE — the same refusal, naming npm')
const pkg = join(scratch, 'npm', 'lib', 'node_modules', 'mercury-tech-cli')
mkdirSync(pkg, { recursive: true })
copyFileSync(DIST, join(pkg, 'mercury.mjs'))
{
  const requestsBefore = requests()
  const r = run(join(pkg, 'mercury.mjs'), ['update'], env(pathOf()))
  check(
    'the bare update exits 1 naming npm and its command',
    r.code === 1 && r.stderr.includes(`update refused: this Mercury was installed by npm; update it with \`${NPM_COMMAND}\``) && r.stderr.includes(SCOPE_WORDS),
    r.stderr.slice(0, 300),
  )
  check('no request reached the release server', requests() === requestsBefore)
  const c = run(join(pkg, 'mercury.mjs'), ['update', '--check'], env(pathOf()))
  check('--check ends on the npm command', c.code === 0 && c.stdout.trim().endsWith(`this Mercury was installed by npm; update it with \`${NPM_COMMAND}\``), c.stdout.slice(-200))
}

section('§3 A VERSIONS-ROOT INSTALL — still updates; the `mercury` the shell runs is named when it is not the stable command')
const foreignMercury = join(otherBin, IS_WIN ? 'mercury.cmd' : 'mercury')
writeFileSync(foreignMercury, IS_WIN ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n')
if (!IS_WIN) chmodSync(foreignMercury, 0o755)
const exportLine = 'export PATH="$HOME/.local/bin:$PATH"'
const aheadFix = IS_WIN
  ? `put ${binDir} ahead of it in your user PATH (Settings › System › Advanced system settings › Environment Variables › User variables › Path)`
  : `put ${binDir} ahead of it on PATH — in this terminal: ${exportLine}`
const onFix = `put ${binDir} on PATH — in this terminal: ${exportLine}`
const seedForUpdate = (): string => {
  const bundle = seedInstalled(V_OLD, { realBundle: true })
  rmSync(binDir, { recursive: true, force: true })
  return bundle
}
{
  const bundle = seedForUpdate()
  const r = run(bundle, ['update', '--allow-unsigned'], env(pathOf(binDir)))
  check('(a) the stable command first on PATH: the update lands', r.code === 0 && r.stdout.includes(`updated: ${V_OLD} → ${V_NEW}`) && pointer() === V_NEW && existsSync(shim), r.all.slice(0, 500))
  check('(a) and nothing is said about the `mercury` the shell runs', !r.stdout.includes('your shell runs') && !r.stdout.includes('is on your PATH'), r.stdout)
}
{
  const bundle = seedForUpdate()
  const r = run(bundle, ['update', '--allow-unsigned'], env(pathOf(otherBin, binDir)))
  const last = r.stdout.trim().split('\n').slice(-2).map(l => l.trim())
  check(
    '(b) another `mercury` ahead of it: the update lands and the last two lines name both paths and the fix',
    r.code === 0 && pointer() === V_NEW && last[0] === `the \`mercury\` your shell runs is ${foreignMercury}; the updated one is ${shim}` && last[1] === aheadFix,
    r.all.slice(0, 900),
  )
}
if (IS_WIN) {
  console.log('  · (c) skipped on this platform: a PATH carrying no `mercury` at all cannot be built from a scratch tools folder here')
} else {
  const bundle = seedForUpdate()
  const r = run(bundle, ['update', '--allow-unsigned'], env(pathOf()))
  const last = r.stdout.trim().split('\n').slice(-2).map(l => l.trim())
  check(
    '(c) no `mercury` on PATH at all: the update lands and the last two lines say so with the fix',
    r.code === 0 && pointer() === V_NEW && last[0] === `no \`mercury\` is on your PATH; the updated one is ${shim}` && last[1] === onFix,
    r.all.slice(0, 900),
  )
}
{
  const bundle = seedForUpdate()
  const r = run(bundle, ['update', '--allow-unsigned', '--json'], env(pathOf(otherBin, binDir)))
  const record = parse(r.stdout)
  const found = record?.commandOnPath as { state?: string; resolved?: string } | undefined
  check('(d) --json carries the shell\'s command beside the update record', r.code === 0 && record?.state === 'updated' && found?.state === 'other' && found?.resolved === foreignMercury, r.stdout.slice(0, 300))
}

section('§4 THE DOCTOR — the provenance row names the updating tool; the command-on-path row says whether the shell runs the stable command')
const doctorRow = (bundle: string, id: string, environment: Record<string, string>): { status?: string; evidence?: string; fix?: string } | null => {
  const r = spawnSync('node', [bundle, 'doctor', '--only', id, '--json'], { encoding: 'utf8', timeout: 180_000, env: environment })
  const cert = parse(r.stdout ?? '') as { sections?: Array<{ checks: Array<{ id: string; status: string; evidence: string; fix?: string }> }> } | null
  return cert?.sections?.flatMap(s => s.checks).find(c => c.id === id) ?? null
}
{
  const row = doctorRow(kegBundle, 'install-provenance', env(pathOf()))
  check(
    "a Homebrew install's provenance row says homebrew and names the brew command",
    row?.status === 'ok' && (row?.evidence ?? '').startsWith('homebrew ') && (row?.evidence ?? '').includes(`update it with \`${BREW_COMMAND}\``),
    JSON.stringify(row),
  )
  const onPath = doctorRow(kegBundle, 'command-on-path', env(pathOf(otherBin)))
  check(
    "its command-on-path row is an observation naming the shell's `mercury` and where this Mercury runs from",
    onPath?.status === 'info' && onPath?.evidence === `the \`mercury\` your shell runs is ${foreignMercury}; this Mercury runs from ${libexec}`,
    JSON.stringify(onPath),
  )
}
{
  const bundle = join(versionsDir, V_OLD, 'mercury.mjs')
  const ok = doctorRow(bundle, 'command-on-path', env(pathOf(binDir)))
  check('a versions-root install whose shell runs the stable command: ok', ok?.status === 'ok' && ok?.evidence === `the \`mercury\` your shell runs is the stable command ${shim}`, JSON.stringify(ok))
  const warn = doctorRow(bundle, 'command-on-path', env(pathOf(otherBin, binDir)))
  check(
    'another `mercury` ahead of the stable command: warn, both paths, the fix',
    warn?.status === 'warn' && warn?.evidence === `the \`mercury\` your shell runs is ${foreignMercury}; the stable command is ${shim}` && warn?.fix === aheadFix,
    JSON.stringify(warn),
  )
  if (!IS_WIN) {
    const absent = doctorRow(bundle, 'command-on-path', env(pathOf()))
    check('no `mercury` on PATH: warn with the fix', absent?.status === 'warn' && absent?.evidence === `no \`mercury\` is on your PATH; the stable command is ${shim}` && absent?.fix === onFix, JSON.stringify(absent))
  }
}

await server.close()
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-update-provenance: all green' : `\nprove-update-provenance: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
