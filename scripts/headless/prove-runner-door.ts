#!/usr/bin/env bun
// gate-watch: src/cli/print.ts src/cli/headless/runnerMethods.ts src/cli/headless/runnerAsks.ts src/runner/wire/* src/main.tsx src/entrypoints/cli.tsx
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { hostRunner, scratchHome } from '../lib/runnerHost.ts'
import { RPC_INVALID_PARAMS, RPC_METHOD_NOT_FOUND, RPC_NOT_INITIALIZED, RPC_REFUSED } from '../../src/runner/wire/errors.ts'

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
const guarded = async (body: () => Promise<void>): Promise<void> => {
  try {
    await body()
  } catch (error) {
    check('the section ran to its end', false, error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  }
}
const errorOf = async (p: Promise<unknown>): Promise<{ code?: number; message: string; data?: { kind?: string } } | null> => {
  try {
    await p
    return null
  } catch (error) {
    return error as { code?: number; message: string; data?: { kind?: string } }
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
console.log(`runner door proof against ${DIST}`)
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the runner door proof exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

section('§1 the handshake: nothing before initialize, a protocol mismatch refused, the table\'s codes for an unknown method and bad params')
await guarded(async () => {
  const api = await startFixtureApi([{ kind: 'text', text: 'DOOR-ONE.' }])
  const scratch = scratchHome('runner-door-')
  const host = hostRunner({ dist: DIST, node, cwd: scratch.cwd, home: scratch.home, env: { ...scratch.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'fixture-key-000' }, argv: ['--model', 'claude-opus-4-8'] })
  const exitedEarly = host.exited.then(code => `the runner exited ${code} before the handshake: ${host.stderr().slice(0, 300)}`)
  const early = await Promise.race([errorOf(host.request('session/facts', {}, 60_000)), exitedEarly])
  check('a request before initialize is refused with -32002 (not initialized)', typeof early === 'object' && early !== null && early.code === RPC_NOT_INITIALIZED, j(early))
  const mismatch = await Promise.race([errorOf(host.peer.request('initialize', { protocol: 7, host: { name: 'proof', version: '0' }, capabilities: { holds_asks: true, elicitation: false, partial_rows: false } }, { deadlineMs: 90_000 })), exitedEarly])
  check('a protocol mismatch is refused -32010 with kind protocol and the runner\'s own protocol in the data', typeof mismatch === 'object' && mismatch !== null && mismatch.code === RPC_REFUSED && mismatch.data?.kind === 'protocol' && (mismatch.data as { protocol?: number }).protocol === 1, j(mismatch))
  const init = await Promise.race([host.initialize({}, 90_000), exitedEarly])
  check('initialize answers protocol 1, the runner (version, pid) and the session id', typeof init === 'object' && init.protocol === 1 && typeof init.runner.version === 'string' && init.runner.pid === host.child.pid && typeof init.session_id === 'string', j(init))
  const again = await errorOf(host.initialize({}, 10_000))
  check('a second initialize is refused (already initialized)', again?.code === RPC_REFUSED && again.data?.kind === 'already-initialized', j(again))
  const unknown = await errorOf(host.peer.request('session/frobnicate' as never, {} as never, { deadlineMs: 10_000 }))
  check('an unknown method answers -32601, never a sentence to match', unknown?.code === RPC_METHOD_NOT_FOUND, j(unknown))
  const badParams = await errorOf(host.peer.request('turn/interrupt', { hard: 'yes' } as never, { deadlineMs: 10_000 }))
  check("params the method's schema refuses answer -32602 naming the method and the issue", badParams?.code === RPC_INVALID_PARAMS && j(badParams.data).includes('turn/interrupt') && j(badParams.data).includes('hard'), j(badParams))
  const modeWord = await errorOf(host.request('session/set_mode', { mode: 'frobnicate' }, 10_000))
  check('a mode word off the one list is refused -32010 kind mode in one sentence naming the word and the list', modeWord?.code === RPC_REFUSED && modeWord.data?.kind === 'mode' && modeWord.message.includes("'frobnicate' is not a permission mode") && modeWord.message.includes('default, dontAsk, implement, sovereign, flow, apollo'), j(modeWord))
  const mode = await host.request('session/set_mode', { mode: 'implement' }, 10_000)
  check('a lawful mode lands and answers the mode; the mode row follows', mode.mode === 'implement' && (await host.waitFor('the mode row', row => row.type === 'mode' && row.mode === 'implement', 10_000)) !== undefined)
  const code = await host.stop()
  await api.close()
  check('closing stdin ends a runner that ran no turn, exit 0 or 1 and no crash', code === 0 || code === 1, `exit=${code} stderr=${host.stderr().slice(0, 300)}`)
  rmSync(scratch.home, { recursive: true, force: true })
  rmSync(scratch.cwd, { recursive: true, force: true })
})

section('§2 a turn: queue/add opens it, rows ride `row`, the outcome closes it; a duplicate id is refused; the interrupt answers in flight')
await guarded(async () => {
  const api = await startFixtureApi([
    { kind: 'text', text: 'DOOR-ONE.' },
    { kind: 'paced', deltas: ['slow', '…', 'ly', '…'], gapMs: 400 },
    { kind: 'hang', deltas: ['hanging…'] },
    { kind: 'text', text: 'DOOR-FOUR.' },
  ])
  const scratch = scratchHome('runner-door-')
  const host = hostRunner({ dist: DIST, node, cwd: scratch.cwd, home: scratch.home, env: { ...scratch.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'fixture-key-000' }, argv: ['--model', 'claude-opus-4-8'] })
  const init = await host.initialize({}, 90_000)
  const id = '11111111-1111-4111-8111-111111111111'
  const added = await host.prompt('say one', { id, priority: 'next' })
  check('queue/add accepts the prompt', added.accepted === true, j(added))
  const turnRow = await host.waitFor('the turn row', row => row.type === 'turn' && row.state === 'started', 60_000)
  check('the turn row carries the prompt id as its message id and the session id of the handshake', j(turnRow.message_ids) === j([id]) && turnRow.session_id === init.session_id, j(turnRow))
  const outcome = await host.waitFor('the first outcome', row => row.type === 'outcome' && row.turn === 1, 60_000)
  check('the outcome completes with the answer', outcome.status === 'completed' && outcome.answer === 'DOOR-ONE.', j(outcome))
  const sessionAt = host.rows.findIndex(row => row.type === 'session')
  const turnAt = host.rows.indexOf(turnRow)
  check('the session row came first and before the turn row', sessionAt !== -1 && turnAt !== -1 && sessionAt < turnAt, j(host.rows.map(r => r.type)))
  const dup = await host.prompt('say one', { id })
  check('the same id again is refused as a duplicate', dup.accepted === false && dup.reason === 'duplicate', j(dup))

  const second = await host.prompt('go slowly')
  check('a second prompt is accepted', second.accepted === true)
  await host.waitFor('the second turn open', row => row.type === 'turn' && row.state === 'started' && row.turn === 2, 60_000)
  const heldModel = await host.request('session/set_model', { model: 'claude-opus-4-8' }, 10_000)
  check("a model verb that lands mid-turn answers at 'turn_end'", heldModel.at === 'turn_end' && heldModel.model === 'claude-opus-4-8', j(heldModel))
  const facts = await host.request('session/facts', {}, 30_000)
  check('session/facts answers mid-turn with the facts (model, usage, queue, work)', typeof facts.model === 'object' && 'usage' in facts && Array.isArray(facts.queue), j(Object.keys(facts)))
  const outcome2 = await host.waitFor('the second outcome', row => row.type === 'outcome' && row.turn === 2, 60_000)
  check('the paced turn completes', outcome2.status === 'completed', j(outcome2))
  await new Promise(resolve => setTimeout(resolve, 200))
  const applied = host.notifications.find(n => n.method === 'session/applied')
  check('session/applied names the held request by its JSON-RPC id and the verb once the turn ended', applied !== undefined && (applied.params as { verb?: string; model?: string; request_id?: number }).verb === 'set_model' && typeof (applied.params as { request_id?: number }).request_id === 'number', j(applied))

  const third = await host.prompt('hang')
  check('a third prompt is accepted', third.accepted === true)
  const turn3 = await host.waitFor('the third turn open', row => row.type === 'turn' && row.state === 'started' && row.turn === 3, 60_000)
  await host.waitFor('the third turn streams', row => row.type === 'wait' && row.state === 'done' && row.turn === 3, 60_000)
  const stale = await host.request('turn/interrupt', { turn_id: 'not-this-turn' }, 10_000)
  check('an interrupt naming another turn does nothing and says so', stale.interrupted === false, j(stale))
  const t0 = Date.now()
  const interrupted = await host.request('turn/interrupt', { turn_id: String(turn3.turn_id), op_id: 'op-1' }, 10_000)
  const interruptMs = Date.now() - t0
  check(`turn/interrupt naming the open turn answers interrupted within ${interruptMs} ms`, interrupted.interrupted === true && interruptMs < 2_000, j(interrupted))
  const outcome3 = await host.waitFor('the interrupted outcome', row => row.type === 'outcome' && row.turn === 3, 60_000)
  check('the interrupted outcome reaches the host', outcome3.status === 'interrupted', j(outcome3))
  const repeat = await host.request('turn/interrupt', { op_id: 'op-1' }, 10_000)
  check('a repeated op_id is a retry: it answers what the first delivery did (interrupted)', repeat.interrupted === true, j(repeat))
  const idle = await host.request('turn/interrupt', { op_id: 'op-idle' }, 10_000)
  const idleAgain = await host.request('turn/interrupt', { op_id: 'op-idle' }, 10_000)
  check('an interrupt with no turn running interrupts nothing, and its retry says the same', idle.interrupted === false && idleAgain.interrupted === false, j([idle, idleAgain]))
  const seqs = host.rows.map(row => Number(row.seq))
  check('seq is contiguous from 1 across every row notification', seqs.every((seq, i) => seq === i + 1), j(seqs))
  const code = await host.stop()
  await api.close()
  check('closing stdin ends the runner; its exit code follows the last outcome (interrupted → 1)', code === 1, `exit=${code} stderr=${host.stderr().slice(0, 300)}`)
  rmSync(scratch.home, { recursive: true, force: true })
  rmSync(scratch.cwd, { recursive: true, force: true })
})

section('§3 the ask: permission/request carries the tool and its input; deny carries its message into the tool result and the outcome\'s denials; deny with stop ends the turn')
await guarded(async () => {
  const scratch = scratchHome('runner-door-')
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Write', input: { file_path: join(scratch.cwd, 'denied.txt'), content: 'no\n' }, preText: 'Writing.' },
    { kind: 'text', text: 'DOOR-DENIED.' },
    { kind: 'tool_use', name: 'Write', input: { file_path: join(scratch.cwd, 'stopped.txt'), content: 'no\n' }, preText: 'Writing again.' },
    { kind: 'text', text: 'NEVER.' },
  ])
  const host = hostRunner({ dist: DIST, node, cwd: scratch.cwd, home: scratch.home, env: { ...scratch.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'fixture-key-000' }, argv: ['--model', 'claude-opus-4-8'] })
  await host.initialize({}, 90_000)
  await host.prompt('write it')
  const ask = await host.waitForAsk('the first ask', 60_000)
  check('the ask names the tool, the call id and the input', ask.params.kind === 'tool' && ask.params.tool_name === 'Write' && typeof ask.params.tool_use_id === 'string' && (ask.params.input as { file_path?: string }).file_path === join(scratch.cwd, 'denied.txt'), j(ask.params))
  host.answerAsk(ask.id, { outcome: 'deny', message: 'the host says no' })
  const result = await host.waitFor('the tool result', row => row.type === 'tool_result', 60_000)
  check("the denial reaches the model as an error tool result carrying the host's words", result.status === 'error' && String(result.output).includes('the host says no'), j(result))
  const outcome = await host.waitFor('the outcome', row => row.type === 'outcome' && row.turn === 1, 60_000)
  check('the outcome completes and lists the denial', outcome.status === 'completed' && Array.isArray(outcome.denials) && (outcome.denials as Array<{ tool?: string }>).length === 1 && (outcome.denials as Array<{ tool?: string }>)[0]!.tool === 'Write', j(outcome.denials))
  check('nothing was written', !existsSync(join(scratch.cwd, 'denied.txt')))
  await host.prompt('write again')
  const ask2 = await host.waitForAsk('the second ask', 60_000)
  host.answerAsk(ask2.id, { outcome: 'deny', message: 'stop now', stop: true })
  const outcome2 = await host.waitFor('the stopped outcome', row => row.type === 'outcome' && row.turn === 2, 60_000)
  check('deny with stop ends the turn as interrupted', outcome2.status === 'interrupted', j(outcome2))
  const code = await host.stop()
  await api.close()
  check('the runner ends on stdin close', code !== null, `exit=${code}`)
  rmSync(scratch.home, { recursive: true, force: true })
  rmSync(scratch.cwd, { recursive: true, force: true })
})

section('§4 the warm runner: initialize answers session_id null, queue/add waits for session/claim, the claim names the session')
await guarded(async () => {
  const api = await startFixtureApi([{ kind: 'text', text: 'DOOR-CLAIMED.' }])
  const scratch = scratchHome('runner-door-')
  const host = hostRunner({ dist: DIST, node, cwd: scratch.cwd, home: scratch.home, env: { ...scratch.env, MERCURY_CONCOURSE_WORKER: '1', ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'fixture-key-000' }, argv: ['--model', 'claude-opus-4-8'] })
  const init = await host.initialize({}, 90_000)
  check('a warm runner answers initialize with session_id null', init.session_id === null, j(init))
  let queued = false
  const pending = host.prompt('say it').then(result => {
    queued = true
    return result
  })
  await new Promise(resolve => setTimeout(resolve, 500))
  check('queue/add before the claim waits (the queue scope is held)', queued === false)
  const sid = '22222222-2222-4222-8222-222222222222'
  const refused = await errorOf(host.request('session/claim', { session_id: 'not-a-uuid' }, 30_000))
  check('a claim without a UUID is refused -32010 kind claim', refused?.code === RPC_REFUSED && refused.data?.kind === 'claim', j(refused))
  const claimed = await host.request('session/claim', { session_id: sid, model: 'claude-opus-4-8' }, 60_000)
  check('the claim answers the session id', claimed.session_id === sid, j(claimed))
  const added = await pending
  check('the held queue/add is answered once the claim landed', added.accepted === true, j(added))
  const outcome = await host.waitFor('the claimed turn outcome', row => row.type === 'outcome', 60_000)
  check('the turn ran under the claimed session', outcome.session_id === sid && outcome.status === 'completed', j({ session: outcome.session_id, status: outcome.status }))
  const second = await errorOf(host.request('session/claim', { session_id: sid }, 10_000))
  check('a second claim is refused: the runner carries a session identity', second?.code === RPC_REFUSED && second.data?.kind === 'claim', j(second))
  await host.stop()
  await api.close()
  rmSync(scratch.home, { recursive: true, force: true })
  rmSync(scratch.cwd, { recursive: true, force: true })
})

console.log('')
if (failures > 0) {
  console.log(`❌ runner door: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('✅ runner door: all laws hold')
