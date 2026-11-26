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

const GPT_REPLY = 'sol answers from the fixture'
const LONG_THINK_ASK = 'think long please'
const TEARDOWN_BUDGET_MS = 1_000

const RUN_HOME = path.join(realpathSync(tmpdir()), `mercury-interruptlive-${process.pid}`)
const FIXTURE_CWD = path.join(RUN_HOME, 'fixture-repo')
const PROBE_KEY = 'sk-ant-interruptlive-probe-key'
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
writeFileSync(path.join(RUN_HOME, 'settings.json'), JSON.stringify({ guardrails: { mode: 'flow' } }))
writeFileSync(path.join(FIXTURE_CWD, 'README.md'), '# interrupt drive fixture\n')

const captureFile = path.join(RUN_HOME, 'wire-captures.jsonl')
writeFileSync(captureFile, '')
const fixture = spawn('node', [path.join(import.meta.dir, 'switch-fixture-server.ts'), captureFile], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
const port = await new Promise<number>((resolve, reject) => {
  const killer = setTimeout(() => reject(new Error('fixture server never printed PORT — run scripts/journey/switch-fixture-server.ts by hand and fix what it prints on stderr')), 15_000)
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
console.log(' interrupt after a switch LIVE — the real binary, both loopback families')
console.log('============================================================')

const out = path.join(RUN_HOME, 'grid-interrupt.json')
const cfg = {
  argv: ['node', DIST, '--model', 'gpt-5.6-sol'],
  cwd: FIXTURE_CWD,
  sends: [
    { atTick: 40, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { atTick: 80, minTick: 20, awaitText: 'Type a prompt', awaitSettleTicks: 2, data: 'hello sol\r', mark: 'hello-sent' },
    { atTick: 150, minTick: 10, awaitText: GPT_REPLY, data: '/model claude-opus-5\r', mark: 'switch-sent' },
    { atTick: 200, minTick: 8, awaitText: 'Model switch preview', awaitSettleTicks: 2, data: '\r', mark: 'switch-confirmed' },
    { atTick: 260, minTick: 10, awaitText: 'ready · Opus 5 ·', requireAwait: true, awaitSettleTicks: 2, data: `${LONG_THINK_ASK}\r`, mark: 'think-sent' },
    { afterPrevTicks: 20, atTick: 320, data: '\x1b', mark: 'esc-sent' },
  ],
  readyText: ['Interrupted'],
  stableTicks: 4,
  total: 420,
  cols: 110,
  rows: 34,
  out,
}
const cfgPath = path.join(RUN_HOME, 'cfg-interrupt.json')
writeFileSync(cfgPath, JSON.stringify(cfg))

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: RUN_HOME,
  ANTHROPIC_API_KEY: PROBE_KEY,
  ANTHROPIC_BASE_URL: base,
  OPENAI_API_KEY: 'sk-test-interruptlive-openai',
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
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
delete childEnv.MERCURY_DAEMON_PERMISSION_MODE

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
type Capture = { kind: string; method?: string; url?: string; body?: Record<string, unknown>; at: number; openMs?: number; why?: string }
const wire: Capture[] = readFileSync(captureFile, 'utf8')
  .split('\n')
  .filter(l => l.trim() !== '')
  .map(l => JSON.parse(l) as Capture)
const escAt = receipts[5]?.ts ?? 0
const thinkAt = receipts[4]?.ts ?? 0

section('L1 — the GPT leg ran and the switch applied on the real binary')
{
  const gptCalls = wire.filter(c => c.kind === 'openai')
  check('the Responses fixture served the GPT turn', gptCalls.length >= 1, `openai calls=${gptCalls.length} vshot status=${res.status} hits=${wire.map(c => `${c.kind}:${c.url ?? ''}`).join('|') || 'NONE'} — the binary never reached the OpenAI Responses fixture; check MERCURY_OPENAI_API_BASE in childEnv and the fixture log under ${RUN_HOME}`)
  check('the switch send fired on its await, not its deadline (the GPT reply painted)', (receipts[2]?.atTick ?? 999) < 120, `switch-sent at tick ${receipts[2]?.atTick} — the GPT reply text never painted, so the send waited for its deadline; read the grid in ${out}`)
  check('the confirm fired on its await (the preview card painted and settled)', (receipts[3]?.atTick ?? 999) < 180, `confirm at tick ${receipts[3]?.atTick} — the Model switch preview card (src/commands/model/TransitionPreviewCard.tsx) never painted after /model claude-opus-5; read the grid in ${out}`)
  check("the think ask fired on its await (the status row rested on 'ready · Opus 5 ·' — the switch applied)", (receipts[4]?.atTick ?? 999) < 250, `think-sent at tick ${receipts[4]?.atTick} — the status row never rested on ready · Opus 5 · after the confirm, so the switch did not apply; read the grid in ${out}`)
  check('the esc was sent after the ask', escAt > thinkAt && thinkAt > 0, `think ${thinkAt} esc ${escAt} — a send receipt is missing; the vshot run in ${out} ended before the think ask and the esc were sent (vshot status=${res.status})`)
}

section('L2 — the switched turn DISPATCHES on the Anthropic wire, and is OPEN at the esc')
{
  const main = wire.find(
    c =>
      c.kind === 'anthropic' &&
      Array.isArray(c.body?.tools) &&
      (c.body?.tools as unknown[]).length > 0 &&
      JSON.stringify(c.body ?? {}).includes(LONG_THINK_ASK),
  )
  check('the Anthropic loopback received the switched request (tools aboard, the ask in the body)', main !== undefined, `anthropic calls=${wire.filter(c => c.kind === 'anthropic').length} — the turn after the switch was not sent to the Anthropic loopback with tools and the ask; check ANTHROPIC_BASE_URL in childEnv and the model switch path`)
  if (main) check('the switched request targets claude-opus-5', String(main.body?.model ?? '').startsWith('claude-opus-5'), `${String(main.body?.model)} — the request after /model claude-opus-5 carried another model; the switch did not reach the request builder`)
  const opened = wire.find(c => c.kind === 'anthropic-open')
  check('the thinking phase was open BEFORE the esc (the request the esc must tear down)', opened !== undefined && escAt > 0 && opened.at < escAt, `open ${opened?.at} esc ${escAt} — the fixture never saw the thinking request open before the esc; the ask ${LONG_THINK_ASK} must reach switch-fixture-server.ts before the esc fires`)
}

section('L3 — THE TEAR-DOWN: the fixture sees the connection drop within a second of the esc')
{
  const closed = wire.find(c => c.kind === 'anthropic-closed')
  const lag = closed !== undefined && escAt > 0 ? closed.at - escAt : Number.NaN
  check(`the connection dropped (the client aborted the stream — never the fixture's own ceiling)`, closed !== undefined && closed.why === 'client-dropped', `${JSON.stringify(closed ?? null)} — the esc did not abort the open stream; the client must drop the connection (see escRungOf in src/screen/composer/input-core/escRung.ts and the abort path of the interrupted turn)`)
  check(`the drop landed within ${TEARDOWN_BUDGET_MS} ms of the esc (measured ${Number.isFinite(lag) ? `${lag} ms` : 'never'})`, Number.isFinite(lag) && lag >= 0 && lag <= TEARDOWN_BUDGET_MS, `esc ${escAt} closed ${closed?.at} — the teardown after the esc is slower than ${TEARDOWN_BUDGET_MS} ms or never happened; the request must be aborted on the esc, not on a timeout`)
  if (Number.isFinite(lag)) console.log(`  [info] esc → connection drop: ${lag} ms`)
}

section('L4 — THE ROW TELLS THE TRUTH after the interrupt')
{
  const before = markGrids.get('esc-sent') ?? ''
  const status = before.split('\n').find(line => line.includes('esc interrupts')) ?? ''
  check('the live status row shows Opus 5 and high effort with the esc hint, without a phase or ready label', status.includes('Opus 5 · high') && status.includes('esc interrupts · ⇧← back') && !/thinking|ready ·/.test(status), `${status} — the status row at the esc must show the model, effort and esc hint without a phase label; see statusLine in src/screen/chat/SwitchboardTagBar.tsx and escRungHint in src/screen/composer/input-core/escRung.ts`)
  check('the interruption painted (⨯ Interrupted)', /Interrupted/.test(gridText), `${gridText.split('\n').slice(-12).join('\n')}\n — no Interrupted line painted after the esc; the interrupted turn must write its notice into the transcript`)
  check('the composer returned', /╭─+╮\n│❯\s[^\n]*│\n╰─+╯/.test(gridText), `${gridText.split('\n').slice(-8).join('\n')}\n — the composer did not come back after the interrupt; read the last rows above`)
  check("the status row reads ready — no 'interrupting' left standing", /ready · [^\n]*← back/.test(gridText) && !/interrupting —/.test(gridText), `${gridText.split('\n').slice(-8).join('\n')}\n — the interrupting label stayed on the status row; its source is statusLine in src/screen/chat/SwitchboardTagBar.tsx (s.interrupting must clear once the turn ends)`)
  check("no 'thinking' stands over a stream that ended", !/thinking for|· thinking/.test(gridText), `${gridText.split('\n').slice(-8).join('\n')}\n — a thinking label still stands after the stream ended; the status row must drop it once the turn is interrupted`)
}

section('L5 — flow mode: the hosted session ran the flow posture')
{
  const factsDir = path.join(RUN_HOME, 'daemon', 'session-facts')
  let mode: string | undefined
  try {
    for (const f of readdirSync(factsDir)) {
      const facts = JSON.parse(readFileSync(path.join(factsDir, f), 'utf8')) as { permissionMode?: string }
      mode = facts.permissionMode ?? mode
    }
  } catch {
  }
  check("the session's facts report permissionMode 'flow' (the saved posture the seat inherits)", mode === 'flow', `permissionMode=${mode ?? 'unread'} — the hosted session did not take guardrails.mode flow from settings.json in ${RUN_HOME}; look at the session-facts files the daemon wrote under ${factsDir}`)
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
  }
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
