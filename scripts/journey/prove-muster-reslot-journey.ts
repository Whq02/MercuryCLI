#!/usr/bin/env bun
// ============================================================================
//  scripts/journey/prove-muster-reslot-journey.ts — the ONE PTY journey:
//  engage → reslot at idle → receipt → the next dispatch carries the new model
//  (fixture-observed; ZERO paid calls — no prompt is ever sent).
//
//  The REAL dist binary boots a scribe-engaged session (MERCURY_SCRIBE=1)
//  against an ISOLATED config home + a FIXTURE control daemon
//  (muster-fixture-daemon.ts) that speaks the real newline-framed protocol.
//  The operator types `/model implementer sonnet5`:
//    1. the ACK row renders ("respawning now · slot saved") — the request;
//    2. the RECEIPT row renders ("⇄ reslot applied — implementer →
//       claude-sonnet-5") — minted only after the receipt engine OBSERVES the
//       fixture roster's RUNNING model flip (the wait-doctrine's honest apply);
//    3. the fixture's request log carries the reconfigure with the RESOLVED
//       model (the wire truth every real dispatch respawn rides — the same
//       validated ll.spec chain prove-reconfigure pins daemon-side);
//    4. seat-slots.json in the isolated home holds the persisted slot (the
//       env-var-and-re-engage path is not the only way).
//
//  Run:  ~/.bun/bin/bun run scripts/journey/prove-muster-reslot-journey.ts
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const ROOT = join(import.meta.dir, '..', '..')
const BIN = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(BIN)) {
  console.error('dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(2)
}

console.log('============================================================')
console.log(' muster reslot journey — engage → reslot → receipt → wire truth')
console.log('============================================================')

// ── isolated estate ──────────────────────────────────────────────────────────
const HOME = mkdtempSync(join(tmpdir(), 'muster-journey-'))
const configDir = join(HOME, 'config')
const daemonDir = join(HOME, 'daemon')
const fixtureLog = join(HOME, 'fixture.jsonl')
mkdirSync(configDir, { recursive: true })
// Seed onboarding/trust/auth so the REPL boots straight to the prompt (the
// artifactArena recipe): fake key approved by its last-20; repo cwd trusted.
const API_KEY = 'sk-ant-test-muster-journey-0000000000000000000000'
writeFileSync(
  join(configDir, '.config.json'),
  JSON.stringify({
    theme: 'dark',
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: [API_KEY.slice(-20)] },
    projects: { [ROOT]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }),
)

// ── the fixture control daemon ───────────────────────────────────────────────
const bun = process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`
const fixture = spawn(bun, ['run', join(import.meta.dir, 'muster-fixture-daemon.ts')], {
  env: { ...process.env, MERCURY_DAEMON_DIR: daemonDir, MUSTER_FIXTURE_LOG: fixtureLog },
  stdio: 'ignore',
})
let fixtureUp = false
for (let t = 0; t < 50; t++) {
  // The sock path may hash to tmpdir on a deep temp dir (the fixture mirrors
  // controlSockPath) — supervisor.json is the reliable up signal; the sock is
  // recorded inside it.
  if (existsSync(join(daemonDir, 'supervisor.json'))) {
    fixtureUp = true
    break
  }
  await sleep(100)
}
check('fixture control daemon is up (supervisor.json written)', fixtureUp)

// ── the PTY leg ──────────────────────────────────────────────────────────────
// A RESUMED session (the proven scenario input surface — every green party/ui
// scenario types into --resume; a fresh Helm-home boot ate keystrokes twice
// during authoring): seed a minimal 2-row synthetic transcript in the isolated
// home, resume it, then type the reslot.
const SID = `00000000-aaaa-bbbb-cccc-${(process.pid % 0xffffff).toString(16).padStart(12, '0')}`
{
  const projects = join(configDir, 'projects', ROOT.replace(/[\\/.]/g, '-'))
  mkdirSync(projects, { recursive: true })
  const base = (extra: Record<string, unknown>) => ({
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd: ROOT,
    sessionId: SID,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    ...extra,
  })
  const lines = [
    base({
      parentUuid: null,
      type: 'user',
      uuid: '00000000-0000-4000-8000-0000000ba001',
      message: { role: 'user', content: 'seat check' },
      timestamp: '2026-07-17T12:00:01.000Z',
    }),
    base({
      parentUuid: '00000000-0000-4000-8000-0000000ba001',
      type: 'assistant',
      uuid: '00000000-0000-4000-8000-0000000ba002',
      requestId: 'req_muster_1',
      message: {
        id: 'msg_muster_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'Ready.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      timestamp: '2026-07-17T12:00:02.000Z',
    }),
  ]
  // The session file holds RECORD lines — the shape the product opens.
  writeFileSync(join(projects, `${SID}.jsonl`), encodeSeedTranscript(lines, SID))
}
try {
  const gridPath = join(HOME, 'grid.json')
  const cfgPath = join(HOME, 'vshot.json')
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: ['node', BIN, '--resume', SID],
      sends: [
        { atTick: 30, data: '/model implementer sonnet5' },
        { atTick: 40, awaitText: 'implementer sonnet5', minTick: 4, data: '\r' },
      ],
      // observed-ready: the RECEIPT row is the journey's end state (the
      // ACK renders seconds earlier); the hard total stays the deadline.
      readyText: ['reslot applied — implementer'],
      stableTicks: 4,
      total: 150,
      cols: 120,
      rows: 40,
      out: gridPath,
    }),
  )
  const res = spawnSync('/usr/bin/python3', [join(ROOT, 'scripts', 'ui', 'vshot.py'), cfgPath], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(180_000),
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_TEAMS_DIR: join(HOME, 'teams'),
      MERCURY_PARTY_STATE_DIR: join(HOME, 'party'),
      ANTHROPIC_API_KEY: API_KEY,
      MERCURY_SCRIBE: '1',
      MERCURY_PARTY: '0',
      // capture pins (repo convention): ambience off — the journey is the subject
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_LIVE_GLYPHS: '0',
    },
  })
  check('vshot leg exited 0', res.status === 0, (res.stderr || '').slice(0, 300))
  const parsed = JSON.parse(readFileSync(gridPath, 'utf8')) as { grid?: Array<Array<{ c?: string }>> }
  const text = Array.isArray(parsed.grid)
    ? parsed.grid.map(row => row.map(cell => cell.c ?? ' ').join('')).join('\n')
    : ''

  console.log('\n— transcript truth —')
  check('the ACK row renders (request ≠ apply, wait-doctrine wording)', /Implementer → model claude-sonnet-5 · respawning now/.test(text))
  check('the ACK names the persistence (slot saved)', /slot saved/.test(text))
  check('ONE receipt row renders on the OBSERVED apply', /⇄ reslot applied — implementer → claude-sonnet-5/.test(text))

  console.log('\n— wire + disk truth —')
  const logLines = readFileSync(fixtureLog, 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
  const reconfigures = logLines.filter(l => (l.req as Record<string, unknown> | undefined)?.op === 'reconfigure')
  check('the fixture observed exactly ONE reconfigure', reconfigures.length === 1, String(reconfigures.length))
  check('…carrying the RESOLVED model (the next dispatch/respawn truth)', (reconfigures[0]?.req as Record<string, unknown> | undefined)?.model === 'claude-sonnet-5')
  const slotsRaw = join(configDir, 'seat-slots.json')
  check('the persisted slot survives on disk (env-and-re-engage is no longer the only way)', existsSync(slotsRaw) && (JSON.parse(readFileSync(slotsRaw, 'utf8')) as { slots?: { implementer?: { model?: string } } }).slots?.implementer?.model === 'claude-sonnet-5')
} finally {
  try {
    fixture.kill('SIGTERM')
  } catch {
    /* gone */
  }
  if (failures === 0) rmSync(HOME, { recursive: true, force: true })
  else console.log(`  (artifacts kept for diagnosis: ${HOME})`)
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} check(s) failed`)
  process.exit(1)
}
console.log(' ALL muster-JOURNEY PROOFS PASS')
