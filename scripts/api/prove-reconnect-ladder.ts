#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
if (process.env.MERCURY_CONFIG_DIR === undefined || process.env.MERCURY_CONFIG_DIR === '') {
  process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'reconnect-ladder-home-'))
}
process.env.MERCURY_CREDENTIAL_STORE = 'file'
if (process.env.ANTHROPIC_API_KEY === undefined || process.env.ANTHROPIC_API_KEY === '') process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_RECONNECT_SCALE = '0.01'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_RECOVERY_BUDGET_MINUTES
delete process.env.MERCURY_RECONNECT_BUDGET_MINUTES
delete process.env.MERCURY_MAX_RETRIES

const budget = await import('../../src/services/api/recoveryBudget.js')
const retry = await import('../../src/services/api/withRetry.js')
const { APIConnectionError, APIConnectionTimeoutError, APIError } = await import('../../src/services/api/sdkErrors.js')
const ladder = await import('../../src/services/api/reconnectLadder.js').catch(() => null)
const transport = await import('../../src/services/api/transportEvidence.js')
const apiClient = await import('../../src/services/api/client.js')
const REPO = resolve(import.meta.dir, '..', '..')
const undiciErrors = (await import(join(REPO, 'node_modules/undici/lib/core/errors.js'))) as { ConnectTimeoutError: new (message?: string) => Error }
const { default: Anthropic } = await import('@anthropic-ai/sdk')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nprove-reconnect-ladder: TIMEOUT after 240 s (an unbounded wait somewhere)')
  process.exit(1)
}, 240_000)
guard.unref?.()

type Notice = { type: string; subtype: string; error: Error; errorDetail?: { name: string; message: string; status?: number; code?: string }; retryInMs: number; retryAttempt: number; maxRetries: number }
type Seat = ReturnType<typeof budget.makeRecoveryBudget>
type Drive = { result: unknown; error: unknown; notices: Notice[]; words: string[]; honoured: Array<{ honoredMs: number; spent: boolean }>; charged: Seat; seat: Seat }

const errno = (message: string, code: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error(message), { code, ...extra })
const nodeShape = (inner: Error): Error => new APIConnectionError({ cause: new TypeError('fetch failed', { cause: inner }) })
const refusedNode = (): Error => nodeShape(errno('connect ECONNREFUSED 127.0.0.1:1', 'ECONNREFUSED', { errno: -61, syscall: 'connect', address: '127.0.0.1', port: 1 }))
const dnsNode = (): Error => nodeShape(errno('getaddrinfo ENOTFOUND api.example.invalid', 'ENOTFOUND', { errno: -3008, syscall: 'getaddrinfo', hostname: 'api.example.invalid' }))
const unreachable = (): Error => nodeShape(errno('connect ENETUNREACH 203.0.113.9:443', 'ENETUNREACH', { syscall: 'connect' }))
const undiciConnectTimeout = (): Error => new TypeError('fetch failed', { cause: new undiciErrors.ConnectTimeoutError('Connect Timeout Error (attempted address: 127.0.0.1:1, timeout: 300ms)') })
const bareSdkTimeout = (): Error => new APIConnectionTimeoutError()
const tls = (): Error => nodeShape(errno('certificate has expired', 'CERT_HAS_EXPIRED'))
const proxy407 = (): Error => nodeShape(errno('Proxy response (407) !== 200 when HTTP Tunneling', 'UND_ERR_ABORTED'))
const sandboxed = (): Error => nodeShape(errno('connect EPERM 203.0.113.9:443', 'EPERM', { syscall: 'connect' }))
const stale = (): Error => nodeShape(errno('other side closed', 'UND_ERR_SOCKET'))
const firstByte = (): Error => new APIConnectionTimeoutError({ message: 'no first byte from Opus 5 after 90 s (the request was accepted and nothing arrived)' })
const answered = (status: number): Error => new APIError(status, { type: 'error', error: { type: 'api_error', message: `HTTP ${status}` } }, `${status} answered`, new Headers())

async function refusedByLoopback(): Promise<Error> {
  const server = createServer(s => s.destroy())
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(r => server.close(() => r()))
  const client = new Anthropic({ apiKey: 'proof-key-ci-gate-not-a-real-key', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0, timeout: 2_000 })
  try {
    await client.messages.create({ model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
  } catch (e) {
    return e as Error
  }
  throw new Error('the closed loopback port answered')
}

const pause = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function drive(script: Array<() => unknown>, options: { maxRetries?: number; reconnect?: boolean } = {}): Promise<Drive> {
  const seat = budget.makeRecoveryBudget()
  const notices: Notice[] = []
  const words: string[] = []
  const honoured: Array<{ honoredMs: number; spent: boolean }> = []
  const queue = [...script]
  const gen = retry.withRetry(
    async () => ({}) as never,
    async () => {
      const next = queue.shift()
      if (next === undefined) return 'answer'
      const out = await next()
      if (out instanceof Error) throw out
      return out
    },
    { model: 'claude-x', thinkingConfig: { type: 'disabled' }, ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}), ...(options.reconnect !== undefined ? { reconnect: options.reconnect } : {}) },
  )
  try {
    for (;;) {
      const e = await gen.next()
      if (e.done) {
        const charged = { ...seat }
        if (budget.recoveryAnswerRefills({ type: 'stream_event', event: { type: 'message_start' } })) budget.refillRecoveryBudget(seat)
        return { result: e.value, error: undefined, notices, words, honoured, charged, seat }
      }
      const notice = e.value as unknown as Notice
      notices.push(notice)
      const facts = budget.recoveryNoticeFacts(notice)
      if (facts === null) {
        words.push('<not a notice>')
        continue
      }
      const h = budget.honourRecoveryWait(seat, facts)
      honoured.push({ honoredMs: h.honoredMs, spent: h.spent })
      words.push(budget.retryWaitWords({ facts, honoredMs: h.honoredMs, budget: seat }))
    }
  } catch (error) {
    return { result: undefined, error, notices, words, honoured, charged: { ...seat }, seat }
  }
}

const NETWORK_ROW = /^network unreachable \((connection refused|host not found|no route to the host|the network is down|connect timed out)\) — waiting \d+ s(?: \d+s)? before reconnect \d+(; (\d+ s|\d+m(?: \d+s)?) of the \S+ reconnect budget left|; the \S+ reconnect budget ends with this wait)?$/

section('S1 — the pin: three refused connects then the answer never spend the API recovery budget, and every row names the network')
{
  const loopback = await refusedByLoopback()
  check('the closed loopback port throws the SDK connection-error class with no status', loopback.constructor.name === 'APIConnectionError' && (loopback as { status?: unknown }).status === undefined, `${loopback.constructor.name} ${loopback.message}`)
  const d = await drive([() => loopback, refusedNode, dnsNode])
  check('the answer arrived after three connection failures', d.result === 'answer' && d.error === undefined, String(d.error))
  check('three notices, one per reconnect', d.notices.length === 3, String(d.notices.length))
  const delays = d.notices.map(n => n.retryInMs)
  check('the reconnect back-off doubles from the first wait (5 s → 10 s → 20 s, here at proof scale 50 → 100 → 200 ms) — never the API ladder\'s 500 ms rungs', delays.length === 3 && delays[0] === 50 && delays[1] === 100 && delays[2] === 200, JSON.stringify(delays))
  check('the notices count reconnects 1, 2, 3 on their own ladder', d.notices.map(n => n.retryAttempt).join(',') === '1,2,3', d.notices.map(n => n.retryAttempt).join(','))
  check('THE BUDGET IS UNTOUCHED: the seat road honoured every wait and charged nothing (spentMs 0, no waits, no faults)', d.charged.spentMs === 0 && d.charged.waits === 0 && d.charged.faults === 0, `spentMs=${d.charged.spentMs} waits=${d.charged.waits} faults=${d.charged.faults}`)
  check('every row reads the network grammar', d.words.length === 3 && d.words.every(w => NETWORK_ROW.test(w)), d.words.join(' | '))
  check('the first row names the refusal and the whole reconnect budget', d.words[0] === 'network unreachable (connection refused) — waiting 0 s before reconnect 1; 10m of the 10m reconnect budget left', d.words[0] ?? '')
  check('the DNS failure names the host', /host not found/.test(d.words[2] ?? ''), d.words[2] ?? '')
  check('no row names the provider or "connection lost"', d.words.every(w => !/provider|connection lost|retry budget/.test(w)), d.words.join(' | '))
  check('no wait was declared spent (the reconnect budget has 10 minutes)', d.honoured.every(h => !h.spent), JSON.stringify(d.honoured))
  check('the answer refilled nothing because nothing was spent (0 before the refill, 0 after; the outage cleared off the budget)', d.charged.spentMs === 0 && d.seat.spentMs === 0 && d.charged.outage?.reconnect === 3 && d.seat.outage === undefined, JSON.stringify({ charged: d.charged, seat: d.seat }))
  for (const w of d.words) console.log(`    row: ${w}`)
}

