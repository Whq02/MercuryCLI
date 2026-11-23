#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'retry-door-'))
Object.assign(process.env, { MERCURY_CONFIG_DIR: home, MERCURY_HOME: home, MERCURY_RECOVERY_BUDGET_MINUTES: '1', MERCURY_BUSY_RETRY_SCALE: '0.01', MERCURY_RECONNECT_SCALE: '0.01', MERCURY_RECONNECT_BUDGET_MINUTES: '0' })
delete process.env.MERCURY_MAX_RETRIES
const realRandom = Math.random
Math.random = () => 0.5
const { openTurnRetries } = await import('../../src/engine/requests/withRetry.ts')

let checks = 0
let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  checks++
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${!condition && detail ? ` — ${detail}` : ''}${!condition ? ' — fix: the wait, attempt count and verdict come from openTurnRetries (afterFault) in src/engine/requests/withRetry.ts' : ''}`)
}

type Fault = { kind: string; code: string; message: string; retryable: boolean; status?: number; retryAfterMs?: number; outage?: { code: string; words: string }; silentMs?: number }
type Notice = { retryInMs: number; retryAttempt: number; maxRetries: number; error: { message: string } }
type Row = { kind: string; attempt: number; of: number; delayMs: number; held?: unknown; reconnecting?: boolean } | null
const rateLimit = (retryAfterMs?: number): Fault => ({ kind: 'http-error', code: 'http-429', message: 'rate limited', retryable: true, status: 429, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) })
const busy: Fault = { kind: 'http-error', code: 'http-503', message: 'overloaded', retryable: true, status: 503 }
const broke: Fault = { kind: 'http-error', code: 'http-500', message: 'broke', retryable: true, status: 500 }
const empty: Fault = { kind: 'truncated-stream', code: 'no-finish', message: 'closed with no events', retryable: true }
const cut: Fault = { kind: 'transport-error', code: 'read-failed', message: 'socket closed', retryable: true }
const unreachable: Fault = { kind: 'transport-error', code: 'fetch-failed', message: 'connect refused', retryable: true, outage: { code: 'ECONNREFUSED', words: 'connection refused' } }

function door(opts: { agent?: boolean; singleShot?: boolean; streamReconnect?: boolean; backoffMs?: number } = {}) {
  const controller = new AbortController()
  const rows: Row[] = []
  const retries = openTurnRetries<Fault>({ signal: controller.signal, maxAttempts: 2, backoffMs: attempt => (opts.backoffMs ?? 5) * attempt, provider: 'Fixture', log: '[fixture]', agent: opts.agent === true, singleShot: opts.singleShot === true, streamReconnect: opts.streamReconnect === true, onWait: wait => void rows.push(wait as Row) })
  const after = async (fault: Fault, typed: string, cancelAfterMs?: number): Promise<{ verdict: string; line?: string; notices: Notice[]; tookMs: number }> => {
    const notices: Notice[] = []
    const started = Date.now()
    if (cancelAfterMs !== undefined) setTimeout(() => controller.abort(), cancelAfterMs)
    const generator = retries.afterFault(fault, { typed, retryEligible: true })
    for (;;) {
      const step = await generator.next()
      if (step.done) return { verdict: step.value.kind, ...('line' in step.value ? { line: step.value.line } : {}), notices, tookMs: Date.now() - started }
      notices.push(step.value as unknown as Notice)
    }
  }
  return { retries, rows, after }
}
async function scaled<T>(name: string, value: string, run: () => Promise<T>): Promise<T> {
  const kept = process.env[name]
  process.env[name] = value
  try {
    return await run()
  } finally {
    if (kept === undefined) delete process.env[name]
    else process.env[name] = kept
  }
}

console.log('── a rate limit is said at once and retried up to MERCURY_MAX_RETRIES')
{
  const named = door()
  named.retries.next()
  const first = await named.after(rateLimit(300), 'rate_limit')
  check('a rate limit that names 300 ms is said at once on the main thread: one notice, attempt 1 of 10, in 300 ms, and it waits 300 ms', first.verdict === 'again' && first.tookMs >= 290 && first.notices.length === 1 && first.notices[0]?.retryInMs === 300 && first.notices[0]?.retryAttempt === 1 && first.notices[0]?.maxRetries === 10, JSON.stringify(first))
  check('its row is a retry row that nothing holds back, and no busy ladder is opened', named.rows.length === 1 && named.rows[0]?.kind === 'retry' && named.rows[0]?.delayMs === 300 && named.rows[0]?.held === undefined && named.retries.busy === undefined, JSON.stringify(named.rows))
  const second = (named.retries.next(), await named.after(rateLimit(300), 'rate_limit'))
  check("each retry is a counted attempt and requests stay open past the road's own cap of two: attempt 2 of 10, then attempt 3", second.verdict === 'again' && second.notices[0]?.retryAttempt === 2 && second.notices[0]?.maxRetries === 10 && !named.retries.left && named.retries.next() && named.retries.attempt === 3, JSON.stringify([second, named.retries.attempt]))
  const agent = door({ agent: true })
  agent.retries.next()
  const onAgent = await agent.after(rateLimit(300), 'rate_limit')
  check("on an agent's call it is the same notice at once, not a held row", onAgent.verdict === 'again' && onAgent.notices.length === 1 && onAgent.notices[0]?.retryInMs === 300 && agent.rows.length === 1 && agent.rows[0]?.held === undefined, JSON.stringify([onAgent, agent.rows]))
  const unnamed = await scaled('MERCURY_MAX_RETRIES', '2', async () => {
    const d = door({ backoffMs: 30_000 })
    const steps: Array<Awaited<ReturnType<typeof d.after>>> = []
    for (let i = 0; i < 3; i++) {
      d.retries.next()
      steps.push(await d.after(rateLimit(), 'rate_limit'))
    }
    return steps
  })
  check("a rate limit that names no wait backs off 562.5 ms, then 1125 ms, never the road's own 30 s: attempt 1 of 2, then 2 of 2", unnamed[0]?.verdict === 'again' && unnamed[0].notices[0]?.retryInMs === 562.5 && unnamed[0].notices[0]?.retryAttempt === 1 && unnamed[0].notices[0]?.maxRetries === 2 && unnamed[1]?.verdict === 'again' && unnamed[1].notices[0]?.retryInMs === 1125 && unnamed[1].notices[0]?.retryAttempt === 2 && unnamed[1].tookMs < 5000, JSON.stringify(unnamed))
  check('the refusal after MERCURY_MAX_RETRIES retries is spent at once with nothing said', unnamed[2]?.verdict === 'spent' && unnamed[2].notices.length === 0 && unnamed[2].tookMs < 300, JSON.stringify(unnamed[2]))
  for (const value of ['0', 'ten']) {
    const none = await scaled('MERCURY_MAX_RETRIES', value, async () => {
      const d = door()
      d.retries.next()
      return d.after(rateLimit(300), 'rate_limit')
    })
    check(`with MERCURY_MAX_RETRIES=${value} a rate limit is not retried: spent at once, nothing said`, none.verdict === 'spent' && none.notices.length === 0 && none.tookMs < 250, JSON.stringify(none))
  }
  const overloaded = door()
  overloaded.retries.next()
  const rung = await overloaded.after({ kind: 'api-error', code: 'zai-1305', message: 'the service is overloaded', retryable: true, status: 429 }, 'rate_limit')
  check('a busy refusal that is typed a rate limit keeps the busy ladder: quiet on the main thread', rung.verdict === 'again' && rung.notices.length === 0 && overloaded.rows.length === 0 && overloaded.retries.busy !== undefined, JSON.stringify([rung, overloaded.rows]))
  const probe = door({ singleShot: true })
  probe.retries.next()
  const single = await probe.after(rateLimit(300), 'rate_limit')
  check("a single-shot call's rate limit is never retried", single.verdict === 'spent' && single.notices.length === 0 && single.tookMs < 250, JSON.stringify(single))
}

console.log('── an explicit Retry-After is followed first')
{
  const plain = door()
  plain.retries.next()
  const server: Fault = { ...broke, retryAfterMs: 200 }
  const again = await plain.after(server, 'server_error')
  check('a fault off the ladder that names 200 ms waits 200 ms where its own backoff is 5 ms, and says attempt 1 of 1', again.verdict === 'again' && again.tookMs >= 190 && again.notices[0]?.retryInMs === 200 && again.notices[0]?.retryAttempt === 1 && again.notices[0]?.maxRetries === 1, JSON.stringify(again))
  const window = door()
  window.retries.next()
  const refusedWindow = await window.after(rateLimit(3_600_000), 'rate_limit')
  check('a named wait past the recovery budget is not waited: spent at once, nothing said', refusedWindow.verdict === 'spent' && refusedWindow.notices.length === 0 && refusedWindow.tookMs < 500 && window.rows.length === 0, JSON.stringify(refusedWindow))
}

console.log('── what counts as an attempt')
{
  const d = door({ streamReconnect: true })
  check('the first request is attempt 1', d.retries.next() && d.retries.attempt === 1)
  const reconnected = await d.after(cut, 'server_error')
  check('a dropped stream reconnects: the row is set before the notice, and the next request is attempt 1 again', reconnected.verdict === 'again' && d.rows[0]?.reconnecting === true && reconnected.notices.length === 1 && d.retries.next() && d.retries.attempt === 1, JSON.stringify([reconnected, d.rows, d.retries.attempt]))
  const emptied = await d.after(empty, 'server_error')
  check('an empty stream says attempt 2 of 3 and the next request is attempt 1 again', emptied.verdict === 'again' && emptied.notices[0]?.retryAttempt === 2 && emptied.notices[0]?.maxRetries === 3 && d.retries.next() && d.retries.attempt === 1, JSON.stringify(emptied))
  const second = await d.after(empty, 'server_error')
  const third = await d.after(empty, 'server_error')
  check('the third empty stream in a row is spent, and the door says the turn ended on one', second.verdict === 'again' && third.verdict === 'spent' && third.notices.length === 0 && d.retries.emptyEnd, JSON.stringify([second.verdict, third.verdict, d.retries.emptyEnd]))
  const p = door()
  p.retries.next()
  const first = await p.after(broke, 'server_error')
  check('a retry off the ladder counts: the next request is attempt 2, the last one left', first.verdict === 'again' && p.retries.left && p.retries.next() && p.retries.attempt === 2 && !p.retries.left, JSON.stringify([first.verdict, p.retries.attempt]))
  const last = await p.after(broke, 'server_error')
  check('the second refusal of two attempts is spent and no third request is opened', last.verdict === 'spent' && !p.retries.next(), last.verdict)
  const probe = door({ singleShot: true })
  probe.retries.next()
  check('a single-shot call is never retried', (await probe.after(busy, 'server_error')).verdict === 'spent' && (await probe.after(unreachable, 'server_error')).verdict === 'spent')
}

console.log('── the busy ladder')
{
  const quiet = door()
  quiet.retries.next()
  const held = await quiet.after(busy, 'server_error')
  check('inside the quiet window a busy retry says nothing on the main thread, and the ladder keeps requests open past the attempt cap', held.verdict === 'again' && held.notices.length === 0 && quiet.rows.length === 0 && quiet.retries.busy !== undefined && quiet.retries.next() && quiet.retries.next() && quiet.retries.attempt === 3, JSON.stringify([held, quiet.rows, quiet.retries.attempt]))
  const agent = door({ agent: true })
  agent.retries.next()
  const row = await agent.after(busy, 'server_error')
  check("on an agent's call the same wait is a held row: attempt 1 of 6, 10 ms", row.notices.length === 0 && agent.rows.length === 1 && agent.rows[0]?.held !== undefined && agent.rows[0]?.attempt === 1 && agent.rows[0]?.of === 6 && agent.rows[0]?.delayMs === 10, JSON.stringify(agent.rows))
  const whole = door()
  whole.retries.next()
  const verdicts: string[] = []
  const said: Notice[] = []
  for (let i = 0; i < 7; i++) {
    const step = await whole.after(busy, 'server_error')
    verdicts.push(step.verdict)
    said.push(...step.notices)
  }
  check('six rungs, the last one said aloud as attempt 6 of 6, then spent', verdicts.join(' ') === 'again again again again again again spent' && said.length === 1 && said[0]?.retryAttempt === 6 && said[0]?.maxRetries === 6 && whole.retries.busy?.ladder.waitsMs.length === 6, JSON.stringify([verdicts, said.map(notice => [notice.retryAttempt, notice.maxRetries])]))
}

console.log('── a cancel ends every wait at once')
{
  const cases: Array<[string, () => Promise<{ verdict: string; tookMs: number }>, () => Row[]]> = []
  const onLadder = door({ agent: true })
  onLadder.retries.next()
  cases.push(['a 30 s wait a rate limit named', () => onLadder.after(rateLimit(30_000), 'rate_limit', 30), () => onLadder.rows])
  const offLadder = door({ backoffMs: 30_000 })
  offLadder.retries.next()
  cases.push(['a 30 s backoff', () => offLadder.after(broke, 'server_error', 30), () => offLadder.rows])
  const emptied = door()
  emptied.retries.next()
  cases.push(['a 30 s empty-stream wait', () => scaled('MERCURY_BUSY_RETRY_SCALE', '30', () => emptied.after(empty, 'server_error', 30)), () => emptied.rows])
  const outage = door()
  outage.retries.next()
  cases.push(['a 30 s outage wait', () => scaled('MERCURY_RECONNECT_SCALE', '6', () => outage.after(unreachable, 'server_error', 30)), () => outage.rows])
  const dropped = door({ streamReconnect: true })
  dropped.retries.next()
  cases.push(['a 30 s stream reconnect wait', () => scaled('MERCURY_RECONNECT_SCALE', '6', () => dropped.after(cut, 'server_error', 30)), () => dropped.rows])
  for (const [name, run] of cases) {
    const ended = await run()
    check(`${name} ends as cancelled within half a second`, ended.verdict === 'cancelled' && ended.tookMs < 500, JSON.stringify(ended))
  }
  check('the stream reconnect clears its row on a cancel, and no other wait does', dropped.rows.at(-1) === null && [onLadder, offLadder, emptied, outage].every(d => d.rows.length === 1 && d.rows[0] !== null), JSON.stringify(cases.map(([name, , rows]) => [name, rows().map(row => (row === null ? null : row.kind))])))
}

console.log('── a spent reconnect budget')
{
  const dropped = door({ streamReconnect: true })
  dropped.retries.next()
  const first = await scaled('MERCURY_RECONNECT_BUDGET_MINUTES', '0.00002', () => dropped.after(cut, 'server_error'))
  await new Promise(resolve => setTimeout(resolve, 5))
  const second = await dropped.after(cut, 'server_error')
  check('a dropped stream past the budget is spent with nothing said', first.verdict === 'again' && second.verdict === 'stream-reconnect-spent' && second.notices.length === 0, JSON.stringify([first, second]))
  const outage = door()
  outage.retries.next()
  const one = await scaled('MERCURY_RECONNECT_BUDGET_MINUTES', '0.00002', () => outage.after(unreachable, 'server_error'))
  await new Promise(resolve => setTimeout(resolve, 5))
  const two = await outage.after(unreachable, 'server_error')
  check('an outage past the budget says its last notice with no wait and hands back the line for the red row', one.verdict === 'again' && two.verdict === 'outage-spent' && two.notices.length === 1 && two.notices[0]?.retryInMs === 0 && typeof two.line === 'string' && two.line.length > 0, JSON.stringify([one, two]))
}

Math.random = realRandom
rmSync(home, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-retry-door: the door holds' : `prove-retry-door: ${failures} FAILURE(S) — the retry waits and counters live in src/engine/requests/withRetry.ts (openTurnRetries)`)
process.exit(failures === 0 ? 0 : 1)
