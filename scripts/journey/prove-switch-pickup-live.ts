#!/usr/bin/env bun
// ============================================================================
//  scripts/journey/prove-switch-pickup-live.ts — the operator's switch-wedge
//  repro driven end-to-end on the REAL binary: a GPT session on a loopback
//  Responses fixture, /model claude-opus-5 mid-session, a pickup ask — and
//  the assertion the incident violated: the switched turn DISPATCHES to the
//  Anthropic wire and paints its reply.
//
//  The wedge: ChatGPT→Opus mid-session left Opus
//  consuming zero tokens while a fresh session worked. The fixture-seam
//  provers pinned the conversion (lane R), the engine dispatch + request
//  parity (prove-switched-dispatch-parity), and the pool-recovery mechanism
//  (prove-watchdog-pool-reset). This journey closes the LAST layer: the
//  interactive REPL itself — queue processor, /model command, composer —
//  driving dist/mercury.mjs in a real PTY over both loopback families.
//
//  The fixture server is a SEPARATE process (switch-fixture-server.ts): a
//  PTY-driven child cannot connect back into a server held by the prover
//  process under the harness sandbox (live-found; the in-process variant
//  timed out at TCP connect for every child layer).
//
//    L1  the GPT leg runs on the real binary (the Responses fixture serves
//        the first turn; its reply paints)
//    L2  /model claude-opus-5 lands mid-session (no restart)
//    L3  the pickup ask DISPATCHES: the Anthropic loopback receives the
//        switched request, model claude-opus-5, carrying the GPT-leg
//        history and the pickup ask
//    L4  the switched reply PAINTS (no wedge, no zero-token stall)
//
//  Run: ~/.bun/bin/bun run scripts/journey/prove-switch-pickup-live.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

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

// Contract data shared with switch-fixture-server.ts (kept in both files —
// the server cannot be imported without starting it).
const GPT_REPLY = 'sol answers from the fixture'
const OPUS_REPLY = 'opus picked up cleanly'

