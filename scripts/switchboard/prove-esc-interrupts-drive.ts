#!/usr/bin/env bun
// ============================================================================
//  prove-esc-interrupts-drive — the trio's SIGNED line "esc interrupts it"
//  on the real product (the operator's word: their suspicion
//  that esc stopped interrupting a thinking model — adjudicated on the
//  built bundle, every seat kind and both sheet sizes):
//   A  a HOPPED managed session, THINKING phase (request open, zero deltas)
//      at 120x40 — esc ⇒ the turn interrupts, the screen says so
//      (⨯ Interrupted), the composer returns, the record settles;
//   B  the NEW SESSION born at the face's ↵ (bare boot → New Session →
//      words) mid-turn at 120x40 — the same law through the born seat (the
//      one-door law: ↵ births the session; no nascent seat exists);
//   C  a hopped session mid-REPLYING at 100x30 — the small sheet.
//  Poison = a dead esc: the turn still replying in every late frame.
// ============================================================================
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const DIST = join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const { runArtifactArena, grabScreens, firstOutputTs } = await import('../streaming/artifactArena.ts')
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
      /* not yet */
    }
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

// One hopped-seat leg: dispatch a session on `turnShape`, hop in, esc at
// +12 s, read the frames + the settled record.
const hoppedLeg = async (
  tag: string,
  cols: number,
  rows: number,
  turnShape: Record<string, unknown>,
): Promise<void> => {
  const SCRATCH = mkdtempSync(join(tmpdir(), `escpin-${tag}-`))
  const daemonDir = join(SCRATCH, 'daemon')
  const work = join(SCRATCH, 'work')
  for (const d of [daemonDir, work]) mkdirSync(d, { recursive: true })
  process.env.MERCURY_DAEMON_DIR = daemonDir
  delete process.env.MERCURY_HOME
  process.env.MERCURY_CONCOURSE = 'always'
  const api = await startFixtureApi([turnShape as never, { kind: 'text', text: 'Spare.' }])
  const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
  let daemon: ReturnType<typeof spawn> | null = null
  let sid = ''
  const run = await runArtifactArena({
    turns: [],
    sends: ['after:Alpha think:2500:\t', 'after:Alpha think:4000:\r', 'after:Alpha think:5200:\r', 'after:Alpha think:12000:\x1b'],
    seconds: 24,
    cols,
    rows,
    keep: true,
    seedHome: async (configDir, _cwd) => {
      seedFirstRun(configDir, [_cwd, work])
      process.env.MERCURY_CONFIG_DIR = configDir
      daemon = spawn('node', [DIST, 'daemon', 'run', work], {
        cwd: work,
        env: { ...process.env, MERCURY_CONFIG_DIR: configDir, MERCURY_DAEMON_DIR: daemonDir, ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: api.url, MERCURY_CACHE_CLOCK: '0', MERCURY_PARTY: '0' },
        stdio: ['ignore', logFd, logFd],
      })
      check(`${tag}: the daemon serves`, await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
      const a = (await daemonControlRpc({
        op: 'concourseDispatch',
        clientMessageId: `escpin-${tag}`,
        prompt: 'think for a long while',
        workspaceDir: _cwd,
        title: 'Alpha think',
        modelKey: 'claude-opus-5',
        effort: 'xhigh',
      } as never)) as { ok?: boolean; sessionId?: string }
      check(`${tag}: dispatched`, a.ok === true, JSON.stringify(a))
      sid = a.sessionId ?? ''
      const t = join(paths.getProjectDir(_cwd), `${sid}.jsonl`)
      check(`${tag}: transcript born`, await untilAsync(() => existsSync(t) && statSync(t).size > 100, 30_000))
    },
    extraEnv: { MERCURY_CONCOURSE: 'always', MERCURY_DAEMON_DIR: daemonDir, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'fixture-key-000', MERCURY_CACHE_CLOCK: '0' },
  })
  try {
    const grabs = grabScreens(run, cols, rows, [11000, 16000, 20000, 23000].map(m => S(m)))
    const text = (g: { rows: string[] }): string => g.rows.join('\n')
    const before = grabs.filter(g => g.atMs <= 11000)
    check(`${tag}: the turn was LIVE before esc (replying/thinking on screen)`, before.some(g => /replying — your words land|✶|thinking/.test(text(g))), before.map(g => String(g.atMs)).join(','))
    const late = grabs.filter(g => g.atMs >= 16000)
    check(`${tag}: esc INTERRUPTED — the screen says so (⨯ Interrupted)`, late.some(g => /Interrupted/.test(text(g))), late.map(g => String(g.atMs)).join(','))
    check(`${tag}: the composer returned (poison: still replying in every late frame)`, late.some(g => /Type a prompt/.test(text(g))) && !late.every(g => /replying — your words land/.test(text(g))))
    const recs = JSON.parse(readFileSync(join(daemonDir, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, { sessionId: string; lastDeliveryAt?: number; lastTurnSettledAt?: number }> }
    const rec = Object.values(recs.workers).find(w => w.sessionId === sid)
    check(`${tag}: the record settled (the daemon carried the interrupt)`, (rec?.lastTurnSettledAt ?? 0) >= (rec?.lastDeliveryAt ?? 1), JSON.stringify(rec ?? {}))
  } finally {
    run.cleanup()
  }
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
    /* down */
  }
  ;(daemon as ReturnType<typeof spawn> | null)?.kill('SIGTERM')
  await api.close()
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log('leg A — hopped seat, THINKING phase (no deltas yet), 120x40')
await hoppedLeg('A-thinking', 120, 40, { kind: 'paced', deltas: ['never-arrives '], gapMs: 500, startDelayMs: 60_000, whenModel: 'opus' })

console.log('leg C — hopped seat, mid-REPLYING, 100x30')
await hoppedLeg('C-small', 100, 30, { kind: 'paced', deltas: Array.from({ length: 80 }, (_, i) => `pondering ${String(i + 1).padStart(3, '0')} `), gapMs: 500, settleDelayMs: 2000, whenModel: 'opus' })

// ── leg B: the session born at the face's ↵ (bare boot → ↵ → words → esc mid-thinking) ──
console.log('leg B — the born session, mid-thinking, 120x40')
{
  const SCRATCH = mkdtempSync(join(tmpdir(), 'escpin-boot-'))
  const daemonDir = join(SCRATCH, 'daemon')
  mkdirSync(daemonDir, { recursive: true })
  process.env.MERCURY_DAEMON_DIR = daemonDir
  delete process.env.MERCURY_CONCOURSE
  const run = await runArtifactArena({
    turns: [
      { kind: 'paced', deltas: ['never-arrives '], gapMs: 500, startDelayMs: 60_000, whenModel: 'opus' },
      { kind: 'text', text: 'Spare.' },
    ],
    sends: ['after:Type a prompt:1200:think about the sea', 'after:Type a prompt:2400:\r', 'after:Type a prompt:8400:\x1b'],
    seconds: 20,
    cols: 120,
    rows: 40,
    keep: true,
    extraEnv: { MERCURY_DAEMON_DIR: daemonDir },
  })
  try {
    // The assert clock is the SEND LOG's actual fire times (the sends are
    // needle-anchored; a fixed-offset read adjudicates the wrong frames).
    const t0 = firstOutputTs(run)
    const escMs = run.sendLog
      .filter(s => Buffer.from(s.b64, 'base64').toString('latin1') === '\x1b')
      .map(s => s.sent - t0)
      .sort((a, b) => a - b)[0]
    check('B: the esc was sent', escMs !== undefined, JSON.stringify(run.sendLog.length))
    const grabs = grabScreens(run, 120, 40, [Math.max(0, (escMs ?? 8000) - 700), (escMs ?? 8000) + 2500, (escMs ?? 8000) + 5500])
    const text = (g: { rows: string[] }): string => g.rows.join('\n')
    check('B: the born session\'s turn was live before esc', /replying — your words land|thinking/.test(text(grabs[0]!)))
    const late = grabs.slice(1)
    check('B: esc interrupted the born session (⨯ Interrupted painted)', late.some(g => /Interrupted/.test(text(g))), late.map(g => String(g.atMs)).join(','))
    check('B: the composer returned', late.some(g => /Type a prompt/.test(text(g))))
  } finally {
    run.cleanup()
  }
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
    /* down */
  }
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-esc-interrupts-drive: ALL LAWS HOLD' : `\nprove-esc-interrupts-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
