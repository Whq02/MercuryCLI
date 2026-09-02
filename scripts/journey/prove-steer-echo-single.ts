#!/usr/bin/env bun
// ============================================================================
//  scripts/journey/prove-steer-echo-single.ts — LIVE-BUG item 4 (the driven
//  study's D2): submitting a prompt while a turn streamed painted the SAME
//  user line twice, stacked, identical timestamps
//  (mercury-journey-120.bin t≈10.9s).
//
//  Root cause (historical; the law OUTLIVES the mechanism — under the
//  steer-removal delivery law the echo is the connector's identity-keyed
//  row and this drive keeps pinning paint-exactly-once + continuity):
//  the queue-drain submit raised the echo placeholder
//  (processUserInput) while the turn-end reset had left the echo gate IDLE —
//  the phase whose unconditional eligibility exists for real slash commands,
//  which land no human turn. A drained slash-SHAPED prompt (an unregistered
//  /word riding to the model as text) lands a human turn, so echo AND
//  committed row painted together until the flag cleared. The fix routes
//  every raise through REPL's raiseInputEcho, which ARMS the gate at the
//  live transcript length — the committed row's landing then retires the
//  echo by the gate's own law.
//
//  The law, read off EVERY painted frame of a real PTY drive (VSHOT_TEE +
//  offline pyte step-replay):
//    S1  no frame ever paints the steered line twice
//    S2  the steered line does paint (echo continuity — the fix must not
//        trade the double for a vanishing line)
//
//  Run: bun scripts/journey/prove-steer-echo-single.ts
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = path.resolve(import.meta.dir, '../..')
const DIST = path.join(REPO, 'dist/mercury.mjs')
const VSHOT = path.join(REPO, 'scripts/ui/vshot.py')
const BUN = process.env.BUN ?? path.join(process.env.HOME ?? '', '.bun/bin/bun')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

if (!existsSync(DIST)) {
  console.log('FAIL dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-steerecho-${process.pid}`)
const FIXTURE_CWD = path.join(RUN_HOME, 'work')
const PROBE_KEY = 'sk-ant-steerecho-probe-key'
rmSync(RUN_HOME, { recursive: true, force: true })
mkdirSync(FIXTURE_CWD, { recursive: true })
writeFileSync(
  path.join(RUN_HOME, '.mercury.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    numStartups: 10,
    theme: 'dark',
    projects: { [FIXTURE_CWD]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
  }),
)
writeFileSync(path.join(RUN_HOME, 'settings.json'), JSON.stringify({}))

// ── the fixture (its own process; the study's no-ping stream is ideal here:
//    a long deterministic paced document to steer INTO) ─────────────────────
const fixture = spawn(BUN, ['run', path.join(import.meta.dir, 'noping-fixture-server.ts')], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, FIXTURE_PORT: '0', FIXTURE_TPS: '40', FIXTURE_TTFB_MS: '350' },
})
const port = await new Promise<number>((resolve, reject) => {
  const killer = setTimeout(() => reject(new Error('fixture never printed PORT')), 15_000)
  let buffer = ''
  fixture.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const m = /PORT (\d+)/.exec(buffer)
    if (m) {
      clearTimeout(killer)
      resolve(Number(m[1]))
    }
  })
  fixture.on('exit', code => reject(new Error(`fixture exited early (${code})`)))
}).catch(err => {
  console.log(`FAIL ${String(err)}`)
  process.exit(1)
})
const base = `http://127.0.0.1:${port}`

const reap = (): void => {
  try {
    fixture.kill('SIGTERM')
  } catch {
    /* gone */
  }
  if (failures === 0) {
    try {
      rmSync(RUN_HOME, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  } else {
    console.log(`[forensics] world kept: ${RUN_HOME}`)
  }
}
process.on('exit', reap)

console.log('============================================================')
console.log(' steer echo — one painted line per frame, on trial')
console.log('============================================================')

// The steered text is the OPERATOR'S OWN live shape: slash-formed but not a
// registered command, so it rides to the model as prose (the class that
// exposed the idle-gate hole; a plain-word steer exercises the same law).
const STEER = '/acc/sessions'
const out = path.join(RUN_HOME, 'grid.json')
const tee = path.join(RUN_HOME, 'frames.tee')
const cfg = {
  argv: ['node', DIST],
  cwd: FIXTURE_CWD,
  sends: [
    // THE LANDING RULE: a bare boot lands on the Boot face — ↵ on New Session enters the chat first.
    { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, minTick: 10, awaitText: '? for shortcuts', data: 'explain the plan\r' },
    // Mid-stream: the doc's opening paints within ~a second of the request;
    // this send lands while deltas still flow (the steer window).
    { requireAwait: true, minTick: 5, awaitText: 'tokenizer currently allocates', data: `${STEER}\r` },
  ],
  readyText: ['re-arm it instantly'],
  stableTicks: 6,
  total: 250,
  cols: 120,
  rows: 36,
  out,
}
const cfgPath = path.join(RUN_HOME, 'cfg.json')
writeFileSync(cfgPath, JSON.stringify(cfg))

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  VSHOT_TEE: tee,
  MERCURY_OPERATOR: 'sam',
  MERCURY_CONFIG_DIR: RUN_HOME,
  ANTHROPIC_API_KEY: PROBE_KEY,
  ANTHROPIC_BASE_URL: base,
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_DECK_COMPANION: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_VERIFY_EVIDENCE: '0',
  MERCURY_DOCTOR_STATE_DIR: path.join(RUN_HOME, 'doctor-state'),
  MERCURY_DAEMON_DIR: path.join(RUN_HOME, 'daemon'),
  MERCURY_TEAMS_DIR: path.join(RUN_HOME, 'teams'),
  MERCURY_TABULA_DIR: path.join(RUN_HOME, 'tabula'),
  MERCURY_TABULA_MINERVA: '0',
  MERCURY_HOME: path.join(RUN_HOME, 'proof-home'),
}
delete childEnv.NODE_ENV
delete childEnv.ANTHROPIC_AUTH_TOKEN

const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
  encoding: 'utf-8',
  timeout: vshotBudgetMs(150_000),
  cwd: FIXTURE_CWD,
  env: childEnv,
})

