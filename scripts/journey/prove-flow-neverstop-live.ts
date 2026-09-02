#!/usr/bin/env bun
// ============================================================================
//  scripts/journey/prove-flow-neverstop-live.ts — the operator's flow-mode
//  stall repro driven end-to-end on the REAL binary: a GPT flow session
//  whose scripted backend calls GROUPED reads, then a REPEAT read (the
//  dedup front-door), then finishes — the incident's exact tool shapes,
//  with the never-stop promise on trial at every layer.
//
//  The incident: in flow mode the GPT agent
//  "calls a few tools and then just STOPS, mid-task, repeatedly"; the
//  model's own account blamed grouped reads failing and a repeat read
//  "rejected as a duplicate" whose output never reached it. The engine
//  fixtures pin the continuation laws (prove-flow-dead-turn) and the
//  delivery-truthful dedup (prove-read-dedup-delivery); this journey proves
//  the whole product — REPL, flow permission posture, GPT lane, tool
//  orchestration — never stops across those shapes on dist/mercury.mjs.
//
//    F1  the grouped Read round executes and BOTH results ride back on the
//        next wire call (per-member settlement, no unit death)
//    F2  the repeat Read answers the file-unchanged stub and THE STUB ITSELF
//        is delivered on the following call (dedup delivery on the wire)
//    F3  the run continues to the final text — three model calls, one turn,
//        no silent stop; the reply paints and the composer returns to idle
//
//  Run: ~/.bun/bin/bun run scripts/journey/prove-flow-neverstop-live.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

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
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

if (!existsSync(DIST)) {
  console.log('FAIL dist/mercury.mjs missing — run `bun run build.ts` first (the drive proves the BUILT binary)')
  process.exit(1)
}

// Contract data shared with flow-fixture-server.ts.
const FINAL_TEXT = 'flow finished: both files read, repeat served from context'

// ── the hermetic world ──────────────────────────────────────────────────────
const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-flowlive-${process.pid}`)
const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
const PROBE_KEY = 'sk-ant-flowlive-probe-key'
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
writeFileSync(path.join(FIXTURE_CWD, 'README.md'), 'readme body: the flow drive reads this file twice\n')
writeFileSync(path.join(FIXTURE_CWD, 'NOTES.md'), 'notes body: the grouped sibling\n')

// ── the fixture server (its own process) ────────────────────────────────────
const captureFile = path.join(RUN_HOME, 'wire-captures.jsonl')
writeFileSync(captureFile, '')
const fixture = spawn(
  BUN,
  ['run', path.join(import.meta.dir, 'flow-fixture-server.ts'), captureFile, FIXTURE_CWD],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)
const port = await new Promise<number>((resolve, reject) => {
  const killer = setTimeout(() => reject(new Error('fixture server never printed PORT')), 15_000)
  let buffer = ''
  fixture.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const m = /PORT (\d+)/.exec(buffer)
    if (m) {
      clearTimeout(killer)
      resolve(Number(m[1]))
    }
  })
  fixture.on('exit', code => reject(new Error(`fixture server exited early (${code})`)))
}).catch(err => {
  console.log(`FAIL ${String(err)}`)
  process.exit(1)
})
const base = `http://127.0.0.1:${port}`

const reap = (): void => {
  try {
    fixture.kill('SIGTERM')
  } catch {
    /* already gone */
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
console.log(' flow never-stop LIVE — grouped reads · dedup repeat · finish')
console.log('============================================================')

// ── the PTY drive ───────────────────────────────────────────────────────────
const out = path.join(RUN_HOME, 'grid-flow.json')
const cfg = {
  argv: ['node', DIST, '--model', 'gpt-5.6-sol', '--permission-mode', 'flow'],
  cwd: FIXTURE_CWD,
  sends: [
    // --permission-mode flow boots into the flow-default NOTICE panel in
    // place of the composer (live-found) — dismiss it first.
    { requireAwait: true, minTick: 10, awaitText: 'Flow is the default permission mode', data: '\r' },
    // The idle-composer hint is the true ready signal (see the switch
    // journey's live-found gating note). requireAwait: a deadline-fired
    // send on a slow loaded boot typed into a not-ready surface and was
    // eaten (live-found) — never-ready is a loud exit 4, not a wrong-frame.
    // THE LANDING RULE: a bare boot lands on the Boot face — ↵ on New Session enters the chat first.
    { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, minTick: 10, awaitText: '? for shortcuts', data: 'read both docs then summarize\r' },
  ],
  readyText: [FINAL_TEXT],
  stableTicks: 4,
  total: 400,
  cols: 110,
  rows: 34,
  out,
}
const cfgPath = path.join(RUN_HOME, 'cfg-flow.json')
writeFileSync(cfgPath, JSON.stringify(cfg))

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: RUN_HOME,
  ANTHROPIC_API_KEY: PROBE_KEY,
  ANTHROPIC_BASE_URL: base,
  OPENAI_API_KEY: 'sk-test-flowlive-openai',
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
  timeout: vshotBudgetMs(180_000),
  cwd: FIXTURE_CWD,
  env: childEnv,
})
let gridText = ''
if (existsSync(out)) {
  const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>> }
  gridText = payload.grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')
}
type Capture = { kind: string; n?: number; body?: Record<string, unknown>; at: number }
const wire: Capture[] = readFileSync(captureFile, 'utf8')
  .split('\n')
  .filter(l => l.trim() !== '')
  .map(l => JSON.parse(l) as Capture)
const gpt = wire.filter(c => c.kind === 'openai').sort((a, b) => (a.n ?? 0) - (b.n ?? 0))
const bodyOf = (c: Capture | undefined): string => JSON.stringify(c?.body ?? {})

section('F1 — the grouped Read round settles per member and rides back')
{
  check('three GPT calls made — the run NEVER stopped early', gpt.length >= 3, `openai calls=${gpt.length} vshot status=${res.status}`)
  const second = bodyOf(gpt[1])
  check(
    "BOTH grouped results ride call 2 (call_id-paired function_call_outputs)",
    second.includes('call_read_a') && second.includes('call_read_b'),
    second.slice(0, 300),
  )
  check(
    'the grouped results carry the real file bodies',
    second.includes('the flow drive reads this file twice') && second.includes('the grouped sibling'),
  )
}

section('F2 — the repeat Read answers the stub and the stub is DELIVERED')
{
  const third = bodyOf(gpt[2])
  check("the repeat's result rides call 3", third.includes('call_read_repeat'), third.slice(0, 200))
  check(
    'the repeat answered the file-unchanged stub (the dedup front-door, delivered on the wire)',
    third.includes('unchanged since it was last read'),
  )
}

section('F3 — the run finishes: the reply paints, the composer idles')
{
  check('the final text painted (never-stop held on the real binary)', gridText.includes(FINAL_TEXT), gridText.split('\n').slice(-12).join('\n'))
  check('the composer returned to idle (no wedged turn)', gridText.includes('? for shortcuts') || !gridText.includes('esc interrupt'))
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
