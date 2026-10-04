#!/usr/bin/env bun
// gate-watch: src/cli/run.ts src/cli/headless/hostAskLiveness.ts src/cli/headless/runnerAsks.ts src/runner/wire/* src/substrate/flagRegistry.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { hostRunner, scratchHome } from '../lib/runnerHost.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const distArg = process.argv.indexOf('--dist')
const DIST = distArg !== -1 && process.argv[distArg + 1] ? resolve(process.argv[distArg + 1]!) : join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const guarded = async (body: () => Promise<void>): Promise<void> => {
  try {
    await body()
  } catch (error) {
    check('the section ran to its end', false, error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  }
}

if (!existsSync(DIST)) {
  console.log(`❌ ${DIST} absent — build first`)
  process.exit(1)
}
const node = Bun.which('node')
if (node === null) {
  console.log('❌ no node binary on PATH')
  process.exit(1)
}
console.log(`the ask clock's owner — ${DIST}`)
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the ask clock proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const LIMIT_MINUTES = '0.05'
const LIMIT_MS = 3_000

function world(name: string): { scratch: ReturnType<typeof scratchHome>; env: Record<string, string> } {
  const scratch = scratchHome(`ask-clock-${name}-`)
  return { scratch, env: { ...scratch.env, MERCURY_HEADLESS_IDLE_MINUTES: LIMIT_MINUTES } }
}

section('§1 a host that holds the asks: the runner never denies a parked ask at the turn limit, the turn stays alive, the late answer lands')
await guarded(async () => {
  const { scratch, env } = world('held')
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Write', input: { file_path: join(scratch.cwd, 'held.txt'), content: 'held\n' }, preText: 'Writing.' },
    { kind: 'text', text: 'HELD-DONE.' },
  ])
  const host = hostRunner({ dist: DIST, node, cwd: scratch.cwd, home: scratch.home, env: { ...env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'fixture-key-000' }, argv: ['--model', 'claude-opus-4-8'] })
  await host.initialize({ holds_asks: true }, 90_000)
  await host.prompt('write it')
  const ask = await host.waitForAsk('the ask', 60_000)
  const askedAt = Date.now()
  await sleep(LIMIT_MS * 3)
  const outcomeEarly = host.rows.find(row => row.type === 'outcome')
  check(`${Math.round((Date.now() - askedAt) / 1000)} s past a ${LIMIT_MS / 1000} s limit: the ask is still the host's (no $/cancel_request from the runner)`, !host.withdrawn.has(ask.id), j([...host.withdrawn]))
  check('no tool result and no outcome landed while the host held the ask', !host.rows.some(row => row.type === 'tool_result') && outcomeEarly === undefined, j(host.rows.map(row => row.type)))
  check('the runner is alive', host.child.exitCode === null && host.child.signalCode === null)
  host.answerAsk(ask.id, { outcome: 'allow' })
  const result = await host.waitFor('the tool result', row => row.type === 'tool_result', 60_000)
  check('the late allow lands: the tool ran', result.status !== 'error' && existsSync(join(scratch.cwd, 'held.txt')), j(result))
  const outcome = await host.waitFor('the outcome', row => row.type === 'outcome', 60_000)
  check('the turn completes with no denial', outcome.status === 'completed' && Array.isArray(outcome.denials) && (outcome.denials as unknown[]).length === 0, j(outcome))
  await host.stop()
  await api.close()
  rmSync(scratch.home, { recursive: true, force: true })
  rmSync(scratch.cwd, { recursive: true, force: true })
})

section('§2 a host that declares nothing: the runner keeps its own clock — the parked ask is denied at the limit with the reason, withdrawn from the host, and the turn goes on')
await guarded(async () => {
  const { scratch, env } = world('runner-clock')
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Write', input: { file_path: join(scratch.cwd, 'late.txt'), content: 'late\n' }, preText: 'Writing.' },
    { kind: 'text', text: 'CLOCK-DONE.' },
  ])
  const host = hostRunner({ dist: DIST, node, cwd: scratch.cwd, home: scratch.home, env: { ...env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'fixture-key-000' }, argv: ['--model', 'claude-opus-4-8'] })
  await host.initialize({ holds_asks: false }, 90_000)
  await host.prompt('write it')
  const ask = await host.waitForAsk('the ask', 60_000)
  const askedAt = Date.now()
  const result = await host.waitFor('the tool result', row => row.type === 'tool_result', LIMIT_MS * 10)
  const waited = Date.now() - askedAt
  check(`the ask is denied by the runner at its limit (${waited} ms after the ask; limit ${LIMIT_MS} ms)`, result.status === 'error' && waited >= LIMIT_MS - 500 && waited < LIMIT_MS * 5, j(result))
  check("the denial names the reason: nobody answered within the turn's no-progress limit", String(result.output).includes('nobody answered within') && String(result.output).includes("no-progress limit"), String(result.output).slice(0, 300))
  check('the host\'s card is withdrawn ($/cancel_request for the ask)', host.withdrawn.has(ask.id), j([...host.withdrawn]))
  const outcome = await host.waitFor('the outcome', row => row.type === 'outcome', 60_000)
  check('the turn goes on and completes, the denial listed', outcome.status === 'completed' && Array.isArray(outcome.denials) && (outcome.denials as Array<{ tool?: string }>).some(d => d.tool === 'Write'), j(outcome))
  check('nothing was written', !existsSync(join(scratch.cwd, 'late.txt')))
  await host.stop()
  await api.close()
  rmSync(scratch.home, { recursive: true, force: true })
  rmSync(scratch.cwd, { recursive: true, force: true })
})

console.log('')
if (failures > 0) {
  console.log(`❌ ask clock owner: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ ask clock owner: the host that holds the asks owns their clock; a host that declares nothing gets the runner\'s')
