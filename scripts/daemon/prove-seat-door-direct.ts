#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const home = mkdtempSync(join(tmpdir(), 'seat-door-'))
process.env.MERCURY_CONFIG_DIR = join(home, 'config')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const daemonDir = join(home, 'daemon')
mkdirSync(daemonDir, { recursive: true })
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREWS_DIR = join(home, 'crews')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '9.9.9' }

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20))

section('§1 the census: the daemon speaks the method table and nothing older')
{
  const words = ['control_request', 'control_response', 'control_cancel_request', 'can_use_tool', 'set_permission_mode']
  const hits: string[] = []
  for (const name of readdirSync(join(ROOT, 'src', 'daemon'))) {
    if (!name.endsWith('.ts')) continue
    const text = readFileSync(join(ROOT, 'src', 'daemon', name), 'utf8')
    for (const word of words) if (text.includes(word)) hits.push(`${name}:${word}`)
  }
  check('no retired control word stands in src/daemon', hits.length === 0, hits.join(', '))
  const connection = readFileSync(join(ROOT, 'src', 'daemon', 'runnerConnection.ts'), 'utf8')
  check('the connection owns no subtype table and no frame translator', !/SUBTYPE_METHODS|paramsOfSubtype|askFrameOf|inputRowOfFrame|answerPayloadOf/.test(connection))
  check('the connection is a typed client: send, request, notify, deliver', /send<M extends Verb>/.test(connection) && /notify<M extends HostNotificationName>/.test(connection) && /deliver\(row: InputRow\)/.test(connection))
  const roster = readFileSync(join(ROOT, 'src', 'daemon', 'roster.ts'), 'utf8')
  check('the roster parses no child line of its own (the door parses once)', !/JSON\.parse\(line\)|drainChildStdout|onChildLine|writeFrame/.test(roster))
  check("the roster hands the seat its door, never a frame writer", /door\(short: string\): RunnerDoor \| undefined/.test(roster) && !/control\(short: string, frame: string\)/.test(roster))
  const seat = readFileSync(join(ROOT, 'src', 'daemon', 'sessionSeat.ts'), 'utf8')
  check('the seat keeps no waiter map and no request-id prefix', !/Waiters = new Map|REQUEST_PREFIX|startsWith\(SEAT_/.test(seat))
  check('the seat reads the older runner from the peer code, not an English regex', !/unsupported control request subtype/.test(seat) && /RPC_METHOD_NOT_FOUND/.test(seat))
  const warm = readFileSync(join(ROOT, 'src', 'daemon', 'warmRunner.ts'), 'utf8')
  check('the warm claim rides session/claim; no per-line hook sniffs the drain', /'session\/claim'/.test(warm) && !/onWarmRunnerLine|WARM_CLAIM_REQUEST_PREFIX/.test(warm))
  const spawn = readFileSync(join(ROOT, 'src', 'daemon', 'headlessRun.ts'), 'utf8')
  check("the spawn builder spells 'runner' itself — no argv rewrite from the row stream's words", /^\s+'runner',$/m.test(spawn) && !/runnerDoorArgv|'--input=rows'|'--partial'/.test(spawn))
}

const { standInRunner } = await import('../lib/seatDoor.ts')
const seatModule = await import('../../src/daemon/sessionSeat.ts')
const asks = await import('../../src/daemon/permissionAsks.ts')
const dispatch = await import('../../src/daemon/concourseDispatch.ts')
const { RPC_METHOD_NOT_FOUND, RPC_REFUSED } = await import('../../src/runner/wire/errors.ts')

const RUNNER = 'concourse-w1'
const SESSION = 'session-1'
writeFileSync(
  join(daemonDir, 'concourse-workers.json'),
  JSON.stringify({ version: 1, workers: { [RUNNER]: { schema: 1, runnerId: RUNNER, sessionId: SESSION, workspaceId: '/ws', isolation: 'exclusive', modelKey: 'm', spawnedAt: 1, lastLiveAt: 1, title: 'the seat' } } }),
)

section('§2 deadlines reach the runner; the refusal kinds are the peer’s')
{
  const stand = standInRunner()
  const roster = stand.roster()
  const pending = seatModule.rewindSession(SESSION, { mode: 'code', userMessageId: 'u1' }, roster, daemonDir, { deadlineMs: 120 })
  const request = await stand.nextRequest('session/rewind')
  check('the seat sent session/rewind with the typed params', request.method === 'session/rewind' && j(request.params) === j({ user_message_id: 'u1', mode: 'code' }), j(request.params))
  const out = await pending
  check("the runner's silence past the seat's deadline is 'no-answer', typed", out.outcome === 'refused' && out.refusal === 'no-answer' && (out.detail ?? '').includes('did not answer the rewind within'), j(out))
  await tick()
  check("…and the runner saw the request cancelled — the host's deadline is not invisible to it", request.cancelled && stand.cancels.includes(request.id), j({ cancelled: request.cancelled, cancels: stand.cancels }))

  const older = seatModule.rewindSession(SESSION, { mode: 'code', userMessageId: 'u2' }, roster, daemonDir)
  ;(await stand.nextRequest('session/rewind')).refuse(RPC_METHOD_NOT_FOUND, 'unknown method session/rewind', { method: 'session/rewind' })
  const o = await older
  check("-32601 reads 'runner-older' (the method's absence, not an English regex)", o.outcome === 'refused' && o.refusal === 'runner-older' && (o.detail ?? '').includes('/daemon restart'), j(o))

  const refused = seatModule.rewindSession(SESSION, { mode: 'code', userMessageId: 'u3' }, roster, daemonDir)
  ;(await stand.nextRequest('session/rewind')).refuse(RPC_REFUSED, 'the checkpoint is gone', { kind: 'rewind' })
  const r = await refused
  check("a -32010 refusal relays the runner's own sentence", r.outcome === 'refused' && r.refusal === 'restore-failed' && r.detail === 'the checkpoint is gone', j(r))

  const receipt = seatModule.rewindSession(SESSION, { mode: 'conversation', userMessageId: 'u4', dryRun: true }, roster, daemonDir)
  const dry = await stand.nextRequest('session/rewind')
  check('a dry run carries dry_run', j(dry.params) === j({ user_message_id: 'u4', mode: 'conversation', dry_run: true }), j(dry.params))
  dry.answer({ outcome: 'applied', mode: 'conversation', restored: 2 })
  const applied = await receipt
  check("the runner's receipt relays whole", applied.outcome === 'applied' && applied.mode === 'conversation', j(applied))

  const withdraw = seatModule.withdrawSessionSend(SESSION, 'msg-1', roster, daemonDir)
  const w = await stand.nextRequest('queue/withdraw')
  check('withdraw-send asks queue/withdraw by the identity', j(w.params) === j({ id: 'msg-1' }), j(w.params))
  w.answer({ withdrawn: true, text: 'the words' })
  const wo = await withdraw
  check('the typed answer settles applied with the words', wo.outcome === 'applied' && wo.withdrawn === true && wo.text === 'the words', j(wo))

  const mode = seatModule.setSessionPermissionMode(SESSION, 'flow', roster, daemonDir)
  const m = await stand.nextRequest('session/set_mode')
  m.answer({ mode: 'flow' })
  const mo = await mode
  check("set-permission-mode asks session/set_mode and relays the runner's mode", j(m.params) === j({ mode: 'flow' }) && mo.outcome === 'applied' && (mo.detail ?? '').endsWith('→ flow'), j(mo))

  const stop = seatModule.controlSessionAgent(SESSION, 'agent-1', 'stop-agent', roster, daemonDir, { note: 'enough' })
  const st = await stand.nextRequest('agent/stop')
  check('stop-agent asks agent/stop with the agent id and the note', j(st.params) === j({ agent_id: 'agent-1', note: 'enough' }), j(st.params))
  st.answer({ stopped: 'agent-1' })
  check("the runner's receipt is the detail", (await stop).outcome === 'applied')

  const left = seatModule.rewindSession(SESSION, { mode: 'code', userMessageId: 'u5' }, roster, daemonDir)
  await stand.nextRequest('session/rewind')
  stand.close('the runner exited')
  const l = await left
  check("a runner that leaves mid-wait answers typed — nothing is assumed restored", l.outcome === 'refused' && l.refusal === 'no-answer' && (l.detail ?? '').includes('left before it answered'), j(l))
  const none = await seatModule.rewindSession(SESSION, { mode: 'code', userMessageId: 'u6' }, roster, daemonDir)
  check('a seat with no door refuses no-channel at once', none.outcome === 'refused' && none.refusal === 'no-channel', j(none))
}

section('§3 the asks ride permission/request, typed both ways')
{
  const answers: unknown[] = []
  const stand = standInRunner({
    hooks: {
      onAsk: params => asks.holdWorkerAsk(RUNNER, params, daemonDir, 60_000, () => 'attached'),
    },
  })
  const first = stand.ask({ kind: 'tool', tool_use_id: 'toolu_1', tool_name: 'Bash', input: { command: 'rm -rf build' }, reason: 'the rule asks', agent_id: undefined })
  await tick()
  const parked = asks.listPendingPermissionAsks().filter(a => a.workerId === RUNNER)
  check('the typed ask parks in the daemon’s table with its tool and session', parked.length === 1 && parked[0]!.toolName === 'Bash' && parked[0]!.sessionId === SESSION, j(parked))
  const answered = asks.answerPermissionAsk(parked[0]!.requestId, true, 'operator', undefined, { updatedInput: { command: 'rm -rf build/tmp' }, permissionUpdates: [] })
  check('the answer road applied', answered.outcome === 'applied', j(answered))
  answers.push(await first)
  check("the runner's request resolves with the typed allow and the card's edited input", j(answers[0]) === j({ outcome: 'allow', input: { command: 'rm -rf build/tmp' } }), j(answers[0]))

  const second = stand.ask({ kind: 'network', host: 'example.org' })
  await tick()
  const net = asks.listPendingPermissionAsks().find(a => a.workerId === RUNNER)
  check('a network ask parks under the sandbox tool name with the host as its input', net !== undefined && net.toolName === 'SandboxNetworkAccess', j(net))
  asks.answerPermissionAsk(net!.requestId, false, 'operator', undefined, { feedback: 'not now', interrupt: true })
  const denied = await second
  check('a deny with the abort verb resolves deny with stop', denied.outcome === 'deny' && denied.stop === true && (denied.message ?? '').includes('not now'), j(denied))

  const emptied = stand.ask({ kind: 'tool', tool_use_id: 'toolu_2b', tool_name: 'Write', input: { file_path: '/x', content: 'the original bytes' } })
  await tick()
  const write = asks.listPendingPermissionAsks().find(a => a.workerId === RUNNER)
  asks.answerPermissionAsk(write!.requestId, true, 'operator', undefined, { updatedInput: {}, permissionUpdates: [] })
  const emptyAnswer = await emptied
  check("an allow with an explicit EMPTY input resolves the request with input {} — the original arguments are never restored by the daemon", j(emptyAnswer) === j({ outcome: 'allow', input: {} }), j(emptyAnswer))
  const unedited = stand.ask({ kind: 'tool', tool_use_id: 'toolu_2c', tool_name: 'Write', input: { file_path: '/x' } })
  await tick()
  const plain = asks.listPendingPermissionAsks().find(a => a.workerId === RUNNER)
  asks.answerPermissionAsk(plain!.requestId, true, 'operator')
  check('an allow with no edited input resolves the request without one (the runner keeps its original)', j(await unedited) === j({ outcome: 'allow' }))

  const controller = new AbortController()
  const third = stand.ask({ kind: 'tool', tool_use_id: 'toolu_3', tool_name: 'Write', input: { file_path: '/x' } }, { signal: controller.signal })
  await tick()
  check('a third ask parks', asks.listPendingPermissionAsks().some(a => a.workerId === RUNNER))
  controller.abort()
  await third.catch(() => undefined)
  await tick()
  check('the runner withdrawing its request retires the ask from the table', !asks.listPendingPermissionAsks().some(a => a.workerId === RUNNER), j(asks.listPendingPermissionAsks()))

  const crew = await standInRunner({ hooks: { onAsk: params => asks.holdWorkerAsk('ada', params, daemonDir) } }).ask({ kind: 'tool', tool_use_id: 'toolu_4', tool_name: 'Bash', input: {} })
  check('a seat nobody watches (a crew seat) is answered deny at once — never a hanging ask', crew.outcome === 'deny' && (crew.message ?? '').includes('no operator holds this seat'), j(crew))
  stand.close()
}

section('§4 rows once, verbs landed through session/applied, deliveries as rows')
{
  const rows: unknown[] = []
  const applied: unknown[] = []
  const stand = standInRunner({
    hooks: {
      onRow: row => rows.push(row),
      onApplied: params => applied.push(params),
    },
  })
  const stamp = { timestamp: '2026-10-03T09:00:00.000Z', session_id: SESSION }
  stand.row({ type: 'session', seq: 1, ...stamp, schema: 1, version: '9.9.9', cwd: '/ws', model: 'm', mode: 'flow', tools: [], mcp_servers: [], commands: [], agents: [], skills: [], extensions: [] })
  stand.row({ type: 'text', seq: 2, ...stamp, turn: 1, message_id: 'msg_1', block: 0, text: 'hello' })
  stand.row({ type: 'text', seq: 3, ...stamp, turn: 1, message_id: 'msg_1', block: 'not-a-block', text: 'torn' })
  await tick()
  check('each row the schema admits reaches the seat hook once, as the row the peer parsed; a row the schema refuses never does', rows.length === 2 && (rows[0] as { type: string }).type === 'session' && (rows[1] as { text?: string }).text === 'hello', j(rows))
  const hadFacts = await stand.nextRequest('session/facts', 50).then(() => true, () => false)
  check('the connection asks nothing of its own (the seat owns the facts cadence)', !hadFacts)
  stand.applied({ request_id: 7, verb: 'set_model', model: 'm2' })
  await tick()
  check('session/applied reaches the seat typed', j(applied) === j([{ request_id: 7, verb: 'set_model', model: 'm2' }]), j(applied))

  const roster = stand.roster()
  const switching = seatModule.setSessionModel(SESSION, 'claude-opus-5-5', roster, daemonDir)
  const set = await stand.nextRequest('session/set_model')
  check('set-model asks session/set_model', j(set.params) === j({ model: 'claude-opus-5-5' }), j(set.params))
  set.answer({ model: 'claude-opus-5-5', at: 'turn_end' })
  const held = await switching
  check("the runner's turn_end answer parks the switch as queued", held.outcome === 'queued', j(held))
  stand.applied({ request_id: set.id, verb: 'set_model', model: 'claude-opus-5-5' })
  await tick()
  seatModule.onSeatApplied(RUNNER, { request_id: set.id, verb: 'set_model', model: 'claude-opus-5-5' }, roster, daemonDir)
  const facts = await stand.nextRequest('session/facts', 1_000).then(() => true, (error: unknown) => String(error))
  check('the landed switch re-asks the facts through session/facts', facts === true, String(facts))
  const record = JSON.parse(readFileSync(join(daemonDir, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, { modelKey: string }> }
  check("session/applied naming the held request lands the model on the record", record.workers[RUNNER]!.modelKey === 'claude-opus-5-5', j(record.workers[RUNNER]))

  const delivery = stand.connection.deliver({ type: 'prompt', content: 'run the tests', id: '0b5c2d0a-6e9e-4c4b-8a2c-3f1d2e5b7a90', priority: 'next' })
  const add = await stand.nextRequest('queue/add')
  check('a delivery is queue/add carrying the input row as-is', j(add.params) === j({ type: 'prompt', content: 'run the tests', id: '0b5c2d0a-6e9e-4c4b-8a2c-3f1d2e5b7a90', priority: 'next' }), j(add.params))
  add.answer({ accepted: true })
  check('an accepted delivery is true', (await delivery) === true)

  const prompt = await dispatch.buildConcoursePromptRow('hello there', { identity: '0b5c2d0a-6e9e-4c4b-8a2c-3f1d2e5b7a91', priority: 'now', sentAt: '2026-10-03T09:00:00Z' }, 'the ground note')
  check('the operator’s words are a prompt row with the ground note above, the identity as id, the band and the stamp', j(prompt) === j({ type: 'prompt', content: 'the ground note\n\nhello there', id: '0b5c2d0a-6e9e-4c4b-8a2c-3f1d2e5b7a91', priority: 'now', sent_at: '2026-10-03T09:00:00Z' }), j(prompt))
  const shell = await dispatch.buildConcoursePromptRow('ls -la', { mode: 'bash', identity: 'not-a-uuid' }, 'never on a command')
  check('a bash line is a shell row with a minted id and no note', shell.type === 'shell' && shell.command === 'ls -la' && typeof shell.id === 'string' && /^[0-9a-f-]{36}$/.test(shell.id), j(shell))
  const note = await dispatch.buildConcoursePromptRow('done?', { mode: 'task-notification', agentId: 'agent-9' })
  check('a task notification is a note row addressed to the agent', note.type === 'note' && note.to === 'agent-9' && note.content === 'done?', j(note))
  const rich = await dispatch.buildConcoursePromptRow('', { content: [{ type: 'text', text: 'see:' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] })
  check("rich content rides as the row's blocks (text, image with its bytes)", rich.type === 'prompt' && j(rich.content) === j([{ type: 'text', text: 'see:' }, { type: 'image', media_type: 'image/png', data: 'AAAA' }]), j(rich))

  const told = seatModule.relayCredentialChange({ door: roster.door, liveWorkerFacts: () => [{ short: RUNNER, kind: 'long-lived' }, { short: 'one-shot', kind: 'one-shot' }] })
  await tick()
  check('the credential poke is the credentials/changed notification to every long-lived seat', j(told) === j([RUNNER]) && stand.notifications.some(n => n.method === 'credentials/changed'), j(stand.notifications))
  stand.close()
}

section('§5 the warm claim rides session/claim')
{
  const warm = await import('../../src/daemon/warmRunner.ts')
  const stand = standInRunner({ sessionId: null })
  const claimed = warm.claimWarmRunner
  check('the pool exports the claim', typeof claimed === 'function')
  const source = readFileSync(join(ROOT, 'src', 'daemon', 'warmRunner.ts'), 'utf8')
  check('the claim names the typed params: session_id, model, mode, effort, resume, restart_reason, openai_catalogue', ['session_id: args.sessionId', 'model: args.modelKey', 'mode: args.permissionMode', 'effort: args.effort', 'resume: true', 'restart_reason: args.restartReason', 'openai_catalogue: openaiCatalogueToWire'].every(needle => source.includes(needle)))
  check("the claim's liveness pulse aborts the request through its signal; a dead runner reads 'died'", source.includes('signal: pulse.signal') && source.includes('the warm runner died before it answered the claim'))
  stand.close()
}

section('§6 the roster: a turn that settles inside the delivery\'s answer leaves the seat idle')
{
  const { PassThrough } = await import('node:stream')
  const { EventEmitter } = await import('node:events')
  const { createPeer } = await import('../../src/runner/wire/peer.ts')
  const { mock } = await import('bun:test')
  const child = Object.assign(new EventEmitter(), { pid: process.pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
  const childModule = await import('../../src/daemon/headlessRun.ts')
  mock.module('../../src/daemon/headlessRun.ts', () => ({ ...childModule, spawnRunnerChild: () => ({ child, capabilities: { holds_asks: true, elicitation: false, partial_rows: false } }) }))
  const { TaskRoster } = await import('../../src/daemon/roster.ts')
  const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 3 } }))
  const runner = createPeer({ input: child.stdin, output: child.stdout, side: 'runner', log: () => {} })
  runner.onRequest('initialize', () => ({ protocol: 1, runner: { version: '0', pid: process.pid }, session_id: 'session-6' }))
  runner.onRequest('schedule/roster', () => ({}))
  const stamp = { timestamp: '2026-10-03T09:00:00.000Z', session_id: 'session-6' }
  let seq = 0
  let slash = true
  runner.onRequest('queue/add', () => {
    if (slash) {
      runner.notify('row', { type: 'turn', seq: ++seq, ...stamp, turn: 1, state: 'started', turn_id: 't-6', message_ids: ['m-6'] } as never)
      runner.notify('row', { type: 'outcome', seq: ++seq, ...stamp, schema: 1, turn: 1, turn_id: 't-6', status: 'completed', steps: 0, wall_ms: 1, usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 }, models: {}, denials: [] } as never)
    }
    return { accepted: true }
  })
  const roster = new TaskRoster({ dir: home, breaker: { shouldSuppressFire: () => false, recordResult: () => {}, recordTimeout: () => {} } as never, maxInflight: 3 })
  roster.registerLongLived('concourse-w6', { cwd: home, model: 'm', effort: 'high', role: 'MERCURY_CONCOURSE_WORKER', agentId: 'w6' } as never)
  const sup = await import('../../src/daemon/concourseWorkers.ts')
  sup.updateConcourseWorkers(ws => {
    ws['concourse-w6'] = { schema: 1, runnerId: 'concourse-w6', sessionId: 'session-6', workspaceId: home, isolation: 'exclusive', modelKey: 'm', spawnedAt: 1, lastLiveAt: Date.now() }
  }, daemonDir)
  const delivered = await roster.reply('concourse-w6', { type: 'prompt', content: '/seats', id: '0b5c2d0a-6e9e-4c4b-8a2c-3f1d2e5b7a96' })
  await tick()
  await tick()
  const row = roster.list().find(e => e.short === 'concourse-w6')
  check('the delivery is accepted', delivered)
  check("red on the base: a slash turn that opened and settled before the delivery's answer was read leaves the seat IDLE, never busy for good", row?.busy === false && row.turnActive === false, j({ busy: row?.busy, turnActive: row?.turnActive }))
  const record = sup.readSessionWorkers(daemonDir)['concourse-w6']
  check("red on the base: the record's turn is settled too — the delivery stamp lands before the answer, the settle stamp after it (a /clear on this seat parks it instead of draining for good)", record !== undefined && record.lastDeliveryAt !== undefined && !sup.turnInFlightOf(record), j({ delivery: record?.lastDeliveryAt, settled: record?.lastTurnSettledAt }))
  slash = false
  const long = await roster.reply('concourse-w6', { type: 'prompt', content: 'a long turn', id: '0b5c2d0a-6e9e-4c4b-8a2c-3f1d2e5b7a97' })
  const open = roster.list().find(e => e.short === 'concourse-w6')
  check('a delivery whose turn is still to come opens the turn at the delivery (busy from the first byte)', long && open?.busy === true && open.turnActive === true, j({ busy: open?.busy, turnActive: open?.turnActive }))
  runner.notify('row', { type: 'outcome', seq: ++seq, ...stamp, schema: 1, turn: 2, turn_id: 't-7', status: 'completed', steps: 0, wall_ms: 1, usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 }, models: {}, denials: [] } as never)
  await tick()
  check("the runner's outcome row closes it", roster.list().find(e => e.short === 'concourse-w6')?.busy === false)
  roster.kill('concourse-w6')
  runner.close('done')
}

rmSync(home, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-seat-door-direct: ALL LAWS HOLD' : `prove-seat-door-direct: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
