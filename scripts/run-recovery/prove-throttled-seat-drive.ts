#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
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
    } catch {
    }
    await sleep(everyMs)
  }
  return false
}

const BUDGET_MINUTES = 0.1
const BUDGET_MS = 6_000
const IDLE_MS = 2_000
const FALLBACK_MS = 8_000
const HUNG_BUDGET_MINUTES = 0.5
const LEG_MS = 40_000

const SCRATCH = mkdtempSync(join(tmpdir(), 'throttled-seat-'))
const configDir = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [configDir, daemonDir, work]) mkdirSync(d, { recursive: true })
const readme = join(work, 'README.md')
writeFileSync(readme, '# throttle fixture\n')
for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'fixture']]) {
  spawnSync('git', args, { cwd: work, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
}
process.env.MERCURY_CONFIG_DIR = configDir
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(configDir, [work])
{
  const cfgPath = join(configDir, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg.switchboardCapacity = { askedAt: 0, allowed: true, recommendedSeats: 8 }
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`)
}
function writePatience(recoveryBudgetMinutes: number): void {
  const settingsPath = join(configDir, 'settings.json')
  const current = ((): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    } catch {
      return {}
    }
  })()
  current.patience = { streamIdleSeconds: IDLE_MS / 1000, quietStreamIdleSeconds: IDLE_MS / 1000, fallbackCeilingSeconds: FALLBACK_MS / 1000, recoveryBudgetMinutes }
  writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`)
}
writePatience(BUDGET_MINUTES)
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')

type Capture = { kind: string; at: number; arm?: string; route?: string; status?: number; streaming?: boolean; nth?: number; toolResult?: boolean }
const captureFile = join(SCRATCH, 'wire-captures.jsonl')
writeFileSync(captureFile, '')
const wire = (): Capture[] =>
  readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Capture)

const projectDir = paths.getProjectDir(work)
const parentTranscript = (sid: string): string => {
  const p = join(projectDir, `${sid}.jsonl`)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}
const seatTranscript = (sid: string): string => {
  const dir = join(projectDir, sid, 'subagents')
  if (!existsSync(dir)) return ''
  return readdirSync(dir)
    .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'))
    .map(f => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
}
type WorkRow = { kind?: string; status?: string; wait?: string; error?: string; name?: string; paused?: { why?: string; words?: string; resumesAtMs?: number } }
const seatRows = (sid: string): WorkRow[] => {
  try {
    const facts = JSON.parse(readFileSync(join(daemonDir, 'session-facts', `${sid}.json`), 'utf8')) as { work?: WorkRow[] }
    return (facts.work ?? []).filter(r => r.kind === 'agent')
  } catch {
    return []
  }
}
const findText = (value: unknown, pred: (s: string) => boolean, depth = 0): string | null => {
  if (depth > 12 || value === null || value === undefined) return null
  if (typeof value === 'string') return pred(value) ? value : null
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findText(v, pred, depth + 1)
      if (hit !== null) return hit
    }
    return null
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const hit = findText(v, pred, depth + 1)
      if (hit !== null) return hit
    }
  }
  return null
}
const toolResultTexts = (value: unknown, out: string[], depth = 0): void => {
  if (depth > 12 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const v of value) toolResultTexts(v, out, depth + 1)
    return
  }
  const record = value as Record<string, unknown>
  if (record.kind === 'tool-result') {
    const body = record.body
    if (typeof body === 'string') out.push(body)
    else if (Array.isArray(body)) {
      const texts = body.map(b => (b !== null && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).filter(t => t !== '')
      if (texts.length > 0) out.push(texts.join('\n'))
    }
    return
  }
  if (record.type === 'tool_result') {
    const content = record.content
    const text = typeof content === 'string' ? content : findText(content, () => true)
    if (text !== null) out.push(text)
    return
  }
  for (const v of Object.values(record)) toolResultTexts(v, out, depth + 1)
}
const receiptOf = (sid: string): string | null => {
  for (const line of parentTranscript(sid).split('\n')) {
    if (!line.includes('"kind":"tool-result"') && !line.includes('tool_result')) continue
    try {
      const out: string[] = []
      toolResultTexts(JSON.parse(line) as unknown, out)
      const hit = out.find(s => /Agent execution failed|refused|throttled|overload|recovered after busy|slow but alive|paused/i.test(s))
      if (hit !== undefined) return hit
    } catch {
    }
  }
  return null
}
const readFacts = (sid: string): { busy?: boolean } | undefined => {
  try {
    return JSON.parse(readFileSync(join(daemonDir, 'session-facts', `${sid}.json`), 'utf8')) as { busy?: boolean }
  } catch {
    return undefined
  }
}
const noticeCount = (sid: string): number => (seatTranscript(sid).match(/"noticeKind":"api_error"/g) ?? []).length
const pausedOf = (sid: string): WorkRow['paused'] | null => {
  for (const row of seatRows(sid)) if (row.paused !== undefined) return row.paused
  return null
}
const cutRow = (sid: string): string | null => {
  const m = /\[Request cut off[^\]]*\]/.exec(seatTranscript(sid))
  return m === null ? null : m[0]
}

