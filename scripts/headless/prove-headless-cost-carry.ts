#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, bootRunner, bound, childEnv, configKeyOf, isResult, makeTally, user } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-headless-cost-carry')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first or pass --dist`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'headless-cost-carry-')))
const runHome = join(root, 'home')
const cwd = join(root, 'work')
seedScratchHome(runHome, cwd)
const fixture = await startScriptedFixture(() => [{ type: 'text', text: 'cost probe answered' }])
const port = Number(new URL(fixture.base).port)

type Turn = { result: Record<string, unknown> | null; exitCode: number | null }
async function runTurn(ask: string, extraArgv: string[] = []): Promise<Turn> {
  const runner = bootRunner({ cwd, env: childEnv(runHome, port), extraArgv })
  runner.send(user(ask, randomUUID()))
  const result = await runner.waitFor('result', isResult, bound(90_000))
  await runner.stop(bound(5_000))
  return { result, exitCode: await runner.exited }
}
const storedFor = (): { lastSessionId?: string; lastCost?: number } => {
  try {
    const config = JSON.parse(readFileSync(join(runHome, '.mercury.json'), 'utf8')) as { projects?: Record<string, { lastSessionId?: string; lastCost?: number }> }
    return config.projects?.[configKeyOf(cwd)] ?? {}
  } catch {
    return {}
  }
}

tally.section('turn 1: a fresh headless seat meters its own usage and saves its totals when it closes')
const first = await runTurn('cost probe first')
const c1 = Number(first.result?.total_cost_usd ?? NaN)
const sid = String(first.result?.session_id ?? '')
tally.check('turn 1 settled with a result frame', first.result?.subtype === 'success', JSON.stringify(first.result).slice(0, 160))
tally.check('turn 1 reports a positive cost', c1 > 0, `total_cost_usd ${c1}`)
const stored = storedFor()
tally.check("the seat's close saved the session's totals under its session id", stored.lastSessionId === sid && (stored.lastCost ?? 0) > 0, `lastSessionId ${String(stored.lastSessionId)} · lastCost ${String(stored.lastCost)} · session ${sid}`)

tally.section('turn 2: the same session resumed headless (-p --resume) carries the stored totals forward')
const second = await runTurn('cost probe second', ['--resume', sid])
const c2 = Number(second.result?.total_cost_usd ?? NaN)
tally.check('turn 2 settled with a result frame in the same session', second.result?.subtype === 'success' && second.result?.session_id === sid, `session ${String(second.result?.session_id)} vs ${sid}`)
tally.check('turn 2 reports a positive cost', c2 > 0, `total_cost_usd ${c2}`)
tally.check("the resumed seat's total is cumulative (turn 1 + turn 2), not restarted at zero", c2 > c1 * 1.5, `turn 1 ${c1} · turn 2 ${c2}`)
const storedAfter = storedFor()
tally.check('the resumed close saved the cumulative total', (storedAfter.lastCost ?? 0) > c1 * 1.5, `lastCost ${String(storedAfter.lastCost)}`)

tally.section('turn 3: a fork of the session (-p --resume --fork-session) keeps its own fresh ledger')
const fork = await runTurn('cost probe third', ['--resume', sid, '--fork-session'])
const c3 = Number(fork.result?.total_cost_usd ?? NaN)
const forkSid = String(fork.result?.session_id ?? '')
tally.check('the fork settled under a session id of its own', fork.result?.subtype === 'success' && forkSid !== '' && forkSid !== sid, `session ${forkSid} vs ${sid}`)
tally.check("the fork's total is its own turn's, not the original's carried total", c3 > 0 && c3 < c1 * 1.5, `fork ${c3} · original turn 1 ${c1}`)
console.log(`  fixture requests: ${fixture.requests.length}`)
await fixture.close()
rmSync(root, { recursive: true, force: true })
tally.finish()