section('S1b — the API ladder resumes with its budget as it was: a 503 before and after the outage are the only charges')
{
  const d = await drive([() => answered(503), refusedNode, refusedNode, () => answered(503)])
  check('the answer arrived', d.result === 'answer', String(d.error))
  check('four notices: fault, reconnect, reconnect, fault', d.notices.length === 4, String(d.notices.length))
  const kinds = d.notices.map(n => budget.recoveryNoticeFacts(n)?.kind ?? '?')
  check('the seat road classes them fault, outage, outage, fault', kinds.join(',') === 'fault,outage,outage,fault', kinds.join(','))
  const first = d.notices[0]?.retryInMs ?? 0
  const last = d.notices[3]?.retryInMs ?? 0
  check('the API ladder\'s rung after the outage is its SECOND rung (about 1 s), not its fourth: the outage spent no API attempt', first >= 500 && first <= 625 && last >= 1_000 && last <= 1_250, `first=${first} last=${last}`)
  check('the seat budget held exactly the two 503 waits, both faults, until the answer refilled it', d.charged.waits === 2 && d.charged.faults === 2 && d.charged.spentMs === first + last && d.seat.spentMs === 0, `waits=${d.charged.waits} faults=${d.charged.faults} spentMs=${d.charged.spentMs}`)
  check('the fault rows keep the provider grammar; the reconnect rows the network grammar', /^provider error \(HTTP 503\) — waiting/.test(d.words[0] ?? '') && NETWORK_ROW.test(d.words[1] ?? '') && NETWORK_ROW.test(d.words[2] ?? '') && /^provider error \(HTTP 503\) — waiting/.test(d.words[3] ?? ''), d.words.join(' | '))
  for (const w of d.words) console.log(`    row: ${w}`)
}

section('S2 — an outage longer than the reconnect budget ends typed with the network named; the API budget still whole')
{
  process.env.MERCURY_RECONNECT_BUDGET_MINUTES = '0.02'
  const d = await drive(Array.from({ length: 12 }, () => refusedNode), { maxRetries: 1 })
  delete process.env.MERCURY_RECONNECT_BUDGET_MINUTES
  const thrown = d.error as { originalError?: unknown } | undefined
  const typed = thrown?.originalError as { reconnectBudgetSpent?: unknown; message?: string; reconnects?: number; capMs?: number } | undefined
  check('the turn ended in the cannot-retry wrapper', d.error instanceof retry.CannotRetryError, String(d.error))
  check('the wrapped error is the typed reconnect-budget-spent stop', typed?.reconnectBudgetSpent === true, String(typed?.message ?? d.error))
  check('the ladder walked 50, 100, 200, 400 ms and then the 450 ms the budget had left (five reconnects), then one zero-wait notice that the budget is spent', d.notices.map(n => n.retryInMs).slice(0, 4).join(',') === '50,100,200,400' && d.notices.length === 6 && (d.notices[4]?.retryInMs ?? 0) > 0 && (d.notices[4]?.retryInMs ?? 0) <= 450 && d.notices[5]?.retryInMs === 0, d.notices.map(n => n.retryInMs).join(','))
  check('the fifth row says the reconnect budget ends with this wait', /; the 1s reconnect budget ends with this wait$/.test(d.words[4] ?? ''), d.words[4] ?? '')
  check('the sixth row says no further reconnect, the budget spent after five', d.words[5] === 'network unreachable (connection refused) — no further reconnect; the 1s reconnect budget is spent after 5 reconnects', d.words[5] ?? '')
  check('the seat road saw the fifth wait as the spending one (the cut lands at its end) and the sixth as an immediate cut (honoured 0, spent), the earlier ones not', d.honoured.slice(0, 4).every(h => !h.spent) && d.honoured[4]?.spent === true && (d.honoured[4]?.honoredMs ?? 0) > 0 && d.honoured[5]?.spent === true && d.honoured[5]?.honoredMs === 0, JSON.stringify(d.honoured))
  check('the typed line names the network, the reconnects, the budget and the way back', /^the network was unreachable through 5 reconnects over \d+ s \(connection refused\) — the 1s reconnect budget is spent and the turn was ended; check the connection and send again, or raise MERCURY_RECONNECT_BUDGET_MINUTES$/.test(typed?.message ?? ''), typed?.message ?? '')
  check('the API recovery budget is whole: nothing charged through the whole outage', d.seat.spentMs === 0 && d.seat.waits === 0, `spentMs=${d.seat.spentMs} waits=${d.seat.waits}`)
  const seatLine = budget.recoveryBudgetSpentLine(d.seat)
  check('the dispatched-agent road: the seat\'s spent line names the network and the way back, never the provider', seatLine === 'the network was unreachable through 5 reconnects (connection refused) — the 1s reconnect budget is spent and the agent stopped; its work is kept — a message to it resumes it, or raise MERCURY_RECONNECT_BUDGET_MINUTES', seatLine)
  check('the workflow rescue recognises it as a spent budget (no re-run against a dead network)', budget.isRecoveryBudgetSpentLine(seatLine), seatLine)
  const cut = new budget.RecoveryBudgetSpentError(d.seat, { declaredMs: d.notices[4]?.retryInMs ?? 0, honoredMs: d.honoured[4]?.honoredMs ?? 0 })
  const cutFacts = budget.recoveryBudgetSpentFactsOf(cut)
  check('the typed cut a sub-agent throws carries the network words, no HTTP status, the reconnect count and the reconnect budget', cut.message === seatLine && cut.lastStatus === undefined && cut.lastCause === 'network unreachable (connection refused)' && cut.waits === 5 && cut.capMs === 1_200 && cutFacts?.words === seatLine, JSON.stringify(cutFacts))
  check('the one automatic resume waits the part of the next rung the budget did not honour (the 600 ms ceiling, nothing honoured on the zero-wait notice)', cutFacts !== null && cutFacts.resumeAfterMs === 600, JSON.stringify(cutFacts))
  for (const w of d.words) console.log(`    row: ${w}`)
  console.log(`    end: ${typed?.message ?? String(d.error)}`)
}

section('S3 — a provider answer during an outage ends the episode: a 503 takes the API ladder (charged) and a later outage opens a fresh ladder')
{
  const d = await drive([refusedNode, unreachable, () => answered(503), dnsNode, refusedNode])
  check('the answer arrived', d.result === 'answer', String(d.error))
  const kinds = d.notices.map(n => budget.recoveryNoticeFacts(n)?.kind ?? '?')
  check('outage, outage, fault, outage, outage', kinds.join(',') === 'outage,outage,fault,outage,outage', kinds.join(','))
  check('the 503 is charged as a fault on the API budget (the only charge)', d.charged.waits === 1 && d.charged.faults === 1 && d.charged.spentMs >= 500 && d.charged.spentMs <= 625, `waits=${d.charged.waits} faults=${d.charged.faults} spentMs=${d.charged.spentMs}`)
  check('the outage after the 503 is a NEW episode: reconnect 1 at the first rung again', d.notices[3]?.retryAttempt === 1 && d.notices[3]?.retryInMs === 50 && d.notices[4]?.retryAttempt === 2 && d.notices[4]?.retryInMs === 100, d.notices.map(n => `${n.retryAttempt}:${n.retryInMs}`).join(','))
  check('the rows name the route, the provider, the host in turn', /connection refused/.test(d.words[0] ?? '') && /no route to the host/.test(d.words[1] ?? '') && /^provider error \(HTTP 503\)/.test(d.words[2] ?? '') && /host not found/.test(d.words[3] ?? ''), d.words.join(' | '))
  for (const w of d.words) console.log(`    row: ${w}`)
}