const fixture = spawn('node', [join(import.meta.dir, 'throttle-fixture-server.ts'), captureFile], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, FIXTURE_READ_PATH: readme },
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

const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const daemon = spawn('node', [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: base,
    MERCURY_RECOVERY_BUDGET_MINUTES: '',
    MERCURY_STREAM_IDLE_TIMEOUT_MS: '',
    MERCURY_API_TIMEOUT_MS: '',
    MERCURY_TOOL_DEFER: '0',
    MERCURY_CACHE_CLOCK: '0',
    MERCURY_PARTY: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
  },
  stdio: ['ignore', logFd, logFd],
})
const cleanup = async (): Promise<void> => {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
  }
  for (const p of [daemon, fixture]) {
    try {
      p.kill('SIGTERM')
    } catch {
    }
  }
  if (failures === 0 && process.env.THROTTLE_SEAT_KEEP !== '1') rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

type Leg = {
  arm: string
  sid: string
  notices: number
  waits: string[]
  firstNoticeAt: number | null
  cutAt: number | null
  cut: string | null
  receipt: string | null
  seatStatus: string | null
  seatError: string | null
  landed: boolean
  parentDone: boolean
  paused: WorkRow['paused'] | null
  endedAt: number | null
}
const runLeg = async (arm: string): Promise<Leg> => {
  writePatience(arm === 'hung' ? HUNG_BUDGET_MINUTES : BUDGET_MINUTES)
  const opened = (await daemonControlRpc({
    op: 'concourseDispatch',
    clientMessageId: `throttle-open-${arm}`,
    prompt: 'throttle-open',
    workspaceDir: work,
    title: `throttle ${arm}`,
    model: 'claude-opus-5',
    effort: 'high',
  } as never)) as { ok?: boolean; sessionId?: string; error?: string }
  check(`${arm}: the session opened`, opened.ok === true && typeof opened.sessionId === 'string', JSON.stringify(opened))
  const sid = opened.sessionId ?? ''
  await untilAsync(() => parentTranscript(sid).includes('fixture answers') && readFacts(sid)?.busy === false, 45_000, 50)
  const granted = (await daemonControlRpc({ op: 'sessionControl', action: 'grant-workflows', sessionId: sid, by: 'seat-drive' } as never)) as { ok?: boolean; outcome?: string; error?: string; detail?: string }
  check(`${arm}: the session holds the workflows-allowed tag`, granted.ok === true && (granted.outcome === undefined || granted.outcome === 'applied' || granted.outcome === 'noop'), JSON.stringify(granted))
  const reply = (await daemonControlRpc({
    op: 'concourseDispatch',
    clientMessageId: `throttle-${arm}`,
    prompt: `throttle-run: ${arm}`,
    workspaceDir: work,
    title: `throttle ${arm}`,
    model: 'claude-opus-5',
    effort: 'high',
    targetSessionId: sid,
  } as never)) as { ok?: boolean; sessionId?: string; error?: string }
  check(`${arm}: the ask delivered into the opened session`, reply.ok === true && reply.sessionId === sid, JSON.stringify(reply))
  const leg: Leg = { arm, sid, notices: 0, waits: [], firstNoticeAt: null, cutAt: null, cut: null, receipt: null, seatStatus: null, seatError: null, landed: false, parentDone: false, paused: null, endedAt: null }
  const t0 = Date.now()
  legStarts.set(arm, t0)
  let sawBusy = false
  while (Date.now() - t0 < LEG_MS) {
    for (const row of seatRows(sid)) {
      if (typeof row.wait === 'string' && row.wait !== '' && leg.waits[leg.waits.length - 1] !== row.wait) leg.waits.push(row.wait)
      if (typeof row.status === 'string') leg.seatStatus = row.status
      if (typeof row.error === 'string') leg.seatError = row.error
    }
    const n = noticeCount(sid)
    if (n > 0 && leg.firstNoticeAt === null) leg.firstNoticeAt = Date.now()
    leg.notices = n
    if (leg.cut === null) {
      const cut = cutRow(sid)
      if (cut !== null) {
        leg.cut = cut
        leg.cutAt = Date.now()
      }
    }
    if (parentTranscript(sid).includes('parent done')) {
      leg.parentDone = true
      break
    }
    const busy = readFacts(sid)?.busy
    if (busy === true) sawBusy = true
    if (sawBusy && busy === false) break
    await sleep(40)
  }
  await untilAsync(() => receiptOf(sid) !== null, 5_000, 50)
  leg.receipt = receiptOf(sid)
  await untilAsync(() => seatRows(sid).length > 0 && seatRows(sid).every(row => row.status !== 'running'), 5_000, 50)
  for (const row of seatRows(sid)) {
    if (typeof row.status === 'string') leg.seatStatus = row.status
    if (typeof row.error === 'string') leg.seatError = row.error
  }
  leg.paused = pausedOf(sid)
  leg.endedAt = Date.now()
  leg.notices = noticeCount(sid)
  leg.landed = /recovered after busy|slow but alive/.test(seatTranscript(sid))
  try {
    await daemonControlRpc({ op: 'sessionControl', action: 'revoke-workflows', sessionId: sid, by: 'seat-drive' } as never)
    await daemonControlRpc({ op: 'sessionControl', action: 'stop', sessionId: sid, by: 'seat-drive' } as never)
  } catch {
  }
  return leg
}
const cutAfterMs = (leg: Leg): number | null => (leg.cutAt !== null && leg.firstNoticeAt !== null ? leg.cutAt - leg.firstNoticeAt : null)
const gapsOf = (arm: string, status: number): number[] => {
  const answers = wire().filter(c => c.kind === 'answered' && c.arm === arm && c.route === 'seat' && c.status === status)
  return answers.slice(1).map((c, i) => c.at - answers[i]!.at)
}
const printLeg = (leg: Leg): void => {
  console.log(`  [table] ${leg.arm}: notices=${leg.notices} cut=${leg.cut === null ? 'none' : `${cutAfterMs(leg)} ms after the first notice`} seat=${leg.seatStatus ?? '?'} landed=${leg.landed}`)
  for (const w of leg.waits) console.log(`  [table]   row: ${w}`)
  console.log(`  [table]   receipt: ${leg.receipt === null ? '(none)' : leg.receipt.slice(0, 220)}`)
  if (leg.cut !== null) console.log(`  [table]   cut row: ${leg.cut.slice(0, 220)}`)
}

