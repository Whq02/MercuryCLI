#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FIXTURE_MODEL, fixtureCli, withFixtureRunner } from '../lib/builtProduct.ts'
import { handoffTurn, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { nodeBinPath } from '../lib/nodeBin.ts'
import { endProcessGroup, spawnInOwnGroup } from '../lib/processGroup.ts'
import type { HostedRunner } from '../lib/runnerHost.ts'
import { FLAG_REGISTRY } from '../../src/platform/substrate/flagRegistry.ts'
import { RPC_INVALID_PARAMS, RPC_REFUSED } from '../../src/daemon/runner-wire/errors.ts'
import { RUNNER_NOTIFICATION_METHODS, RUNNER_REQUEST_METHODS } from '../../src/daemon/runner/runnerMethods.ts'

type Want = 'answer' | 'refused' | 'invalid' | 'failed'
type Answer = { result: unknown } | { error: { code?: number; message: string; data?: unknown } }
type Taken = { arm: string; call: string; want: Want; params: unknown; answer: Answer }
type PrintRun = { name: string; format: string; args: string[]; status: number | null; stdout: string; stderr: string }
type Recording = { arms: Taken[]; scenes: Record<string, unknown>; prints: PrintRun[]; later?: { calls: Taken[]; scenes: Record<string, unknown> } }

const argOf = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}

