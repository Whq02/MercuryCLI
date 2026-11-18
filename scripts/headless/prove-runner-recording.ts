#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIXTURE_MODEL, fixtureCli, withFixtureRunner } from '../lib/builtProduct.ts'
import { handoffTurn, type ScriptedTurn } from '../lib/fixtureApi.ts'
import type { HostedRunner } from '../lib/runnerHost.ts'
import { RPC_INVALID_PARAMS, RPC_REFUSED } from '../../src/runner/wire/errors.ts'
import { RUNNER_NOTIFICATION_METHODS, RUNNER_REQUEST_METHODS } from '../../src/cli/headless/runnerMethods.ts'

type Want = 'answer' | 'refused' | 'invalid' | 'failed'
type Answer = { result: unknown } | { error: { code?: number; message: string; data?: unknown } }
type Taken = { arm: string; call: string; want: Want; params: unknown; answer: Answer }
type PrintRun = { name: string; format: string; args: string[]; status: number | null; stdout: string; stderr: string }
type Recording = { arms: Taken[]; scenes: Record<string, unknown>; prints: PrintRun[] }

const argOf = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

const CLAIMED = '6f1d2c3b-4a59-4e68-9f70-a1b2c3d4e5f6'
const UNSEEN = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const OTHER_MODEL = 'claude-sonnet-5'
const QUIESCE_TOKEN = 'recording-token-0001'

const taken: Taken[] = []

async function call(runner: HostedRunner, arm: string, name: string, want: Want, params: unknown, deadlineMs = 30_000): Promise<Answer> {
  let answer: Answer
  try {
    answer = { result: await runner.peer.request(arm as never, params as never, { deadlineMs }) }
  } catch (error) {
    const e = error as { code?: number; message?: string; data?: unknown }
    answer = { error: { ...(e.code !== undefined ? { code: e.code } : {}), message: String(e.message), ...(e.data !== undefined ? { data: e.data } : {}) } }
  }
  taken.push({ arm, call: name, want, params, answer })
  return answer
}

