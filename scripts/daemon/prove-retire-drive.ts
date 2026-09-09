#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const KEEP = process.env.RETIRE_KEEP === '1'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
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

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'retire-drive-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CREW_DIR
const git = (args: string[]): void => {
  const r = spawnSync('git', ['-C', work, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}
git(['init', '-q'])
writeFileSync(join(work, 'README.md'), 'the retire probe repository\n')
git(['add', 'README.md'])
git(['commit', '-q', '-m', 'the probe commit'])
seedFirstRun(home, [work])

const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const hits: Array<{ n: number; body: string }> = []
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
    const n = hits.length + 1
    hits.push({ n, body })
    const text = body.includes('retire-probe-second') ? 'retire-probe: second answer' : 'retire-probe: first answer'
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.end(
      [
        `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_rt_${n}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
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

const logPath = join(SCRATCH, 'daemon.log')
const logFd = openSync(logPath, 'a')
const daemon = spawn('node', [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
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
  },
  stdio: ['ignore', logFd, logFd],
})
let daemonExited = false
daemon.once('exit', () => { daemonExited = true })

type Rec = { runnerId: string; sessionId: string; pid?: number; parkedAt?: number; parkedBy?: string; parkIntent?: unknown; parkRefused?: { reason: string }; endedAt?: number; stoppedAt?: number }
const records = (): Rec[] => {
  try {
    return Object.values((JSON.parse(readFileSync(join(daemonDir, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, Rec> }).workers)
  } catch {
    return []
  }
}
const recOf = (sid: string): Rec | undefined => records().find(w => w.sessionId === sid)
const readFacts = (sid: string): { busy?: boolean } | undefined => {
  try {
    return JSON.parse(readFileSync(join(daemonDir, 'session-facts', `${sid}.json`), 'utf8')) as { busy?: boolean }
  } catch {
    return undefined
  }
}
const transcriptOf = (sid: string): string => {
  const p = join(paths.getProjectDir(work), `${sid}.jsonl`)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}
const ledger = (): Array<{ event?: string; kind: string; id: string; reason?: string; outcome?: string }> => {
  const p = join(daemonDir, 'spawn-ledger.jsonl')
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : []
}
const pidAlive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const cleanup = async (): Promise<void> => {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {}
  await untilAsync(() => daemonExited, 10_000)
  try {
    daemon.kill('SIGTERM')
  } catch {}
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  if (failures === 0 && !KEEP) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

console.log('retire drive — a park on the real daemon runs prepare, commit and the observed exit before the record says parked')
try {
  check('R1 the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
  const reply = (await daemonControlRpc({
    op: 'concourseDispatch',
    clientMessageId: 'retire-1',
    prompt: 'retire-probe-first: answer once',
    workspaceDir: work,
    title: 'Retire probe',
    model: 'claude-sonnet-5',
    effort: 'high',
  } as never)) as { ok?: boolean; sessionId?: string }
  check('R1 a session dispatched through the door', reply.ok === true && typeof reply.sessionId === 'string', JSON.stringify(reply))
  const sid = reply.sessionId ?? ''
  check('R1 the turn completed and the seat went idle', await untilAsync(() => transcriptOf(sid).includes('retire-probe: first answer') && readFacts(sid)?.busy === false, 60_000), transcriptOf(sid).slice(-300))
  const before = recOf(sid)
  const pidBefore = before?.pid
  check('R1 the record is live with a runner pid and no park stamp', before !== undefined && pidAlive(pidBefore) && before.parkedAt === undefined, JSON.stringify(before))
  const transcriptBytesBefore = transcriptOf(sid).length

  const parkStarted = Date.now()
  const parkPromise = daemonControlRpc({ op: 'sessionControl', action: 'park', sessionId: sid, by: 'operator:retire-drive' } as never, { timeoutMs: 30_000 }) as Promise<{ ok?: boolean; outcome?: string; detail?: string }>
  const intentSeen = await untilAsync(() => recOf(sid)?.parkIntent !== undefined, 10_000, 20)
  const heldReply = intentSeen
    ? ((await daemonControlRpc({ op: 'concourseDispatch', clientMessageId: 'retire-2', prompt: 'retire-probe-second: answer again', workspaceDir: work, targetSessionId: sid } as never)) as { ok?: boolean; heldReason?: string; error?: string; state?: string })
    : undefined
  const park = await parkPromise
  check('R2 the park verb answered applied for the runner', park.ok === true && park.outcome === 'applied' && /parked/.test(park.detail ?? ''), JSON.stringify(park))
  const after = recOf(sid)
  check('R2 the durable park intent was on the record while the park was in flight', intentSeen, JSON.stringify(after))
  check('R3 a delivery during the retirement was HELD typed (session-retiring), never delivered and never failed', heldReply !== undefined && heldReply.ok === false && heldReply.heldReason === 'session-retiring' && heldReply.state !== 'failed', JSON.stringify(heldReply))
  check('R4 parked landed on the record with the intent cleared and no refusal', after?.parkedAt !== undefined && after.parkedBy === 'operator:retire-drive' && after.parkIntent === undefined && after.parkRefused === undefined && after.endedAt === undefined && after.stoppedAt === undefined, JSON.stringify(after))
  check('R4 the runner had exited before parked was written', after?.parkedAt !== undefined && !pidAlive(pidBefore) && after.parkedAt >= parkStarted, `pid ${pidBefore} alive=${pidAlive(pidBefore)}`)
  const runnerRowId = `${before?.runnerId ?? '?'}@concourse`
  const exitRowsOf = () => ledger().filter(r => r.event === 'exit' && r.kind === 'long-lived' && r.id === runnerRowId)
  check("R4 the runner's one exit row reads killed (an intentional stop the supervisor never respawned), and no reap row exists for it", await untilAsync(() => exitRowsOf().length >= 1, 5_000) && exitRowsOf().length === 1 && exitRowsOf()[0]?.outcome === 'killed' && !ledger().some(r => r.event === 'reap' && r.id === before?.runnerId), JSON.stringify(exitRowsOf().length > 0 ? exitRowsOf() : ledger().slice(-4)))
  check('R4 the supervisor did not respawn the retired runner (one birth row for it)', ledger().filter(r => r.event === undefined && r.kind === 'long-lived' && r.id === runnerRowId).length === 1, JSON.stringify(ledger().filter(r => r.id === runnerRowId)))
  check('R4 the transcript on disk is intact (no bytes lost to the exit)', transcriptOf(sid).length >= transcriptBytesBefore && transcriptOf(sid).includes('retire-probe: first answer'))
  check('R5 the second message never reached the model while the session parked', !hits.some(h => h.body.includes('retire-probe-second')), `hits ${hits.length}`)
  const again = (await daemonControlRpc({ op: 'sessionControl', action: 'park', sessionId: sid, by: 'operator:retire-drive' } as never)) as { ok?: boolean; outcome?: string; detail?: string }
  check('R6 a second park on the parked record is a noop', again.ok === true && again.outcome === 'noop', JSON.stringify(again))
  if (failures > 0 || KEEP) console.log(`  daemon log tail: ${readFileSync(logPath, 'utf8').slice(-1500)}`)
} catch (err) {
  failures++
  console.log(`  [FAIL] the drive threw: ${String(err)}`)
  if (existsSync(logPath)) console.log(`  daemon log tail: ${readFileSync(logPath, 'utf8').slice(-1500)}`)
} finally {
  await cleanup()
}

console.log(failures === 0 ? '\n RETIRE DRIVE — prepare, commit, observed exit, then parked; a delivery in between was held typed' : `\n ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