let failures = 0
const RECORDING_FAIL_HINT = 'to fix, change the arm named in the detail (the arms are bound in bindRunnerMethods in src/daemon/runner/runnerMethods.ts, project/query is served by src/daemon/runner/projectQuery.ts) so its answer class matches the want; if the new answer is intended, regenerate the stored recording with --out and rebuild the bundle with bun run build.ts first, since this proof runs the built bundle'
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} | ` : ''}${RECORDING_FAIL_HINT}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

const CLAIMED = '6f1d2c3b-4a59-4e68-9f70-a1b2c3d4e5f6'
const UNSEEN = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const OTHER_MODEL = 'claude-sonnet-5'
const QUIESCE_TOKEN = 'recording-token-0001'

const taken: Taken[] = []
const takenLater: Taken[] = []

async function call(runner: HostedRunner, arm: string, name: string, want: Want, params: unknown, deadlineMs = 30_000, into: Taken[] = taken): Promise<Answer> {
  let answer: Answer
  try {
    answer = { result: await runner.peer.request(arm as never, params as never, { deadlineMs }) }
  } catch (error) {
    const e = error as { code?: number; message?: string; data?: unknown }
    answer = { error: { ...(e.code !== undefined ? { code: e.code } : {}), message: String(e.message), ...(e.data !== undefined ? { data: e.data } : {}) } }
  }
  into.push({ arm, call: name, want, params, answer })
  return answer
}

const outcomes = (runner: HostedRunner): number => runner.rows.filter(row => row.type === 'outcome').length
const settled = (runner: HostedRunner, n: number): Promise<unknown> => runner.waitFor(`outcome ${n}`, () => outcomes(runner) >= n, 60_000)
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function serversSettled(runner: HostedRunner): Promise<void> {
  for (let tries = 0; tries < 150; tries++) {
    const facts = (await runner.peer.request('session/facts' as never, {} as never, { deadlineMs: 30_000 })) as { mcp?: Array<{ type?: string }> }
    if ((facts.mcp ?? []).length > 0 && (facts.mcp ?? []).every(row => row.type !== 'pending')) return
    await pause(200)
  }
}

async function idleScene(): Promise<unknown> {
  const turns: ScriptedTurn[] = [handoffTurn(), { kind: 'text', text: 'First answer.' }]
  return withFixtureRunner(turns, async runner => {
    const a = (arm: string, name: string, want: Want, params: unknown): Promise<Answer> => call(runner, arm, name, want, params)
    await a('project/query', 'the sessions of a folder nobody trusted', 'refused', { op: 'sessions' })
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
    await a('agent/resume', 'an agent nothing recorded', 'refused', { agent_id: 'a-none' })
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
      await serversSettled(runner)
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

function ownHome(trusted = false): { dir: string; root: string; savedUsd: () => number | null } {
  const root = mkdtempSync(join(tmpdir(), 'built-product-'))
  const dir = join(mkdtempSync(join(root, 'run-')), '.mercury')
  mkdirSync(dir, { recursive: true })
  if (trusted) writeFileSync(join(dir, '.mercury.json'), JSON.stringify({ projects: Object.fromEntries([tmpdir(), realpathSync(tmpdir())].map(folder => [folder.replace(/\\/g, '/'), { hasTrustDialogAccepted: true }])) }))
  const savedUsd = (): number | null => {
    const file = ['.config.json', '.mercury.json'].map(name => join(dir, name)).find(path => existsSync(path))
    if (file === undefined) return null
    const projects = (JSON.parse(readFileSync(file, 'utf8')) as { projects?: Record<string, { lastCost?: unknown }> }).projects ?? {}
    const saved = Object.values(projects).map(project => project.lastCost).filter((cost): cost is number => typeof cost === 'number')
    return saved.length === 0 ? null : saved.reduce((sum, cost) => sum + cost, 0)
  }
  return { dir, root, savedUsd }
}

async function closedMidTurnScene(): Promise<unknown> {
  const turns: ScriptedTurn[] = [handoffTurn(), { kind: 'paced', deltas: ['One ', 'two ', 'three.'], gapMs: 400 }]
  const home = ownHome()
  try {
    return await withFixtureRunner(
      turns,
      async runner => {
        await runner.prompt('count to three')
        await runner.waitFor('the paced turn has its first byte', row => row.type === 'wait' && row.state === 'done', 60_000)
        runner.end()
        const code = await Promise.race([runner.exited, pause(30_000).then(() => 'still running' as const)])
        return { rows: [...runner.rows], notifications: [...runner.notifications], stderr: runner.stderr(), exit: code, ledger_usd: home.savedUsd() }
      },
      { env: { MERCURY_CONFIG_DIR: home.dir } },
    )
  } finally {
    rmSync(home.root, { recursive: true, force: true })
  }
}

async function closedAfterTurnScene(): Promise<unknown> {
  const turns: ScriptedTurn[] = [handoffTurn(), { kind: 'text', text: 'One answer.' }]
  const home = ownHome()
  try {
    return await withFixtureRunner(
      turns,
      async runner => {
        await runner.prompt('answer once')
        await settled(runner, 1)
        runner.end()
        const code = await Promise.race([runner.exited, pause(30_000).then(() => 'still running' as const)])
        return { rows: [...runner.rows], notifications: [...runner.notifications], stderr: runner.stderr(), exit: code, ledger_usd: home.savedUsd() }
      },
      { env: { MERCURY_CONFIG_DIR: home.dir } },
    )
  } finally {
    rmSync(home.root, { recursive: true, force: true })
  }
}

async function trustedFolderScene(): Promise<unknown> {
  const turns: ScriptedTurn[] = [handoffTurn(), { kind: 'text', text: 'Trusted answer.' }]
  const home = ownHome(true)
  try {
    return await withFixtureRunner(
      turns,
      async runner => {
        const a = (name: string, want: Want, params: unknown): Promise<Answer> => call(runner, 'project/query', `in a trusted folder: ${name}`, want, params, 30_000, takenLater)
        await runner.prompt('say the trusted answer')
        await settled(runner, 1)
        const own = String(runner.rows.find(row => row.type === 'session')?.session_id)
        await a('the sessions', 'answer', { op: 'sessions' })
        await a('rows with no session id', 'invalid', { op: 'rows' })
        await a('rows with a session id that is no uuid', 'invalid', { op: 'rows', session_id: 'not-a-uuid' })
        await a('rows of a session that is not saved', 'refused', { op: 'rows', session_id: UNSEEN })
        await a('a letter with no sender and no message', 'invalid', { op: 'send', session_id: own })
        await a('a letter with no message', 'invalid', { op: 'send', session_id: own, sender: 'a-client' })
        await a('a letter to a session that is not live', 'refused', { op: 'send', session_id: own, sender: 'a-client', message: 'words' })
        await a('a recall with no query', 'invalid', { op: 'recall' })
        await a('a resource with no reference', 'invalid', { op: 'resource' })
        await a('a resource whose reference is no mercury:// reference', 'invalid', { op: 'resource', ref: 'https://example.test/x' })
        await a('a transcript reference whose id is no uuid', 'invalid', { op: 'resource', ref: 'mercury://transcript/session/not-a-uuid' })
        await a('a transcript reference to a session that is not saved', 'refused', { op: 'resource', ref: `mercury://transcript/session/${UNSEEN}` })
        await a('a file outside the project', 'refused', { op: 'resource', ref: 'mercury://file/../outside.txt' })
        runner.end()
        const code = await Promise.race([runner.exited, pause(30_000).then(() => 'still running' as const)])
        return { rows: [...runner.rows], notifications: [...runner.notifications], stderr: runner.stderr(), exit: code }
      },
      { env: { MERCURY_CONFIG_DIR: home.dir } },
    )
  } finally {
    rmSync(home.root, { recursive: true, force: true })
  }
}

