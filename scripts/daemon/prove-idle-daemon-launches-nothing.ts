#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
const CENSUS = join(REPO, 'scripts', 'daemon', 'census-preload.cjs')
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const KEEP = process.env.IDLE_LAUNCH_KEEP === '1'
const IDLE_MS = 60_000
const SETTLE_MS = 8_000
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
  console.log('\n❌ TIMEOUT — prove-idle-daemon-launches-nothing exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()
const read = (p: string): string => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
for (const k of ['MERCURY_HOME', 'MERCURY_CREW_DIR', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_SUCCESSOR_OF', 'MERCURY_DAEMON_HANDOVER_FROM', 'NODE_OPTIONS', 'DAEMON_CENSUS_DIR', 'NODE_ENV']) delete process.env[k]
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
let hits = 0
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
    hits++
    const text = 'idle-probe: answered'
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.end(
      [
        `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_i_${hits}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
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
const owner = spawn('node', ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })
const ownerPid = owner.pid ?? 0

interface World {
  name: string
  scratch: string
  home: string
  daemonDir: string
  work: string
  censusDir: string
  daemons: Array<{ label: string; child: ChildProcess; pid: number; log: string; exited: boolean }>
}
const mkWorld = (name: string): World => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), `idle-launch-${name}-`)))
  const w: World = { name, scratch, home: join(scratch, 'home'), daemonDir: join(scratch, 'daemon'), work: join(scratch, 'work'), censusDir: join(scratch, 'census'), daemons: [] }
  for (const d of [w.home, w.daemonDir, w.work, w.censusDir]) mkdirSync(d, { recursive: true })
  spawnSync('git', ['-C', w.work, 'init', '-q'])
  writeFileSync(join(w.work, 'README.md'), 'the idle probe repository\n')
  spawnSync('git', ['-C', w.work, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'add', 'README.md'])
  spawnSync('git', ['-C', w.work, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-q', '-m', 'the probe commit'])
  seedFirstRun(w.home, [w.work])
  return w
}
const envFor = (w: World, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: w.home,
  MERCURY_CONFIG_DIR: w.home,
  MERCURY_DAEMON_DIR: w.daemonDir,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_OPERATOR: 'sam',
  MERCURY_DAEMON_OWNER_PID: String(ownerPid),
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
  NODE_OPTIONS: `--require=${CENSUS}`,
  DAEMON_CENSUS_DIR: w.censusDir,
  ...extra,
})
const bootDaemon = (w: World, label: string, script: string, extra: Record<string, string> = {}): { pid: number; log: string } => {
  const log = join(w.scratch, `${label}.log`)
  const child = spawn('node', [script, 'daemon', 'run', w.work], { cwd: w.work, env: envFor(w, extra), stdio: ['ignore', openSync(log, 'a'), openSync(log, 'a')] })
  const entry = { label, child, pid: child.pid ?? 0, log, exited: false }
  child.once('exit', () => {
    entry.exited = true
  })
  w.daemons.push(entry)
  return { pid: entry.pid, log }
}
const { daemonControlRpc, clearControlKeyMemo } = await import('../../src/daemon/controlSocket.ts')
const inWorld = async <T>(w: World, call: () => Promise<T>): Promise<T> => {
  process.env.MERCURY_CONFIG_DIR = w.home
  process.env.MERCURY_DAEMON_DIR = w.daemonDir
  clearControlKeyMemo()
  return call()
}
const dispatch = (w: World, id: string): Promise<{ ok?: boolean; sessionId?: string; error?: string }> =>
  inWorld(w, async () => (await daemonControlRpc({ op: 'concourseDispatch', clientMessageId: id, prompt: 'idle-probe: answer once', workspaceDir: w.work, title: 'Idle probe', model: 'claude-sonnet-5', effort: 'high' } as never, { timeoutMs: 30_000 })) as { ok?: boolean; sessionId?: string; error?: string })
const factsOf = (w: World, sid: string): { busy?: boolean } | undefined => {
  try {
    return JSON.parse(read(join(w.daemonDir, 'session-facts', `${sid}.json`))) as { busy?: boolean }
  } catch {
    return undefined
  }
}

interface CensusLine {
  t: number
  pid: number
  spawns: Array<{ t: number; kind: string; cmd: string; args: string[] }>
}
const spawnsOf = (w: World, pid: number, from: number, to: number): Array<{ t: number; kind: string; cmd: string; args: string[] }> => {
  const file = join(w.censusDir, `census-${pid}.jsonl`)
  return read(file)
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as CensusLine)
    .flatMap(l => l.spawns)
    .filter(s => s.t >= from && s.t < to)
}
const flushedTo = (w: World, pid: number): number => {
  const file = join(w.censusDir, `census-${pid}.jsonl`)
  return read(file)
    .split('\n')
    .filter(Boolean)
    .map(l => (JSON.parse(l) as CensusLine).t)
    .reduce((a, b) => Math.max(a, b), 0)
}
const describe = (spawns: Array<{ kind: string; cmd: string; args: string[] }>): string => {
  const byCmd: Record<string, number> = {}
  for (const s of spawns) {
    const k = `${s.kind} ${s.cmd} ${s.args.slice(0, 3).join(' ')}`
    byCmd[k] = (byCmd[k] ?? 0) + 1
  }
  return Object.entries(byCmd)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n}× ${k}`)
    .join(' · ')
}

const worlds: World[] = []
const cleanup = async (): Promise<void> => {
  try {
    owner.kill('SIGKILL')
  } catch {}
  for (const w of worlds) for (const d of w.daemons) await untilAsync(() => d.exited || !alive(d.pid), 15_000)
  for (const w of worlds) for (const d of w.daemons) {
    try {
      process.kill(d.pid, 'SIGKILL')
    } catch {}
  }
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  if (failures === 0 && !KEEP) for (const w of worlds) rmSync(w.scratch, { recursive: true, force: true })
  else console.log(`[forensics] worlds kept: ${worlds.map(w => w.scratch).join(', ')}`)
}

try {
  section(`three idle daemons under the census, ${IDLE_MS / 1000} s each, side by side: no session · one idle session · an install's successor beside its predecessor`)
  const plain = mkWorld('plain')
  const session = mkWorld('session')
  const handover = mkWorld('handover')
  worlds.push(plain, session, handover)
  const TREE_X = 'x'.repeat(40)
  const TREE_Y = 'y'.repeat(40)
  const runtime = join(handover.home, 'runtime')
  const mkBuild = (name: string, tree: string): string => {
    const dir = join(runtime, 'builds', name)
    mkdirSync(dir, { recursive: true })
    copyFileSync(DIST, join(dir, 'mercury.mjs'))
    const manifest = JSON.parse(readFileSync(join(REPO, 'dist', 'manifest.json'), 'utf8')) as Record<string, unknown>
    manifest.buildTree = tree
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
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

  const p = bootDaemon(plain, 'daemon', DIST)
  const s = bootDaemon(session, 'daemon', DIST)
  const a = bootDaemon(handover, 'daemon-A', join(runtime, 'current', 'mercury.mjs'))
  check('the plain daemon came up', await untilAsync(() => read(p.log).includes('control socket up'), 60_000), read(p.log).slice(-400))
  check('the session daemon came up', await untilAsync(() => read(s.log).includes('control socket up'), 60_000), read(s.log).slice(-400))
  check('daemon A (build X) came up', await untilAsync(() => read(a.log).includes('control socket up'), 60_000), read(a.log).slice(-400))
  const born = await dispatch(session, 'idle-1')
  const sid = born.sessionId ?? ''
  check('one session was born on the session daemon', born.ok === true && sid !== '', JSON.stringify(born))
  check('it answered and went idle', await untilAsync(() => factsOf(session, sid)?.busy === false, 60_000))
  const bornA = await dispatch(handover, 'idle-2')
  const sidA = bornA.sessionId ?? ''
  check('one session was born on daemon A', bornA.ok === true && sidA !== '', JSON.stringify(bornA))
  check('it answered and went idle', await untilAsync(() => factsOf(handover, sidA)?.busy === false, 60_000))
  pointAt('current', 'Y')
  pointAt('dist', 'Y')
  const b = bootDaemon(handover, 'daemon-B', join(runtime, 'current', 'mercury.mjs'), { MERCURY_DAEMON_HANDOVER_FROM: String(a.pid) })
  check('daemon B (build Y) took the plane from A, which keeps its session and holds the daemon lock', await untilAsync(() => read(b.log).includes('took the plane'), 60_000), read(b.log).slice(-600))
  check('…and waits for the lock A holds', await untilAsync(() => /daemon lock/.test(read(b.log)), 10_000), read(b.log).slice(-400))
  const sessionRunner = ((): number => {
    try {
      return Object.values((JSON.parse(read(join(session.daemonDir, 'concourse-workers.json'))) as { workers: Record<string, { pid?: number }> }).workers)[0]?.pid ?? 0
    } catch {
      return 0
    }
  })()

  await sleep(SETTLE_MS)
  const t0 = Date.now()
  console.log(`  idling ${IDLE_MS / 1000} s from ${new Date(t0).toISOString()} — plain ${p.pid} · session ${s.pid} (runner ${sessionRunner}) · A ${a.pid} · B ${b.pid} · owner ${ownerPid}`)
  await sleep(IDLE_MS)
  const t1 = Date.now()
  await untilAsync(() => [p, s, a, b].every(d => flushedTo(d === p ? plain : d === s ? session : handover, d.pid) >= t1), 12_000)
  for (const [label, w, d] of [
    ['a daemon with no session', plain, p],
    ['a daemon with one idle session', session, s],
    ["an install's predecessor holding its session and the daemon lock", handover, a],
    ["an install's successor serving the plane while its predecessor holds the lock", handover, b],
  ] as const) {
    const spawns = spawnsOf(w, d.pid, t0, t1)
    check(`${label} launched nothing in ${IDLE_MS / 1000} s of idle (pid ${d.pid})`, spawns.length === 0, `${spawns.length} launch(es): ${describe(spawns)}`)
    check(`…and is still alive after the window`, alive(d.pid), read(d.log).slice(-300))
  }
  if (sessionRunner > 0) {
    const runnerSpawns = spawnsOf(session, sessionRunner, t0, t1)
    check(`the idle session's runner launched nothing either (pid ${sessionRunner})`, runnerSpawns.length === 0, describe(runnerSpawns))
  }

  section('the reap still works with no process on the beat: the owner dies, every daemon parks and leaves within the grace')
  const ownerWatch = await import('../../src/daemon/ownerWatch.ts')
  const ceilingMs = ownerWatch.OWNER_WATCH_INTERVAL_MS * ownerWatch.OWNER_WATCH_GRACE_CHECKS + ownerWatch.OWNER_WATCH_INTERVAL_MS + 3_000
  const killedAt = Date.now()
  owner.kill('SIGKILL')
  const allGone = await untilAsync(() => [p, s, a, b].every(d => !alive(d.pid)), ceilingMs + 12_000)
  const reapMs = Date.now() - killedAt
  console.log(`  every daemon gone ${reapMs} ms after the owner died (ceiling ${ceilingMs} ms + 12 s of margin for four parks)`)
  check('every daemon left after its owner died', allGone, [p, s, a, b].map(d => `${d.pid}:${alive(d.pid) ? 'alive' : 'gone'}`).join(' '))
  check('the plain daemon named the road (owner-gone) in its log', /owner pid \d+ gone \(owner-gone\)/.test(read(p.log)), read(p.log).slice(-400))

  section('the wiring — nothing periodic launches a process')
  {
    const ow = read(join(REPO, 'src/daemon/ownerWatch.ts'))
    check('the owner watch has no probe on a cadence of its own (the token is read again only when liveness moved)', !/t - facts\.lastProbeAt >= floorMs/.test(ow) && /cameBack/.test(ow))
    const main = read(join(REPO, 'src/daemon/main.ts'))
    check('the handover lock beat claims only when the lock holder is gone (a kill(0) read, no process)', /if \(lockHeldByLivePidSync\(\) !== null\) return/.test(main))
    check('the successor lock wait re-decides on kill(0) facts instead of claiming every 100 ms', /while \(decision\.road === 'wait-lock' && Date\.now\(\) < deadline\)/.test(main) && !/while \(!supervisorLock && Date\.now\(\) < deadline\)/.test(main))
    const sup = read(join(REPO, 'src/daemon/concourseSupervisor.ts'))
    check('the reconcile never probes a runner the daemon itself rosters or holds', /const pidLive = rosterLive \|\| workerPidAlive\(rec\)/.test(sup) && /rosteredOrHeld\(\)/.test(main))
  }
} finally {
  await cleanup()
}
console.log(`\n${failures === 0 ? '✅ prove-idle-daemon-launches-nothing: ALL PASS' : `❌ prove-idle-daemon-launches-nothing: ${failures} FAIL`}`)
clearTimeout(guard)
process.exit(failures === 0 ? 0 : 1)
