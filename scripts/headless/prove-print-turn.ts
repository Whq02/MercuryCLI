#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mock } from 'bun:test'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const at = (rel: string): string => join(ROOT, rel)

let failures = 0
const turnFixHint = 'change the turn road in src/daemon/runner/runnerTurn.ts (runPrintTurn, assembleTurnTools, registerPerTurnHandlers, registerElicitationHandlersForClient) until the label reads true'
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} · ` : ''}${turnFixHint}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (value: unknown): string => JSON.stringify(value)
const UNSETTLED = Symbol('unsettled')
const within = <T,>(work: Promise<T> | T, ms = 3_000): Promise<T | typeof UNSETTLED> => Promise.race([Promise.resolve(work), new Promise<typeof UNSETTLED>(done => setTimeout(() => done(UNSETTLED), ms))])
setTimeout(() => {
  console.log('  [FAIL] the proof ended within its two minutes — a turn never settled; look at the last section printed above and at runPrintTurn in src/daemon/runner/runnerTurn.ts')
  process.exit(1)
}, 120_000).unref()

type Call = { name: string; args: unknown[] }
const seen: Call[] = []
const answers = new Map<string, (...args: unknown[]) => unknown>()
const said = (name: string): Call[] => seen.filter(call => call.name === name)
const names = (): string[] => seen.map(call => call.name)
const order = (...wanted: string[]): boolean => {
  const at = wanted.map(name => names().indexOf(name))
  return at.every((index, i) => index !== -1 && (i === 0 || index > at[i - 1]!))
}

async function spied(rel: string, wanted: string[]): Promise<Record<string, (...args: never[]) => unknown>> {
  const real = (await import(at(rel))) as Record<string, (...args: never[]) => unknown>
  const wrapped = Object.fromEntries(
    wanted.map(name => [
      name,
      (...args: unknown[]): unknown => {
        seen.push({ name, args })
        return answers.get(name)?.(...args)
      },
    ]),
  )
  mock.module(at(rel), () => ({ ...real, ...wrapped }))
  return real
}

await spied('src/engine/rows/turn.ts', ['ask', 'sessionFactsOf'])
await spied('src/models/roads/workloadContext.ts', ['runWithWorkload'])
await spied('src/models/advisor/index.ts', ['advisorMainRound'])
await spied('src/daemon/runner/messageQueueManager.ts', ['holdQueuedWordsForTurnEnd'])
await spied('src/platform/substrate/startupMenu.ts', ['applyLiveBootMenuEnv'])
await spied('src/crew/agent-results/summaryRoom.ts', ['fitCompletionCommands'])
await spied('src/models/roads/toolEconomy.ts', ['clearToolRosterLatches', 'clearToolRosterRestore'])
await spied('src/models/roads/lawfulPrefixChange.ts', ['declareLawfulPrefixChange'])
await spied('src/integrations/mcp/elicitationHandler.ts', ['withElicitationEntered'])
const realTools = await spied('src/tools/kit/toolList.ts', ['getTools', 'mcpToolPartition', 'toolsWithheldByDeny'])

const turn = await import('../../src/daemon/runner/runnerTurn.ts')
const { createRunnerState } = await import('../../src/daemon/runner/runnerPorts.ts')
const { getSessionId } = await import('../../src/boot/process-state/processState.ts')

type Ports = Parameters<typeof turn.runTurn>[4]
type Asked = Record<string, unknown> & { during: { inFlight: unknown; currentTurn: unknown; inside: boolean; anchor: unknown } }
type Scene = { ports: Ports; live: Ports['live']; messages: unknown[]; state: { now: Record<string, unknown> }; rows: unknown[]; asked: Asked[]; out: Array<Record<string, unknown>>; advisorRoad: unknown; assembled: unknown[] }

function scene(given: Record<string, unknown> = {}, script: Array<Record<string, unknown>> = [{ type: 'turn', state: 'started', turn_id: 'the-engine-turn' }, { type: 'text', text: 'words' }, { type: 'outcome', status: 'completed' }]): Scene {
  seen.length = 0
  answers.clear()
  const live = createRunnerState()
  const messages: unknown[] = []
  const rows: unknown[] = []
  const asked: Asked[] = []
  const out: Array<Record<string, unknown>> = []
  const advisorRoad = { onQuiet: () => {} }
  const assembled: unknown[] = [{ name: 'Read' }, { name: 'mcp__live__tool' }]
  const state = { now: { mcp: { clients: [{ name: 'live', type: 'connected' }], commands: [{ name: 'mcp-command' }, { name: 'shadowed' }], tools: [] }, toolPermissionContext: { mode: 'implement' } } as Record<string, unknown> }
  live.activeCommands = [{ name: 'own-command' }, { name: 'shadowed' }] as never
  let inside = false
  answers.set('runWithWorkload', async (_workload, fn) => {
    inside = true
    try {
      return await (fn as () => Promise<unknown>)()
    } finally {
      inside = false
    }
  })
  answers.set('sessionFactsOf', async () => ({ version: '1', cwd: '/', model: 'm', mode: 'implement', tools: [], mcp_servers: [], commands: [], agents: [], skills: [], extensions: [] }))
  answers.set('fitCompletionCommands', members => members)
  answers.set('toolsWithheldByDeny', () => [])
  answers.set('ask', params => {
    asked.push({ ...(params as Record<string, unknown>), during: { inFlight: live.inFlightAbort, currentTurn: live.currentTurn, inside, anchor: live.turnAnchor } })
    return (async function* () {
      for (const row of script) {
        if (row.throw !== undefined) throw new Error(String(row.throw))
        yield row
      }
    })()
  })
  const recorder = (name: string): unknown =>
    new Proxy(function () {}, {
      apply: (_target, _self, args: unknown[]) => void seen.push({ name: `port:${name}`, args }),
      get: (_target, key) => (typeof key === 'symbol' || key === 'then' ? undefined : recorder(`${name}.${key}`)),
    })
  const held: Record<string, unknown> = {
    live,
    messages,
    advisorRoad,
    options: {},
    inputPrompt: 'the one-shot prompt',
    maxTime: undefined,
    peer: null,
    getAppState: () => state.now,
    enqueueRow: (row: unknown) => void rows.push(row),
    liveScope: () => ({ session_id: 'the-session' }),
    localCommandInput: () => false,
    takeModeNotice: () => (seen.push({ name: 'port:takeModeNotice', args: [] }), null),
    answerSchemaOf: (schema: unknown) => schema,
    assembleTools: (...args: unknown[]) => (seen.push({ name: 'port:assembleTools', args }), assembled),
    io: { outbound: { enqueue: (line: Record<string, unknown>) => (seen.push({ name: `applied:${String((line.params as { verb?: string } | undefined)?.verb)}`, args: [line] }), void out.push(line)) } },
    asks: { pendingControlRequestCount: () => 0, parkedAsks: () => [], denyPendingPermissionRequests: () => 0, handleElicitation: (...args: unknown[]) => (seen.push({ name: 'port:asks.handleElicitation', args }), { action: 'accept' }) },
    statusIsProgress: () => false,
    promisedWaitOf: () => undefined,
    statusRowOf: () => null,
    ...given,
  }
  const made = new Map<string, unknown>()
  const ports = new Proxy(held, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined
      if (key in target) return target[key]
      if (!made.has(key)) made.set(key, recorder(key))
      return made.get(key)
    },
  }) as unknown as Ports
  return { ports, live, messages, state, rows, asked, out, advisorRoad, assembled }
}
const prompt = (value: string, more: Record<string, unknown> = {}): never => ({ value, mode: 'prompt', uuid: `uuid-of-${value}`, ...more }) as never
const run = (s: Scene, command: never, batch: never[] = [], given?: never[]): Promise<unknown> => within(turn.runTurn(command, batch, (row => void s.out.push(row as never)) as never, given, s.ports).then(() => 'ended', error => `threw: ${error instanceof Error ? error.message : String(error)}`))

section('§1 what the turn hands the engine')
{
  const s = scene()
  const ended = await run(s, prompt('the words'))
  const asked = s.asked[0]
  check('the daemon-hosted seat IS a write-back caller (run.ts hands its one session array into ask as mutableMessages)', ended === 'ended' && s.asked.length === 1 && asked?.mutableMessages === s.messages, String(ended))
  check('the turn runs under its own number and abort: the count rises by one, the engine is handed that number and the controller an interrupt reads, and both are cleared when it ends', asked?.turn === 1 && asked.during.currentTurn === 1 && asked.abortController === asked.during.inFlight && asked.abortController instanceof AbortController && s.live.turnsRun === 1 && s.live.currentTurn === null && s.live.inFlightAbort === null && s.live.turnAnchor === null && s.live.currentTurnId === 'the-engine-turn' && asked.during.anchor === 'uuid-of-the words' && asked.promptUuid === 'uuid-of-the words', j({ turn: asked?.turn, turnsRun: s.live.turnsRun, id: s.live.currentTurnId }))
  check('every row the engine yields reaches the driver, in order', j(s.out.map(row => row.type)) === j(['turn', 'text', 'outcome']), j(s.out))
  const state = s.state.now
  check(
    'the headless tool pool reads the MCP store live for each turn and its requested schema',
    said('port:assembleTools').length === 1 && said('port:assembleTools')[0]!.args[0] === state && asked?.tools === s.assembled && j(asked.mcpClients) === j((state.mcp as { clients: unknown[] }).clients) && asked.mcpClients !== (state.mcp as { clients: unknown[] }).clients && j((asked.commands as Array<{ name: string }>).map(command => command.name)) === j(['own-command', 'shadowed', 'mcp-command']) && said('port:registerPerTurnHandlers')[0]?.args[0] === asked.mcpClients,
    j((asked?.commands as Array<{ name: string }> | undefined)?.map(command => command.name)),
  )
  s.state.now = { ...state, mcp: { clients: [], commands: [], tools: [] } }
  await run(s, prompt('again', { schema: { type: 'object' } }))
  check('…a second turn reads the store again and asks for its own schema', said('port:assembleTools').length === 2 && said('port:assembleTools')[1]!.args[0] === s.state.now && j(said('port:assembleTools')[1]!.args[1]) === j({ type: 'object' }) && j(s.asked[1]?.mcpClients) === j([]) && j(s.asked[1]?.jsonSchema) === j({ type: 'object' }) && s.asked[1]?.turn === 2, j(said('port:assembleTools')[1]?.args[1]))
  check('a turn that asks for another answer schema than the last declares the change of the tool prefix; the same schema declares nothing', said('declareLawfulPrefixChange').length === 1 && said('clearToolRosterLatches').length === 1 && s.live.lastAnswerSchemaKey === j({ type: 'object' }), j(names().filter(name => !name.startsWith('port:'))))
  check('the session row is spoken once for a session: on its first turn and not on its second', s.rows.filter(row => (row as { type?: string }).type === 'session').length === 1 && s.live.sessionRowFor === String(getSessionId()), j(s.rows.map(row => (row as { type?: string }).type)))

  const marks: Record<string, unknown> = {}
  for (const [name, command] of Object.entries({ 'operator words': prompt('a'), 'a meta prompt': prompt('b', { isMeta: true }), 'a task notification': { value: '<task-notification><status>completed</status></task-notification>', mode: 'task-notification' }, 'a shell line': { value: 'ls', mode: 'bash' } })) {
    const each = scene()
    await run(each, command as never)
    marks[name] = each.asked[0]?.operatorPrompt
  }
  check("the runner marks the operator's own words — a prompt-mode command that is not meta — and none of the three other kinds driven here: a meta prompt, a task notification and a shell line carry no mark", j(marks) === j({ 'operator words': true, 'a meta prompt': false, 'a task notification': false, 'a shell line': false }), j(marks))

  const fire = scene({ options: { workload: 'the-run-workload' } })
  await run(fire, prompt('the fire', { workload: 'cron' }))
  const fired = said('runWithWorkload')[0]?.args[0]
  const inside = fire.asked[0]?.during.inside
  await run(fire, prompt('plain'))
  check("the run-time reader takes the queued command's workload first and enters the turn under it", fired === 'cron' && inside === true && said('runWithWorkload')[1]?.args[0] === 'the-run-workload', `${String(fired)} · ${String(inside)} · ${String(said('runWithWorkload')[1]?.args[0])}`)

  const batched = scene()
  const members = [prompt('one'), prompt('two', { origin: { kind: 'saturn', fire: 'cron' } }), { value: 'three', mode: 'prompt' }] as never[]
  await run(batched, members[0]!, members)
  const tail = batched.asked[0]?.batchTail
  const single = scene()
  await run(single, prompt('alone'))
  check("the runner's batch tail carries each member's origin beside its words and identity (red on the base: value and uuid alone)", j(tail) === j([{ value: 'two', uuid: 'uuid-of-two', origin: { kind: 'saturn', fire: 'cron' } }, { value: 'three' }]) && j(batched.asked[0]?.batchUuids) === j(['uuid-of-one', 'uuid-of-two']) && !('batchTail' in (single.asked[0] ?? {})) && !('batchUuids' in (single.asked[0] ?? {})), j(tail))

  const wake = scene()
  await run(wake, prompt('a wake', { isMeta: false, origin: { kind: 'saturn', fire: 'wake' }, skipSlashCommands: true }))
  const plainLine = scene()
  await run(plainLine, { value: 'no marks', mode: 'prompt' } as never)
  check('the turn road hands skipSlashCommands to the engine beside isMeta and the origin (red on the base: isMeta and the origin alone)', wake.asked[0]?.isMeta === false && j(wake.asked[0]?.origin) === j({ kind: 'saturn', fire: 'wake' }) && wake.asked[0]?.skipSlashCommands === true && !('origin' in (plainLine.asked[0] ?? {})) && !('skipSlashCommands' in (plainLine.asked[0] ?? {})) && 'isMeta' in (plainLine.asked[0] ?? {}), j([wake.asked[0]?.isMeta, wake.asked[0]?.origin, wake.asked[0]?.skipSlashCommands]))

  const noticed = scene()
  const earlier = [{ value: 'an earlier notice', mode: 'task-notification' }] as never[]
  const command = prompt('with notices')
  await run(noticed, command, [], earlier)
  const announced = said('port:emitCommandNotifications')[0]?.args[0] as unknown[] | undefined
  check("the next operator turn's held deliveries speak their frames through the one announcer, before the engine is asked", announced?.length === 2 && announced[0] === earlier[0] && announced[1] === command && j(noticed.asked[0]?.initialNotices) === j(earlier) && order('port:emitCommandNotifications', 'runWithWorkload', 'ask'), j(names().slice(0, 6)))

  const round = scene()
  await run(round, prompt('rounds'))
  const settledRows = [{ type: 'user' }]
  ;(round.asked[0]?.onToolRoundSettled as (rows: unknown) => void)(settledRows)
  const told = said('advisorMainRound')[0]?.args
  check("the main chat's tool-round boundary: the engine's onToolRoundSettled takes the same main road with the engine's own rows (red on the base: no boundary inside a running turn)", told?.[0] === String(getSessionId()) && told[1] === settledRows && told[2] === round.advisorRoad, j(told?.[0]))

  const local = scene({ localCommandInput: () => true })
  await run(local, prompt('/model'))
  check('a local command opens no anchor for the party feed and opens its block instead', local.asked[0]?.during.anchor === null && said('port:party.blockOpen').length === 1 && said('port:party.turnEnd').length === 1)
}

section('§2 the end of the turn: what was held lands, in its order, whatever the turn did')
{
  const hold = (s: Scene): void => {
    s.live.heldSeatModel = { requestId: 11, model: 'the-held-model', words: 'the spoken name', replacedDefault: 'the-replaced-default' }
    s.live.heldSeatEffort = { requestId: 12, effort: 'low' }
    s.live.deferredModelBreadcrumb = { to: 'to-model', from: 'from-model' }
    s.live.deferredSpawnSwitches = [{ kind: 'subagents', on: false, requestId: 13 }]
    s.live.deferredAdvisorQuiet = [{ id: 'quiet-1' }, { id: 'quiet-2' }] as never
  }
  const s = scene()
  hold(s)
  const ended = await run(s, prompt('held'))
  check('the turn boundary applies the held verb before the deferred rows flush', ended === 'ended' && order('port:applySeatModel', 'applied:set_model', 'port:applySeatEffort', 'applied:set_effort', 'holdQueuedWordsForTurnEnd', 'port:injectModelSwitchBreadcrumbs') && j(said('port:applySeatModel')[0]?.args) === j(['the-held-model', 'the spoken name', 'the-replaced-default']) && j(said('port:injectModelSwitchBreadcrumbs')[0]?.args) === j(['to-model', 'from-model']) && j(said('holdQueuedWordsForTurnEnd')[0]?.args) === j([false]), j(names().filter(name => !name.startsWith('port:party'))))
  check("the turn's end lands every held quiet row, after the spawn switches, the same way the model breadcrumb is held", order('port:injectModelSwitchBreadcrumbs', 'port:landSpawnSwitch', 'applied:set_spawn_switch', 'port:landAdvisorQuiet') && j(said('port:landAdvisorQuiet').map(call => call.args[0])) === j([{ id: 'quiet-1' }, { id: 'quiet-2' }]) && j(said('port:landSpawnSwitch')[0]?.args) === j(['subagents', false]) && s.live.deferredAdvisorQuiet.length === 0 && s.live.deferredSpawnSwitches.length === 0 && s.live.deferredModelBreadcrumb === null && s.live.heldSeatModel === null && s.live.heldSeatEffort === null, j(names()))
  check('each held verb is answered to the host with the request that asked it', j(s.out.filter(line => line.method === 'session/applied').map(line => line.params)) === j([{ request_id: 11, verb: 'set_model', model: 'the-held-model' }, { request_id: 12, verb: 'set_effort', effort: 'low' }, { request_id: 13, verb: 'set_spawn_switch', switch: 'subagents', on: false }]), j(s.out.filter(line => line.method === 'session/applied')))
  check('the crew board is read and the installed build compared once the turn is over', order('port:landAdvisorQuiet', 'port:swarmLead.check', 'port:swarmResumes.check', 'port:checkBuildBehind') && j(said('port:checkBuildBehind')[0]?.args) === j([true]) && order('ask', 'port:party.turnEnd'))

  const broken = scene({}, [{ type: 'turn', state: 'started', turn_id: 't' }, { throw: 'the engine failed' }])
  hold(broken)
  const threw = await run(broken, prompt('fails'))
  check('a turn the engine throws out of still lands what was held and clears its abort, and the failure reaches the driver', threw === 'threw: the engine failed' && order('port:applySeatModel', 'holdQueuedWordsForTurnEnd', 'port:landSpawnSwitch', 'port:landAdvisorQuiet') && broken.live.inFlightAbort === null && broken.live.currentTurn === null, String(threw))

  const quiet = scene()
  await run(quiet, prompt('nothing held'))
  check('a turn with nothing held applies nothing and still releases the queued words', said('port:applySeatModel').length === 0 && said('port:landSpawnSwitch').length === 0 && said('port:landAdvisorQuiet').length === 0 && said('port:injectModelSwitchBreadcrumbs').length === 0 && said('holdQueuedWordsForTurnEnd').length === 1 && quiet.out.every(line => line.method === undefined))
}

section('§3 the tool pool of a turn, and the elicitation handlers')
{
  const partition = [{ name: 'mcp__live__kept', isMcp: true }]
  const base = [{ name: 'Read' }, { name: 'Bash' }]
  const sessionTools = [{ name: 'Read' }, { name: 'an-extra-tool' }, { name: 'mcp__live__denied', isMcp: true }, { name: 'mcp__live__kept', isMcp: true }]
  const s = scene({ sessionTools, baseToolNames: new Set(['Read', 'Bash']), answerSchemaOf: () => undefined })
  answers.set('getTools', () => base)
  answers.set('mcpToolPartition', () => partition)
  const state = { mcp: { tools: [{ name: 'mcp__live__kept' }, { name: 'mcp__live__denied' }] }, toolPermissionContext: { mode: 'implement' } }
  const pool = turn.assembleTurnTools(state as never, undefined, s.ports)
  const handed = said('mcpToolPartition')[0]?.args
  check('the runner assembles its MCP partition through mcpToolPartition, never its own deny filter', handed?.[0] === state.mcp.tools && handed[1] === state.toolPermissionContext && pool.includes(partition[0] as never) && j(said('getTools')[0]?.args) === j([state.toolPermissionContext]), j(pool.map(tool => tool.name)))
  check('the run per-turn assembly exists, and startup extras cannot shadow the current filtered MCP collection', j(pool.map(tool => tool.name)) === j(['Read', 'Bash', 'an-extra-tool', 'mcp__live__kept']) && pool[0] === (base[0] as never), j(pool.map(tool => tool.name)))
  check('the real partition is the shared one that rides the deny rules', typeof realTools.mcpToolPartition === 'function')

  const handlers = new Map<string, (...args: never[]) => unknown>()
  const client = { name: 'live', type: 'connected', client: { setRequestHandler: (name: string, handler: (...args: never[]) => unknown) => void handlers.set(name, handler), setNotificationHandler: (name: string, handler: (...args: never[]) => unknown) => void handlers.set(name, handler) } }
  const e = scene()
  answers.set('withElicitationEntered', (_client, work) => (work as () => unknown)())
  await turn.registerElicitationHandlersForClient(client as never, 'live', e.ports)
  const signal = new AbortController().signal
  const answer = await (handlers.get('elicitation/create') as (request: unknown, ctx: unknown) => Promise<unknown>)({ params: { mode: 'form', message: 'which one', requestedSchema: { type: 'object' } } }, { mcpReq: { signal } })
  const entered = said('withElicitationEntered')[0]?.args[0]
  const handedOn = said('port:asks.handleElicitation')[0]?.args
  check('the print/SDK structured-IO handler enters the same ledger', entered === client.client && order('withElicitationEntered', 'port:asks.handleElicitation') && j(answer) === j({ action: 'accept' }) && handedOn?.[0] === 'live' && handedOn[1] === 'which one' && j(handedOn[2]) === j({ type: 'object' }) && handedOn[3] === signal && handedOn[4] === 'form', j(handedOn?.slice(0, 3)))
  await (handlers.get('notifications/elicitation/complete') as (notification: unknown) => Promise<void>)({ params: { elicitationId: 'e-1' } })
  check('a completed elicitation is told to the host as its own notification', j(e.out.at(-1)) === j({ method: 'elicitation/complete', params: { server: 'live', elicitation_id: 'e-1' } }), j(e.out.at(-1)))
  const registered = new Set<string>()
  const r = scene({ elicitationRegistered: registered })
  turn.registerPerTurnHandlers([client, client, { name: 'pending-one', type: 'pending' }] as never, r.ports)
  turn.registerPerTurnHandlers([client] as never, r.ports)
  check('a connected server has its handlers registered once for the run, and a server that is not connected has none', said('port:registerElicitationHandlersForClient').length === 1 && j([...registered]) === j(['live']), j([...registered]))
}

section('§4 a turn of notices alone')
{
  const s = scene({ localCommandInput: () => false })
  const hostNotice = { value: '<task-notification><task-id>host-notice-1</task-id><status>completed</status></task-notification>', mode: 'task-notification' }
  const { isHostNotice } = await import('../../src/screen/composer/input-core/command-queue.ts')
  if (isHostNotice(hostNotice as never)) {
    const ended = await run(s, hostNotice as never)
    check('a turn whose members are all host notices announces and records them and asks the engine nothing', ended === 'ended' && s.asked.length === 0 && !s.live.turnReachedModel && said('port:recordHostNoticeRows').length === 1 && s.live.turnsRun === 0, j(names()))
  } else {
    const ended = await run(s, { value: 'a meta line', mode: 'prompt', isMeta: true } as never, [{ value: 'a meta line', mode: 'prompt', isMeta: true }, { value: 'shown', mode: 'prompt' }] as never[])
    check('a batch with a meta member records the unshown member as a meta row and asks the engine with what is shown', ended === 'ended' && s.asked.length === 1 && s.live.turnReachedModel && said('port:recordNoticeRows').length === 1 && s.asked[0]?.prompt === 'shown', j(names()))
  }
}

console.log(failures === 0 ? '\nprove-print-turn: green' : `\nprove-print-turn: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
