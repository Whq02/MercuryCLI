#!/usr/bin/env bun
// ============================================================================
//  scripts/journey/prove-noping-stream-completes.ts — LIVE-BUG item 3 (the
//  driven study's D3): against a minimal Anthropic-dialect endpoint that
//  sends NO ping events and sparse usage, Mercury twice stalled
//  mid-final-paragraph and never painted completion. Sloppy third-party
//  "Anthropic-compatible" endpoints ship exactly such gaps, so the consumer
//  must finish on the documented event grammar alone.
//
//  The law: the WHOLE document paints and the composer returns to idle —
//  driven on dist/mercury.mjs through a real PTY (vshot), the fixture in its
//  OWN process (the sandbox blocks in-prover loopbacks from PTY children).
//
//    N1  the final paragraph's closing line is on screen (the stream was
//        consumed to its end — no mid-paragraph freeze)
//    N2  the turn settled (no wedged 'esc to interrupt' lift; the composer
//        hint is back)
//
//  Run: bun scripts/journey/prove-noping-stream-completes.ts
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

const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-noping-${process.pid}`)
const FIXTURE_CWD = path.join(RUN_HOME, 'work')
const PROBE_KEY = 'sk-ant-noping-probe-key'
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

// ── the fixture (its own process; ephemeral port) ───────────────────────────
const captureFile = path.join(RUN_HOME, 'wire.jsonl')
writeFileSync(captureFile, '')
const fixture = spawn(BUN, ['run', path.join(import.meta.dir, 'noping-fixture-server.ts'), captureFile], {
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
console.log(' no-ping anthropic-dialect stream — completion on trial')
console.log('============================================================')

// The doc streams ~9s at 40tps; the budget is generous because the LAW is
// completion, not latency. The final line is the ready gate; a stall parks
// the run at `total` and the checks below speak.
const out = path.join(RUN_HOME, 'grid.json')
const cfg = {
  argv: ['node', DIST],
  cwd: FIXTURE_CWD,
  sends: [
    // THE LANDING RULE: a bare boot lands on the Boot face — ↵ on New Session enters the chat first.
    { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, minTick: 10, awaitText: '? for shortcuts', data: 'stream the plan\r' },
  ],
  readyText: ['re-arm it instantly'],
  stableTicks: 6,
  total: 300,
  cols: 120,
  rows: 36,
  out,
}
const cfgPath = path.join(RUN_HOME, 'cfg.json')
writeFileSync(cfgPath, JSON.stringify(cfg))

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
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
let gridText = ''
if (existsSync(out)) {
  const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>> }
  gridText = payload.grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')
}

check(
  'N1 the final paragraph painted to its last line (no mid-paragraph freeze)',
  gridText.includes('re-arm it instantly'),
  `vshot status=${res.status}\n${gridText.split('\n').slice(-14).join('\n')}`,
)
check(
  'N2 the turn settled — no wedged interrupt lift',
  !/esc to interrupt|esc interrupt/i.test(gridText),
  gridText.split('\n').slice(-6).join('\n'),
)

console.log(failures === 0 ? '\nprove-noping-stream-completes: ALL LAWS HOLD' : `\nprove-noping-stream-completes: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