const ARMS = (process.env.THROTTLE_SEAT_ARMS ?? '429-retry-after,429-bare,529,quiet,drop,slow,window,hung').split(',').map(s => s.trim()).filter(s => s !== '')
const legs: Leg[] = []
const legStarts = new Map<string, number>()
const t0Of = (leg: Leg): number => legStarts.get(leg.arm) ?? 0
console.log('throttled seat — the retry budget under each provider answer, on the real daemon')
try {
  check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
  for (const arm of ARMS) {
    console.log(`\n── ${arm} ──`)
    const leg = await runLeg(arm)
    legs.push(leg)
    printLeg(leg)
    check(`${arm}: the parent's turn ended`, leg.parentDone, `waits=${leg.waits.length} notices=${leg.notices}`)
    const busy = /provider busy \(HTTP 429\) — waiting \d+ s before retry \d+ of \d+/
    const spent = /the provider refused \d+ times? in a row \(HTTP (429, busy|529, overloaded)\) — the 6s retry budget is spent/
    const near = (ms: number | null): boolean => ms !== null && ms >= BUDGET_MS - 1_500 && ms <= BUDGET_MS + 4_000
    if (arm === '429-retry-after') {
      check('L1 the header\'s wait is honoured: the refusals land two seconds apart', gapsOf(arm, 429).length >= 2 && gapsOf(arm, 429).every(g => g >= 1_700), JSON.stringify(gapsOf(arm, 429)))
      check('L1 the row names the answer and the wait', leg.waits.some(w => busy.test(w) && /waiting 2 s/.test(w)), leg.waits.join(' | '))
      check('L1 the row names the budget left', leg.waits.some(w => /of the 6s retry budget left$/.test(w)), leg.waits.join(' | '))
      check('L1 the third refusal spends the budget: the seat stops typed', leg.cut !== null && leg.notices >= 3, `cut=${leg.cut} notices=${leg.notices}`)
      check('L1 the cut fires at the budget, on the harness clock', near(cutAfterMs(leg)), String(cutAfterMs(leg)))
      check('L1 the receipt names the refusals and the budget', leg.receipt !== null && spent.test(leg.receipt) && /HTTP 429/.test(leg.receipt), leg.receipt ?? '(none)')
      check('L1 the seat row settled failed with the spent line as its reason', leg.seatStatus === 'failed' && leg.seatError !== null && /retry budget is spent/.test(leg.seatError), `${leg.seatStatus} ${leg.seatError}`)
    }
    if (arm === '429-bare') {
      check('L2 no header: the ladder\'s own back-off (the first gap under 1.5 s)', gapsOf(arm, 429).length >= 2 && gapsOf(arm, 429)[0]! < 1_500, JSON.stringify(gapsOf(arm, 429)))
      check('L2 the row names the answer and the wait', leg.waits.some(w => busy.test(w)), leg.waits.join(' | '))
      check('L2 the budget is spent and the seat stops typed at the budget', leg.cut !== null && near(cutAfterMs(leg)), `cut=${leg.cut} after=${cutAfterMs(leg)}`)
      check('L2 the receipt names the refusals and the budget', leg.receipt !== null && spent.test(leg.receipt) && /HTTP 429/.test(leg.receipt), leg.receipt ?? '(none)')
    }
    if (arm === '529') {
      check('L3 the row names the overload and the wait', leg.waits.some(w => /provider overloaded \(HTTP 529\) — waiting \d+ s before retry \d+ of \d+/.test(w)), leg.waits.join(' | '))
      check('L3 the overloads end the seat typed and the receipt names them', leg.seatStatus === 'failed' && leg.receipt !== null && /overload/i.test(leg.receipt), `${leg.seatStatus} ${leg.receipt ?? '(none)'}`)
    }
    if (arm === 'quiet' || arm === 'drop') {
      const cause = arm === 'quiet' ? 'the stream went quiet' : 'the stream dropped'
      const tag = arm === 'quiet' ? 'L4' : 'L5'
      const seatHits = wire().filter(c => c.kind === 'request' && c.arm === arm && c.route === 'seat')
      check(`${tag} the wire saw the recovery: streamed tries, the non-streamed fallback, then the busy answer and the reply`, seatHits.some(c => c.streaming === false) && wire().some(c => c.kind === 'answered' && c.arm === arm && c.status === 429) && wire().some(c => c.kind === 'answered' && c.arm === arm && c.status === 200 && c.toolResult !== false && c.nth === 2), JSON.stringify(seatHits.map(c => [c.streaming, c.toolResult, c.nth])))
      check(`${tag} the row names the recovery, never a refusal`, leg.waits.some(w => w.startsWith(`${cause} — `) && /up to (\d+ s|\d+m(?: \d+s)?)/.test(w)), leg.waits.join(' | '))
      check(`${tag} the busy answer after the tool call is waited out with the budget whole`, leg.waits.some(w => busy.test(w) && /waiting 1 s/.test(w) && /5 s of the 6s retry budget left$/.test(w)), leg.waits.join(' | '))
      check(`${tag} the seat is never cut and lands`, leg.cut === null && leg.landed, `cut=${leg.cut} landed=${leg.landed}`)
      check(`${tag} the receipt is the seat's reply`, leg.receipt !== null && /recovered after busy/.test(leg.receipt), leg.receipt ?? '(none)')
    }
    if (arm === 'window') {
      const seatRequests = wire().filter(c => c.kind === 'request' && c.arm === arm && c.route === 'seat')
      check('L7 a wait past the budget is the provider\'s window: ONE request, no retry, no notice', seatRequests.length === 1 && leg.notices === 0, `requests=${seatRequests.length} notices=${leg.notices}`)
      check('L7 the seat PAUSES on the window: the roster row carries why and when it resumes by itself', leg.paused !== null && leg.paused.why === 'provider busy' && typeof leg.paused.resumesAtMs === 'number' && leg.paused.resumesAtMs > Date.now() + 2 * 3_600_000, JSON.stringify(leg.paused))
      check('L7 the receipt says the seat paused, leads its trailer with the pause, the countdown and the doors, then the provider\'s own row', leg.receipt !== null && /The subagent paused before returning any output\./.test(leg.receipt) && /Agent execution failed: paused — provider busy · resumes by itself at \d\d:\d\d \(in 2h5\dm\)/.test(leg.receipt) && /a message resumes it now/.test(leg.receipt) && /429/.test(leg.receipt), leg.receipt ?? '(none)')
      check('L7 the seat row settled with the provider\'s row as its reason', leg.seatStatus === 'failed' && leg.seatError !== null && /429/.test(leg.seatError), `${leg.seatStatus} ${leg.seatError}`)
    }
    if (arm === 'hung') {
      const seatRequests = wire().filter(c => c.kind === 'request' && c.arm === arm && c.route === 'seat')
      const nonStreamed = seatRequests.filter(c => c.streaming === false)
      check('L8 a hung wire: the stream, its reissue, then ONE non-streamed answer — never a ladder of ceilings', seatRequests.filter(c => c.streaming === true).length === 2 && nonStreamed.length === 1, JSON.stringify(seatRequests.map(c => [c.streaming, c.nth])))
      check('L8 the seat is cut with the silence named: the stream\'s budget, the fallback\'s ceiling, the model', leg.receipt !== null && /the stream went quiet for 2 s and one non-streamed answer got nothing in 8 s from /.test(leg.receipt) && /no keep-alive arrived/.test(leg.receipt), leg.receipt ?? '(none)')
      check('L8 the seat row settled failed with the same reason', leg.seatStatus === 'failed' && leg.seatError !== null && /the stream went quiet for 2 s/.test(leg.seatError), `${leg.seatStatus} ${leg.seatError}`)
      check('L8 the cut came inside the two budgets and the one ceiling, with slack', leg.endedAt !== null && leg.endedAt - t0Of(leg) < IDLE_MS * 2 + FALLBACK_MS + 12_000, String(leg.endedAt !== null ? leg.endedAt - t0Of(leg) : null))
    }
    if (arm === 'slow') {
      check('L6 a live slow stream raises no notice and no wait words', leg.notices === 0 && leg.waits.length === 0, `notices=${leg.notices} waits=${leg.waits.join(' | ')}`)
      check('L6 the seat lands and the receipt is its reply', leg.landed && leg.cut === null && leg.receipt !== null && /slow but alive/.test(leg.receipt), `landed=${leg.landed} receipt=${leg.receipt}`)
    }
  }
} finally {
  await cleanup()
}

console.log('\n── the table ──')
for (const leg of legs) printLeg(leg)
console.log(failures === 0 ? '\n ✅ THROTTLED SEAT — every answer named, only the refusals spend the budget' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