const outcomes = (runner: HostedRunner): number => runner.rows.filter(row => row.type === 'outcome').length
const settled = (runner: HostedRunner, n: number): Promise<unknown> => runner.waitFor(`outcome ${n}`, () => outcomes(runner) >= n, 60_000)
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function idleScene(): Promise<unknown> {
  const turns: ScriptedTurn[] = [handoffTurn(), { kind: 'text', text: 'First answer.' }]
  return withFixtureRunner(turns, async runner => {
    const a = (arm: string, name: string, want: Want, params: unknown): Promise<Answer> => call(runner, arm, name, want, params)
    await a('project/query', 'the sessions of a folder nobody trusted', 'failed', { op: 'sessions' })
    await a('project/query', 'an op that is none of the six', 'invalid', { op: 'nope' })
    await a('project/query', 'a key the strict object does not hold', 'invalid', { op: 'sessions', extra: true })
    await a('session/facts', 'the facts before a turn', 'answer', {})
    await a('session/facts', 'params that are a string', 'invalid', 'facts')
    await a('session/facts', 'params that are a number', 'invalid', 7)
    await a('session/set_effort', 'an effort on the ladder', 'answer', { effort: 'high' })
    await a('session/set_effort', 'an effort that is not on the ladder', 'refused', { effort: 'ludicrous' })
    await a('session/set_effort', 'no effort', 'invalid', {})
    await a('session/set_mode', 'a mode', 'answer', { mode: 'implement' })
    await a('session/set_mode', 'a mode that is none', 'refused', { mode: 'nope' })
    await a('session/set_mode', 'no mode', 'invalid', {})
    await a('session/set_spawn_switch', 'crewmates off while idle', 'answer', { switch: 'subagents', on: false })
    await a('session/set_spawn_switch', 'a switch that is none', 'invalid', { switch: 'bogus', on: true })
    await a('session/set_spawn_switch', 'no on', 'invalid', { switch: 'subagents' })
    await a('session/set_spawn_switch', 'crewmates back on', 'answer', { switch: 'subagents', on: true })
    await a('session/set_spawn_switch', 'the workflows switch', 'answer', { switch: 'workflows', on: true })
    await a('session/set_model', 'another model while idle', 'answer', { model: OTHER_MODEL, words: 'the other one' })
    await a('session/set_model', 'a model no provider serves', 'refused', { model: 'compat/no-such-lane/no-such-model' })
    await a('session/set_model', 'a model that is a number', 'invalid', { model: 5 })
    await a('session/set_model', 'back to the first model', 'answer', { model: FIXTURE_MODEL })
    await a('mcp/action', 'cancel a sign-in that is not running', 'answer', { name: 'no-such-server', action: 'cancel-auth' })
    await a('mcp/action', 'reconnect a server that is not configured', 'answer', { name: 'no-such-server', action: 'reconnect' })
    await a('mcp/action', 'an action that is none', 'invalid', { name: 'no-such-server', action: 'explode' })
    await a('mcp/action', 'an empty name', 'invalid', { name: '', action: 'reconnect' })
    await a('mcp/tools', 'the tools of a server that is absent', 'answer', { name: 'no-such-server' })
    await a('mcp/tools', 'no name', 'invalid', {})
    await a('mcp/tools', 'an empty name', 'invalid', { name: '' })
    await a('session/set_kit', 'a kit with no servers and no skills', 'answer', { kit: { schema: 1, mcp: [], skills: [], invocable: [] } })
    await a('session/set_kit', 'a kit that is a number', 'refused', { kit: 5 })
    await a('session/set_kit', 'a kit whose lists are not lists', 'refused', { kit: { mcp: 'all', skills: 7 } })
    await a('session/pause_gate', 'pause', 'answer', { paused: true })
    await a('session/pause_gate', 'no paused', 'invalid', {})
    await a('session/pause_gate', 'paused that is a word', 'invalid', { paused: 'yes' })
    await a('session/pause_gate', 'resume', 'answer', { paused: false })
    await a('session/board_post', 'a post to the board', 'answer', { client_op_id: 'recording-1', channel: 'general', text: 'recorded' })
    await a('session/board_post', 'an empty op id', 'invalid', { client_op_id: '', channel: 'general', text: 'recorded' })
    await a('session/board_post', 'a channel that is none', 'invalid', { client_op_id: 'recording-2', channel: 'shout', text: 'recorded' })
    await a('schedule/roster', 'a roster of one fire and one junk row', 'answer', { schedules: [{ id: 's1', when: 'every day at 9', kind: 'fire', next_fire_ms: 1 }, { id: 5 }] })
    await a('schedule/roster', 'params that are a string', 'invalid', 'roster')
    await a('schedule/roster', 'params that are a number', 'invalid', 7)
    await a('turn/interrupt', 'an interrupt with no turn in flight', 'answer', { op_id: 'recording-op' })
    await a('turn/interrupt', 'the same op again', 'answer', { op_id: 'recording-op' })
    await a('turn/interrupt', 'hard that is a word', 'invalid', { hard: 'yes' })
    await a('turn/interrupt', 'an op id that is a number', 'invalid', { op_id: 5 })
    await a('queue/withdraw', 'an id nothing queued carries', 'answer', { id: 'no-such-line' })
    await a('queue/withdraw', 'no id', 'invalid', {})
    await a('queue/withdraw', 'an id that is a number', 'invalid', { id: 5 })
    await a('agent/stop', 'an agent that does not exist', 'refused', { agent_id: 'a-none' })
    await a('agent/stop', 'no agent', 'invalid', {})
    await a('agent/stop', 'an agent that is a number', 'invalid', { agent_id: 5 })
    await a('agent/resume', 'no agent', 'invalid', {})
    await a('agent/resume', 'an agent that is a number', 'invalid', { agent_id: 5 })
    await a('shell/background', 'no shell in the foreground', 'refused', {})
    await a('shell/background', 'params that are a string', 'invalid', 'background')
    await a('shell/background', 'params that are a number', 'invalid', 7)
    await a('session/send_now', 'nothing in flight', 'answer', {})
    await a('session/send_now', 'params that are a string', 'invalid', 'now')
    await a('session/send_now', 'params that are a number', 'invalid', 7)
    await a('session/claim', 'a claim on a runner that carries its identity', 'refused', { session_id: CLAIMED })
    await a('session/claim', 'no session id', 'invalid', {})
    runner.peer.notify('credentials/changed' as never, {} as never)
    await a('session/facts', 'the facts after credentials/changed', 'answer', {})
    await a('queue/add', 'a prompt', 'answer', { type: 'prompt', content: 'say the first answer', id: UNSEEN })
    await settled(runner, 1)
    await a('queue/add', 'the same id again', 'answer', { type: 'prompt', content: 'say the first answer', id: UNSEEN })
    await a('queue/add', 'a prompt with no words', 'invalid', { type: 'prompt', content: '' })
    await a('queue/add', 'a row that is no input', 'invalid', { type: 'shout', content: 'x' })
    await a('session/rewind', 'a dry rewind to the prompt', 'answer', { user_message_id: UNSEEN, mode: 'conversation', dry_run: true })
    await a('session/rewind', 'a rewind to a message nothing carries', 'answer', { user_message_id: 'no-such-message', mode: 'conversation', dry_run: true })
    await a('session/rewind', 'a mode that is none', 'invalid', { user_message_id: UNSEEN, mode: 'everything' })
    await a('session/rewind', 'a message id that is a number', 'invalid', { user_message_id: 5, mode: 'code' })
    await a('session/file_restore', 'a dry undo with nothing to undo', 'answer', { action: 'undo', user_message_id: UNSEEN, dry_run: true })
    await a('session/file_restore', 'a restore with no file', 'invalid', { action: 'restore', user_message_id: UNSEEN })
    await a('session/file_restore', 'an action that is none', 'invalid', { action: 'explode', user_message_id: UNSEEN })
    await a('agent/resume', 'an agent nothing recorded', 'failed', { agent_id: 'a-none' })
    await a('session/facts', 'the facts after a turn', 'answer', {})
    await a('session/quiesce', 'a token too short to be one', 'refused', { action: 'prepare', token: 'short' })
    await a('session/quiesce', 'prepare', 'answer', { action: 'prepare', token: QUIESCE_TOKEN })
    await a('session/quiesce', 'commit under another token', 'refused', { action: 'commit', token: 'another-token-0002' })
    await a('session/quiesce', 'an action that is none', 'invalid', { action: 'explode', token: QUIESCE_TOKEN })
    await a('session/quiesce', 'cancel', 'answer', { action: 'cancel', token: QUIESCE_TOKEN })
    await a('session/leave', 'params that are a string', 'invalid', 'leave')
    await a('session/leave', 'params that are a number', 'invalid', 7)
    await a('session/leave', 'leave with a conversation', 'answer', {})
    await pause(200)
    const code = await runner.stop(5_000)
    return { rows: [...runner.rows], notifications: [...runner.notifications], stderr: runner.stderr(), exit: code }
  })
}

