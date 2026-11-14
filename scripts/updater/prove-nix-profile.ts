import { spawn, spawnSync } from 'node:child_process'
import { mock } from 'bun:test'
import fs, { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { nodeBinPath } from '../lib/nodeBin.ts'

const option = (name: string): string | undefined => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined
const root = resolve(option('--source') ?? join(dirname(fileURLToPath(import.meta.url)), '../..'))
const dist = resolve(option('--dist') ?? join(root, 'dist/mercury.mjs'))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-nix-profile-')))
const home = join(scratch, 'home')
const profile = join(home, '.nix-profile')
const logical = join(profile, 'libexec/mercury/mercury.mjs')
const node = nodeBinPath()
const config = join(home, '.mercury')
const daemonDir = join(scratch, 'daemon')
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function makeOutput(name: string, tree: string): string {
  const output = join(scratch, 'store', name)
  const payload = join(output, 'libexec/mercury')
  mkdirSync(join(payload, 'vendor/node/bin'), { recursive: true })
  mkdirSync(join(output, 'nix-support'), { recursive: true })
  writeFileSync(join(output, 'nix-support/mercury'), 'libexec/mercury\n')
  copyFileSync(dist, join(payload, 'mercury.mjs'))
  writeFileSync(join(payload, 'manifest.json'), JSON.stringify({ schema: 2, name: 'mercury', version: '9.9.9', buildTree: tree, buildTime: '2026-01-01T00:00:00.000Z', bundle: 'mercury.mjs' }))
  writeFileSync(join(payload, 'mercury'), '#!/bin/sh\nexit 0\n')
  symlinkSync(node, join(payload, 'vendor/node/bin/node'))
  return output
}
try {
  mkdirSync(home, { recursive: true })
  mkdirSync(config, { recursive: true })
  mkdirSync(daemonDir, { recursive: true })
  const first = makeOutput('first-mercury', 'a'.repeat(40))
  const second = makeOutput('second-mercury', 'b'.repeat(40))
  symlinkSync(first, profile, 'dir')
  const original = { ...fs }
  const calls: string[] = []
  const observed = Object.fromEntries((['existsSync', 'readFileSync', 'realpathSync'] as const).map(name => [name, (...args: any[]) => { calls.push(name); return (original[name] as any)(...args) }]))
  mock.module('node:fs', () => ({ ...original, ...observed }))
  const provenance = await import(pathToFileURL(join(root, 'src/services/privateChannel/installProvenance.ts')).href)
  const fixtureVersions = join(scratch, 'versions')
  for (const [label, entry] of [['managed', join(fixtureVersions, '9.9.9/mercury.mjs')], ['homebrew', join(scratch, 'Cellar/mercury/9.9.9/libexec/mercury.mjs')]]) {
    mkdirSync(dirname(entry!), { recursive: true })
    writeFileSync(entry!, '')
    writeFileSync(join(dirname(entry!), 'manifest.json'), '{}')
    calls.length = 0
    const found = provenance.classifyInstallProvenance(provenance.gatherInstallProbeFacts({ invokedPath: entry, versionsDir: fixtureVersions, platform: 'linux', env: {} }))
    const counted = [...calls]
    check(`${label}: the existing owner is unchanged`, found.kind === label, JSON.stringify(found))
    console.log(`FILESYSTEM ${label}: ${JSON.stringify(counted)}`)
    check(`${label}: Nix adds no filesystem operation to the baseline probe`, JSON.stringify(counted) === JSON.stringify(['realpathSync', 'realpathSync', 'existsSync', 'existsSync', 'existsSync', 'existsSync', 'existsSync', 'existsSync', 'existsSync', 'existsSync', 'existsSync', ...(label === 'homebrew' ? ['existsSync'] : [])]), JSON.stringify(counted))
  }
  mock.module('node:fs', () => original)
  const build = await import(pathToFileURL(join(root, 'src/daemon/daemonBuild.ts')).href)
  const path = await import(pathToFileURL(join(root, 'src/services/privateChannel/installPath.ts')).href)
  const previousArg = process.argv[1]
  process.argv[1] = logical
  check('the daemon keeps the profile spelling it was invoked by', build.selfScriptPath() === logical, build.selfScriptPath())
  check('the daemon runtime keeps its profile spelling too', build.vendoredNodeBeside(dirname(logical)) === join(dirname(logical), 'vendor/node/bin/node'))
  check('a shell line names the profile command, even when an unrelated Mercury is first on PATH', path.ownCommandWord({ provenanceKind: 'nix', found: { state: 'other', resolved: '/other/mercury', npmWrapper: false }, node, bundle: logical }) === join(profile, 'bin/mercury'))
  process.argv[1] = previousArg!
  if (process.platform !== 'win32') {
    for (const spelling of ['space here', 'dollar$HOME', 'quoted\'name', 'semi;colon']) {
      const command = join(scratch, spelling, '.nix-profile/bin/mercury')
      const word = path.ownCommandWord({ provenanceKind: 'nix', found: { state: 'absent' }, node, bundle: join(scratch, spelling, '.nix-profile/libexec/mercury/mercury.mjs') })
      const parsed = spawnSync('/bin/sh', ['-c', `set -- ${word}; printf '%s' "$1"`], { encoding: 'utf8', env: { HOME: home, USERPROFILE: home, PATH: '/usr/bin:/bin', MERCURY_LOCAL_PROBE_TARGETS: 'none' } })
      check(`a profile path containing ${spelling} stays one literal shell word`, parsed.status === 0 && parsed.stdout === command, parsed.stdout + parsed.stderr)
    }
    const env = { PATH: `${dirname(node)}:/usr/bin:/bin`, HOME: home, USERPROFILE: home, MERCURY_CONFIG_DIR: config, MERCURY_DAEMON_DIR: daemonDir, MERCURY_DAEMON_NO_SELF_WARM: '1', MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_UPDATE_NOTICE: '0', MERCURY_EVOLUTION_LEDGER: '0', CI: '1' }
    const homeCheck = spawnSync(node, ['-e', 'if (require("node:os").homedir() !== process.env.HOME) throw new Error("Nix profile proof runtime has the wrong home")'], { env, encoding: 'utf8' })
    if (homeCheck.status !== 0) throw new Error(homeCheck.stderr || 'Nix profile proof runtime did not confirm its scratch home')
    const recordPath = join(daemonDir, 'daemon.json')
    const child = spawn(node, [logical, 'daemon', 'run', scratch], { env, cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stdout?.on('data', d => { log += String(d) })
    child.stderr?.on('data', d => { log += String(d) })
    try {
      const record = await new Promise<any>(done => {
        const finish = (value: unknown): void => { clearTimeout(timer); watcher.close(); done(value) }
        const read = (): void => { try { const row = JSON.parse(readFileSync(recordPath, 'utf8')); if (row.pid === child.pid) finish(row) } catch {} }
        const watcher = watch(daemonDir, read)
        const timer = setTimeout(() => finish(null), 30_000)
        child.once('exit', () => finish(null))
        read()
      })
      check('a live daemon registers the profile path, not the current store path', record?.script === logical, JSON.stringify(record) + log)
      rmSync(profile)
      symlinkSync(second, profile, 'dir')
      check('upgrading the profile moves its target, not the registered spelling', realpathSync(logical) === join(second, 'libexec/mercury/mercury.mjs') && record?.script === logical)
      const handshake = await import(pathToFileURL(join(root, 'src/daemon/handshake.ts')).href)
      const { MERCURY_DAEMON_PROTO } = await import(pathToFileURL(join(root, 'src/daemon/protocol.ts')).href)
      const decision = handshake.decideHandshake({ kind: 'hello', reply: { ok: true, op: 'hello', proto: MERCURY_DAEMON_PROTO, minProto: 1, ready: true, version: '9.9.9', buildTree: record?.buildTree, pid: record?.pid, startedAt: 1, ownerPid: null, foreground: false, live: 0, liveSessions: 0, warm: 0, restartArmed: false } }, { proto: MERCURY_DAEMON_PROTO, version: '9.9.9', buildTree: 'b'.repeat(12) })
      check('the running daemon stays identified as its old build after the profile upgrade', record?.buildTree === 'a'.repeat(12) && decision.state === 'rebuilt' && decision.heal === 'operator', JSON.stringify(decision))
    } finally {
      child.kill('SIGTERM')
      await new Promise<void>(done => { if (child.exitCode !== null || child.signalCode !== null) return done(); const timer = setTimeout(() => { child.kill('SIGKILL'); done() }, 5000); child.once('exit', () => { clearTimeout(timer); done() }) })
    }
  }
} finally { rmSync(scratch, { recursive: true, force: true }) }
console.log(`prove-nix-profile: ${checks - failures}/${checks} passed`)
process.exitCode = failures ? 1 : 0
