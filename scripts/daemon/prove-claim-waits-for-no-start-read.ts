#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
const CENSUS = join(REPO, 'scripts', 'daemon', 'census-preload.cjs')
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
if (process.platform !== 'darwin') {
  console.log(`  [SKIP] the start read is a child process on macOS only (this is ${process.platform}: Linux reads /proc, and the Windows read cannot be counted through this preload)`)
  process.exit(0)
}
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${[detail, 'change: a runner asks for its own start token as it starts (src/boot/main.tsx, beside the other reads begun early), so the session writer’s lock at the claim (src/sessions/transcripts/sessionWriter.ts through src/platform/substrate/pidLock.ts) finds it answered; scripts/daemon/census-preload.cjs records every launch, and the world path is printed as [forensics] below'].filter(Boolean).join(' | ')}`}`)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const until = async (pred: () => boolean, ms: number): Promise<boolean> => {
  const stop = Date.now() + ms
  for (;;) {
    if (pred()) return true
    if (Date.now() > stop) return false
    await sleep(50)
  }
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — prove-claim-waits-for-no-start-read exceeded 180s; read the daemon log in the world printed as [forensics]')
  process.exit(1)
}, 180_000)
guard.unref?.()
const read = (path: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
for (const name of ['MERCURY_HOME', 'MERCURY_CREW_DIR', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_SUCCESSOR_OF', 'MERCURY_DAEMON_HANDOVER_FROM', 'MERCURY_DAEMON_NO_SELF_WARM', 'MERCURY_WARM_RUNNER', 'NODE_OPTIONS', 'DAEMON_CENSUS_DIR', 'NODE_ENV']) delete process.env[name]

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const fixture = createServer((req: IncomingMessage, res: ServerResponse) => {
  req.on('data', () => {})
  req.on('end', () => {
    if (req.method !== 'POST' || !((req.url ?? '').split('?')[0] ?? '').endsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.end(
      [
        `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_claim', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
        `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'claimed: answered' } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
        `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 8 } })}`,
        `event: message_stop\n${sse({ type: 'message_stop' })}`,
      ].join(''),
    )
  })
})
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
const owner = spawn('node', ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'claim-no-read-')))
const home = join(scratch, 'home')
const daemonDir = join(scratch, 'daemon')
const work = join(scratch, 'work')
const censusDir = join(scratch, 'census')
for (const dir of [home, daemonDir, work, censusDir]) mkdirSync(dir, { recursive: true })
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
const { daemonControlRpc } = await import('../../src/daemon/control/controlSocket.ts')

type Launch = { t: number; kind: string; cmd: string; args: string[] }
const launchesOf = (pid: number): Launch[] =>
  read(join(censusDir, `census-${pid}.jsonl`))
    .split('\n')
    .filter(Boolean)
    .flatMap(line => (JSON.parse(line) as { spawns: Launch[] }).spawns)
const flushedTo = (pid: number): number =>
  read(join(censusDir, `census-${pid}.jsonl`))
    .split('\n')
    .filter(Boolean)
    .reduce((latest, line) => Math.max(latest, (JSON.parse(line) as { t: number }).t), 0)
const ownStartReads = (pid: number): Launch[] => launchesOf(pid).filter(launch => launch.cmd === 'ps' && launch.args.includes('lstart=') && launch.args.includes(String(pid)))
const stampOf = (text: string, words: string): number => {
  const line = text.split('\n').find(row => row.includes(words))
  const stamp = line === undefined ? undefined : /^(\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(line)?.[1]
  return stamp === undefined ? 0 : Date.parse(stamp)
}

const log = join(scratch, 'daemon.log')
const daemon = spawn('node', [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    HOME: home,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
    MERCURY_DAEMON_OWNER_PID: String(owner.pid ?? 0),
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${(fixture.address() as { port: number }).port}`,
    OPENAI_API_KEY: '',
    MERCURY_CACHE_CLOCK: '0',
    MERCURY_PARTY: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    NODE_OPTIONS: `--require=${CENSUS}`,
    DAEMON_CENSUS_DIR: censusDir,
  },
  stdio: ['ignore', openSync(log, 'a'), openSync(log, 'a')],
})

console.log('============================================================')
console.log(' a claim on a standing warm runner waits for no read of the runner’s own start: the runner asked as it started')
console.log('============================================================')
try {
  check('the daemon came up and spawned its warm runner', await until(() => /warm runner pre-spawned: \S+ \(pid \d+\)/.test(read(log)), 90_000), read(log).slice(-400))
  const runnerPid = Number(/warm runner pre-spawned: \S+ \(pid (\d+)\)/.exec(read(log))?.[1] ?? 0)
  const spawnedAt = stampOf(read(log), 'warm runner pre-spawned')
  check('the warm runner booted and its first launches are on the census', await until(() => flushedTo(runnerPid) > spawnedAt, 60_000), `no census line for pid ${runnerPid}`)
  await sleep(1_500)
  const askedAt = Date.now()
  const born = (await daemonControlRpc({ op: 'sessionAdmit', workspaceDir: work, by: 'operator' } as never, { timeoutMs: 60_000 })) as { ok?: boolean; sessionId?: string; error?: string }
  check('a session was born on the standing warm runner', born.ok === true && /warm claim acked in \d+ms/.test(read(log)) && new RegExp(`concourse worker admitted: \\S+ \\(pid ${runnerPid}\\)`).test(read(log)), `${JSON.stringify(born)} | ${read(log).split('\n').slice(-4).join(' ¦ ')}`)
  const admittedAt = Date.now()
  await until(() => flushedTo(runnerPid) > admittedAt, 20_000)
  const reads = ownStartReads(runnerPid)
  const early = reads.filter(launch => launch.t < askedAt)
  const late = reads.filter(launch => launch.t >= askedAt)
  check('the runner asked for its own start token as it started, before any claim', early.length >= 1, `${early.length} read(s) before the claim, ${late.length} after it`)
  check('the claim launched no read of the runner’s own start', late.length === 0, `${late.length} read(s) launched after the claim was sent: ${late.map(launch => `${launch.kind} ${launch.cmd} ${launch.args.join(' ')} at +${launch.t - askedAt} ms`).join(' · ')}`)
} finally {
  try {
    owner.kill('SIGKILL')
  } catch {
    void 0
  }
  await until(() => daemon.exitCode !== null || daemon.signalCode !== null, 30_000)
  if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL')
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  if (failures === 0) rmSync(scratch, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${scratch}`)
}
console.log(failures === 0 ? '\nprove-claim-waits-for-no-start-read: all green' : `\nprove-claim-waits-for-no-start-read: ${failures} FAILURE(S)`)
clearTimeout(guard)
process.exit(failures === 0 ? 0 : 1)