async function inFlightScene(): Promise<unknown> {
  const turns: ScriptedTurn[] = [{ kind: 'hang', deltas: ['Thinking'] }, { kind: 'text', text: 'Second answer.' }]
  return withFixtureRunner(turns, async runner => {
    const a = (arm: string, name: string, want: Want, params: unknown): Promise<Answer> => call(runner, arm, name, want, params)
    await a('queue/add', 'a prompt whose turn hangs', 'answer', { type: 'prompt', content: 'hang here' })
    await runner.waitFor('the hanging turn has its first byte', row => row.type === 'wait' && row.state === 'done', 60_000)
    await a('session/set_model', 'another model while a turn is in flight', 'answer', { model: OTHER_MODEL })
    await a('session/set_effort', 'an effort while a turn is in flight', 'answer', { effort: 'low' })
    await a('session/set_spawn_switch', 'crewmates off while a turn is in flight', 'answer', { switch: 'subagents', on: false })
    await a('queue/add', 'a later line behind the turn', 'answer', { type: 'prompt', content: 'a line to withdraw', id: UNSEEN, priority: 'later' })
    await a('session/facts', 'the facts with a turn in flight and a line queued', 'answer', {})
    await a('queue/withdraw', 'the queued line', 'answer', { id: UNSEEN })
    await a('queue/withdraw', 'the same line again', 'answer', { id: UNSEEN })
    await a('session/send_now', 'send now with a turn in flight', 'answer', {})
    await a('session/leave', 'leave with a turn in flight', 'answer', {})
    await a('session/rewind', 'a rewind with a turn in flight', 'answer', { user_message_id: 'no-such-message', mode: 'conversation', dry_run: true })
    await a('session/quiesce', 'prepare with a turn in flight', 'refused', { action: 'prepare', token: QUIESCE_TOKEN })
    await a('turn/interrupt', 'an interrupt of another turn', 'answer', { turn_id: 'not-this-turn' })
    await a('turn/interrupt', 'an interrupt with a turn in flight', 'answer', { op_id: 'recording-flight' })
    await settled(runner, 1)
    await runner.waitFor('the three held verbs land', () => runner.notifications.filter(n => n.method === 'session/applied').length >= 3, 30_000).catch(() => undefined)
    await pause(300)
    await a('session/facts', 'the facts after the interrupt', 'answer', {})
    await a('queue/add', 'a prompt after the interrupt', 'answer', { type: 'prompt', content: 'say the second answer' })
    await settled(runner, 2)
    await a('session/quiesce', 'prepare', 'answer', { action: 'prepare', token: QUIESCE_TOKEN })
    await a('session/quiesce', 'commit', 'answer', { action: 'commit', token: QUIESCE_TOKEN })
    const code = await Promise.race([runner.exited, pause(10_000).then(() => 'still running' as const)])
    return { rows: [...runner.rows], notifications: [...runner.notifications], stderr: runner.stderr(), exit: code }
  })
}

