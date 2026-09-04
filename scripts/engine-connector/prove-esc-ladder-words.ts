#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

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

const arity = await import('../../src/input-core/interruptArity.ts')
const bar = await import('../../src/components/SwitchboardTagBar.tsx')
const { IDLE_LIVE } = await import('../../src/services/engine-connector/seatLive.ts')
type SessionLiveV1 = import('../../src/services/engine-connector/seatLive.ts').SessionLiveV1
type SeatStatusV1 = import('../../src/services/engine-connector/seatLive.ts').SeatStatusV1

const escClauses = (frame: string): number => (frame.match(/\besc\b/g) ?? []).length

const live = (phase: SessionLiveV1['phase'], inFlight = true, agentsWaiting = 0): SessionLiveV1 =>
  ({ ...IDLE_LIVE, inFlight, phase, agentsWaiting, turnStartedAtMs: inFlight ? Date.now() - 5_000 : null }) as SessionLiveV1
const status = (over: Partial<SeatStatusV1> = {}): SeatStatusV1 =>
  ({
    title: 'a chat',
    projectLabel: 'proj',
    interrupting: false,
    hardStopping: false,
    wait: null,
    quietMs: null,
    watchdogMs: 90_000,
    phaseMs: null,
    toolBudgetMs: null,
    stuck: false,
    ...over,
  }) as SeatStatusV1
const frame = (l: SessionLiveV1, s: SeatStatusV1): string => `${bar.statusLine(l, s)}  ${bar.escBackHint(l, s)}`

section('L1 — the rung law')
{
  check('idle', arity.escRungOf({ inFlight: false, interrupting: false, hardStopping: false }) === 'idle')
  check('in flight', arity.escRungOf({ inFlight: true, interrupting: false, hardStopping: false }) === 'in-flight')
  check('interrupting', arity.escRungOf({ inFlight: true, interrupting: true, hardStopping: false }) === 'interrupting')
  check('hard-stopping outranks interrupting', arity.escRungOf({ inFlight: true, interrupting: true, hardStopping: true }) === 'hard-stopping')
  check('the in-flight hint', arity.escRungHint('in-flight') === 'esc interrupts')
  check('the interrupting hint', arity.escRungHint('interrupting') === 'esc again forces a stop')
  check('nothing to press when idle or hard-stopping', arity.escRungHint('idle') === '' && arity.escRungHint('hard-stopping') === '')
}

section('L2 — one esc clause per frame, per rung (a message queued during a thinking stream)')
{
  const idle = frame(live('idle', false), status())
  check('idle: no esc clause', escClauses(idle) === 0, idle)
  const inFlight = frame(live('thinking'), status())
  check('in flight: exactly one esc clause', escClauses(inFlight) === 1, inFlight)
  check('in flight: the clause is the rung hint', inFlight.includes('esc interrupts'), inFlight)
  const interrupting = frame(live('thinking'), status({ interrupting: true }))
  check('interrupting: exactly one esc clause', escClauses(interrupting) === 1, interrupting)
  check('interrupting: the clause is "esc again forces a stop"', interrupting.includes('esc again forces a stop') && !interrupting.includes('esc again stops'), interrupting)
  check('interrupting: the state words say the request is torn down', interrupting.includes('interrupting — the request is torn down'), interrupting)
  const hard = frame(live('thinking'), status({ interrupting: true, hardStopping: true }))
  check('hard-stopping: no esc clause (nothing more to press)', escClauses(hard) === 0, hard)
  check('hard-stopping: the state words say the runner is cut', hard.includes('stopping — the runner is cut'), hard)
}

section('L3 — every state word a running turn can wear keeps to one clause')
{
  const wears: Array<[string, SessionLiveV1, SeatStatusV1]> = [
    ['a tool', live('tool'), status({ phaseMs: 12_000, toolBudgetMs: 120_000 })],
    ['a wait on agents', live('waiting', true, 2), status()],
    ['a first-byte wait past its budget', live('thinking'), status({ wait: { kind: 'first-byte', cold: true, promptTokens: 26_000, model: 'Opus 5', budgetMs: 90_000, sinceMs: Date.now() - 100_000, attempt: 1 }, quietMs: 100_000 })],
    ['a retry wait', live('thinking'), status({ wait: { kind: 'retry', attempt: 2, of: 3, reason: 'a 529', delayMs: 4_000, sinceMs: Date.now() } })],
    ['the stuck verdict', live('thinking'), status({ stuck: true, quietMs: 50_000 })],
    ['replying', live('responding'), status()],
    ['compacting', live('compacting'), status()],
  ]
  for (const [name, l, s] of wears) {
    const f = frame(l, s)
    check(`${name}: exactly one esc clause`, escClauses(f) === 1, f)
    check(`${name}: the state words carry none`, escClauses(bar.statusLine(l, s)) === 0, bar.statusLine(l, s))
  }
}

section('L4 — the arity-2 arm hint is its own word')
{
  const resolved = arity.interruptArityOf('a-surface-nobody-declared')
  check('an undeclared scope reads arity 1 with the default arm hint', resolved.arity === 1 && resolved.hint === 'esc again interrupts')
  check('the arm hint never rides the row', !frame(live('thinking'), status()).includes('esc again interrupts'))
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