// ── the frame census: step the tee through pyte, count the line per frame ──
// The tee is length-prefixed `>II` (tick, len) raw PTY reads; feeding them
// in order reproduces every painted frame. The census asks one question per
// frame: how many rendered rows carry the steered text.
// Counted rows are the NAMEPLATED user-line grammar ('[sam] ❯ <text>'), so
// the composer's own typed text never counts. Frames where the queued strip
// is on screen ('⤳ steering' marker, or its second hint line) are excluded:
// the strip legitimately paints its one nameplated preview at the enqueue
// instant. Reads coalesce PER 0.2s TICK and a failure needs the double on
// TWO consecutive ticks — a single logical repaint can tear across two PTY
// reads (stale strip rows beside the fresh committed row for one byte
// window), while the defect held its stacked pair for whole seconds.
const CENSUS = `
import struct, sys
import pyte
screen = pyte.Screen(120, 36)
stream = pyte.ByteStream(screen)
needle = '[sam] \\u276f ' + ${JSON.stringify(STEER)}
strip_markers = ['\\u2933 steering', 'tab holds the next one', 'waits for the next turn', 'folds in at the next step', 'Tab queues for after it', 'holds for the next turn']
seen = 0
run = 0
worst_run = 0
pen_frames = 0
def census():
    rows = screen.display
    count = sum(1 for row in rows if needle in row)
    strip_up = any(m in row for row in rows for m in strip_markers)
    return count, strip_up
with open(${JSON.stringify(tee)}, 'rb') as f:
    cur_tick = None
    while True:
        hdr = f.read(8)
        if len(hdr) < 8:
            break
        tick, n = struct.unpack('>II', hdr)
        data = f.read(n)
        if cur_tick is not None and tick != cur_tick:
            count, strip_up = census()
            if count > 0:
                seen += 1
            if strip_up:
                pen_frames += 1
            run = run + 1 if (count >= 2 and not strip_up) else 0
            worst_run = max(worst_run, run)
        cur_tick = tick
        stream.feed(data)
    count, strip_up = census()
    if count > 0:
        seen += 1
    if strip_up:
        pen_frames += 1
    run = run + 1 if (count >= 2 and not strip_up) else 0
    worst_run = max(worst_run, run)
print(f'WORSTRUN {worst_run} SEEN {seen} PEN {pen_frames}')
`
const census = spawnSync('/usr/bin/python3', ['-c', CENSUS], { encoding: 'utf-8', timeout: vshotBudgetMs(120_000) })
const m = /WORSTRUN (\d+) SEEN (\d+) PEN (\d+)/.exec(census.stdout ?? '')
const worstDoubleRun = m ? Number(m[1]) : -1
const framesWithLine = m ? Number(m[2]) : -1
const penFrames = m ? Number(m[3]) : -1

let gridText = ''
if (existsSync(out)) {
  const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>> }
  gridText = payload.grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')
}

check(
  'S1 the steered line never paints twice across consecutive ticks (no steady double)',
  worstDoubleRun >= 0 && worstDoubleRun <= 1,
  `doubled-tick run=${worstDoubleRun} vshot status=${res.status} census='${(census.stdout ?? census.stderr ?? '').trim()}'`,
)
check(
  'S2 the steered line painted (echo continuity — no vanishing line)',
  framesWithLine > 0,
  `frames with the line=${framesWithLine}`,
)
check('S3 the drive completed (both turns settled to the final text)', gridText.includes('re-arm it instantly'), gridText.split('\n').slice(-10).join('\n'))

// S4 — THE PEN IS DEAD ON THE DRIVEN ROAD (steer-removal): the census
// markers that once EXCUSED strip frames are now POISON — no frame of a
// live mid-turn send may carry the strip's steering/queued vocabulary.
check('S4 no frame ever paints the pen vocabulary (steering strip / hold copy — poison)', penFrames === 0, `pen frames=${penFrames}`)

// S5 — the transcript store carries the mid-turn message EXACTLY ONCE (the
// delivery law's durable half: one submit, one input row, never a journal
// double or a re-drained second row).
{
  const { readdirSync } = await import('node:fs')
  const projectsDir = path.join(RUN_HOME, 'projects')
  let inputRows = 0
  let files = 0
  try {
    for (const proj of readdirSync(projectsDir)) {
      const dir = path.join(projectsDir, proj)
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue
        files++
        for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n')) {
          if (!line.includes(STEER)) continue
          try {
            const rec = JSON.parse(line) as { payload?: { kind?: string; content?: unknown } }
            const kind = rec.payload?.kind
            const content = JSON.stringify(rec.payload?.content ?? '')
            if ((kind === 'input' || kind === 'attachment') && content.includes(STEER)) inputRows++
          } catch {
            /* non-record line */
          }
        }
      }
    }
  } catch {
    /* no projects dir — the check below reds on files=0 */
  }
  check('S5 the transcript store carries the mid-turn message exactly once', files > 0 && inputRows === 1, `files=${files} rows=${inputRows}`)
}

console.log(failures === 0 ? '\nprove-steer-echo-single: ALL LAWS HOLD' : `\nprove-steer-echo-single: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