const DIST = process.env.MERCURY_PROOF_DIST ?? join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
const MCP_CLIENT = 'recording-client'
const DEAD_BASE = /^(?:MERCURY_UPDATE_API_BASE_URL|MERCURY_[A-Z0-9_]+_BASE)$/

async function mcpServerScene(): Promise<unknown> {
  const turns: ScriptedTurn[] = [handoffTurn(), { kind: 'text', text: 'Served answer.' }]
  const home = ownHome(true)
  try {
    return await withFixtureRunner(
      turns,
      async (runner, api) => {
        await runner.prompt('say the served answer')
        await settled(runner, 1)
        const session = runner.rows.find(row => row.type === 'session') as { session_id?: string; cwd?: string } | undefined
        const own = String(session?.session_id)
        runner.end()
        await Promise.race([runner.exited, pause(30_000)])
        const tokenFile = join(home.root, 'mcp-token.json')
        writeFileSync(tokenFile, JSON.stringify({ clients: [{ name: MCP_CLIENT, token: 'recording-token-00000000000000000000000000000', run: false, send: [own] }] }), { mode: 0o600 })
        const node = nodeBinPath()
        const env = {
          ...Object.fromEntries(['ANTHROPIC_BASE_URL', ...FLAG_REGISTRY.map(row => row.env).filter(name => DEAD_BASE.test(name))].map(name => [name, 'http://127.0.0.1:1'])),
          PATH: `/usr/bin:/bin:${dirname(node)}`,
          HOME: dirname(home.dir),
          TERM: 'dumb',
          TMPDIR: tmpdir(),
          MERCURY_CONFIG_DIR: home.dir,
          MERCURY_DAEMON_DIR: join(dirname(home.dir), 'daemon'),
          MERCURY_LOCAL_PROBE_TARGETS: 'none',
          MERCURY_CREDENTIAL_STORE: 'file',
          ANTHROPIC_API_KEY: 'fixture-key-000',
          ANTHROPIC_BASE_URL: api.url,
        }
        const child = spawnInOwnGroup(node, [DIST, 'mcp-server', '--token-file', tokenFile, '--client', MCP_CLIENT], { cwd: String(session?.cwd), env, stdio: ['pipe', 'pipe', 'pipe'] })
        let out = ''
        child.stdout!.on('data', chunk => (out += String(chunk)))
        child.stderr!.on('data', () => {})
        child.stdin!.on('error', () => {})
        const exited = new Promise<void>(done => child.on('close', () => done()))
        type McpAnswer = { id?: number; result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: { code?: number; message?: string } }
        let next = 0
        const ask = async (method: string, params: unknown): Promise<McpAnswer> => {
          const id = ++next
          child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
          for (let waited = 0; waited < 90_000; waited += 25) {
            const answer = out.split('\n').slice(0, -1).filter(text => text.startsWith('{')).map(text => JSON.parse(text) as McpAnswer).find(frame => frame.id === id && (frame.result !== undefined || frame.error !== undefined))
            if (answer !== undefined) return answer
            await pause(25)
          }
          return { error: { message: 'mercury mcp-server gave no answer within 90 s' } }
        }
        const said: Array<{ call: string; answer: string }> = []
        const heard = (call: string, answer: McpAnswer): void => void said.push({ call, answer: answer.result !== undefined ? `${answer.result.isError === true ? 'error' : 'result'}: ${(answer.result.content ?? []).map(part => part.text ?? '').join('')}` : `refused ${String(answer.error?.code)}: ${String(answer.error?.message)}` })
        try {
          await ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'recording-host', version: '0' } })
          child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
          heard('a letter whose sender is blank', await ask('tools/call', { name: 'mercury_send', arguments: { session_id: own, sender: ' ', message: 'words' } }))
          heard('a letter whose sender and message are blank', await ask('tools/call', { name: 'mercury_send', arguments: { session_id: own, sender: ' ', message: ' ' } }))
          heard("a letter in the client's own name whose message is blank", await ask('tools/call', { name: 'mercury_send', arguments: { session_id: own, sender: MCP_CLIENT, message: ' ' } }))
          heard('a recall whose query is blank', await ask('tools/call', { name: 'mercury_recall', arguments: { query: ' ' } }))
          heard('a resource read of a reference the wire refuses', await ask('resources/read', { uri: 'mercury://FILE/inside.txt' }))
          child.stdin!.end()
          await Promise.race([exited, pause(10_000)])
        } finally {
          endProcessGroup(child)
        }
        return { said }
      },
      { env: { MERCURY_CONFIG_DIR: home.dir } },
    )
  } finally {
    rmSync(home.root, { recursive: true, force: true })
  }
}