async function claimScene(): Promise<unknown> {
  const turns: ScriptedTurn[] = [{ kind: 'text', text: 'Claimed answer.' }]
  return withFixtureRunner(
    turns,
    async runner => {
      const a = (arm: string, name: string, want: Want, params: unknown): Promise<Answer> => call(runner, arm, name, want, params)
      await a('session/facts', 'the facts before the claim', 'answer', {})
      await a('agent/resume', 'a resume before the claim', 'refused', { agent_id: 'a-none' })
      await a('session/claim', 'a session id that is no uuid', 'refused', { session_id: 'not-a-uuid' })
      await a('session/claim', 'a mode that is none', 'refused', { session_id: CLAIMED, mode: 'bogus' })
      await a('session/claim', 'an effort that is not on the ladder', 'refused', { session_id: CLAIMED, effort: 'banana' })
      await a('session/claim', 'a model no provider serves', 'refused', { session_id: CLAIMED, model: 'compat/no-such-lane/no-such-model' })
      await a('session/claim', 'a resume of a session nothing recorded', 'refused', { session_id: UNSEEN, resume: true })
      await a('session/claim', 'a session id that is a number', 'invalid', { session_id: 5 })
      await a('session/claim', 'the claim', 'answer', { session_id: CLAIMED, model: FIXTURE_MODEL, mode: 'implement', effort: 'high', title: 'the recorded claim', restart_reason: 'crash' })
      await a('session/facts', 'the facts after the claim', 'answer', {})
      await a('session/claim', 'a second claim', 'refused', { session_id: UNSEEN })
      await a('queue/add', 'a prompt on the claimed session', 'answer', { type: 'prompt', content: 'say the claimed answer' })
      await settled(runner, 1)
      await a('session/facts', 'the facts after the claimed turn', 'answer', {})
      const code = await runner.stop(5_000)
      return { rows: [...runner.rows], notifications: [...runner.notifications], stderr: runner.stderr(), exit: code }
    },
    { model: null, env: { MERCURY_CONCOURSE_WORKER: '1' } },
  )
}