section('S4 — not an outage: a TLS failure, a proxy 407, a sandbox refusal, a stale socket, the first-byte timeout and any answered status keep today\'s road')
{
  const classify = (e: unknown): string | null => (ladder === null ? '<no ladder module>' : (ladder.outageCauseOf(e)?.words ?? null))
  check('a TLS certificate failure is not an outage', classify(tls()) === null, String(classify(tls())))
  check('a proxy 407 is not an outage', classify(proxy407()) === null, String(classify(proxy407())))
  check('a sandbox refusal (EPERM at connect) is not an outage', classify(sandboxed()) === null, String(classify(sandboxed())))
  check('a stale keep-alive socket is not an outage (the pool rebuild heals it)', classify(stale()) === null && retry.isStaleConnectionError(stale()), String(classify(stale())))
  check('the first-byte timeout is not an outage (the connection was made; the provider stalled)', classify(firstByte()) === null, String(classify(firstByte())))
  check('a provider that answered any status is never an outage', classify(answered(503)) === null && classify(answered(429)) === null && classify(answered(407)) === null)
  check('a bare Error carrying a connect code is not an outage (only the SDK\'s class is)', classify(errno('connect ECONNREFUSED', 'ECONNREFUSED')) === null)
  check('a cause-less connection error is not an outage (nothing says it heals by waiting)', classify(new APIConnectionError({})) === null)
  check('the outage signatures: refused (Node and Bun), DNS, unreachable', classify(refusedNode()) === 'connection refused' && classify(dnsNode()) === 'host not found' && classify(unreachable()) === 'no route to the host' && classify(nodeShape(errno('EAI_AGAIN', 'EAI_AGAIN'))) === 'host not found', [refusedNode(), dnsNode(), unreachable()].map(classify).join(','))
  const d = await drive([tls])
  check('driven: the TLS failure rides the API ladder as a fault and is charged', d.result === 'answer' && d.notices.length === 1 && budget.recoveryNoticeFacts(d.notices[0])?.kind === 'fault' && d.charged.faults === 1 && d.charged.spentMs >= 500, `${d.words.join(' | ')} spentMs=${d.charged.spentMs}`)
  check('driven: its row keeps today\'s words', /^connection lost — waiting 1 s before retry 1 of 10; /.test(d.words[0] ?? ''), d.words[0] ?? '')
  const fb = await drive([firstByte])
  check('driven: the first-byte timeout rides the API ladder as a fault named "no first byte"', fb.result === 'answer' && fb.notices.length === 1 && budget.recoveryNoticeFacts(fb.notices[0])?.cause === 'no first byte' && fb.charged.faults === 1, fb.words.join(' | '))
  const off = await drive([refusedNode], { maxRetries: 0 })
  check('MERCURY_MAX_RETRIES=0 turns the reconnect ladder off with every other retry: the refused connect ends the turn at once', off.error instanceof retry.CannotRetryError && off.notices.length === 0 && (off.error as { originalError?: unknown }).originalError === undefined === false, String(off.error))
  const probe = await drive([refusedNode, refusedNode], { maxRetries: 2, reconnect: false })
  check('a caller that opts out (the latency-sensitive key probe) keeps the API ladder for a refused connect: charged faults, no reconnect rows', probe.result === 'answer' && probe.notices.length === 2 && probe.words.every(w => /^connection lost — waiting/.test(w)) && probe.charged.faults === 2, probe.words.join(' | '))
  const src = await Bun.file('src/services/providers/anthropic/requestParams.ts').text()
  check('the key probe opts out at its call', /maxRetries: 2, model, thinkingConfig: \{ type: 'disabled' \}, reconnect: false \}/.test(src))
}

