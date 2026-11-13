#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { bound, childEnv, DIST, NODE, SCRATCH_ROOT } from '../daemon/dupline-world.ts'
import { handoffTurn, isHandoffRequest, startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedScratchHome } from '../lib/scriptedTurn.ts'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${'─'.repeat(76)}\n${t}\n${'─'.repeat(76)}`)
}
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)
const KEEP = process.argv.includes('--keep')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'budget-before-a-call-')))
console.log(`world: ${scratch}`)

const PRICED = 'claude-opus-4-8'
const j = (value: unknown): string => JSON.stringify(value)
type Outcome = { type?: string; status?: string; steps?: number; cost_usd?: number; error?: { message?: string; class?: string } } & Record<string, unknown>
type Played = { code: number | null; stderr: string; outcome: Outcome | null; calls: number }

function oneShot(cwd: string, env: NodeJS.ProcessEnv, flags: string[], prompt: string): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise(resolvePromise => {
    const child = spawn(NODE, [DIST, 'run', '--format', 'json', '--mode', 'sovereign', '--model', PRICED, ...flags, '--', prompt], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), bound(120_000))
    child.on('close', code => {
      clearTimeout(timer)
      resolvePromise({ code, stderr, stdout })
    })
  })
}
const outcomeOf = (stdout: string): Outcome | null => {
  try {
    return JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1) ?? 'null') as Outcome | null
  } catch {
    return null
  }
}

async function play(name: string, turns: ScriptedTurn[], flags: string[], before?: { turns: ScriptedTurn[]; flags: string[] }): Promise<Played> {
  const home = join(scratch, name, 'home')
  const cwd = join(scratch, name, 'work')
  seedScratchHome(home, cwd)
  const session = randomUUID()
  if (before !== undefined) {
    const first = await startFixtureApi([...before.turns, handoffTurn()])
    await oneShot(cwd, childEnv(home, Number(new URL(first.url).port)), [...before.flags, '--session-id', session], 'the first run of the fixture')
    await first.close()
  }
  const fixture = await startFixtureApi([...turns, handoffTurn()])
  const run = await oneShot(cwd, childEnv(home, Number(new URL(fixture.url).port)), before === undefined ? flags : [...flags, '--resume', session], 'do the steps of the fixture')
  const calls = fixture.messageRequests().filter(sent => !sent.path.includes('count_tokens') && !isHandoffRequest(sent)).length
  await fixture.close()
  return { code: run.code, stderr: run.stderr, outcome: outcomeOf(run.stdout), calls }
}
const step = (usage: { input_tokens: number; output_tokens: number }, model?: string): ScriptedTurn => ({ kind: 'tool_use', name: 'Bash', input: { command: 'true', description: 'a step of the fixture' }, usage, ...(model !== undefined ? { model } : {}) })
const said = (played: Played): string => `calls ${played.calls} · exit ${String(played.code)} · ${j({ status: played.outcome?.status, steps: played.outcome?.steps, cost_usd: played.outcome?.cost_usd, error: played.outcome?.error })}`

section('S1 — a budget of $5 and a call of $4.625: the second call, whose cached input alone is $0.45 against $0.375 left, is not started')
{
  const heavy = { input_tokens: 900_000, output_tokens: 5_000 }
  const played = await play('five', [step(heavy), step(heavy), step(heavy), { kind: 'text', text: 'done' }], ['--budget', '5'])
  console.log(`  ${said(played)}`)
  check('the run ends budget_limit, exit 1', played.code === 1 && played.outcome?.type === 'outcome' && played.outcome.status === 'budget_limit' && played.outcome.error?.class === 'budget_limit', said(played))
  check('one model call was made, not two', played.calls === 1 && played.outcome?.steps === 1, said(played))
  check('the run cost what that one call cost: $4.625, under the budget', played.outcome?.cost_usd === 4.625, said(played))
  check('the outcome says why, in the ruled words', played.outcome?.error?.message === "Stopped before a model call the budget of $5 could not pay: $4.625 spent, and the call's input alone would cost at least $0.45", j(played.outcome?.error))
}

section('S2 — a budget of $1 and a call of $0.55: the second call, whose cached input is $0.05 against $0.45 left, is made; the budget is then reached as before')
{
  const light = { input_tokens: 100_000, output_tokens: 2_000 }
  const played = await play('one', [step(light), step(light), step(light), { kind: 'text', text: 'done' }], ['--budget', '1'])
  console.log(`  ${said(played)}`)
  check('the run ends budget_limit', played.code === 1 && played.outcome?.status === 'budget_limit', said(played))
  check('two model calls were made: a call a cache hit could have paid for is not refused', played.calls === 2 && played.outcome?.steps === 2, said(played))
  check('the sentence of a budget reached after a step is unchanged', played.outcome?.error?.message === 'Reached the maximum budget of $1', j(played.outcome?.error))
}

section('S3 — replies from a model with no price on file: the rule does not act')
{
  const heavy = { input_tokens: 900_000, output_tokens: 5_000 }
  const played = await play('unpriced', [step(heavy, 'fixture-model-with-no-price'), step(heavy, 'fixture-model-with-no-price'), { kind: 'text', text: 'done', model: 'fixture-model-with-no-price' }], ['--budget', '5'])
  console.log(`  ${said(played)}`)
  check('the run is not stopped: all three model calls are made and it completes', played.code === 0 && played.outcome?.status === 'completed' && played.calls === 3, said(played))
}

section('S4 — a resumed session that has spent $4.625 of a budget of $5 and carries 900,000 tokens: the first call of the new run is not started')
{
  const heavy = { input_tokens: 900_000, output_tokens: 5_000 }
  const played = await play('resumed', [{ kind: 'text', text: 'answered in the second run', usage: heavy }], ['--budget', '5'], { turns: [{ kind: 'text', text: 'answered in the first run', usage: heavy }], flags: [] })
  console.log(`  ${said(played)}`)
  check('the run ends budget_limit with no model call made', played.code === 1 && played.outcome?.status === 'budget_limit' && played.calls === 0 && played.outcome?.steps === 0, said(played))
  check('the outcome says so in the same words: the spend the session brought with it, and the input the call would carry', played.outcome?.error?.message === "Stopped before a model call the budget of $5 could not pay: $4.625 spent, and the call's input alone would cost at least $0.45", j(played.outcome?.error))
}

if (failures === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
console.log(`\n${checks} checks, ${failures} failures`)
if (failures > 0) {
  console.log('BUDGET BEFORE A CALL RED')
  process.exit(1)
}
console.log('BUDGET BEFORE A CALL GREEN')
