#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import net from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const WORLD_ROOT = existsSync('/private/tmp/mw') ? '/private/tmp/mw' : '/tmp'
mkdirSync(WORLD_ROOT, { recursive: true })
const SCRATCH = mkdtempSync(join(WORLD_ROOT, 'aw-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'd')
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })

const cs = await import('../../src/daemon/controlSocket.ts')
const { daemonControlRpc, controlSockPath, controlSocketCensus } = cs
const setBox = (cs as { setBoxReadingForTesting?: (reading: { load1: number; cores: number } | null) => void }).setBoxReadingForTesting ?? ((): void => {})
const ceilingOf = (cs as { answerCeilingMs?: (timeoutMs: number, box: { load1: number; cores: number }) => number }).answerCeilingMs

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n── ${t} ──`)

const BUDGET_MS = 400
const SLOW_MS = 1000
const CORES = 4

type Mode = 'serving' | 'wedged' | 'held'
let mode: Mode = 'serving'
let pings = 0
const server = net.createServer(sock => {
  let pending = ''
  sock.on('error', () => sock.destroy())
  sock.on('data', chunk => {
    pending += chunk.toString('utf8')
    const nl = pending.indexOf('\n')
    if (nl < 0) return
    const frame = JSON.parse(pending.slice(0, nl)) as { op: string }
    pending = ''
    if (frame.op === 'ping') {
      pings++
      if (mode !== 'wedged') sock.end(`${JSON.stringify({ ok: true, op: 'ping' })}\n`)
      return
    }
    if (mode === 'held') return
    setTimeout(() => {
      if (!sock.destroyed) sock.end(`${JSON.stringify({ ok: true, op: frame.op, slow: true })}\n`)
    }, SLOW_MS)
  })
})
await new Promise<void>(resolve => server.listen(controlSockPath(), resolve))

const census = controlSocketCensus as { waitsExtended?: number; waitsEndedDead?: number }
const resetCensus = (): void => {
  census.waitsExtended = 0
  census.waitsEndedDead = 0
  pings = 0
}
const slowOp = async (): Promise<{ reply: { ok?: boolean; code?: string; error?: string }; ms: number }> => {
  const t0 = Date.now()
  const reply = (await daemonControlRpc({ op: 'slow-answer' } as never, { timeoutMs: BUDGET_MS })) as { ok?: boolean; code?: string; error?: string }
  return { reply, ms: Date.now() - t0 }
}

console.log("the daemon's answer wait follows the box: the named budget is the period of a liveness read, the wait extends while the daemon answers a ping, and the whole wait is bounded by the budget scaled to the box's load per core — never below the budget")
try {
  section('§0 the ceiling is the budget scaled to the box, never below it')
  check('the scaling law is exported', typeof ceilingOf === 'function')
  if (ceilingOf !== undefined) {
    check('a quiet box keeps the budget (load under one per core)', ceilingOf(2000, { load1: 1, cores: 15 }) === 2000 && ceilingOf(2000, { load1: 0, cores: 2 }) === 2000)
    check('a box three times oversubscribed waits three budgets', ceilingOf(2000, { load1: 6, cores: 2 }) === 6000)
    check('the ceiling never falls below the budget whatever the reading', ceilingOf(2000, { load1: Number.NaN, cores: 0 }) === 2000 && ceilingOf(2000, { load1: -3, cores: 4 }) === 2000)
  }

  section('§1 a quiet box: a slow answer still times out at the budget (the held-reply law keeps its deadline)')
  setBox({ load1: 0, cores: CORES })
  resetCensus()
  mode = 'serving'
  {
    const { reply, ms } = await slowOp()
    check('the answer that takes longer than the budget is refused with ETIMEOUT', reply.ok === false && reply.code === 'ETIMEOUT', JSON.stringify(reply))
    check(`the refusal lands at the budget (${ms} ms, budget ${BUDGET_MS})`, ms >= BUDGET_MS - 20 && ms < SLOW_MS, String(ms))
    check('no liveness read ran on a quiet box', pings === 0, `${pings} pings`)
  }

  section('§2 a loaded box: the same slow answer lands — the wait extended while the daemon answered a ping')
  setBox({ load1: 3 * CORES, cores: CORES })
  resetCensus()
  {
    const { reply, ms } = await slowOp()
    check('the slow answer landed (ok, the op echoed)', reply.ok === true && (reply as { slow?: boolean }).slow === true, JSON.stringify(reply))
    check(`it landed when the daemon answered, past the budget (${ms} ms)`, ms >= SLOW_MS - 50 && ms < 3 * BUDGET_MS + 1500, String(ms))
    check('the daemon was asked whether it serves before the wait was extended', pings >= 1 && (census.waitsExtended ?? 0) >= 1, `${pings} pings · extended ${census.waitsExtended}`)
  }

  section('§3 a loaded box, a wedged daemon: no ping answered, the wait ends at the first period')
  setBox({ load1: 3 * CORES, cores: CORES })
  resetCensus()
  mode = 'wedged'
  {
    const { reply, ms } = await slowOp()
    check('the refusal is ETIMEOUT', reply.ok === false && reply.code === 'ETIMEOUT', JSON.stringify(reply))
    check(`the wait ended after the period and its unanswered liveness read (${ms} ms), not the stretched ceiling`, ms >= BUDGET_MS - 20 && ms <= 2 * BUDGET_MS + 300, String(ms))
    check('the census counts the wait that ended on a dead liveness read', (census.waitsEndedDead ?? 0) === 1 && (census.waitsExtended ?? 0) === 0, JSON.stringify(census))
  }

  section('§4 a loaded box, a live daemon that never answers the op: the wait ends at the scaled ceiling')
  setBox({ load1: 3 * CORES, cores: CORES })
  resetCensus()
  mode = 'held'
  {
    const { reply, ms } = await slowOp()
    check('the refusal is ETIMEOUT', reply.ok === false && reply.code === 'ETIMEOUT', JSON.stringify(reply))
    check(`the wait is bounded by three budgets (${ms} ms, ceiling ${3 * BUDGET_MS})`, ms >= 3 * BUDGET_MS - 50 && ms < 3 * BUDGET_MS + 1500, String(ms))
    check('the refusal names the time actually waited', typeof reply.error === 'string' && new RegExp(`within ${ms - 30 > 0 ? '\\d{3,}' : '\\d+'}ms \\(ETIMEOUT\\)`).test(reply.error), String(reply.error))
  }
} finally {
  setBox(null)
  server.close()
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-answer-wait-follows-the-box: ALL LAWS HOLD' : `\nprove-answer-wait-follows-the-box: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