section('S5 — the ladder\'s own arithmetic at scale 1 with an injected clock, and the knob')
if (ladder === null) {
  check('the reconnect ladder module exists', false, 'src/services/api/reconnectLadder.ts is absent')
} else {
  delete process.env.MERCURY_RECONNECT_SCALE
  const cause = { code: 'ECONNREFUSED', words: 'connection refused' }
  const l = ladder.openReconnectLadder(0, cause, 10 * 60_000, 1)
  const steps: Array<NonNullable<ReturnType<typeof ladder.nextReconnect>>> = []
  let clock = 0
  for (let i = 0; i < 6; i++) {
    const s = ladder.nextReconnect(l, cause, clock)
    if (s === null) break
    steps.push(s)
    clock += s.waitMs + 20
  }
  check('5 s, 10 s, 20 s, 40 s, 60 s, 60 s — doubling to the ceiling', steps.map(s => s.waitMs).join(',') === '5000,10000,20000,40000,60000,60000', steps.map(s => s.waitMs).join(','))
  check('the first row says the cap admits 13 reconnects in 10 minutes', steps[0]?.of === 13, String(steps[0]?.of))
  check('the second row at scale 1 reads the brief\'s grammar', budget.outageWaitWords(steps[1]!) === 'network unreachable (connection refused) — waiting 10 s before reconnect 2; 9m 45s of the 10m reconnect budget left', budget.outageWaitWords(steps[1]!))
  const past = ladder.openReconnectLadder(0, cause, 6 * 60_000, 1)
  const atCap = ladder.nextReconnect(past, cause, 6 * 60_000)
  const pastCap = ladder.nextReconnect(past, cause, 6 * 60_000 + 1)
  check('past the wall clock the ladder is spent: a zero-wait spent step, no reconnect counted', atCap.spent && atCap.waitMs === 0 && atCap.reconnect === 0 && pastCap.spent && pastCap.waitMs === 0 && past.reconnects === 0, JSON.stringify([atCap, pastCap]))
  check('the zero-wait spent step spells the row that says so', budget.outageWaitWords(atCap) === 'network unreachable (connection refused) — no further reconnect; the 6m reconnect budget is spent after 0 reconnects', budget.outageWaitWords(atCap))
  const clipped = ladder.openReconnectLadder(0, cause, 12_000, 1)
  const c1 = ladder.nextReconnect(clipped, cause, 0)
  const c2 = ladder.nextReconnect(clipped, cause, 5_000)
  check('a rung longer than the remainder is clipped to it and marked as the last', c1?.waitMs === 5_000 && !c1.spent && c2?.waitMs === 7_000 && c2.spent && c2.rungMs === 10_000, JSON.stringify([c1, c2]))
  check('the clipped row says so', budget.outageWaitWords(c2!) === 'network unreachable (connection refused) — waiting 7 s before reconnect 2; the 12s reconnect budget ends with this wait', budget.outageWaitWords(c2!))
  const free = ladder.openReconnectLadder(0, cause, Infinity, 1)
  const f1 = ladder.nextReconnect(free, cause, 0)
  check('a budget that is off names no budget and is never spent', f1 !== null && !f1.spent && f1.leftMs === Infinity && budget.outageWaitWords(f1) === 'network unreachable (connection refused) — waiting 5 s before reconnect 1', f1 === null ? 'null' : budget.outageWaitWords(f1))
  check('the knob: unset ⇒ 10 minutes', ladder.reconnectBudgetMs() === 10 * 60_000, String(ladder.reconnectBudgetMs()))
  process.env.MERCURY_RECONNECT_BUDGET_MINUTES = '6'
  check('the knob: 6 ⇒ six minutes', ladder.reconnectBudgetMs() === 6 * 60_000)
  process.env.MERCURY_RECONNECT_BUDGET_MINUTES = '0'
  check('the knob: 0 ⇒ no bound', ladder.reconnectBudgetMs() === Infinity)
  process.env.MERCURY_RECONNECT_BUDGET_MINUTES = 'junk'
  check('the knob: junk ⇒ the default', ladder.reconnectBudgetMs() === 10 * 60_000)
  process.env.MERCURY_RECONNECT_BUDGET_MINUTES = '-3'
  check('the knob: a negative ⇒ the default', ladder.reconnectBudgetMs() === 10 * 60_000)
  process.env.MERCURY_RECONNECT_BUDGET_MINUTES = '1e8'
  check('the knob: a day is the most it accepts (1e8 minutes read as 1440)', ladder.reconnectBudgetMs() === 1440 * 60_000 && ladder.RECONNECT_BUDGET_MAX_MINUTES === 1440, String(ladder.reconnectBudgetMs()))
  process.env.MERCURY_RECONNECT_BUDGET_MINUTES = '1e12'
  check('the knob: 1e12 too', ladder.reconnectBudgetMs() === 1440 * 60_000)
  delete process.env.MERCURY_RECONNECT_BUDGET_MINUTES
  const bruteCount = (first: number, ceiling: number, from: number, left: number): number => {
    let n = 0
    for (let rung = from; left > 0; rung++) {
      n++
      left -= Math.min(Math.min(first * 2 ** (rung - 1), ceiling), left)
    }
    return n
  }
  const shapes: Array<[number, number, number, number]> = [[5_000, 60_000, 2, 595_000], [5_000, 60_000, 1, 600_000], [5_000, 60_000, 5, 12_345], [5_000, 60_000, 1, 4_000], [50, 600, 2, 599_950], [5_000, 60_000, 1, 86_400_000], [5_000, 5_000, 1, 33_333], [7, 9, 1, 100]]
  check('the reconnect count is the closed form of the ladder: it agrees with a brute walk on eight shapes', shapes.every(([first, ceiling, from, left]) => ladder.reconnectsWithin({ firstWaitMs: first, ceilingMs: ceiling }, from, left) === bruteCount(first, ceiling, from, left)), shapes.map(([first, ceiling, from, left]) => `${ladder.reconnectsWithin({ firstWaitMs: first, ceilingMs: ceiling }, from, left)}/${bruteCount(first, ceiling, from, left)}`).join(' '))
  const wide = ladder.openReconnectLadder(0, cause, 1440 * 60_000, 1)
  const t0 = performance.now()
  for (let i = 0; i < 1_000; i++) ladder.nextReconnect({ ...wide, reconnects: 0 }, cause, 0)
  const perNotice = (performance.now() - t0) / 1_000
  check('a notice at the widest budget costs the event loop under a tenth of a millisecond', perNotice < 0.1, `${perNotice.toFixed(4)} ms per notice`)
  check('the count at the widest budget: 4 doubling rungs, then a 60 s rung a minute for the day', ladder.nextReconnect({ ...wide, reconnects: 0 }, cause, 0).of === 4 + Math.ceil((1440 * 60_000 - 75_000) / 60_000), String(ladder.nextReconnect({ ...wide, reconnects: 0 }, cause, 0).of))
  check('the constants are named', ladder.RECONNECT_FIRST_WAIT_MS === 5_000 && ladder.RECONNECT_WAIT_CEILING_MS === 60_000 && ladder.RECONNECT_BUDGET_DEFAULT_MINUTES === 10)
  const turnLine = new ladder.ReconnectBudgetSpentError(l, 10 * 60_000 + 12_000, refusedNode()).message
  check('the turn\'s typed end at scale 1', turnLine === 'the network was unreachable through 6 reconnects over 10m 12s (connection refused) — the 10m reconnect budget is spent and the turn was ended; check the connection and send again, or raise MERCURY_RECONNECT_BUDGET_MINUTES', turnLine)
  check('the seat\'s typed end at scale 1', budget.outageSpentLine({ cause: 'network unreachable (host not found)', reconnects: 13, capMs: 10 * 60_000 }, 'seat') === 'the network was unreachable through 13 reconnects (host not found) — the 10m reconnect budget is spent and the agent stopped; its work is kept — a message to it resumes it, or raise MERCURY_RECONNECT_BUDGET_MINUTES')
  check('one reconnect spells singular', /through 1 reconnect \(/.test(budget.outageSpentLine({ cause: 'network unreachable (connection refused)', reconnects: 1, capMs: 5_000 }, 'seat')))
  const notice = { type: 'system', subtype: 'api_error', error: new ladder.NetworkOutageError(steps[2]!, refusedNode()), errorDetail: { name: 'NetworkOutageError', message: budget.outageWaitWords(steps[2]!) }, retryInMs: 20_000, retryAttempt: 3, maxRetries: 13 }
  const live = budget.recoveryNoticeFacts(notice)
  check('a live outage notice reads as the outage class with its facts', live?.kind === 'outage' && live.declaredMs === 20_000 && live.attempt === 3 && live.outage?.leftMs === steps[2]!.leftMs && live.cause === 'network unreachable (connection refused)', JSON.stringify(live))
  const tripped = budget.recoveryNoticeFacts(JSON.parse(JSON.stringify(notice)))
  check('the same notice after a JSONL round trip still reads as the outage class with the same words (the facts ride the row)', tripped?.kind === 'outage' && tripped.outage?.leftMs === steps[2]!.leftMs && budget.retryWaitWords({ facts: tripped, honoredMs: 20_000, budget: budget.makeRecoveryBudget() }) === budget.outageWaitWords(steps[2]!), JSON.stringify(tripped))
  const nameOnly = budget.recoveryNoticeFacts({ ...notice, error: {} })
  check('a row that kept only errorDetail (error {}) still reads as the outage class off the name, and its words are the row\'s own', nameOnly?.kind === 'outage' && nameOnly.outage === undefined && nameOnly.cause === 'network unreachable (connection refused)' && budget.retryWaitWords({ facts: nameOnly, honoredMs: 20_000, budget: budget.makeRecoveryBudget() }) === budget.outageWaitWords(steps[2]!), JSON.stringify(nameOnly))
  const nameOnlyBudget = budget.makeRecoveryBudget(6_000)
  const nameOnlyHonoured = budget.honourRecoveryWait(nameOnlyBudget, nameOnly!)
  check('…and is honoured whole without a charge', nameOnlyHonoured.honoredMs === 20_000 && !nameOnlyHonoured.spent && nameOnlyBudget.spentMs === 0 && nameOnlyBudget.waits === 0, JSON.stringify(nameOnlyBudget))
  const b = budget.makeRecoveryBudget(6_000)
  budget.honourRecoveryWait(b, budget.recoveryNoticeFacts({ type: 'system', subtype: 'api_error', error: answered(429), errorDetail: { name: 'Error', message: '429', status: 429 }, retryInMs: 2_000, retryAttempt: 1, maxRetries: 10 })!)
  const afterOutage = budget.honourRecoveryWait(b, live!)
  check('an outage wait on a budget already carrying a refusal charges nothing and clears the refusal as the newest answer', afterOutage.honoredMs === 20_000 && !afterOutage.spent && b.spentMs === 2_000 && b.waits === 1 && b.lastStatus === undefined && b.outage?.reconnect === 3, JSON.stringify(b))
  budget.honourRecoveryWait(b, budget.recoveryNoticeFacts({ type: 'system', subtype: 'api_error', error: answered(503), errorDetail: { name: 'Error', message: '503', status: 503 }, retryInMs: 1_000, retryAttempt: 2, maxRetries: 10 })!)
  check('the next provider answer clears the outage off the budget', b.outage === undefined && b.lastStatus === 503 && b.spentMs === 3_000, JSON.stringify(b))
  check('the existing spent lines and their predicate are unchanged', budget.isRecoveryBudgetSpentLine('the provider refused 3 times in a row (HTTP 429, busy) — the 6s retry budget is spent and the agent stopped; its work is kept — a message to it resumes it, or raise MERCURY_RECOVERY_BUDGET_MINUTES') && !budget.isRecoveryBudgetSpentLine('API Error: the network was unreachable through 5 reconnects (connection refused)'))
}

const NODE_SHAPE_SCRIPT = `
import net from 'node:net'
import { pathToFileURL } from 'node:url'
const [repo, mode] = process.argv.slice(2)
const { default: Anthropic } = await import(pathToFileURL(repo + '/node_modules/@anthropic-ai/sdk/index.mjs').href)
const undici = await import(pathToFileURL(repo + '/node_modules/undici/index.js').href)
const held = []
const server = net.createServer(c => { c.on('error', () => {}); held.push(c) })
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const ring = []
const deep = e => { let n = e; let hops = 0; const out = { name: e?.name, ctor: e?.constructor?.name }; while (n && typeof n === 'object' && hops < 6) { if (typeof n.code === 'string') { out.code = n.code; out.codeCtor = n.constructor?.name } n = n.cause; hops++ } return out }
const fetchImpl = async (input, init) => { try { return await undici.fetch(input, init) } catch (e) { ring.push(deep(e)); throw e } }
const dispatcher = new undici.Agent({ connect: { timeout: 300 }, connections: 1, pipelining: 1 })
const baseURL = (mode === 'stall' ? 'https' : 'http') + '://127.0.0.1:' + port
const client = new Anthropic({ apiKey: 'proof-key-ci-gate-not-a-real-key', baseURL, maxRetries: 0, timeout: mode === 'stall' ? 3000 : 300, fetch: fetchImpl, fetchOptions: { dispatcher } })
const t0 = Date.now()
let out
try { await client.messages.create({ model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }); out = { answered: true } }
catch (e) { out = { top: e?.constructor?.name, hasCause: e?.cause !== undefined, message: String(e?.message ?? '').slice(0, 80) } }
out.ms = Date.now() - t0
out.ring = ring
console.log(JSON.stringify(out))
for (const c of held) c.destroy()
server.close()
`

type NodeShape = { top?: string; hasCause?: boolean; message?: string; ms?: number; answered?: boolean; ring?: Array<{ name?: string; ctor?: string; code?: string; codeCtor?: string }> }
function nodeRuntimeShape(mode: 'stall' | 'accepted'): NodeShape | { failed: string } {
  const node = Bun.which('node')
  if (node === null) return { failed: 'no node on PATH' }
  const dir = mkdtempSync(join(tmpdir(), 'reconnect-shape-'))
  const script = join(dir, 'shape.mjs')
  writeFileSync(script, NODE_SHAPE_SCRIPT)
  const run = spawnSync(node, [script, REPO, mode], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, NODE_OPTIONS: '' } })
  const line = run.stdout.trim().split('\n').at(-1) ?? ''
  try {
    return JSON.parse(line) as NodeShape
  } catch {
    return { failed: `${run.stderr.slice(0, 300)} ${line.slice(0, 200)}`.trim() }
  }
}

