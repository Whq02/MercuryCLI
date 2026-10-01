#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const BUNDLE_DIR = process.env.E004_BUNDLE_DIR ?? join(ROOT, 'dist')
const BUNDLE = join(BUNDLE_DIR, 'mercury.mjs')
if (!existsSync(BUNDLE)) {
  console.error(`✗ ${BUNDLE} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const text = (v: unknown): string => JSON.stringify(v) ?? ''
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const until = async (pred: () => boolean | Promise<boolean>, ms: number, step = 100): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await pred()) return true
    await sleep(step)
  }
  return pred()
}

const scratch = mkdtempSync(join(tmpdir(), 'field-e004-skew-'))
const home = join(scratch, 'home')
const work = join(scratch, 'work')
mkdirSync(home, { recursive: true })
mkdirSync(work, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_VERSIONS_DIR
delete process.env.MERCURY_DAEMON_OWNER_PID
delete process.env.MERCURY_DAEMON_SUCCESSOR_OF
delete process.env.MERCURY_DAEMON_HANDOVER_FROM
delete process.env.MERCURY_MODEL
process.env.NODE_ENV = 'test'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0-beta.26' }

const OLD_VERSION = '1.0.0-beta.26'
const NEW_VERSION = '1.0.0-beta.27'
const OLD_TREE = 'a91f96d7a74b0000000000000000000000000000'
const NEW_TREE = '0518549998ad0000000000000000000000000000'
const THIRD_TREE = 'cccccccccccc0000000000000000000000000000'
const versionsDir = join(home, 'versions')

function writePayload(version: string, tree: string): string {
  const dir = join(versionsDir, version)
  mkdirSync(join(dir, 'vendor', 'node'), { recursive: true })
  copyFileSync(BUNDLE, join(dir, 'mercury.mjs'))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 2, name: 'mercury', version, buildTree: tree, buildTime: '2026-10-01T00:00:00.000Z', bundle: 'mercury.mjs' }))
  writeFileSync(join(dir, 'mercury.cmd'), '@echo off\r\nrem release launcher\r\n')
  writeFileSync(join(dir, 'vendor', 'node', 'node.exe'), 'not a real node — the win32 vendored runtime seat')
  return dir
}
const oldDir = writePayload(OLD_VERSION, OLD_TREE)
const newDir = writePayload(NEW_VERSION, NEW_TREE)
const pointTo = (version: string): void => writeFileSync(join(versionsDir, 'current.txt'), `${version} \r\n`)
pointTo(NEW_VERSION)

const hsMod = await import(join(ROOT, 'src/daemon/handshake.ts'))
const handover = await import(join(ROOT, 'src/daemon/handover.ts'))
const sock = await import(join(ROOT, 'src/daemon/controlSocket.ts'))
const protocol = await import(join(ROOT, 'src/daemon/protocol.ts'))
const { isProcessAlive } = await import(join(ROOT, 'src/daemon/ownerWatch.ts'))
const { MERCURY_DAEMON_PROTO } = protocol

const helloReply = (over: Record<string, unknown>): never =>
  ({ ok: true, op: 'hello', proto: MERCURY_DAEMON_PROTO, minProto: 1, ready: true, version: OLD_VERSION, buildTree: OLD_TREE.slice(0, 12), pid: 9, startedAt: 1, ownerPid: null, foreground: false, live: 0, liveSessions: 0, warm: 0, restartArmed: false, ...over }) as never
const screen = { proto: MERCURY_DAEMON_PROTO, version: NEW_VERSION, buildTree: NEW_TREE.slice(0, 12) }

section('§A the pure grammar: a daemon of another build is visible')
{
  const armed = hsMod.decideHandshake({ kind: 'hello', reply: helloReply({ live: 2, liveSessions: 2, restartArmed: true }) }, screen)
  check('A1 a rebuilt daemon whose restart is armed behind live sessions carries THE LINE: both versions and that new sessions run on its build', armed.state === 'rebuilt' && armed.healState === 'armed' && armed.line === 'daemon v1.0.0-beta.26 is another build of this Mercury v1.0.0-beta.27 running with 2 live sessions — new sessions run on its build until it restarts · /daemon restart when ready', text({ state: armed.state, healState: armed.healState, line: armed.line }))
  const idle = hsMod.decideHandshake({ kind: 'hello', reply: helloReply({ live: 3, liveSessions: 3 }) }, screen)
  check('A2 before the heal is asked the pure decision owes no line (the door heals at once; the health row warns on the state itself)', idle.state === 'rebuilt' && idle.healState === 'none' && idle.line === null, text(idle.line))
  const refused = hsMod.applyHeal(idle, { state: 'refused', live: 0, detail: 'came back unchanged 3s ago: the install\'s current version is still v1.0.0-beta.26' })
  check('A3 a refused heal puts the reason on the rebuilt line', refused.line === "daemon v1.0.0-beta.26 is another build of this Mercury v1.0.0-beta.27 — new sessions run on its build until it restarts · came back unchanged 3s ago: the install's current version is still v1.0.0-beta.26", String(refused.line))
  const restarting = hsMod.applyHeal(idle, { state: 'restarting', live: 0 })
  check('A4 a daemon restarting itself owes no line (it is moving)', restarting.line === null && hsMod.daemonSkewLine(restarting) === null)
  check('A5 the health row\'s skew line stands while the heal is pending, naming both versions', hsMod.daemonSkewLine(idle) === 'daemon v1.0.0-beta.26 is another build of this Mercury v1.0.0-beta.27 — new sessions run on its build until it restarts · /daemon restart moves it', String(hsMod.daemonSkewLine(idle)))
  const evidence = hsMod.daemonHandshakeEvidence(idle)
  check('A6 the certificate evidence names both trees AND both versions', evidence.includes('tree a91f96d7a74b vs 0518549998ad') && evidence.includes('this Mercury v1.0.0-beta.27') && evidence.includes('daemon v1.0.0-beta.26'), evidence)
  check('A7 the "Mercury build" row gets the daemon\'s build beside the screen\'s only when they differ', hsMod.daemonBuildBesideScreen(idle) === 'daemon v1.0.0-beta.26 · tree a91f96d7a74b (another build — new sessions run on it until it restarts)' && hsMod.daemonBuildBesideScreen(hsMod.decideHandshake({ kind: 'hello', reply: helloReply({ buildTree: NEW_TREE.slice(0, 12) }) }, screen)) === null, String(hsMod.daemonBuildBesideScreen(idle)))
  const older = hsMod.decideHandshake({ kind: 'hello', reply: helloReply({ proto: MERCURY_DAEMON_PROTO - 1, live: 2, liveSessions: 2, restartArmed: true }) }, screen)
  check('A8 the older-daemon line keeps its words (the armed fact now comes from hello)', older.healState === 'armed' && older.line === 'daemon v1.0.0-beta.26 running with 2 live sessions — new features wait until it restarts · /daemon restart when ready', String(older.line))
}

section('§B the install layout: the release layout (versions\\current.txt, Windows-shaped) resolves beside the source layout')
{
  const release = handover.releaseDeployedRuntime(home, 'win32')
  check('B1 current.txt (CRLF, a trailing space) names the version directory, its bundle, its tree, its version and its vendored node.exe', release !== null && release.layout === 'release' && release.script === join(newDir, 'mercury.mjs') && release.buildTree === NEW_TREE.slice(0, 12) && release.version === NEW_VERSION && release.node === join(newDir, 'vendor', 'node', 'node.exe'), text(release))
  const fromOld = handover.deployedRuntime(home, { platform: 'win32', runningScript: join(oldDir, 'mercury.mjs') })
  check('B2 a daemon running from the versions root resolves the release layout, never process.argv[1]', fromOld !== null && fromOld.script === join(newDir, 'mercury.mjs') && fromOld.layout === 'release', text(fromOld))
  const runtimeDir = join(home, 'runtime', 'current')
  mkdirSync(runtimeDir, { recursive: true })
  writeFileSync(join(runtimeDir, 'mercury.mjs'), '')
  writeFileSync(join(runtimeDir, 'manifest.json'), JSON.stringify({ version: '9.9.9', buildTree: THIRD_TREE }))
  const both = handover.deployedRuntime(home, { platform: 'win32', runningScript: join(oldDir, 'mercury.mjs') })
  check('B3 with both layouts present the one holding the running script wins (release here)', both !== null && both.layout === 'release' && both.script === join(newDir, 'mercury.mjs'), text(both))
  const fromRuntime = handover.deployedRuntime(home, { platform: 'win32', runningScript: join(runtimeDir, 'mercury.mjs') })
  check('B4 …and the source layout for a daemon running under runtime/', fromRuntime !== null && fromRuntime.layout === 'source' && fromRuntime.buildTree === THIRD_TREE.slice(0, 12) && fromRuntime.version === '9.9.9', text(fromRuntime))
  const neither = handover.deployedRuntime(home, { platform: 'win32', runningScript: '/elsewhere/mercury.mjs' })
  check('B5 a script in neither layout keeps the source layout first (today\'s order)', neither !== null && neither.layout === 'source', text(neither))
  rmSync(join(home, 'runtime'), { recursive: true, force: true })
  writeFileSync(join(versionsDir, 'current.txt'), '..\\outside\\evil\r\n')
  check('B6 a pointer that is a path, not a version name, resolves nothing (FC-021)', handover.releaseDeployedRuntime(home, 'win32') === null)
  writeFileSync(join(versionsDir, 'current.txt'), '1.0.0-beta.99\r\n')
  check('B7 a pointer naming an absent version resolves nothing', handover.releaseDeployedRuntime(home, 'win32') === null)
  pointTo(NEW_VERSION)
}

type Daemon = { child: ChildProcess; log: string[]; pid: number }
function startDaemon(script: string, extraEnv: Record<string, string> = {}): Daemon {
  const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_PERSIST: '1', MERCURY_DAEMON_NO_SELF_WARM: '1', MERCURY_EVOLUTION_LEDGER: '0', ...extraEnv }
  const log: string[] = []
  const child = spawn('node', [script, 'steward', 'run', work], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.on('data', d => log.push(String(d)))
  child.stderr?.on('data', d => log.push(String(d)))
  return { child, log, pid: child.pid ?? -1 }
}
const helloFrom = async (): Promise<{ pid: number; buildTree: string | null; version: string; ready: boolean } | null> => {
  const r = await sock.daemonControlRpc({ op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: NEW_VERSION, clientBuildTree: NEW_TREE.slice(0, 12) }, { timeoutMs: 1500, protoRetry: false })
  return r.ok && r.op === 'hello' ? { pid: r.pid as number, buildTree: r.buildTree, version: r.version, ready: r.ready } : null
}
const readyAt = (pid: number): Promise<boolean> => until(async () => {
  const h = await helloFrom()
  return h !== null && h.pid === pid && h.ready
}, 45_000, 250)
const otherThan = async (pid: number): Promise<{ pid: number; buildTree: string | null; version: string } | null> => {
  let seen: { pid: number; buildTree: string | null; version: string } | null = null
  await until(async () => {
    const h = await helloFrom()
    if (h !== null && h.pid !== pid && h.ready) {
      seen = h
      return true
    }
    return false
  }, 45_000, 250)
  return seen
}
const stopPlane = async (): Promise<void> => {
  const h = await helloFrom()
  await sock.daemonControlRpc({ op: 'shutdown', reapWorkers: true }, { timeoutMs: 5000 }).catch(() => undefined)
  if (h !== null) await until(() => !isProcessAlive(h.pid), 20_000, 200)
  await until(async () => (await helloFrom()) === null, 10_000, 200)
}
const killAll = (pids: Set<number>): void => {
  for (const pid of pids) {
    if (pid > 0 && isProcessAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {}
    }
  }
}
const spawned = new Set<number>()

section('§C the heal moves a release install: a daemon of the old payload restarts as the build current.txt names')
{
  hsMod.resetDaemonHandshakeForTesting()
  hsMod.resetHandoverAsksForTesting()
  const old = startDaemon(join(oldDir, 'mercury.mjs'))
  spawned.add(old.pid)
  const up = await readyAt(old.pid)
  const first = await helloFrom()
  check('C1 a daemon started from the OLD payload answers with the old tree', up && first !== null && first.buildTree === OLD_TREE.slice(0, 12), `${text(first)}\n${old.log.join('').slice(-800)}`)
  const verdict = await hsMod.handshakeDaemon({ timeoutMs: 1500, client: screen })
  check('C2 the screen of the new build reads it as rebuilt', verdict.state === 'rebuilt' && verdict.heal === 'restart-when-idle', text({ state: verdict.state, line: verdict.line }))
  const heal = await hsMod.healDaemonVersion(verdict, { by: 'field-e004 proof' })
  check('C3 the idle daemon answers the heal with restarting', heal.state === 'restarting', text(heal))
  const successor = await otherThan(old.pid)
  spawned.add(successor?.pid ?? -1)
  check('C4 THE FIELD DEFECT: the successor runs the build versions\\current.txt names (the new tree), not process.argv[1]\'s old bundle', successor !== null && successor.buildTree === NEW_TREE.slice(0, 12), `${text(successor)}\n${old.log.join('').slice(-1200)}`)
  check('C5 the daemon log names the release layout\'s current build', old.log.join('').includes(`the release layout's current build v${NEW_VERSION}`) && old.log.join('').includes(join(newDir, 'mercury.mjs')), old.log.join('').split('\n').filter(l => l.includes('successor')).join(' | '))
  const matched = await hsMod.handshakeDaemon({ timeoutMs: 1500, client: screen })
  check('C6 the new screen now matches its daemon', matched.state === 'matched' && matched.daemon?.pid === successor?.pid, text({ state: matched.state, pid: matched.daemon?.pid }))
  hsMod.resetDaemonHandshakeForTesting()
  const third = await hsMod.handshakeDaemon({ timeoutMs: 1500, client: { ...screen, buildTree: THIRD_TREE.slice(0, 12) } })
  const guarded = await hsMod.healDaemonVersion(third, { by: 'field-e004 proof (storm guard)' })
  check('C7 inside the storm guard a successor refuses in the release layout\'s words: the install\'s current version and `mercury update`, never "deploy the new build first"', guarded.state === 'refused' && typeof guarded.detail === 'string' && guarded.detail.includes(`the install's current version is still v${NEW_VERSION}`) && guarded.detail.includes('mercury update') && !guarded.detail.includes('deploy the new build first'), text(guarded))
  check('C8 the refused heal is on the line, with both versions', (hsMod.lastDaemonHandshake()?.line ?? '').startsWith(`daemon v${OLD_VERSION} is another build of this Mercury v${NEW_VERSION}`) && (hsMod.lastDaemonHandshake()?.line ?? '').includes('mercury update'), String(hsMod.lastDaemonHandshake()?.line))
  await stopPlane()
  check('C9 the way down: the successor stops on request and nothing of the old daemon survives', !isProcessAlive(old.pid) && (successor === null || !isProcessAlive(successor.pid)), text({ oldAlive: isProcessAlive(old.pid), successorAlive: successor !== null && isProcessAlive(successor.pid) }))
}

section('§D `mercury update` ends by moving a daemon of another build, and says so')
{
  hsMod.resetDaemonHandshakeForTesting()
  hsMod.resetHandoverAsksForTesting()
  const old = startDaemon(join(oldDir, 'mercury.mjs'))
  spawned.add(old.pid)
  await readyAt(old.pid)
  const receipt = await hsMod.moveDaemonToDeployedBuild({ by: 'mercury update (field-e004 proof)', hosted: false, pollMs: 150, tries: 200 })
  const after = await helloFrom()
  spawned.add(after?.pid ?? -1)
  check('D1 a daemon whose restart follows the pointer: moved, on the new tree, the line says so', receipt.state === 'moved' && receipt.line.startsWith('background daemon: moved to v') && receipt.line.includes('new sessions run on it') && after !== null && after.pid !== old.pid && after.buildTree === NEW_TREE.slice(0, 12), `${text(receipt)} ${text(after)}\n${old.log.join('').slice(-600)}`)
  const again = await hsMod.moveDaemonToDeployedBuild({ by: 'mercury update (field-e004 proof)', hosted: false, pollMs: 150, tries: 20 })
  check('D2 asked again, the daemon is already current — no restart, no spawn', again.state === 'current' && again.line.startsWith(`background daemon: already on v${NEW_VERSION}`) && (await helloFrom())?.pid === after?.pid, text(again))
  await stopPlane()
  const none = await hsMod.moveDaemonToDeployedBuild({ by: 'mercury update (field-e004 proof)', hosted: false, pollMs: 100, tries: 5 })
  check('D3 with no daemon the line says the next session starts one on the new build', none.state === 'absent' && none.line === `background daemon: none running — the next session starts one on v${NEW_VERSION}`, text(none))

  await sleep(500)
  killAll(spawned)
  check('D4 the way down: every daemon this proof started is gone', [...spawned].every(pid => pid <= 0 || !isProcessAlive(pid)), text([...spawned].filter(pid => pid > 0 && isProcessAlive(pid))))
}

section('§D2 a daemon of an older build whose restart re-executes its own bundle (the field\'s beta.23) is handed over, never stopped')
{
  const plane = join(scratch, 'fixture-plane')
  mkdirSync(plane, { recursive: true })
  process.env.MERCURY_DAEMON_DIR = plane
  const CONTROL_KEY = 'k'.repeat(64)
  writeFileSync(join(plane, 'control.key'), CONTROL_KEY)
  hsMod.resetDaemonHandshakeForTesting()
  hsMod.resetHandoverAsksForTesting()
  sock.forgetDaemonProtoForTesting()
  sock.clearControlKeyMemo()
  const net = await import('node:net')
  const { unlinkSync } = await import('node:fs')
  const received: string[] = []
  type Fixture = { close: () => Promise<void> }
  const startFixture = (opts: { pid: number; tree: string; restart: () => { state: 'restarting' | 'refused' | 'armed'; live: number; detail?: string }; onRestart?: () => void }): Promise<Fixture> => {
    const server = net.createServer(conn => {
      protocol.readControlFrame(
        conn,
        line => {
          const req = JSON.parse(line) as Record<string, unknown>
          const op = String(req.op)
          received.push(`${opts.pid}:${op}`)
          const answer = (payload: unknown): void => void conn.end(protocol.encodeFrame(payload))
          if (op === 'hello') return answer(helloReply({ pid: opts.pid, buildTree: opts.tree, startedAt: Date.now() - 2000 }))
          if (op === 'ping') return answer({ ok: true, op: 'ping', version: OLD_VERSION, proto: MERCURY_DAEMON_PROTO })
          if (req.auth !== CONTROL_KEY) return answer({ ok: false, code: 'EAUTH', error: `${op} rejected: no key` })
          if (op === 'restart-when-idle') {
            const reply = opts.restart()
            if (reply.state === 'restarting') setTimeout(() => server.close(() => opts.onRestart?.()), 10)
            return answer({ ok: true, op: 'restart-when-idle', ...reply })
          }
          if (op === 'shutdown') return answer({ ok: true, op: 'shutdown', reaped: 0 })
          return answer({ ok: false, code: 'EUNKNOWN', error: `unknown op: ${op}` })
        },
        () => conn.destroy(),
      )
    })
    return new Promise(resolve => {
      try {
        unlinkSync(sock.controlSockPath())
      } catch {}
      server.listen(sock.controlSockPath(), () => resolve({ close: () => new Promise(done => server.close(() => done())) }))
    })
  }
  let successorFixture: Fixture | null = null
  let newFixture: Fixture | null = null
  await startFixture({
    pid: 111,
    tree: OLD_TREE.slice(0, 12),
    restart: () => ({ state: 'restarting', live: 0 }),
    onRestart: () => {
      void startFixture({ pid: 222, tree: OLD_TREE.slice(0, 12), restart: () => ({ state: 'refused', live: 0, detail: 'came back unchanged 1s ago (still v1.0.0-beta.23, protocol 12): the bundle at C:\\Users\\WHQ\\.mercury\\versions\\1.0.0-beta.23\\mercury.mjs is what a restart runs — deploy the new build first' }) }).then(f => {
        successorFixture = f
      })
    },
  })
  const spawns: Array<{ script: string; env: Record<string, string | undefined>; node: string | null | undefined }> = []
  const receipt = await hsMod.moveDaemonToDeployedBuild({
    by: 'mercury update (field-e004 proof)',
    hosted: false,
    pollMs: 25,
    tries: 200,
    runtime: { script: join(newDir, 'mercury.mjs'), buildTree: NEW_TREE.slice(0, 12), dir: newDir, node: join(newDir, 'vendor', 'node', 'node.exe'), layout: 'release', version: NEW_VERSION },
    spawn: (script, _dir, env, _ownerPipe, _persist, node) => {
      spawns.push({ script, env, node })
      void (successorFixture as Fixture | null)?.close().then(() => startFixture({ pid: 333, tree: NEW_TREE.slice(0, 12), restart: () => ({ state: 'refused', live: 0 }) })).then(f => {
        newFixture = f
      })
      return 333
    },
  })
  check('D2-1 the old daemon was asked to restart when idle, came back on its own bundle, and was then handed over — the receipt says moved to the new build', receipt.state === 'moved' && receipt.line.startsWith(`background daemon: moved to v${OLD_VERSION} (pid 333)`), `${text(receipt)} received=${received.join(',')}`)
  check('D2-2 the successor was spawned from the install\'s current build with its vendored runtime and the handover stamp, persistent like its predecessor', spawns.length === 1 && spawns[0]?.script === join(newDir, 'mercury.mjs') && spawns[0]?.node === join(newDir, 'vendor', 'node', 'node.exe') && spawns[0]?.env.MERCURY_DAEMON_HANDOVER_FROM === '222' && spawns[0]?.env.MERCURY_DAEMON_PERSIST === '1', text(spawns))
  check('D2-3 the wire carried two restart asks and no shutdown — nothing live was ever cut', received.filter(r => r.endsWith(':restart-when-idle')).length === 2 && !received.some(r => r.endsWith(':shutdown')), received.join(','))
  await (newFixture as Fixture | null)?.close()
  await (successorFixture as Fixture | null)?.close()
  delete process.env.MERCURY_DAEMON_DIR
}

section('§E the wiring: the rows, the verb, the daemon')
{
  const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
  const health = read('src/utils/healthReport.ts')
  check('E1 the "Scheduler daemon" row warns on the skew itself, the skew line as the fix', health.includes('const skew = daemonSkewLine(hs)') && health.includes("if (skew !== null) return { status: 'warn', evidence, fix: skew, link: '/daemon' }"))
  check('E2 the "Mercury build" row shows the daemon\'s build beside the screen\'s', health.includes('daemonBuildBesideScreen(await handshakeDaemon({ timeoutMs: 1000 }))') && health.includes('${artifactIdentityLine(identity)}${daemonBuild}'))
  const update = read('src/cli/update.ts')
  check('E3 `mercury update` finishes by moving the daemon and says so on its last line (text and --json)', update.includes("moveDaemonToDeployedBuild({ by: 'mercury update' })") && update.includes('const daemon = installCurrent ? await moveDaemonAfterUpdate() : null') && update.includes('${shimLine}${shellWords}${daemonLine}') && update.includes('{ ...base, daemon }'))
  const dmain = read('src/daemon/main.ts')
  check('E4 the daemon\'s successor is resolved from the layout\'s current pointer, process.argv[1] only when no layout resolves', dmain.includes('const deployed = successorRuntime()') && dmain.includes('[...process.execArgv, deployed.script, ...process.argv.slice(2)]') && dmain.includes('detail: unchangedSuccessorDetail('))
  const handoverSrc = read('src/daemon/handover.ts')
  check('E5 handover.ts knows the release layout through the install layout\'s own pointer reader', handoverSrc.includes('readCurrentVersion(roots)') && handoverSrc.includes("layout: 'release'") && handoverSrc.includes('return source ?? release'))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ prove-field-e004-daemon-skew — all checks pass' : `\n❌ prove-field-e004-daemon-skew — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
