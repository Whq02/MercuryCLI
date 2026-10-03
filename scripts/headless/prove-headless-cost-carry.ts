#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, bootRunner, bound, childEnv, configKeyOf, isOutcome, makeTally } from '../daemon/dupline-world.ts'
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
  void runner.prompt(ask, randomUUID())
  const result = await runner.waitFor('outcome', isOutcome, bound(90_000))
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
const c1 = Number(first.result?.cost_usd ?? NaN)
const sid = String(first.result?.session_id ?? '')
tally.check('turn 1 settled with a completed outcome', first.result?.status === 'completed', JSON.stringify(first.result).slice(0, 160))
tally.check('turn 1 reports a positive cost', c1 > 0, `cost_usd ${c1}`)
const stored = storedFor()
tally.check("the seat's close saved the session's totals under its session id", stored.lastSessionId === sid && (stored.lastCost ?? 0) > 0, `lastSessionId ${String(stored.lastSessionId)} · lastCost ${String(stored.lastCost)} · session ${sid}`)

tally.section('turn 2: a resumed headless run reports only its own API time and cost, while the stored session keeps both turns')
const configPath = join(runHome, '.mercury.json')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
Object.assign(config.projects[configKeyOf(cwd)], { lastAPIDuration: 600_000, lastAPIDurationWithoutRetries: 600_000, lastDuration: 600_000 })
writeFileSync(configPath, JSON.stringify(config))
const second = await runTurn('cost probe second', ['--resume', sid])
const c2 = Number(second.result?.cost_usd ?? NaN)
const wall = Number(second.result?.wall_ms ?? NaN)
const api = Number(second.result?.api_ms ?? NaN)
console.log(JSON.stringify({ wall_ms: wall, api_ms: api, first_cost_usd: c1, cost_usd: c2, models: second.result?.models, usage: second.result?.usage }))
tally.check('turn 2 settled with a completed outcome in the same session', second.result?.status === 'completed' && second.result?.session_id === sid, `session ${String(second.result?.session_id)} vs ${sid}`)
tally.check('the resumed run counts real API time without earlier runs', api > 0 && api <= wall, `api_ms ${api} · wall_ms ${wall}`)
tally.check('the resumed result cost belongs to this run, not the earlier turn', c2 > 0 && Math.abs(c2 - c1) < 1e-9, `turn 1 ${c1} · turn 2 ${c2}`)
const modelRows = Object.values(second.result?.models ?? {}) as Array<{ input_tokens: number; output_tokens: number; cost_usd: number }>
tally.check('the per-model breakdown uses the same run window as the outcome', modelRows.reduce((sum, row) => sum + row.input_tokens, 0) === 40 && modelRows.reduce((sum, row) => sum + row.output_tokens, 0) === 8 && Math.abs(modelRows.reduce((sum, row) => sum + row.cost_usd, 0) - c2) < 1e-9, JSON.stringify(modelRows))
const storedAfter = storedFor()
tally.check('the resumed close still saved the cumulative session total', (storedAfter.lastCost ?? 0) > c1 * 1.5, `lastCost ${String(storedAfter.lastCost)}`)
const savedAfter = JSON.parse(readFileSync(configPath, 'utf8')).projects[configKeyOf(cwd)]
tally.check('the persisted session API time still includes the earlier run', savedAfter.lastAPIDuration >= 600_000 + api, JSON.stringify({ lastAPIDuration: savedAfter.lastAPIDuration, api }))

tally.section('turn 3: a fork of the session (-p --resume --fork) keeps its own fresh ledger')
const fork = await runTurn('cost probe third', ['--resume', sid, '--fork'])
const c3 = Number(fork.result?.cost_usd ?? NaN)
const forkSid = String(fork.result?.session_id ?? '')
tally.check('the fork settled under a session id of its own', fork.result?.status === 'completed' && forkSid !== '' && forkSid !== sid, `session ${forkSid} vs ${sid}`)
tally.check("the fork's total is its own turn's, not the original's carried total", c3 > 0 && c3 < c1 * 1.5, `fork ${c3} · original turn 1 ${c1}`)
console.log(`  fixture requests: ${fixture.requests.length}`)
await fixture.close()
rmSync(root, { recursive: true, force: true })
tally.finish()
