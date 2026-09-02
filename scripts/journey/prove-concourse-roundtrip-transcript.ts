#!/usr/bin/env bun
// ============================================================================
//  scripts/journey/prove-concourse-roundtrip-transcript.ts — LIVE-BUG items
//  1 + 2, the operator's worst live find driven whole on dist:
//
//  A queued cross-provider /model switch (default → gpt-5.6-sol) settles on
//  a turn; the NEXT turn's reply streams on the OpenAI lane and paints;
//  the operator enters the concourse and returns — and on the deployed
//  build the reply row was GONE from the repaint, the ctx meter reset, and
//  the board's live viewer painted no REPL transcript at all.
//
//    R1  the newest assistant reply SURVIVES the concourse round trip
//        (the exact operator journey: turn → /concourse → esc → the row
//        still painted)
//    R2  the ctx meter does not reset to '—' across the round trip
//    R3  the board's live viewer paints the MAIN REPL session's transcript
//        (a tee frame shows the concourse chrome AND the reply text — the
//        managed main-REPL row's mirror is not blank)
//    R4  the reply is PERSISTED — the session log on disk carries the
//        reply text (re-hydration can never drop what disk holds)
//
//  Fixture-hermetic; both dialects served by roundtrip-fixture-server.ts in
//  its own process; every endpoint base pinned.
//
//  Run: bun scripts/journey/prove-concourse-roundtrip-transcript.ts
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-roundtrip-${process.pid}`)
const WORK = path.join(RUN_HOME, 'work')
const PROBE_KEY = 'sk-ant-roundtrip-probe-key'
rmSync(RUN_HOME, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
writeFileSync(
  path.join(RUN_HOME, '.mercury.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    numStartups: 10,
    theme: 'dark',
    projects: { [WORK]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
    // The fixture's consented reading (a declined record reads the live machine).
    switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 5 },
  }),
)
writeFileSync(path.join(RUN_HOME, 'settings.json'), JSON.stringify({}))

// ── the fixture (its own process) ───────────────────────────────────────────
const captureFile = path.join(RUN_HOME, 'wire.jsonl')
writeFileSync(captureFile, '')
const fixture = spawn(BUN, ['run', path.join(import.meta.dir, 'roundtrip-fixture-server.ts'), captureFile], {
  stdio: ['ignore', 'pipe', 'pipe'],
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
console.log(' concourse round trip — the newest reply row on trial')
console.log('============================================================')

const ALPHA_TAIL = 'ALPHA-TAIL-DONE'
const TERRA = 'SIGMA-TERRA-9'
const out = path.join(RUN_HOME, 'grid.json')
const tee = path.join(RUN_HOME, 'frames.tee')
const cfg = {
  argv: ['node', DIST],
  cwd: WORK,
  sends: [
    // THE LANDING RULE: a bare boot lands on the Boot face — ↵ on New Session enters the chat first.
    { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, minTick: 10, awaitText: '? for shortcuts', data: 'run the alpha turn\r' },
    // Mid-alpha (the paced stream holds the window open ~5s): the queued
    // cross-provider switch — the operator's exact gesture.
    { requireAwait: true, minTick: 5, awaitText: 'SIGMA-ALPHA-7', data: '/model gpt-5.6-sol\r' },
    // The boundary applies the switch; the terra turn rides the OpenAI lane.
    { requireAwait: true, minTick: 10, awaitText: ALPHA_TAIL, data: 'run the terra turn\r' },
    // The reply painted — enter the concourse…
    { requireAwait: true, minTick: 10, awaitText: TERRA, awaitSettleTicks: 5, data: '/concourse\r' },
    // …let the board settle (the mirror follows the selected main-REPL
    // row), then esc back to the REPL.
    { requireAwait: true, awaitText: 'SESSION CONCOURSE', awaitSettleTicks: 30, data: '\x1b' },
  ],
  readyText: ['? for shortcuts'],
  stableTicks: 6,
  total: 400,
  cols: 140,
  rows: 40,
  out,
}
const cfgPath = path.join(RUN_HOME, 'cfg.json')
writeFileSync(cfgPath, JSON.stringify(cfg))

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  VSHOT_TEE: tee,
  MERCURY_CONFIG_DIR: RUN_HOME,
  ANTHROPIC_API_KEY: PROBE_KEY,
  ANTHROPIC_BASE_URL: base,
  OPENAI_API_KEY: 'sk-test-roundtrip-openai',
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
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
  timeout: vshotBudgetMs(240_000),
  cwd: WORK,
  env: childEnv,
})
let gridText = ''
if (existsSync(out)) {
  const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>> }
  gridText = payload.grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')
}

// ── R3's frame census: a settled board frame carrying the reply text ───────
const CENSUS = `
import struct
import pyte
screen = pyte.Screen(140, 40)
stream = pyte.ByteStream(screen)
board_with_reply = 0
board_frames = 0
with open(${JSON.stringify(tee)}, 'rb') as f:
    cur = None
    def census():
        global board_with_reply, board_frames
        rows = screen.display
        board = any('SESSION CONCOURSE' in r for r in rows)
        if board:
            board_frames += 1
            if any(${JSON.stringify(TERRA)} in r for r in rows):
                board_with_reply += 1
    while True:
        hdr = f.read(8)
        if len(hdr) < 8:
            break
        tick, n = struct.unpack('>II', hdr)
        data = f.read(n)
        if cur is not None and tick != cur:
            census()
        cur = tick
        stream.feed(data)
    census()