section('S6 — connect timeouts: the SDK drops their cause on the production runtime; the transport ring the client wrapper fills tells them from an accepted connection that stalled')
{
  process.env.MERCURY_RECONNECT_SCALE = '0.01'
  const stall = nodeRuntimeShape('stall')
  const accepted = nodeRuntimeShape('accepted')
  const stallShape = stall as NodeShape
  const acceptedShape = accepted as NodeShape
  check('node + undici: a TLS handshake that never answers ends in undici\'s connect timeout — the SDK rethrows it as a bare timeout with the cause dropped', !('failed' in stall) && stallShape.top === 'APIConnectionTimeoutError' && stallShape.hasCause === false && (stallShape.ms ?? 9_999) < 2_500, JSON.stringify(stall))
  check('…and what the fetch rejected with, as the client wrapper records it, carries UND_ERR_CONNECT_TIMEOUT', !('failed' in stall) && stallShape.ring?.[0]?.code === 'UND_ERR_CONNECT_TIMEOUT' && stallShape.ring?.[0]?.codeCtor === 'ConnectTimeoutError', JSON.stringify(stallShape.ring))
  check('node + undici: a listener that accepts and never answers ends in the SDK\'s own deadline — the same bare timeout class, no cause', !('failed' in accepted) && acceptedShape.top === 'APIConnectionTimeoutError' && acceptedShape.hasCause === false && (acceptedShape.ms ?? 9_999) < 2_500, JSON.stringify(accepted))
  check('…and its fetch rejection is an abort with no transport code: the ring tells the two apart', !('failed' in accepted) && acceptedShape.ring?.[0]?.code === undefined && /abort/i.test(acceptedShape.ring?.[0]?.name ?? ''), JSON.stringify(acceptedShape.ring))
  const classify = (e: unknown): string | null => (ladder === null ? '<no ladder module>' : (ladder.outageCauseOf(e)?.words ?? null))
  transport._resetTransportEvidenceForTesting()
  check('a bare SDK timeout with an empty ring is not an outage', classify(bareSdkTimeout()) === null && classify(firstByte()) === null)
  transport.recordTransportFailure(undiciConnectTimeout(), 'http://127.0.0.1:1/v1/messages')
  check('the same bare timeout right after undici\'s connect-timeout rejection is an outage — through the first-byte rewrite too', classify(bareSdkTimeout()) === 'connect timed out' && classify(firstByte()) === 'connect timed out', `${classify(bareSdkTimeout())} ${classify(firstByte())}`)
  check('a ring entry older than the window does not count', ladder !== null && ladder.connectTimeoutFromTransportRing(Date.now() + ladder.CONNECT_TIMEOUT_RING_WINDOW_MS + 1) === null)
  transport.recordTransportFailure(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }), 'http://127.0.0.1:1/v1/messages')
  check('after the SDK\'s own abort the bare timeout is not an outage again', classify(bareSdkTimeout()) === null && classify(firstByte()) === null)
  transport.recordTransportFailure(nodeShape(errno('connect ETIMEDOUT 203.0.113.9:443', 'ETIMEDOUT', { syscall: 'connect' })), 'http://127.0.0.1:1/v1/messages')
  check('an OS connect timeout in the ring counts', classify(bareSdkTimeout()) === 'connect timed out')
  transport.recordTransportFailure(nodeShape(errno('read ETIMEDOUT', 'ETIMEDOUT', { syscall: 'read' })), 'http://127.0.0.1:1/v1/messages')
  check('a read timeout on an established socket does not', classify(bareSdkTimeout()) === null)
  transport._resetTransportEvidenceForTesting()
  const client = await apiClient.getAnthropicClient({ maxRetries: 0, fetchOverride: (async () => { throw undiciConnectTimeout() }) as unknown as typeof fetch, source: 'proof' })
  const sdkCall = async (): Promise<unknown> => client.messages.create({ model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
  const d = await drive([sdkCall, sdkCall], { maxRetries: 2 })
  check('driven through the real client wrapper and the real SDK: two connect timeouts take the reconnect ladder', d.result === 'answer' && d.notices.length === 2 && d.notices.every(n => budget.recoveryNoticeFacts(n)?.kind === 'outage'), `${d.words.join(' | ')} ${String(d.error)}`)
  check('the rows name the connect timeout and the ladder\'s rungs', /^network unreachable \(connect timed out\) — waiting 0 s before reconnect 1; 10m of the 10m reconnect budget left$/.test(d.words[0] ?? '') && d.notices.map(n => n.retryInMs).join(',') === '50,100', d.words.join(' | '))
  check('the notice carries the transport code for the row\'s suffix', d.notices[0]?.errorDetail?.code === 'UND_ERR_CONNECT_TIMEOUT' && d.notices[0]?.errorDetail?.name === 'NetworkOutageError', JSON.stringify(d.notices[0]?.errorDetail))
  check('the API budget is untouched', d.charged.spentMs === 0 && d.charged.waits === 0, JSON.stringify(d.charged))
  const sockets = new Set<Socket>()
  const silent = createServer(s => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)) })
  await new Promise<void>(r => silent.listen(0, '127.0.0.1', r))
  const silentPort = (silent.address() as { port: number }).port
  const savedBase = process.env.ANTHROPIC_BASE_URL
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${silentPort}`
  const realClient = await apiClient.getAnthropicClient({ maxRetries: 0, source: 'proof' })
  process.env.ANTHROPIC_BASE_URL = savedBase
  const realAccepted = async (): Promise<unknown> => realClient.messages.create({ model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }, { timeout: 300 })
  const a = await drive([realAccepted, realAccepted], { maxRetries: 2 })
  check('a real loopback listener that accepts and never answers, under a 300 ms SDK deadline, stays on the API ladder as a charged fault (the accepted connection is the provider\'s stall)', a.result === 'answer' && a.notices.length === 2 && a.notices.every(n => budget.recoveryNoticeFacts(n)?.kind === 'fault') && a.charged.faults === 2 && a.charged.spentMs >= 1_500, `${a.words.join(' | ')} ${String(a.error)} charged=${JSON.stringify(a.charged)}`)
  check('the ring\'s newest entry for that stall is the deadline\'s abort, never a connect-timeout code', transport.recentTransportFailure() !== undefined && !['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(transport.recentTransportFailure()?.code ?? ''), JSON.stringify(transport.recentTransportFailure()))
  for (const s of sockets) s.destroy()
  await new Promise<void>(r => silent.close(() => r()))
  for (const w of [...d.words, ...a.words]) console.log(`    row: ${w}`)
}

section('S7 — a dispatched agent keeps its typed stop when the reconnect budget runs out between notices (failing attempts that outrun the time left)')
{
  process.env.MERCURY_RECONNECT_BUDGET_MINUTES = '0.0066667'
  const slowRefusal = async (): Promise<Error> => {
    await pause(150)
    return refusedNode()
  }
  let cutScheduled = false
  let cutAtOnce = false
  const seat = budget.makeRecoveryBudget()
  const notices: Notice[] = []
  const words: string[] = []
  let thrown: unknown
  const gen = retry.withRetry(async () => ({}) as never, async () => { throw await slowRefusal() }, { model: 'claude-x', thinkingConfig: { type: 'disabled' }, maxRetries: 2 })
  try {
    for (;;) {
      const e = await gen.next()
      if (e.done) break
      const notice = e.value as unknown as Notice
      notices.push(notice)
      const facts = budget.recoveryNoticeFacts(notice)
      if (facts === null) continue
      const h = budget.honourRecoveryWait(seat, facts)
      words.push(budget.retryWaitWords({ facts, honoredMs: h.honoredMs, budget: seat }))
      if (h.spent && h.honoredMs <= 0) cutAtOnce = true
      if (h.spent) cutScheduled = true
    }
  } catch (error) {
    thrown = error
  }
  delete process.env.MERCURY_RECONNECT_BUDGET_MINUTES
  const typed = (thrown as { originalError?: { reconnectBudgetSpent?: unknown; message?: string } } | undefined)?.originalError
  check('150 ms failing attempts against a 400 ms budget: the run ends in the typed reconnect-budget-spent stop', thrown instanceof retry.CannotRetryError && typed?.reconnectBudgetSpent === true, String(thrown))
  check('the last notice before the throw is the zero-wait spent notice (not clipped: the attempt itself outran the time left)', notices.length >= 2 && notices.at(-1)?.retryInMs === 0 && notices.slice(0, -1).every(n => n.retryInMs > 0), notices.map(n => n.retryInMs).join(','))
  check('the seat road scheduled a budget cut: true — and at once (nothing to wait)', cutScheduled && cutAtOnce, JSON.stringify({ cutScheduled, cutAtOnce }))
  const seatLine = budget.recoveryBudgetSpentLine(seat)
  const cut = new budget.RecoveryBudgetSpentError(seat, { declaredMs: 0, honoredMs: 0 })
  const facts = budget.recoveryBudgetSpentFactsOf(cut)
  check('the typed cut runAgent throws carries the seat\'s network line and the reconnect count', cut.message === seatLine && /^the network was unreachable through \d+ reconnects? \(connection refused\) — the 0s reconnect budget is spent and the agent stopped; its work is kept — a message to it resumes it, or raise MERCURY_RECONNECT_BUDGET_MINUTES$/.test(seatLine) && cut.waits === seat.outage?.reconnect, seatLine)
  check('recoveryBudgetSpentFactsOf(the cut) is read, so the one automatic resume arms; it waits the next rung', facts !== null && facts.words === seatLine && facts.resumeAfterMs === (seat.outage?.rungMs ?? -1), JSON.stringify(facts))
  check('the API budget is whole', seat.spentMs === 0 && seat.waits === 0, JSON.stringify(seat))
  check('the row text the turn carries is recognised as the spent budget even with its prefix (the workflow rescue never re-runs it)', budget.isRecoveryBudgetSpentLine(`API Error: ${typed?.message ?? ''}`) && budget.isRecoveryBudgetSpentLine(seatLine), `API Error: ${typed?.message ?? ''}`)
  for (const w of words) console.log(`    row: ${w}`)
  console.log(`    end: ${typed?.message ?? String(thrown)}`)
}

type RoadItem = { type: string; subtype?: string; retryInMs?: number; retryAttempt?: number; maxRetries?: number; isApiErrorMessage?: boolean; error?: unknown; errorDetail?: { name?: string; status?: number; message?: string; code?: string }; message?: { content: Array<{ type: string; text?: string }> } }
type RoadRun = { items: RoadItem[]; notices: RoadItem[]; kinds: string[]; words: string[]; red: string[]; seat: Seat; waits: Array<Record<string, unknown>>; answered: boolean; ms: number }
type RoadDoor = { name: string; provider: string; model: string; path: RegExp; call: (p: unknown) => AsyncGenerator<unknown>; before?: () => void; after?: () => void }
const roadRuns = new Map<string, RoadRun>()
const ROAD_ANSWER = 'road answer'
const NETWORK_HEAD = 'network unreachable (connection refused)'

section('S8 — the four provider roads through their real client wrappers: a refused loopback connect is an outage on every road and never a charged fault; the ladder is bounded by the knobs; an accepted connection that stalls keeps the road\'s own retry')
{
  const http = await import('node:http')
  const { unlinkSync, existsSync, mkdirSync } = await import('node:fs')
  const { randomUUID } = await import('node:crypto')
  const closedPort = await (async (): Promise<number> => {
    const server = createServer(s => s.destroy())
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    await new Promise<void>(r => server.close(() => r()))
    return port
  })()
  const base = `http://127.0.0.1:${closedPort}`
  const home = process.env.MERCURY_CONFIG_DIR ?? ''
  process.env.OPENAI_API_KEY = 'proof-openai-key-not-a-real-key'
  process.env.MERCURY_OPENAI_API_BASE = `${base}/v1`
  process.env.ZAI_API_KEY = 'proof-zai-key-not-a-real-key'
  process.env.MERCURY_ZAI_API_BASE = `${base}/v4`
  process.env.GEMINI_API_KEY = 'proof-gemini-key-not-a-real-key'
  process.env.MERCURY_GEMINI_API_BASE = `${base}/v1beta`
  process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = `${base}/token`
  process.env.MERCURY_COMPAT_BASE_URL = `${base}/v1`
  process.env.MERCURY_COMPAT_MODELS = 'fixture-model'
  process.env.MERCURY_COMPAT_LABEL = 'the fixture endpoint'
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '1000'
  process.env.MERCURY_RECONNECT_SCALE = '0.01'
  for (const name of ['GOOGLE_API_KEY', 'MERCURY_GEMINI_OAUTH_CLIENT_ID', 'MERCURY_GEMINI_OAUTH_CLIENT_SECRET', 'MERCURY_BUSY_RETRY_SCALE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_MODEL', 'MERCURY_COMPAT_API_KEY', 'MERCURY_RECONNECT_BUDGET_MINUTES']) delete process.env[name]
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const bootstrap = await import('../../src/bootstrap/state.js')
  bootstrap.setIsInteractive(false)
  const { openaiCallModel } = await import('../../src/services/providers/openai/openaiCallModel.js')
  const { zaiCallModel } = await import('../../src/services/providers/zai/zaiCallModel.js')
  const { compatCallModel } = await import('../../src/services/providers/openaicompat/compatCallModel.js')
  const { geminiCallModel } = await import('../../src/services/providers/gemini/geminiCallModel.js')
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.js')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')

  const sseBody = (chunks: unknown[], done = false): string => chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '')
  const usage = { input_tokens: 12, output_tokens: 8, input_tokens_details: { cached_tokens: 0 } }
  const answerFor = (url: string): string => {
    if (url.endsWith('/responses')) {
      return sseBody([
        { type: 'response.created', response: { id: 'resp_fixture' } },
        { type: 'response.output_text.delta', delta: ROAD_ANSWER },
        { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ROAD_ANSWER }] } },
        { type: 'response.completed', response: { id: 'resp_fixture', usage } },
      ])
    }
    if (url.includes('/chat/completions')) return sseBody([{ choices: [{ delta: { content: ROAD_ANSWER }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }], true)
    return sseBody([
      { candidates: [{ content: { role: 'model', parts: [{ text: ROAD_ANSWER }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } },
    ])
  }
  type Listener = { hits: string[]; close: () => Promise<void> }
  async function openListener(mode: 'answer' | 'stall', faultsFirst = 0): Promise<Listener> {
    const hits: string[] = []
    const sockets = new Set<Socket>()
    let faulted = 0
    const server = http.createServer((req, res) => {
      const url = req.url ?? ''
      if (req.method !== 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol', supported_reasoning_levels: ['low', 'medium', 'high'], visibility: 'list', supported_in_api: true }] }))
        return
      }
      if (mode === 'stall') return
      hits.push(url)
      if (faulted < faultsFirst) {
        faulted++
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'a hiccup' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(answerFor(url))
    })
    server.on('connection', s => {
      sockets.add(s)
      s.on('error', () => {})
      s.on('close', () => sockets.delete(s))
    })
    await new Promise<void>((r, reject) => server.listen(closedPort, '127.0.0.1', r).once('error', reject))
    return {
      hits,
      close: async () => {
        for (const s of sockets) s.destroy()
        await new Promise<void>(r => server.close(() => r()))
      },
    }
  }

  const stamp = (): { uuid: string; timestamp: string } => ({ uuid: randomUUID(), timestamp: new Date().toISOString() })
  const userRow = (content: string): unknown => ({ type: 'user', ...stamp(), message: { role: 'user', content } })
  const assistantRow = (model: string): unknown => ({ type: 'assistant', ...stamp(), message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'an earlier answer' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
  const roadParams = (model: string, onWait: (wait: unknown) => void, warm: boolean): unknown => ({
    messages: warm ? [userRow('Say hello.'), assistantRow(model), userRow('Say hello again.')] : [userRow('Say hello.')],
    systemPrompt: asSystemPrompt(['Only answer the request.']),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: new AbortController().signal,
    options: { model, querySource: 'repl_main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 64, onWait },
  })
  async function driveRoad(door: RoadDoor, opts: { warm?: boolean; onNotice?: (count: number) => Promise<void> } = {}): Promise<RoadRun> {
    const seat = budget.makeRecoveryBudget()
    const waits: Array<Record<string, unknown>> = []
    const items: RoadItem[] = []
    const notices: RoadItem[] = []
    const kinds: string[] = []
    const words: string[] = []
    const startedAt = Date.now()
    door.before?.()
    try {
      for await (const raw of door.call(roadParams(door.model, wait => { if (wait !== null && typeof wait === 'object') waits.push(wait as Record<string, unknown>) }, opts.warm === true))) {
        const item = raw as RoadItem
        items.push(item)
        if (item.type !== 'system' || item.subtype !== 'api_error') continue
        notices.push(item)
        const facts = budget.recoveryNoticeFacts(item)
        if (facts === null) {
          kinds.push('?')
          words.push('<not a notice>')
        } else {
          kinds.push(facts.kind)
          const h = budget.honourRecoveryWait(seat, facts)
          words.push(budget.retryWaitWords({ facts, honoredMs: h.honoredMs, budget: seat }))
        }
        await opts.onNotice?.(notices.length)
      }
    } finally {
      door.after?.()
    }
    const red = items.filter(i => i.type === 'assistant' && i.isApiErrorMessage === true).map(i => i.message?.content.map(b => b.text ?? '').join('') ?? '')
    const answered = items.some(i => i.type === 'assistant' && i.isApiErrorMessage !== true && (i.message?.content.some(b => b.text === ROAD_ANSWER) ?? false))
    return { items, notices, kinds, words, red, seat, waits, answered, ms: Date.now() - startedAt }
  }

  const door = (ladder as { outageCauseOfFetchFailure?: (e: unknown) => { code: string; words: string } | null } | null)?.outageCauseOfFetchFailure
  const viaDoor = (e: unknown): string | null => (door === undefined ? '<no fetch-failure door>' : (door(e)?.words ?? null))
  const nodeFetchFailed = (inner: Error): Error => new TypeError('fetch failed', { cause: inner })
  const bunRefused = (): Error => errno('Unable to connect. Is the computer able to access the url?', 'ConnectionRefused', { errno: 0 })
  check('the one classifier has a fetch-failure door for the roads that keep the cause: undici\'s refused connect, DNS failure and connect timeout, the OS connect timeout, and Bun\'s refused connect are outages', viaDoor(nodeFetchFailed(errno('connect ECONNREFUSED 127.0.0.1:1', 'ECONNREFUSED', { syscall: 'connect' }))) === 'connection refused' && viaDoor(nodeFetchFailed(errno('getaddrinfo ENOTFOUND api.example.invalid', 'ENOTFOUND', { syscall: 'getaddrinfo' }))) === 'host not found' && viaDoor(undiciConnectTimeout()) === 'connect timed out' && viaDoor(nodeFetchFailed(errno('connect ETIMEDOUT 203.0.113.9:443', 'ETIMEDOUT', { syscall: 'connect' }))) === 'connect timed out' && viaDoor(nodeFetchFailed(errno('connect ENETUNREACH 203.0.113.9:443', 'ENETUNREACH', { syscall: 'connect' }))) === 'no route to the host' && viaDoor(bunRefused()) === 'connection refused', [nodeFetchFailed(errno('connect ECONNREFUSED 127.0.0.1:1', 'ECONNREFUSED', { syscall: 'connect' })), undiciConnectTimeout(), bunRefused()].map(viaDoor).join(','))
  check('…and the same door refuses what the SDK door refuses: TLS, a proxy 407, a sandbox EPERM, a stale socket, a read timeout, the deadline\'s abort, a cause-less failure, an answered status, a non-error', viaDoor(nodeFetchFailed(errno('certificate has expired', 'CERT_HAS_EXPIRED'))) === null && viaDoor(nodeFetchFailed(errno('Proxy response (407) !== 200 when HTTP Tunneling', 'UND_ERR_ABORTED'))) === null && viaDoor(nodeFetchFailed(errno('connect EPERM 203.0.113.9:443', 'EPERM', { syscall: 'connect' }))) === null && viaDoor(nodeFetchFailed(errno('other side closed', 'UND_ERR_SOCKET'))) === null && viaDoor(nodeFetchFailed(errno('read ETIMEDOUT', 'ETIMEDOUT', { syscall: 'read' }))) === null && viaDoor(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })) === null && viaDoor(new TypeError('fetch failed')) === null && viaDoor(Object.assign(new Error('answered'), { status: 503, code: 'ECONNREFUSED' })) === null && viaDoor('ECONNREFUSED') === null)
  check('the SDK door is unchanged by the refactor: the refused, DNS and unreachable signatures, the ring read and every refusal from S4', ladder !== null && ladder.outageCauseOf(refusedNode())?.words === 'connection refused' && ladder.outageCauseOf(dnsNode())?.words === 'host not found' && ladder.outageCauseOf(unreachable())?.words === 'no route to the host' && ladder.outageCauseOf(tls()) === null && ladder.outageCauseOf(stale()) === null && ladder.outageCauseOf(firstByte()) === null && ladder.outageCauseOf(answered(503)) === null && ladder.outageCauseOf(new APIConnectionError({})) === null && ladder.outageCauseOf(errno('connect ECONNREFUSED', 'ECONNREFUSED')) === null)

  const oauthFile = join(home, '.gemini-auth.json')
  const doors: RoadDoor[] = [
    { name: 'openai', provider: 'OpenAI', model: 'gpt-5.6-sol', path: /\/v1\/responses$/, call: p => openaiCallModel(p as never) as AsyncGenerator<unknown> },
    { name: 'zai', provider: 'Z.AI', model: 'glm-5.2', path: /\/v4\/chat\/completions$/, call: p => zaiCallModel(p as never) as AsyncGenerator<unknown> },
    { name: 'openai-compat', provider: 'the fixture endpoint', model: 'compat/fixture-model', path: /\/v1\/chat\/completions$/, call: p => compatCallModel(p as never) as AsyncGenerator<unknown> },
    { name: 'gemini', provider: 'Gemini', model: 'gemini-3.5-flash', path: /\/v1beta\/openai\/chat\/completions$/, call: p => geminiCallModel(p as never) as AsyncGenerator<unknown> },
    {
      name: 'gemini-oauth',
      provider: 'Gemini',
      model: 'gemini-3.5-flash',
      path: /:streamGenerateContent\?alt=sse$/,
      call: p => geminiCallModel(p as never) as AsyncGenerator<unknown>,
      before: () => {
        mkdirSync(home, { recursive: true })
        writeFileSync(oauthFile, JSON.stringify({ version: 1, preferredSource: 'oauth', client: { clientId: 'proof-client' }, tokens: { accessToken: 'ya29.proof-access-not-a-real-token', refreshToken: 'proof-refresh', accessTokenExpiresAtMs: Date.now() + 3_600_000 } }))
      },
      after: () => { if (existsSync(oauthFile)) unlinkSync(oauthFile) },
    },
  ]
  const TYPED_END = /^API Error: the network was unreachable through (\d+) reconnects? over \d+ s \(connection refused\) — the 0s reconnect budget is spent and the turn was ended; check the connection and send again, or raise MERCURY_RECONNECT_BUDGET_MINUTES$/
  for (const door of doors) {
    console.log(`  · the ${door.provider} road (${door.name})`)
    process.env.MERCURY_RECONNECT_BUDGET_MINUTES = '0.005'
    const spent = await driveRoad(door)
    delete process.env.MERCURY_RECONNECT_BUDGET_MINUTES
    roadRuns.set(door.name, spent)
    check(`${door.name}: every notice through the road's own loop is classed an OUTAGE by the seat road (never a fault)`, spent.notices.length >= 2 && spent.kinds.every(k => k === 'outage'), `kinds=${spent.kinds.join(',') || '(none)'}`)
    check(`${door.name}: the reconnect ladder walked from the first rung (50 ms at proof scale), doubling, and ended on the zero-wait spent notice`, (spent.notices[0]?.retryInMs ?? -1) === 50 && spent.notices.slice(1, -1).every((n, i) => (n.retryInMs ?? 0) > 0 && (n.retryInMs ?? 0) <= 100 * 2 ** i) && spent.notices.at(-1)?.retryInMs === 0, spent.notices.map(n => `${n.retryAttempt}:${n.retryInMs}`).join(','))
    check(`${door.name}: THE FAULT COUNTER IS UNCHANGED and the API retry budget unspent (spentMs 0, no waits, no faults)`, spent.seat.spentMs === 0 && spent.seat.waits === 0 && spent.seat.faults === 0, `spentMs=${spent.seat.spentMs} waits=${spent.seat.waits} faults=${spent.seat.faults}`)
    check(`${door.name}: every row reads the network grammar — never "connection lost", never the provider's name`, spent.words.length >= 2 && spent.words.slice(0, -1).every(w => NETWORK_ROW.test(w)) && /^network unreachable \(connection refused\) — no further reconnect; the 0s reconnect budget is spent after \d+ reconnects?$/.test(spent.words.at(-1) ?? '') && spent.words.every(w => !/connection lost|retry budget|stream failed/.test(w)), spent.words.join(' | '))
    check(`${door.name}: the turn ends on the typed reconnect-budget-spent line the Anthropic road ends on, and the workflow rescue recognises it`, spent.red.length === 1 && TYPED_END.test(spent.red[0] ?? '') && budget.isRecoveryBudgetSpentLine(spent.red[0] ?? '') && !spent.answered, spent.red[0] ?? '(no red line)')
    check(`${door.name}: the seat road saw the spending wait and the zero-wait cut (the dispatched agent's typed stop)`, spent.seat.outage?.spent === true && spent.seat.outage.waitMs === 0, JSON.stringify(spent.seat.outage))
    for (const w of spent.words) console.log(`    row: ${w}`)
    console.log(`    end: ${spent.red[0] ?? '(no red line)'}`)

    let listener: Listener | null = null
    const recovered = await driveRoad(door, {
      onNotice: async count => {
        if (count === 2 && listener === null) listener = await openListener('answer', 1)
      },
    })
    const hits = listener === null ? [] : (listener as Listener).hits
    if (listener !== null) await (listener as Listener).close()
    check(`${door.name}: the network came back after two reconnects, the provider answered a 500 and the road's OWN single retry still served it: outage, outage, fault, then the answer`, recovered.kinds.join(',') === 'outage,outage,fault' && recovered.answered && recovered.red.length === 0 && hits.length === 2 && hits.every(h => door.path.test(h)), `kinds=${recovered.kinds.join(',')} answered=${recovered.answered} hits=${JSON.stringify(hits)} red=${recovered.red[0] ?? ''}`)
    check(`${door.name}: the seat charged exactly the one 500 wait (a fault of 400 ms) and nothing for the outage`, recovered.seat.waits === 1 && recovered.seat.faults === 1 && recovered.seat.spentMs === 400 && recovered.seat.outage === undefined, `waits=${recovered.seat.waits} faults=${recovered.seat.faults} spentMs=${recovered.seat.spentMs}`)
    check(`${door.name}: the reconnect rows then the fault row keep their own grammars`, NETWORK_ROW.test(recovered.words[0] ?? '') && NETWORK_ROW.test(recovered.words[1] ?? '') && /^provider error \(HTTP 500\) — waiting 0 s before retry 1 of 1; /.test(recovered.words[2] ?? ''), recovered.words.join(' | '))
    for (const w of recovered.words) console.log(`    row: ${w}`)

    const stall = await openListener('stall')
    const stalled = await driveRoad(door, { warm: true })
    await stall.close()
    check(`${door.name}: a loopback listener that accepts and never answers is NOT an outage — the first-byte budget fires, the road's own retry runs once as a charged fault, and the turn ends on the road's own line`, stalled.kinds.join(',') === 'fault' && stalled.seat.faults === 1 && budget.recoveryNoticeFacts(stalled.notices[0])?.cause === 'no first byte' && stalled.red.length === 1 && /first-byte-timeout/.test(stalled.red[0] ?? '') && stall.hits.length === 0, `kinds=${stalled.kinds.join(',')} faults=${stalled.seat.faults} red=${stalled.red[0] ?? ''} ms=${stalled.ms}`)
    console.log(`    stall: ${stalled.words[0] ?? ''}`)
  }
}

section('S9 — the status row: during an outage the row says what the transcript row says, on every road, never "connection error"')
if (ladder === null) {
  check('the reconnect ladder module exists', false, 'src/services/api/reconnectLadder.ts is absent')
} else {
  const idle = await import('../../src/services/providers/streamIdleBudget.js')
  const bar = await import('../../src/components/SwitchboardTagBar.tsx')
  const { IDLE_LIVE } = await import('../../src/services/engine-connector/seatLive.js')
  delete process.env.MERCURY_RECONNECT_SCALE
  const cause = { code: 'ECONNREFUSED', words: 'connection refused' }
  const l = ladder.openReconnectLadder(0, cause, 10 * 60_000, 1)
  ladder.nextReconnect(l, cause, 0)
  ladder.nextReconnect(l, cause, 5_100)
  const third = ladder.nextReconnect(l, cause, 15_300)
  const outageError = new ladder.NetworkOutageError(third, refusedNode())
  const reason = idle.retryReasonWords((outageError as { status?: number }).status, outageError.message)
  check('the reason words the Anthropic road hands the row for an outage notice are the outage words, not "a connection error"', reason === NETWORK_HEAD, reason)
  const wait = { kind: 'retry' as const, attempt: third.reconnect, of: third.of, reason, delayMs: third.waitMs, sinceMs: 0 }
  const line = idle.requestWaitLine(wait)
  check('the row: reconnecting — reconnect 3 of 13 after network unreachable (connection refused) · in 20 s', line === 'reconnecting — reconnect 3 of 13 after network unreachable (connection refused) · in 20 s', line)
  const live = { ...IDLE_LIVE, inFlight: true, phase: 'thinking' as const, agentsWaiting: 0, turnStartedAtMs: 0 }
  const seat = { title: 'a chat', projectLabel: 'proj', interrupting: false, hardStopping: false, wait, quietMs: 4_000, watchdogMs: 90_000, phaseMs: null, toolBudgetMs: null, stuck: false }
  const painted = bar.statusLine(live, seat)
  check('the focused chat\'s status row paints that line', painted === line, painted)
  check('the compact row too', bar.statusLine(live, seat, null, true) === line, bar.statusLine(live, seat, null, true))
  const tripped = idle.decodeRequestWait(idle.requestWaitFromWire(idle.requestWaitToWire(wait)))
  check('the wait keeps its words across the runner\'s status frame', tripped !== null && idle.requestWaitLine(tripped) === line, tripped === null ? 'null' : idle.requestWaitLine(tripped))
  check('a 529, a first-byte timeout and a bare connection error keep their words', idle.retryReasonWords(529) === 'a 529' && idle.retryReasonWords(undefined, 'no first byte from Opus 5 after 90 s (the request was accepted and nothing arrived)') === 'a first-byte timeout' && idle.retryReasonWords(undefined, 'Connection error.') === 'a connection error' && idle.retryReasonWords(503, 'network unreachable (connection refused) — waiting') === 'a 503')
  check('the plain retry row is unchanged', idle.requestWaitLine({ kind: 'retry', attempt: 2, of: 10, reason: 'a 529', delayMs: 4_000, sinceMs: 0 }) === 'retrying — attempt 2 of 10 after a 529 · in 4 s')
  for (const [name, run] of roadRuns) {
    const retries = run.waits.filter(w => w.kind === 'retry')
    const lines = retries.map(w => idle.requestWaitLine(w as Parameters<typeof idle.requestWaitLine>[0]))
    const timed = retries.filter(w => typeof w.delayMs === 'number' && w.delayMs > 0)
    check(`${name}: the road published a reconnect wait for every reconnect (and the zero-wait spent one), each with the outage words`, timed.length >= 2 && retries.length === timed.length + 1 && retries.every(w => w.reason === NETWORK_HEAD) && timed.every((w, i) => w.attempt === i + 1) && lines.every((w, i) => w.startsWith(`reconnecting — reconnect ${Math.min(i + 1, timed.length)} of `) && w.includes(` after ${NETWORK_HEAD}`)) && !(lines.at(-1) ?? '').includes(' · in '), `${retries.length} retry waits of ${run.waits.length}: ${lines.join(' | ') || JSON.stringify(run.waits.map(w => w.kind))}`)
    const first = retries[0]
    check(`${name}: the status row paints the first one`, first !== undefined && bar.statusLine(live, { ...seat, wait: first as typeof wait }) === (lines[0] ?? '') && !/connection error/.test(lines[0] ?? ''), lines[0] ?? '(no wait)')
    if (lines[0] !== undefined) console.log(`    status row: ${lines[0]}`)
  }
}

clearTimeout(guard)
console.log(failures === 0 ? '\nprove-reconnect-ladder: all green' : `\nprove-reconnect-ladder: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
