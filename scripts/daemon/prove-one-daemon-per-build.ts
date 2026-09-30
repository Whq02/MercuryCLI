#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const NODE = (spawnSync('which', ['node'], { encoding: 'utf8' }).stdout ?? '').trim()
if (NODE === '') {
  console.error('no node on PATH')
  process.exit(1)
}
const PACK_NODE = join(REPO, 'dist', 'vendor', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
const STANDALONE = existsSync(PACK_NODE)
const KEEP = process.env.ONE_DAEMON_KEEP === '1'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number, everyMs = 100): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {}
    await sleep(everyMs)
  }
  return false
}
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — prove-one-daemon-per-build exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'one-daemon-per-build-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
const runtime = join(home, 'runtime')
const builds = join(runtime, 'builds')
for (const d of [home, daemonDir, work, builds]) mkdirSync(d, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const k of ['MERCURY_HOME', 'MERCURY_CREW_DIR', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_SUCCESSOR_OF', 'MERCURY_DAEMON_HANDOVER_FROM', 'NODE_ENV']) delete process.env[k]
const git = (args: string[]): void => {
  const r = spawnSync('git', ['-C', work, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}
git(['init', '-q'])
writeFileSync(join(work, 'README.md'), 'the one-daemon-per-build probe repository\n')
git(['add', 'README.md'])
git(['commit', '-q', '-m', 'the probe commit'])
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])

const TREE_X = 'x'.repeat(40)
const TREE_Y = 'y'.repeat(40)
const mkBuild = (name: string, tree: string): string => {
  const dir = join(builds, name)
  mkdirSync(join(dir, 'vendor', 'node', 'bin'), { recursive: true })
  copyFileSync(DIST, join(dir, 'mercury.mjs'))
  const manifest = JSON.parse(readFileSync(join(REPO, 'dist', 'manifest.json'), 'utf8')) as Record<string, unknown>
  manifest.buildTree = tree
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  if (STANDALONE) {
    const nodeAt = join(dir, 'vendor', 'node', 'bin', 'node')
    try {
      linkSync(PACK_NODE, nodeAt)
    } catch {
      copyFileSync(PACK_NODE, nodeAt)
    }
  }
  return dir
}
const X = mkBuild('X', TREE_X)
const Y = mkBuild('Y', TREE_Y)
const pointAt = (name: string, target: string): void => {
  const tmp = join(runtime, `.${name}.new`)
  rmSync(tmp, { force: true })
  symlinkSync(join('builds', target), tmp)
  renameSync(tmp, join(runtime, name))
}
pointAt('current', 'X')
pointAt('dist', 'X')

const { daemonControlRpc, controlSockPath } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const { isProcessAlive } = await import('../../src/daemon/ownerWatch.ts')

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const hits: string[] = []
const fixture = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0] ?? ''
    if (req.method !== 'POST' || !url.endsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const body = Buffer.concat(chunks).toString('utf8')
    hits.push(body)
    const n = hits.length
    const word = [...body.matchAll(/build-probe-(\w+)/g)].map(m => m[1] ?? '').pop() ?? 'unknown'
    const text = `build-probe answer ${word}`
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.end(
      [
        `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_b_${n}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
        `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
        `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 8 } })}`,
        `event: message_stop\n${sse({ type: 'message_stop' })}`,
      ].join(''),
    )
  })
})
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`

const daemonEnv: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: daemonDir,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_OPERATOR: 'sam',
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: base,
  OPENAI_API_KEY: '',
  MERCURY_CACHE_CLOCK: '0',
  MERCURY_PARTY: '0',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_VERIFY_EVIDENCE: '0',
  MERCURY_WARM_RUNNER: '0',
}
for (const [k, v] of Object.entries(daemonEnv)) {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}
process.env.MERCURY_DAEMON_OWNER_PID = String(process.pid)
process.execPath = NODE
process.chdir(work)

const read = (p: string): string => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
type Rec = { runnerId: string; sessionId: string; pid?: number; endedAt?: number; stoppedAt?: number; parkedAt?: number; crash?: { respawning: boolean } }
const records = (): Rec[] => {
  try {
    return Object.values((JSON.parse(read(join(daemonDir, 'concourse-workers.json'))) as { workers: Record<string, Rec> }).workers)
  } catch {
    return []
  }
}
const recOf = (sid: string): Rec | undefined => records().find(w => w.sessionId === sid)
const transcriptOf = (sid: string): string => read(join(paths.getProjectDir(work), `${sid}.jsonl`))
const facts = (sid: string): { busy?: boolean } | undefined => {
  try {
    return JSON.parse(read(join(daemonDir, 'session-facts', `${sid}.json`))) as { busy?: boolean }
  } catch {
    return undefined
  }
}
const psCommand = (pid: number): string => (spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim()
const psParent = (pid: number): number => Number((spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim() || '0')
const daemonPids = (): number[] =>
  (spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout ?? '')
    .split('\n')
    .filter(l => l.includes(' daemon run ') && l.includes(SCRATCH))
    .map(l => Number(l.trim().split(/\s+/)[0]))
    .filter(n => Number.isInteger(n) && n > 0)
const scriptArgOf = (command: string): string | null => {
  const m = /(\S+\/mercury\.mjs)/.exec(command)
  return m?.[1] ?? null
}
const realBuildOf = (command: string): string | null => {
  const script = scriptArgOf(command)
  if (script === null) return null
  try {
    return dirname(realpathSync(script))
  } catch {
    return null
  }
}

const logA = join(SCRATCH, 'daemon-A.log')
const A: ChildProcess = spawn(NODE, [join(runtime, 'current', 'mercury.mjs'), 'daemon', 'run', work], {
  cwd: work,
  env: { ...daemonEnv, MERCURY_DAEMON_OWNER_PID: String(process.pid) },
  stdio: ['ignore', openSync(logA, 'a'), openSync(logA, 'a')],
})
const Apid = A.pid ?? 0
let aExited = false
A.once('exit', () => {
  aExited = true
})

const hello = async (): Promise<{ pid: number; buildTree: string | null } | null> => {
  const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/protocol.ts')
  const reply = (await daemonControlRpc({ op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: '1.0.0', clientBuildTree: null } as never, { timeoutMs: 2000, protoRetry: false })) as { ok?: boolean; op?: string; pid?: number; buildTree?: string | null }
  return reply.ok === true && reply.op === 'hello' && typeof reply.pid === 'number' ? { pid: reply.pid, buildTree: reply.buildTree ?? null } : null
}
const dispatch = async (clientMessageId: string, prompt: string, extra: Record<string, unknown> = {}): Promise<{ ok?: boolean; sessionId?: string; error?: string }> =>
  (await daemonControlRpc({ op: 'concourseDispatch', clientMessageId, prompt, workspaceDir: work, title: 'Build probe', model: 'claude-sonnet-5', effort: 'high', ...extra } as never, { timeoutMs: 30_000 })) as { ok?: boolean; sessionId?: string; error?: string }

const cleanup = async (): Promise<void> => {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 3000 })
  } catch {}
  await sleep(1500)
  for (const pid of daemonPids()) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  if (failures === 0 && !KEEP) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

try {
  section('§1 the daemon of build X hosts a session')
  check('daemon A came up on build X through the runtime pointer', await untilAsync(async () => (await hello())?.pid === Apid, 60_000), read(logA).slice(-600))
  check('A says its build is X', (await hello())?.buildTree?.slice(0, 12) === TREE_X.slice(0, 12), JSON.stringify(await hello()))
  const s1 = await dispatch('probe-1', 'build-probe-one: answer once')
  const sid1 = s1.sessionId ?? ''
  check('S1 was born on A', s1.ok === true && sid1 !== '', JSON.stringify(s1))
  check('S1 answered its first turn', await untilAsync(() => transcriptOf(sid1).includes('build-probe answer one') && facts(sid1)?.busy === false, 60_000), transcriptOf(sid1).slice(-300))
  const p1 = recOf(sid1)?.pid ?? 0
  check('S1 runs as a child of A', p1 > 0 && psParent(p1) === Apid, `pid ${p1} ppid ${psParent(p1)}`)

  section('§2 build Y is installed: the runtime pointer moves, the folder of X stays')
  pointAt('current', 'Y')
  pointAt('dist', 'Y')
  check('the pointers now name Y and the X folder is untouched', realpathSync(join(runtime, 'current')) === Y && realpathSync(join(runtime, 'dist')) === Y && existsSync(join(X, 'mercury.mjs')))
  check('A is still alive after the switch', isProcessAlive(Apid))

  section('§3 a session born after the install lands on the daemon of build Y (started by the product road)')
  process.argv[1] = join(Y, 'mercury.mjs')
  const hs = await import('../../src/daemon/handshake.ts')
  hs.resetDaemonHandshakeForTesting()
  hs.resetHandoverAsksForTesting()
  const ensure = await import('../../src/services/switchboard/ensureDaemon.ts')
  ensure._resetDaemonUsableMemoForProofs()
  check('the screen reads its own build as Y', hs.clientVersionFacts().buildTree?.slice(0, 12) === TREE_Y.slice(0, 12), JSON.stringify(hs.clientVersionFacts()))
  const usable = await ensure.ensureOwnedDaemon()
  check('the screen road answered a usable daemon after the install', usable)
  const plane = await hello()
  const Bpid = plane?.pid ?? 0
  check('the plane is served by a daemon that is not A', plane !== null && Bpid !== Apid && Bpid > 0, JSON.stringify(plane))
  check('…of build Y', plane?.buildTree?.slice(0, 12) === TREE_Y.slice(0, 12), JSON.stringify(plane))
  const bCommand = psCommand(Bpid)
  check('daemon B runs the bundle of Y', realBuildOf(bCommand) === Y, bCommand)
  if (STANDALONE) check("daemon B runs on Y's own node runtime (one daemon per installed build — bundle and runtime from one folder)", bCommand.startsWith(join(Y, 'vendor', 'node', 'bin', 'node')), bCommand)
  else console.log('  (no vendored node pack beside dist — the own-runtime check is not staged)')
  const s2 = await dispatch('probe-2', 'build-probe-two: answer once')
  const sid2 = s2.sessionId ?? ''
  check('S2 was born after the install', s2.ok === true && sid2 !== '', JSON.stringify(s2))
  check('S2 answered', await untilAsync(() => transcriptOf(sid2).includes('build-probe answer two') && facts(sid2)?.busy === false, 60_000), transcriptOf(sid2).slice(-300))
  const p2 = recOf(sid2)?.pid ?? 0
  check('S2 runs as a child of B, never of A', p2 > 0 && psParent(p2) === Bpid, `pid ${p2} ppid ${psParent(p2)} (A ${Apid}, B ${Bpid})`)
  check('S2 runs the bundle of Y', realBuildOf(psCommand(p2)) === Y, psCommand(p2))

  section('§4 the old daemon still answers its own session')
  const again = await dispatch('probe-3', 'build-probe-three: answer again', { targetSessionId: sid1 })
  check('a message to S1 went through the plane', again.ok === true, JSON.stringify(again))
  check('…and S1 (held by A) answered it', await untilAsync(() => transcriptOf(sid1).includes('build-probe answer three') && facts(sid1)?.busy === false, 60_000), transcriptOf(sid1).slice(-300))
  check('S1 is still a child of A', psParent(recOf(sid1)?.pid ?? 0) === Apid)
  check('exactly two daemons serve this home: A (X) and B (Y)', daemonPids().sort().join(',') === [Apid, Bpid].sort().join(','), daemonPids().join(','))

  section("§5 the old daemon's own respawns stay on its own build")
  process.kill(p1, 'SIGKILL')
  const respawned = await untilAsync(() => {
    const r = recOf(sid1)
    return r !== undefined && r.pid !== undefined && r.pid !== p1 && isProcessAlive(r.pid)
  }, 45_000)
  const p1b = recOf(sid1)?.pid ?? 0
  check('A restarted the killed runner of S1', respawned, JSON.stringify(recOf(sid1)))
  check('the restarted runner is a child of A', psParent(p1b) === Apid, `pid ${p1b} ppid ${psParent(p1b)}`)
  check('the restarted runner runs the bundle of X — the build A was installed from, not the build installed since', realBuildOf(psCommand(p1b)) === X, psCommand(p1b))

  section('§6 when the old daemon\'s last session exits, no second daemon of any build starts')
  const before = daemonPids()
  const stopped = (await daemonControlRpc({ op: 'sessionControl', action: 'stop', sessionId: sid1, by: 'operator' } as never, { timeoutMs: 15_000 })) as { ok?: boolean; outcome?: string; detail?: string; error?: string }
  check('S1 was stopped through the Concourse', stopped.ok === true && stopped.outcome === 'applied', JSON.stringify(stopped))
  check('S1 reads stopped and its runner is gone', await untilAsync(() => recOf(sid1)?.stoppedAt !== undefined && !isProcessAlive(recOf(sid1)?.pid ?? 0), 20_000), JSON.stringify(recOf(sid1)))
  const seen = new Set<number>()
  const t0 = Date.now()
  while (Date.now() - t0 < 25_000 && !aExited) {
    for (const pid of daemonPids()) if (pid !== Apid && pid !== Bpid) seen.add(pid)
    await sleep(100)
  }
  for (let i = 0; i < 20; i++) {
    for (const pid of daemonPids()) if (pid !== Apid && pid !== Bpid) seen.add(pid)
    await sleep(100)
  }
  check('A exited once its last session had exited', aExited || !isProcessAlive(Apid), read(logA).slice(-400))
  check('no daemon other than A and B ever appeared', seen.size === 0, `extra daemon pid(s): ${[...seen].join(', ')}`)
  const successorLine = /successor spawned — pid (\d+)/.exec(read(logA))
  check("A spawned no successor of its own (a second daemon of the deployed build must never start beside B)", successorLine === null, successorLine?.[0] ?? '')
  check('B still serves the plane after A left', (await hello())?.pid === Bpid, JSON.stringify(await hello()))
  check('B still hosts S2', isProcessAlive(recOf(sid2)?.pid ?? 0) && psParent(recOf(sid2)?.pid ?? 0) === Bpid)
  check('exactly one daemon remains: B', daemonPids().join(',') === String(Bpid), daemonPids().join(','))
  check('the daemons before the stop were exactly A and B', before.sort().join(',') === [Apid, Bpid].sort().join(','), before.join(','))
} finally {
  await cleanup()
}
console.log(`\n${failures === 0 ? '✅ prove-one-daemon-per-build: ALL PASS' : `❌ prove-one-daemon-per-build: ${failures} FAIL`}`)
clearTimeout(guard)
process.exit(failures === 0 ? 0 : 1)