// ── the hermetic world ──────────────────────────────────────────────────────
const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-switchlive-${process.pid}`)
const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
const PROBE_KEY = 'sk-ant-switchlive-probe-key'
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
writeFileSync(path.join(FIXTURE_CWD, 'README.md'), '# switch drive fixture\n')

// ── the fixture server (its own process — see the header) ──────────────────
const captureFile = path.join(RUN_HOME, 'wire-captures.jsonl')
writeFileSync(captureFile, '')
const fixture = spawn(BUN, ['run', path.join(import.meta.dir, 'switch-fixture-server.ts'), captureFile], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
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
  // A red run KEEPS the world for forensics (the path prints below).
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
console.log(' switch pickup LIVE — the real binary, both loopback families')
console.log('============================================================')

// ── the PTY drive ───────────────────────────────────────────────────────────
const out = path.join(RUN_HOME, 'grid-switch.json')
const cfg = {
  argv: ['node', DIST, '--model', 'gpt-5.6-sol'],
  cwd: FIXTURE_CWD,
  sends: [
    // The idle-composer hint is the true ready signal ('❯' paints during
    // boot overlays and mid-turn too — sends gated on it queued into the
    // boot turn, live-found: the whole script drained into ONE turn).
    // THE LANDING RULE: a bare boot lands on the Boot face — ↵ on New Session enters the chat first.
    { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { atTick: 80, minTick: 20, awaitText: '? for shortcuts', data: 'hello sol\r' },
    // The GPT leg settles: its reply on the grid gates the switch.
    { atTick: 150, minTick: 10, awaitText: GPT_REPLY, data: '/model claude-opus-5\r', mark: 'switch-sent' },
    // /model with an argument opens the MODEL SWITCH PREVIEW (live-found in
    // this drive) — enter confirms it through the settlement owner.
    { atTick: 200, minTick: 8, awaitText: 'Model switch preview', data: '\r', mark: 'switch-confirmed' },
    // The band repaints the new model chip ('Opus 5 · ●' — the preview text
    // never carries the status dot) once the switch has actually applied.
    { atTick: 260, minTick: 10, awaitText: 'Opus 5 · ●', data: 'pick up from gpt pls\r', mark: 'pickup-sent' },
  ],
  readyText: [OPUS_REPLY],
  stableTicks: 4,
  total: 400,
  cols: 110,
  rows: 34,
  out,
}
const cfgPath = path.join(RUN_HOME, 'cfg-switch.json')
writeFileSync(cfgPath, JSON.stringify(cfg))

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: RUN_HOME,
  ANTHROPIC_API_KEY: PROBE_KEY,
  ANTHROPIC_BASE_URL: base,
  OPENAI_API_KEY: 'sk-test-switchlive-openai',
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
let pickupSentAt = 0
let switchSentAt = 0
if (existsSync(out)) {
  const payload = JSON.parse(readFileSync(out, 'utf8')) as {
    grid: Array<Array<{ c: string }>>
    sendReceipts?: Array<{ mark?: string; atMs?: number }>
  }
  gridText = payload.grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')
  // Receipts are {atTick, ts} in SEND ORDER (no mark echo): [0]=hello,
  // [1]=/model, [2]=confirm, [3]=pickup. atTick is the fire tick; ts epoch ms.
  const receipts = (payload.sendReceipts ?? []) as unknown as Array<{ atTick?: number; ts?: number }>
  switchSentAt = receipts[1]?.atTick ?? 0
  pickupSentAt = receipts[3]?.ts ?? 0
}
type Capture = { kind: string; method?: string; url?: string; body?: Record<string, unknown>; at: number }
const wire: Capture[] = readFileSync(captureFile, 'utf8')
  .split('\n')
  .filter(l => l.trim() !== '')
  .map(l => JSON.parse(l) as Capture)

section('L1 — the GPT leg ran on the real binary')
{
  const gptCalls = wire.filter(c => c.kind === 'openai')
  check('the Responses fixture served the GPT turn', gptCalls.length >= 1, `openai calls=${gptCalls.length} vshot status=${res.status} hits=${wire.map(c => `${c.kind}:${c.url ?? ''}`).join('|') || 'NONE'}`)
  // The final grid has scrolled past the GPT exchange by settlement — the
  // honest paint evidence is the /model send firing on its GPT_REPLY await
  // WELL BEFORE its tick-150 deadline (a deadline-fired send means the
  // reply never painted; live-found on the delta-less fixture).
  check(
    'the GPT reply painted (the switch send fired on its await, not its deadline)',
    switchSentAt > 0 && switchSentAt < 120,
    `switch-sent at tick ${switchSentAt} (deadline 150)`,
  )
}

section('L2/L3 — the switched turn DISPATCHES to the Anthropic wire')
{
  const opusCalls = wire.filter(c => c.kind === 'anthropic')
  // The MAIN turn is the tool-bearing request carrying the ask — service
  // side calls (title/topic) carry the text too but never the tool catalog.
  const main = opusCalls.find(
    c =>
      Array.isArray(c.body?.tools) &&
      (c.body?.tools as unknown[]).length > 0 &&
      JSON.stringify(c.body ?? {}).includes('pick up from gpt pls'),
  )
  check('the Anthropic loopback received the switched request (dispatch FIRED through the REPL)', main !== undefined, `anthropic calls=${opusCalls.length}`)
  if (main) {
    check('the switched request targets claude-opus-5', String(main.body?.model ?? '').startsWith('claude-opus-5'), String(main.body?.model))
    const bodyText = JSON.stringify(main.body)
    const roleLine = (c: Capture): string =>
      `${((c.body?.messages as unknown[]) ?? []).length}msg[${((c.body?.messages as Array<{ role?: string; content?: unknown }>) ?? [])
        .map(m => {
          const content = m.content
          const text =
            typeof content === 'string'
              ? content
              : Array.isArray(content)
                ? content
                    .map(b => (typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : `<${(b as { type?: string }).type}>`))
                    .join(' ')
                : ''
          return `${(m.role ?? '?')[0]}:${text.replace(/\s+/g, ' ').replace(/<system-reminder>[\s\S]*?$/, '<sysrem>').slice(0, 30)}`
        })
        .join(' | ')}]`
    check(
      'the GPT-leg history rides the switched request',
      bodyText.includes('hello sol') && bodyText.includes(GPT_REPLY),
      `wire order: ${wire.map(c => c.kind).join('→')}; MAIN=${roleLine(main)}; all tool-bearing=${opusCalls
        .filter(c => Array.isArray(c.body?.tools) && (c.body?.tools as unknown[]).length > 0)
        .map(roleLine)
        .join(' ;; ')}`,
    )
    check('no thinking blocks ride the switched wire (cross-family strip)', !bodyText.includes('"type":"thinking"'))
    if (pickupSentAt > 0) {
      console.log(`  [info] pickup-send → anthropic wire arrival: ${main.at - pickupSentAt}ms`)
    }
  }
}

section('L4 — the switched reply PAINTS (the wedge shape is dead)')
{
  check('the Opus reply painted', gridText.includes(OPUS_REPLY), gridText.split('\n').slice(-12).join('\n'))
}

if (failures > 0) {
  try {
    const debugDir = path.join(RUN_HOME, 'debug')
    if (existsSync(debugDir)) {
      const latest = readdirSync(debugDir)
        .filter(f => f.endsWith('.txt'))
        .sort()
        .at(-1)
      if (latest) {
        const tail = readFileSync(path.join(debugDir, latest), 'utf8')
          .split('\n')
          .filter(l => !l.includes('High write ratio'))
          .slice(-30)
          .join('\n')
        console.log(`\n[forensics] debug log tail:\n${tail}`)
      }
    }
  } catch {
    /* forensics best-effort */
  }
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