async function standInDaemonScene(): Promise<unknown> {
  const turns: ScriptedTurn[] = [handoffTurn(), { kind: 'text', text: 'Sent answer.' }]
  const home = ownHome(true)
  const daemonDir = join(dirname(home.dir), 'daemon')
  mkdirSync(daemonDir, { recursive: true })
  const preferred = join(daemonDir, 'control.sock')
  const socketPath = Buffer.byteLength(preferred, 'utf8') <= 100 ? preferred : join(tmpdir(), `hermes-daemon-${createHash('sha1').update(daemonDir).digest('hex').slice(0, 12)}.sock`)
  let reply = ''
  const daemon = createServer(sock => {
    let got = ''
    let answered = false
    sock.on('error', () => {})
    sock.on('data', chunk => {
      got += String(chunk)
      if (answered || !got.includes('\n')) return
      answered = true
      sock.end(reply)
    })
  })
  const calls: Taken[] = []
  try {
    return await withFixtureRunner(
      turns,
      async runner => {
        await runner.prompt('say the sent answer')
        await settled(runner, 1)
        const session = runner.rows.find(row => row.type === 'session') as { session_id?: string; cwd?: string } | undefined
        const own = String(session?.session_id)
        writeFileSync(join(daemonDir, 'concourse-workers.json'), JSON.stringify({ version: 1, workers: { 'r-1': { runnerId: 'r-1', sessionId: own, workspaceId: String(session?.cwd), attachedAt: Date.now() } } }))
        await new Promise<void>(done => daemon.listen(socketPath, done))
        const a = (name: string, want: Want, answer: Record<string, unknown>): Promise<Answer> => {
          reply = `${JSON.stringify(answer)}\n`
          return call(runner, 'project/query', `to a stand-in daemon: ${name}`, want, { op: 'send', session_id: own, sender: 'a-client', message: 'words' }, 30_000, calls)
        }
        await a('it will not take the dispatch', 'refused', { ok: false, code: 'EREFUSED', error: 'the session is held by another caller' })
        await a('a throw inside it', 'failed', { ok: false, code: 'EUNKNOWN', error: 'daemon error — boom' })
        await a('it does not know the verb', 'failed', { ok: false, code: 'EUNKNOWN', error: 'unknown op: sessionDispatch' })
        runner.end()
        const code = await Promise.race([runner.exited, pause(30_000).then(() => 'still running' as const)])
        return { calls, exit: code }
      },
      { env: { MERCURY_CONFIG_DIR: home.dir, MERCURY_DAEMON_DIR: daemonDir } },
    )
  } finally {
    daemon.close()
    rmSync(home.root, { recursive: true, force: true })
  }
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
  const trees = [...new Set([join(import.meta.dir, '..', '..'), ...(argOf('--tree') !== undefined ? [argOf('--tree')!] : [])])].sort((x, y) => y.length - x.length)
  const words = (text: string): string => {
    let out = text
    for (const tree of trees) out = out.split(tree).join('<tree>')
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
  const walk = (value: unknown, key = '', under = ''): unknown => {
    if (typeof value === 'string') return BUILD_KEYS.has(key) ? `<${key}>` : key === 'read' && under === 'memory' ? '<read>' : words(value)
    if (typeof value === 'number') return CLOCK_KEYS.test(key) && !FIXED.has(key) ? `<${key}>` : value
    if (Array.isArray(value)) return value.map(item => walk(item, key, under))
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k, key)]))
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
  const arms = recording.arms.map(t => walk(t) as Taken)
  const scenes = walk(recording.scenes) as Record<string, unknown>
  const prints = recording.prints.map(p => ({ ...p, args: p.args.map(words), stdout: lines(p.stdout) as never, stderr: lines(p.stderr) as never }))
  const later = recording.later === undefined ? undefined : { calls: recording.later.calls.map(t => walk(t) as Taken), scenes: walk(recording.later.scenes) as Record<string, unknown> }
  return { arms, scenes, prints, ...(later !== undefined ? { later } : {}) }
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
scenes.closedMidTurn = await closedMidTurnScene()
const laterScenes: Record<string, unknown> = {}
laterScenes.closedAfterTurn = await closedAfterTurnScene()
laterScenes.trustedFolder = await trustedFolderScene()
laterScenes.mcpServer = await mcpServerScene()
laterScenes.standInDaemon = await standInDaemonScene()
const daemonCalls = (laterScenes.standInDaemon as { calls?: Taken[] }).calls ?? []
const arms = [...RUNNER_REQUEST_METHODS, ...RUNNER_NOTIFICATION_METHODS]
const requested = RUNNER_REQUEST_METHODS.filter(arm => taken.filter(t => t.arm === arm && t.want === 'answer').length >= 1 || taken.filter(t => t.arm === arm).length >= 3)
const wrong = [...taken, ...takenLater].filter(t => classOf(t.answer) !== t.want)
check(`every call came back in its class: an answer, a refusal of the runner (${RPC_REFUSED}) or params the wire refuses (${RPC_INVALID_PARAMS}) (${taken.length + takenLater.length} calls)`, wrong.length === 0, wrong.map(t => `${t.arm} · ${t.call}: wanted ${t.want}, got ${JSON.stringify(t.answer).slice(0, 200)}`).join('\n      '))
const thin = RUNNER_REQUEST_METHODS.filter(arm => taken.filter(t => t.arm === arm).length < 3 || taken.filter(t => t.arm === arm && t.want !== 'answer').length < 2)
check(`each of the ${RUNNER_REQUEST_METHODS.length} request arms is called at least three times, two of them calls it must refuse (${arms.length} arms with the notification)`, thin.length === 0 && requested.length === RUNNER_REQUEST_METHODS.length, thin.join(', '))
const afterNotice = taken.find(t => t.call === 'the facts after credentials/changed')
check('the credentials/changed notification is taken with no answer, and the runner answers the next request', afterNotice !== undefined && 'result' in afterNotice.answer)
const closedRows = ((scenes.closedMidTurn as { rows?: Array<{ type?: string }> }).rows ?? []).map(row => String(row.type))
const closeAt = closedRows.findIndex(type => type === 'close')
const outcomeAt = closedRows.findIndex(type => type === 'outcome')
check("on the wire door an input closed in the middle of a turn writes the close row before that turn's outcome row, and the turn still ends with its outcome and exit 0 (the SDKs and the daemon's seat read past a close row, so this order is recorded here and not changed)", closeAt !== -1 && outcomeAt !== -1 && closeAt < outcomeAt && (scenes.closedMidTurn as { exit?: unknown }).exit === 0, closedRows.join(' '))
type SpendRow = { type?: string; usage?: { input_tokens?: number; output_tokens?: number }; cost_usd?: number }
const spendRows = (type: string): SpendRow[] => ((scenes.closedMidTurn as { rows?: SpendRow[] }).rows ?? []).filter(row => row.type === type)
const spendOf = (rows: SpendRow[]): string => `${rows.reduce((sum, row) => sum + (row.usage?.input_tokens ?? 0), 0)} in ${rows.reduce((sum, row) => sum + (row.usage?.output_tokens ?? 0), 0)} out`
check("the outcome of a turn the input closed in counts its steps' model calls and not the note's, which the close row carries: a client that adds each outcome and the close row counts every call once", spendRows('step').length === 1 && spendRows('close').length === 1 && spendOf(spendRows('close')) !== '0 in 0 out' && spendOf(spendRows('outcome')) === spendOf(spendRows('step')), `steps ${spendOf(spendRows('step'))} · close ${spendOf(spendRows('close'))} · outcome ${spendOf(spendRows('outcome'))} at ${spendRows('outcome')[0]?.cost_usd} USD`)
type CostRow = { type?: string; cost_usd?: number; models?: Record<string, { cost_usd?: number }> }
const sceneOf = (scene: string): unknown => scenes[scene] ?? laterScenes[scene]
const costRows = (scene: string): CostRow[] => ((sceneOf(scene) as { rows?: CostRow[] }).rows ?? []).filter(row => row.type === 'outcome' || row.type === 'close')
const usdOf = (row: CostRow): number => (row.type === 'outcome' ? (row.cost_usd ?? 0) : Object.values(row.models ?? {}).reduce((sum, model) => sum + (model.cost_usd ?? 0), 0))
const ledgerOf = (scene: string): number | null => (sceneOf(scene) as { ledger_usd?: number | null }).ledger_usd ?? null
const addsUp = (scene: string, order: string): boolean => {
  const rows = costRows(scene)
  const ledger = ledgerOf(scene)
  return rows.map(row => row.type).join(' ') === order && ledger !== null && ledger > 0 && rows.every(row => usdOf(row) > 0) && Math.abs(rows.reduce((sum, row) => sum + usdOf(row), 0) - ledger) < 1e-9
}
check(
  "in both orders, the input closed inside a turn and after one, the cost of the outcome and of the close row's models add up to the ledger's total as the runner saved it at its exit",
  addsUp('closedMidTurn', 'close outcome') && addsUp('closedAfterTurn', 'outcome close'),
  ['closedMidTurn', 'closedAfterTurn'].map(scene => `${scene}: ${costRows(scene).map(row => `${row.type} ${usdOf(row)}`).join(', ')} on the rows, ${ledgerOf(scene)} USD on the ledger`).join(' · '),
)
const trustedCalls = takenLater
const errorOf = (t: Taken): { code?: number; message?: string; data?: { kind?: string; method?: string; issues?: Array<{ path?: unknown; message?: unknown }> } } => ('error' in t.answer ? (t.answer.error as never) : {})
const inWireForm = (t: Taken): boolean => errorOf(t).code === RPC_INVALID_PARAMS && errorOf(t).message === 'invalid params for project/query' && errorOf(t).data?.method === 'project/query' && (errorOf(t).data?.issues ?? []).length > 0 && (errorOf(t).data?.issues ?? []).every(issue => typeof issue.path === 'string' && typeof issue.message === 'string' && issue.message !== '')
const ofTheProject = (t: Taken): boolean => errorOf(t).code === RPC_REFUSED && errorOf(t).data?.kind === 'project' && typeof errorOf(t).message === 'string' && errorOf(t).message !== ''
check(
  "in a folder the home trusts, project/query serves the sessions, answers a parameter that is missing or malformed in the wire's one form (-32602, invalid params for project/query, the sentence under data.issues beside the parameter's name) and refuses what the project does not hold or will not serve with the kind project",
  trustedCalls.length === 13 && trustedCalls.filter(t => t.want === 'answer').every(t => 'result' in t.answer) && trustedCalls.filter(t => t.want === 'invalid').length === 8 && trustedCalls.filter(t => t.want === 'invalid').every(inWireForm) && trustedCalls.filter(t => t.want === 'refused').length === 4 &&trustedCalls.filter(t => t.want === 'refused').every(ofTheProject),
  trustedCalls.filter(t => (t.want === 'invalid' && !inWireForm(t)) || (t.want === 'refused' && !ofTheProject(t)) || (t.want === 'answer' && !('result' in t.answer))).map(t => `${t.call}: ${JSON.stringify(t.answer).slice(0, 300)}`).join('\n      '),
)
const DENIED = 'error: Permission denied: the sender must be this client’s name'
const mcpSaid = ((laterScenes.mcpServer as { said?: Array<{ answer: string }> }).said ?? []).map(one => one.answer)
check(
  "mercury mcp-server as built, asked over stdio as an MCP client asks: a letter whose sender is not the client's name is refused before the wire is asked, with a message and without one; in the client's own name a blank message prints the wire's message and then the sentence beside its parameter, a blank query the same, and a reference the wire refuses raises those words for a resource read",
  mcpSaid.length === 5 && mcpSaid[0] === DENIED && mcpSaid[1] === DENIED && mcpSaid[2] === 'error: invalid params for project/query: message: sender and message are required' && mcpSaid[3] === 'error: invalid params for project/query: query: query is required' && (mcpSaid[4] ?? '').includes('invalid params for project/query: ref: A mercury:// reference is required'),
  mcpSaid.join('\n      '),
)
const daemonSaid = daemonCalls.map(t => ('error' in t.answer ? `${String(t.answer.error.code)} ${JSON.stringify((t.answer.error.data as { kind?: string } | undefined)?.kind ?? null)} ${t.answer.error.message}` : 'answered'))
check(
  "from the bundle, project/query send to a live session whose daemon is a stand-in on its socket: the daemon's own refusal of the dispatch (EREFUSED) is the refusal of kind project with its sentence; a throw inside the daemon and a verb it does not know (EUNKNOWN) are the internal error, each with its sentence",
  daemonSaid.length === 3 && daemonSaid[0] === '-32010 "project" the session is held by another caller' && daemonSaid[1] === '-32603 null daemon error — boom' && /^-32603 null the daemon is an older build/.test(daemonSaid[2] ?? ''),
  daemonSaid.join('\n      '),
)