async function printRuns(): Promise<PrintRun[]> {
  const asksToRead: ScriptedTurn = { kind: 'tool_use', name: 'Read', input: { file_path: join(import.meta.dir, 'no-such-file') } }
  const refusal: ScriptedTurn = { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'the fixture says no' }
  const runs: Array<{ name: string; turns: ScriptedTurn[]; args: string[] }> = [
    { name: 'completed', turns: [{ kind: 'text', text: 'DONE.' }], args: ['--model', FIXTURE_MODEL, 'hi'] },
    { name: 'refused', turns: [], args: ['--model', 'compat/no-such-lane/no-such-model', 'hi'] },
    { name: 'failed', turns: [refusal, refusal, refusal], args: ['--model', FIXTURE_MODEL, 'hi'] },
    { name: 'turn limit', turns: [asksToRead, { kind: 'text', text: 'DONE.' }], args: ['--max-turns', '1', '--model', FIXTURE_MODEL, 'hi'] },
    { name: 'blocked', turns: [asksToRead, { kind: 'text', text: 'DONE.' }], args: ['--model', FIXTURE_MODEL, 'hi'] },
  ]
  const out: PrintRun[] = []
  for (const run of runs) {
    for (const format of ['text', 'json', 'rows']) {
      const args = ['run', '--format', format, ...run.args]
      const ran = await fixtureCli(run.turns, args)
      out.push({ name: run.name, format, args, status: ran.status, stdout: ran.stdout, stderr: ran.stderr })
    }
  }
  return out
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const CLOCK_KEYS = /^(?:ts|t|at|pid|port|load_per_core|available_mb)$|(?:Ms|_ms|At|_at|Duration|Seconds|_s|Time|Bytes)$/
const FIXED = new Set(['next_fire_ms', 'nextFireMs', 'streamIdleTimeoutMs', 'stream_idle_timeout_ms'])
const BUILD_KEYS = new Set(['build_tree', 'buildTree', 'build'])

function masked(recording: Recording): Recording {
  const ids = new Map<string, string>()
  const idOf = (uuid: string): string => {
    const key = uuid.toLowerCase()
    if (!ids.has(key)) ids.set(key, `<uuid ${ids.size + 1}>`)
    return ids.get(key)!
  }
  const temp = [...new Set([tmpdir(), realpathSync(tmpdir())])].sort((x, y) => y.length - x.length)
  const words = (text: string): string => {
    let out = text
    for (const root of temp) out = out.split(root).join('<tmp>')
    return out
      .replace(/\/[A-Za-z0-9._/-]*?\/built-product-/g, '<tmp>/built-product-')
      .replace(/<tmp>\/built-product-[A-Za-z0-9]+\/(?:run|fix|cli)-cwd-[A-Za-z0-9]+/g, '<cwd>')
      .replace(/<tmp>\/built-product-[A-Za-z0-9]+\/(?:run|fix|cli)-[A-Za-z0-9]+/g, '<home>')
      .replace(/<tmp>\/built-product-[A-Za-z0-9]+/g, '<scratch>')
      .replace(/projects\/-[A-Za-z0-9_-]+/g, 'projects/<slug>')
      .replace(UUID, idOf)
      .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<time>')
      .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?\b/g, '<time>')
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?: ?[AP]M)?\b/g, '<clock>')
      .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
      .replace(/\bpid \d+\b/g, 'pid <pid>')
      .replace(/\b1[6-9]\d{11}\b/g, '<ms>')
      .replace(/\b[0-9a-f]{40}\b/g, '<digest>')
  }
  const walk = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') return BUILD_KEYS.has(key) ? `<${key}>` : words(value)
    if (typeof value === 'number') return CLOCK_KEYS.test(key) && !FIXED.has(key) ? `<${key}>` : value
    if (Array.isArray(value)) return value.map(item => walk(item, key))
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]))
    return value
  }
  const lines = (text: string): unknown =>
    text
      .split('\n')
      .filter(line => line !== '')
      .map(line => {
        try {
          return walk(JSON.parse(line))
        } catch {
          return words(line)
        }
      })
  return {
    arms: recording.arms.map(t => walk(t) as Taken),
    scenes: walk(recording.scenes) as Record<string, unknown>,
    prints: recording.prints.map(p => ({ ...p, args: p.args.map(words), stdout: lines(p.stdout) as never, stderr: lines(p.stderr) as never })),
  }
}

function differences(a: unknown, b: unknown, path = '$', out: string[] = []): string[] {
  if (out.length >= 60) return out
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${JSON.stringify(a)?.slice(0, 160)} ≠ ${JSON.stringify(b)?.slice(0, 160)}`)
    return out
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: one is a list and the other is not`)
    return out
  }
  const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])]
  for (const key of keys) differences((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], Array.isArray(a) ? `${path}[${key}]` : `${path}.${key}`, out)
  return out
}

