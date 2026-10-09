#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }
process.env.NODE_ENV = 'test'
const home = mkdtempSync(join(tmpdir(), 'runner-slow-init-home-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_SESSION_HOME

let checks = 0
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const j = (v: unknown): string => JSON.stringify(v)

const projections = await import('../../src/services/engine-connector/seatProjections.ts')
const tagBar = await import('../../src/components/SwitchboardTagBar.tsx')
const { IDLE_LIVE } = await import('../../src/services/engine-connector/seatLive.ts')

section('§4 the status row says what the daemon knows: never "ready" over a runner that is booting, crashed or down')
{
  const factOf = (projections as Partial<typeof projections>).runnerStateFactOf
  const now = 1_700_000_000_000
  const starting = factOf?.({ state: 'running', ready: false, respawns: 0, maxRespawns: 5, spawnedAt: now - 23_000 }, now)
  check('a spawned runner that has not answered initialize reads starting, since its spawn', j(starting) === j({ state: 'starting', sinceMs: now - 23_000, respawns: 0, maxRespawns: 5 }), j(starting))
  const live = factOf?.({ state: 'running', ready: true, respawns: 0, maxRespawns: 5, spawnedAt: now - 23_000 }, now)
  check('a runner that answered initialize carries no runner fact (the row speaks its ordinary words)', live === undefined, j(live))
  const crashed = factOf?.({ state: 'spawning', ready: false, respawns: 2, maxRespawns: 5, spawnedAt: now - 60_000, crashedAt: now - 1_000, lastError: 'exit 1' }, now)
  check('a crashed runner with a restart due reads crashed (n/max) with the kept reason', j(crashed) === j({ state: 'crashed', sinceMs: now - 1_000, respawns: 2, maxRespawns: 5, reason: 'exit 1' }), j(crashed))
  const degraded = factOf?.({ state: 'crashed', outcome: 'degraded', ready: false, respawns: 6, maxRespawns: 5, crashedAt: now - 5_000 }, now)
  check('a seat whose respawns are exhausted reads degraded', j(degraded) === j({ state: 'degraded', sinceMs: now - 5_000, respawns: 6, maxRespawns: 5 }), j(degraded))
  check('a killed seat (the operator stopped it) carries no runner fact', factOf?.({ state: 'settled', outcome: 'killed', respawns: 0 }, now) === undefined)
  check('no roster row — nothing is claimed', factOf?.(undefined, now) === undefined)

  const base = { title: 't', projectLabel: 'p', interrupting: false, hardStopping: false, wait: null, quietMs: null, watchdogMs: null, phaseMs: null, toolBudgetMs: null, stuck: false }
  const line = (runner: unknown): string => tagBar.statusLine(IDLE_LIVE, { ...base, runner } as never, null, false)
  const liveNow = Date.now()
  check('an idle seat with no runner fact still reads ready', line(null) === 'ready' && line(undefined) === 'ready', j([line(null), line(undefined)]))
  const booting = { state: 'starting', sinceMs: liveNow - 23_000, respawns: 0, maxRespawns: 5 }
  check('a booting runner: "the runner is starting · 23s" (the receipt painted ready here)', /^the runner is starting · 2[34]s$/.test(line(booting)), line(booting))
  const restarting = { state: 'starting', sinceMs: liveNow - 4_000, respawns: 2, maxRespawns: 5 }
  check('a respawned runner booting again names the ladder', /^the runner is restarting \(2\/5\) · [45]s$/.test(line(restarting)), line(restarting))
  check('a crashed runner with a restart due', line(crashed) === 'the runner crashed (exit 1) — restarting (2/5)', line(crashed))
  check('a degraded seat: the session has no live runner and ↵ revives it', line(degraded) === 'the runner crashed 6 times — the session has no live runner · ↵ revives it', line(degraded))
  check('the runner state outranks the resting receipt (statusRowWarns)', tagBar.statusRowWarns(IDLE_LIVE, { ...base, runner: starting } as never) === true && tagBar.statusRowWarns(IDLE_LIVE, { ...base, runner: null } as never) === false)
  check('the words wear no internal name (no worker short, no "long-lived")', ![line(booting), line(crashed), line(degraded)].some(words => /concourse-w|long-lived/.test(words)))
}

rmSync(home, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-status-row-runner-state: ALL LAWS HOLD' : `prove-status-row-runner-state: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