section('§2 four scripted print runs and one refused at boot, in the three formats')
const prints = await printRuns()
const statusOf = (name: string): string => prints.filter(p => p.name === name).map(p => `${p.format} ${p.status}`).join(' · ')
check('each print run ended with an exit code', prints.every(p => p.status !== null), prints.map(p => `${p.name}/${p.format}: ${p.status}`).join(' · '))
check('the completed run exits 0 and the others do not', prints.filter(p => p.name === 'completed').every(p => p.status === 0) && prints.filter(p => p.name !== 'completed').every(p => p.status !== 0), ['completed', 'refused', 'failed', 'turn limit', 'blocked'].map(name => `${name}: ${statusOf(name)}`).join(' | '))

const whole: Recording = { arms: taken, scenes, prints, later: { calls: takenLater, scenes: laterScenes } }
const recording = masked(whole)
const out = argOf('--out')
if (out !== undefined) {
  writeFileSync(out, JSON.stringify(recording, null, 1) + '\n')
  console.log(`  wrote ${out}`)
}
const raw = argOf('--raw')
if (raw !== undefined) writeFileSync(raw, JSON.stringify(whole, null, 1) + '\n')
const against = argOf('--against')
if (against !== undefined) {
  section(`§3 the recording against ${against}`)
  const diffs = differences(JSON.parse(readFileSync(against, 'utf8')), JSON.parse(JSON.stringify(recording)))
  check('the recording equals the other, field for field, with clocks, ids, pids and temp paths masked', diffs.length === 0, `${diffs.length} difference${diffs.length === 1 ? '' : 's'}:\n      ${diffs.join('\n      ')}`)
}

console.log(failures === 0 ? '\nprove-runner-recording: green' : `\nprove-runner-recording: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