print(f'BOARD {board_frames} WITHREPLY {board_with_reply}')
`
const census = spawnSync('/usr/bin/python3', ['-c', CENSUS], { encoding: 'utf-8', timeout: vshotBudgetMs(120_000) })
const m = /BOARD (\d+) WITHREPLY (\d+)/.exec(census.stdout ?? '')
const boardFrames = m ? Number(m[1]) : -1
const boardWithReply = m ? Number(m[2]) : -1

// R0 — the WIRE truth beneath every paint row: the fixture records every
// request it serves (wire.jsonl). After the boundary applies the queued
// cross-provider switch, the terra turn must reach the OpenAI lane
// (POST /responses) and must not ride the previous provider again — a
// reply painted from the wrong lane makes R1/R3/R4 read as paint faults
// when the dispatch itself never moved with the switch.
{
  type WireRow = { kind: string; model?: string; at: number }
  const wire: WireRow[] = existsSync(captureFile)
    ? readFileSync(captureFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l) as WireRow)
    : []
  const openaiTurns = wire.filter(r => r.kind === 'openai')
  const anthropicMainTurns = wire.filter(r => r.kind === 'anthropic' && !String(r.model ?? '').includes('haiku'))
  check(
    'R0 the terra turn reached the OpenAI lane (the fixture served POST /responses once)',
    openaiTurns.length === 1,
    `wire: ${wire.map(r => `${r.kind}${r.model ? `:${r.model}` : ''}`).join(' · ') || '(no wire log)'}`,
  )
  check(
    'R0 the previous provider served ONE main turn (alpha) — the switched turn never rode it',
    anthropicMainTurns.length === 1,
    `anthropic main-model requests: ${anthropicMainTurns.length}`,
  )
}
check(
  'R1 the newest assistant reply survived the round trip (painted after esc)',
  gridText.includes(TERRA),
  `vshot status=${res.status}\n${gridText.split('\n').slice(-16).join('\n')}`,
)
check('R2 the ctx meter did not reset to em-dash', !/ctx — /.test(gridText), gridText.split('\n').filter(l => l.includes('ctx')).join('\n'))
check(
  "R3 the board's live viewer painted the main REPL transcript (no blank mirror)",
  boardFrames > 0 && boardWithReply > 0,
  `board frames=${boardFrames} with reply=${boardWithReply} census='${(census.stdout ?? census.stderr ?? '').trim()}'`,
)

// ── R4 the reply persisted in the session log ──────────────────────────────
{
  const projectsDir = path.join(RUN_HOME, 'projects')
  let hit = false
  let scanned = 0
  if (existsSync(projectsDir)) {
    for (const dir of readdirSync(projectsDir)) {
      const full = path.join(projectsDir, dir)
      for (const file of readdirSync(full)) {
        if (!file.endsWith('.jsonl')) continue
        scanned++
        if (readFileSync(path.join(full, file), 'utf8').includes(TERRA)) hit = true
      }
    }
  }
  check('R4 the reply text is in the persisted session log', hit, `${scanned} transcript file(s) scanned under ${projectsDir}`)
}

console.log(failures === 0 ? '\nprove-concourse-roundtrip-transcript: ALL LAWS HOLD' : `\nprove-concourse-roundtrip-transcript: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