const classOf = (answer: Answer): Want => ('result' in answer ? 'answer' : answer.error.code === RPC_INVALID_PARAMS ? 'invalid' : answer.error.code === RPC_REFUSED ? 'refused' : 'failed')

const remask = argOf('--remask')
if (remask !== undefined) {
  writeFileSync(argOf('--out') ?? remask.replace(/\.raw\.json$/, '.json'), JSON.stringify(masked(JSON.parse(readFileSync(remask, 'utf8')) as Recording), null, 1) + '\n')
  process.exit(0)
}

section('§1 the runner of the built bundle answers each arm: one call it takes and two it refuses')
const scenes: Record<string, unknown> = {}
scenes.idle = await idleScene()
scenes.inFlight = await inFlightScene()
scenes.claim = await claimScene()
const arms = [...RUNNER_REQUEST_METHODS, ...RUNNER_NOTIFICATION_METHODS]
const requested = RUNNER_REQUEST_METHODS.filter(arm => taken.filter(t => t.arm === arm && t.want === 'answer').length >= 1 || taken.filter(t => t.arm === arm).length >= 3)
const wrong = taken.filter(t => classOf(t.answer) !== t.want)
check(`every call came back in its class: an answer, a refusal of the runner (${RPC_REFUSED}) or params the wire refuses (${RPC_INVALID_PARAMS}) (${taken.length} calls)`, wrong.length === 0, wrong.map(t => `${t.arm} · ${t.call}: wanted ${t.want}, got ${JSON.stringify(t.answer).slice(0, 200)}`).join('\n      '))
const thin = RUNNER_REQUEST_METHODS.filter(arm => taken.filter(t => t.arm === arm).length < 3 || taken.filter(t => t.arm === arm && t.want !== 'answer').length < 2)
check(`each of the ${RUNNER_REQUEST_METHODS.length} request arms is called at least three times, two of them calls it must refuse (${arms.length} arms with the notification)`, thin.length === 0 && requested.length === RUNNER_REQUEST_METHODS.length, thin.join(', '))
const afterNotice = taken.find(t => t.call === 'the facts after credentials/changed')
check('the credentials/changed notification is taken with no answer, and the runner answers the next request', afterNotice !== undefined && 'result' in afterNotice.answer)

section('§2 four scripted print runs and one refused at boot, in the three formats')
const prints = await printRuns()
const statusOf = (name: string): string => prints.filter(p => p.name === name).map(p => `${p.format} ${p.status}`).join(' · ')
check('each print run ended with an exit code', prints.every(p => p.status !== null), prints.map(p => `${p.name}/${p.format}: ${p.status}`).join(' · '))
check('the completed run exits 0 and the others do not', prints.filter(p => p.name === 'completed').every(p => p.status === 0) && prints.filter(p => p.name !== 'completed').every(p => p.status !== 0), ['completed', 'refused', 'failed', 'turn limit', 'blocked'].map(name => `${name}: ${statusOf(name)}`).join(' | '))

const recording = masked({ arms: taken, scenes, prints })
const out = argOf('--out')
if (out !== undefined) {
  writeFileSync(out, JSON.stringify(recording, null, 1) + '\n')
  console.log(`  wrote ${out}`)
}
const raw = argOf('--raw')
if (raw !== undefined) writeFileSync(raw, JSON.stringify({ arms: taken, scenes, prints }, null, 1) + '\n')
const against = argOf('--against')
if (against !== undefined) {
  section(`§3 the recording against ${against}`)
  const diffs = differences(JSON.parse(readFileSync(against, 'utf8')), JSON.parse(JSON.stringify(recording)))
  check('the recording equals the other, field for field, with clocks, ids, pids and temp paths masked', diffs.length === 0, `${diffs.length} difference${diffs.length === 1 ? '' : 's'}:\n      ${diffs.join('\n      ')}`)
}

console.log(failures === 0 ? '\nprove-runner-recording: green' : `\nprove-runner-recording: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
