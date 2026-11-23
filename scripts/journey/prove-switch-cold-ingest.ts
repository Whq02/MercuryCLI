#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { BOOT_FACE_READY } from '../lib/bootFace.ts'

const REPO = path.resolve(import.meta.dir, '../..')
const DIST = path.join(REPO, 'dist/mercury.mjs')
const VSHOT = path.join(REPO, 'scripts/ui/vshot.py')

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

const GPT_REPLY = 'sol answers from the fixture'
const OPUS_REPLY = 'opus picked up cleanly'
const SLOW_INGEST_ASK = 'ingest slowly please'
const IDLE_MS = 3_000
const HOLD_MS = 5_000

const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-coldingest-${process.pid}`)
const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
const PROBE_KEY = 'sk-ant-coldingest-probe-key'
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
writeFileSync(path.join(FIXTURE_CWD, 'README.md'), '# cold ingest fixture\n')

const captureFile = path.join(RUN_HOME, 'wire-captures.jsonl')
writeFileSync(captureFile, '')
const fixture = spawn('node', [path.join(import.meta.dir, 'switch-fixture-server.ts'), captureFile], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, FIXTURE_HOLD_MS: String(HOLD_MS) },
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
  }
  if (failures === 0) {
    try {
      rmSync(RUN_HOME, { recursive: true, force: true })
    } catch {
    }
  } else {
    console.log(`[forensics] world kept: ${RUN_HOME}`)
  }
}
process.on('exit', reap)

console.log('============================================================')
console.log(' switch → cold ingest LIVE — the wait is spoken, the turn completes')
console.log('============================================================')

const out = path.join(RUN_HOME, 'grid-coldingest.json')
const cfg = {
  argv: ['node', DIST, '--model', 'gpt-5.6-sol'],
  cwd: FIXTURE_CWD,
  sends: [
    { atTick: 40, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { atTick: 80, minTick: 20, awaitText: 'Type a prompt', awaitStableTicks: 3, awaitSettleTicks: 2, data: 'hello sol\r' },
    { atTick: 150, minTick: 10, awaitText: GPT_REPLY, data: '/model claude-opus-5\r', mark: 'switch-sent' },
    { atTick: 200, minTick: 8, awaitText: 'Model switch preview', awaitSettleTicks: 2, data: '\r', mark: 'switch-confirmed' },
    { atTick: 260, minTick: 10, awaitText: 'ready · Opus 5 ·', requireAwait: true, awaitSettleTicks: 2, data: `${SLOW_INGEST_ASK}\r`, mark: 'ask-sent' },
    { atTick: 330, minTick: 2, awaitText: 'ingesting a', awaitSettleTicks: 2, data: '', mark: 'wait-seen' },
  ],
  readyText: [OPUS_REPLY],
  stableTicks: 4,
  total: 420,
  cols: 150,
  rows: 34,
  out,
}
const cfgPath = path.join(RUN_HOME, 'cfg-coldingest.json')
writeFileSync(cfgPath, JSON.stringify(cfg))

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: RUN_HOME,
  ANTHROPIC_API_KEY: PROBE_KEY,
  ANTHROPIC_BASE_URL: base,
  OPENAI_API_KEY: 'sk-test-coldingest-openai',
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_STREAM_IDLE_TIMEOUT_MS: String(IDLE_MS),
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_VERIFY_EVIDENCE: '0',
  MERCURY_HEALTH_STATE_DIR: path.join(RUN_HOME, 'health-state'),
  MERCURY_DAEMON_DIR: path.join(RUN_HOME, 'daemon'),
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
let receipts: Array<{ atTick?: number; ts?: number }> = []
let markGrids = new Map<string, string>()
if (existsSync(out)) {
  const payload = JSON.parse(readFileSync(out, 'utf8')) as {
    grid: Array<Array<{ c: string }>>
    sendReceipts?: Array<{ atTick?: number; ts?: number }>
    marks?: Array<{ label: string; grid: Array<Array<{ c: string }>> }>
  }
  gridText = payload.grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')
  receipts = (payload.sendReceipts ?? []) as Array<{ atTick?: number; ts?: number }>
  markGrids = new Map((payload.marks ?? []).map(m => [m.label, m.grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')]))
}
type Capture = { kind: string; url?: string; body?: Record<string, unknown>; at: number; holdMs?: number; heldMs?: number }
const wire: Capture[] = readFileSync(captureFile, 'utf8')
  .split('\n')
  .filter(l => l.trim() !== '')
  .map(l => JSON.parse(l) as Capture)

section('L1 — the GPT leg ran and the switch applied on the real binary')
{
  check('the Responses fixture served the GPT turn', wire.some(c => c.kind === 'openai'), `vshot status=${res.status} hits=${wire.map(c => c.kind).join('|') || 'NONE'} — the GPT turn never reached scripts/journey/switch-fixture-server.ts; check MERCURY_OPENAI_API_BASE handling in the OpenAI provider road and that the vshot run started (status above)`)
  check('the switch send fired on its await (the GPT reply painted)', (receipts[2]?.atTick ?? 999) < 120, `tick ${receipts[2]?.atTick} — the GPT reply text (GPT_REPLY) did not paint in time; look at the first turn of the built binary against the fixture server`)
  check('the confirm fired on its await (the preview card painted and settled)', (receipts[3]?.atTick ?? 999) < 180, `tick ${receipts[3]?.atTick} — the Model switch preview card did not paint after /model claude-opus-5; look at the /model switch command`)
  check("the ask fired on its await (the status row rested on 'ready · Opus 5 ·')", (receipts[4]?.atTick ?? 999) < 250, `tick ${receipts[4]?.atTick} — the status row never showed ready · Opus 5 · after the switch confirm; look at the model switch apply path`)
}

section('L2 — THE WAIT IS SPOKEN while the Opus headers are held')
{
  const seen = markGrids.get('wait-seen') ?? ''
  const line = seen.split('\n').find(l => l.includes('ingesting a')) ?? ''
  check("the status row read the cold wait on its await, not its deadline", (receipts[5]?.atTick ?? 999) < 330, `tick ${receipts[5]?.atTick} — the status row never showed ingesting a; look at the wait line text in src/models/roads/streamIdleBudget.ts and whether the fixture held the Opus headers`)
  check("the words: 'ingesting a Nk-token prompt on Opus 5 — gives up after N s' (minutes at or above sixty: 'gives up after 1m 15s')", /ingesting a \d+k-token prompt on Opus 5 — gives up after (?:\d+ s|\d+m(?: \d+s)?)\b/.test(line), line || seen.split('\n').slice(-8).join('\n') + ' — the cold-wait line must read like the text built in src/models/roads/streamIdleBudget.ts (cold branch with kTokens and seconds); change that text or this pattern together')
  const named = /gives up after (?:(\d+)m(?: (\d+)s)?|(\d+) s)/.exec(line)
  const budget = named === null ? 0 : named[3] !== undefined ? Number(named[3]) * 1000 : (Number(named[1]) * 60 + Number(named[2] ?? 0)) * 1000
  check(`the named budget outlasts the 5 s hold and the 3 s idle budget (named ${budget} ms)`, budget > HOLD_MS && budget > IDLE_MS, `${line} — the first byte budget named in the wait line must exceed the hold and the idle budget; see the cold-ingest budget in src/models/roads/streamIdleBudget.ts`)
}

section('L3 — THE TURN COMPLETES: the hold was waited out, nothing aborted')
{
  const held = wire.find(c => c.kind === 'anthropic-held')
  const sent = wire.find(c => c.kind === 'anthropic-headers-sent')
  check('the fixture held the Opus headers for the whole hold', held !== undefined && sent !== undefined && (sent.heldMs ?? 0) >= HOLD_MS - 50, JSON.stringify({ held, sent }) + ' — the Opus request never reached the held path in scripts/journey/switch-fixture-server.ts; check the ask was sent and the Opus leg used ANTHROPIC_BASE_URL')
  check('the held request was never dropped (the idle budget did not fire on the cold ingest)', !wire.some(c => c.kind === 'anthropic-dropped-while-held'), JSON.stringify(wire.filter(c => c.kind.startsWith('anthropic-'))) + ' — the client dropped the held request: the stream idle budget (MERCURY_STREAM_IDLE_TIMEOUT_MS) must widen for a cold ingest; see src/models/roads/streamIdleBudget.ts')
  check('the Opus reply painted', gridText.includes(OPUS_REPLY), gridText.split('\n').slice(-12).join('\n') + ' — the Opus reply (OPUS_REPLY) did not paint; the turn did not complete after the hold, see the grid tail above and the forensics debug log tail')
  check("no typed timeout row ('no first byte') and no 'stuck' verdict painted", !/no first byte from/.test(gridText) && !/may be stuck/.test(gridText))
}

if (failures > 0) {
  try {
    const debugDir = path.join(RUN_HOME, 'debug')
    if (existsSync(debugDir)) {
      const latest = readdirSync(debugDir).filter(f => f.endsWith('.txt')).sort().at(-1)
      if (latest) {
        const tail = readFileSync(path.join(debugDir, latest), 'utf8').split('\n').filter(l => !l.includes('High write ratio')).slice(-30).join('\n')
        console.log(`\n[forensics] debug log tail:\n${tail}`)
      }
    }
  } catch {
  }
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
