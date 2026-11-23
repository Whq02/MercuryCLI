#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'queued-message-turn-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'queued-message-turn-daemon-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const k of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'NODE_ENV', 'MERCURY_HOME']) delete process.env[k]

const { query } = await import('../../src/engine/turnDoor.ts')
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
await import('../../src/engine/tasks/tasks.ts')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { drainPendingMessages, queueOperatorMessage, queuePendingMessage, takeOperatorMessages } = await import('../../src/engine/tasks/local-agent/crewmateTask.tsx')
const { ResumeAgentTool } = await import('../../src/tools/resume-crewmate/ResumeAgentTool.ts')
import type { AppState } from '../../src/screen/app-state/AppStateStore.ts'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
  if (!cond) failures++
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — queued-message turn prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

type AnyMsg = Record<string, unknown> & { type?: string }
const MODEL = 'claude-opus-4-8'
const AGENT = 'agent-q1'
const agentTask = (id: string, status = 'running'): Record<string, unknown> => ({ id, type: 'local_agent', status, description: `Lane ${id}`, agentId: id, agentType: 'mercury-crew', prompt: '', startTime: Date.now(), isBackgrounded: true, outputFile: '', outputOffset: 0, notified: false })

function makeTool(name: string): never {
  return {
    name,
    async description() { return 'rig tool' },
    async prompt() { return 'rig tool' },
    inputSchema: z.object({ text: z.string().optional() }),
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() { return { result: true } },
    async call(input: Record<string, unknown>) { return { data: `echo:${(input?.text as string) ?? ''}` } },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({ type: 'tool_result', tool_use_id: toolUseId, content: String(data) }),
  } as never
}

type Store = { state: Record<string, unknown>; set: (f: (prev: AppState) => AppState) => void; get: () => AppState }
function makeStore(tasks: Record<string, unknown>): Store {
  const store: Store = {
    state: { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high', tasks, agentNameRegistry: new Map<string, string>() },
    set(f) { store.state = f(store.state as unknown as AppState) as unknown as Record<string, unknown> },
    get: () => store.state as unknown as AppState,
  }
  return store
}
function makeCtx(store: Store, agentId: string | undefined): { ctx: Record<string, unknown>; abortController: AbortController } {
  const abortController = new AbortController()
  const ctx: Record<string, unknown> = {
    abortController,
    options: {
      commands: [], tools: [makeTool('EchoTool')], engineModel: MODEL, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {},
      isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: store.get,
    setAppState: store.set,
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId,
  }
  return { ctx, abortController }
}

type CallRecord = { messages: unknown[] }
function makeModel(script: unknown[][], onCall: (index: number) => void): { calls: CallRecord[]; callModel: unknown } {
  const calls: CallRecord[] = []
  async function* callModel(req: { messages: unknown[] }): AsyncGenerator<never, void> {
    const idx = calls.length
    calls.push({ messages: [...req.messages] })
    onCall(idx)
    const steps = script[idx]
    if (!steps) throw new Error(`model script exhausted at call ${idx}`)
    for (const s of steps) yield s as never
  }
  return { calls, callModel }
}
const allowAll = async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never
const textTurn = (text: string): unknown => {
  const m = createAssistantMessage({ content: text })
  m.message.stop_reason = 'end_turn'
  return m
}

async function run(store: Store, agentId: string | undefined, script: unknown[][], onCall: (index: number) => void): Promise<{ yields: AnyMsg[]; calls: CallRecord[]; terminal: Record<string, unknown> }> {
  const rig = makeCtx(store, agentId)
  const { calls, callModel } = makeModel(script, onCall)
  const gen = query({
    messages: [createUserMessage({ content: 'write the spec' })] as never,
    systemPrompt: ['rig system prompt'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: allowAll as never,
    toolUseContext: rig.ctx as never,
    querySource: 'agent:mercury-crew' as never,
    deps: {
      callModel: callModel as never,
      autocompact: (async () => ({ wasCompacted: false })) as never,
      microcompact: (async (messages: unknown[]) => ({ messages })) as never,
      uuid: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` })(),
    },
  })
  const yields: AnyMsg[] = []
  let r = await gen.next()
  while (!r.done) {
    yields.push(r.value as AnyMsg)
    r = await gen.next()
  }
  await new Promise(resolve => setTimeout(resolve, 5))
  return { yields, calls, terminal: r.value as Record<string, unknown> }
}
const textsOf = (msgs: unknown[]): string[] => {
  const out: string[] = []
  for (const m of msgs as AnyMsg[]) {
    if (m?.type === 'attachment') {
      const att = m.attachment as { prompt?: unknown } | undefined
      if (typeof att?.prompt === 'string') out.push(att.prompt)
      continue
    }
    if (m?.type !== 'user') continue
    const c = (m.message as { content?: unknown } | undefined)?.content
    if (typeof c === 'string') out.push(c)
    else if (Array.isArray(c)) for (const b of c as AnyMsg[]) if (b?.type === 'text' && typeof b.text === 'string') out.push(b.text)
  }
  return out
}
const pendingOf = (store: Store, id: string): string[] => ((store.state.tasks as Record<string, { pendingMessages?: string[] }>)[id]?.pendingMessages ?? [])

section('§1 the recorded sequence: a message queued while the turn runs starts a new turn before the run ends')
{
  const store = makeStore({ [AGENT]: agentTask(AGENT) })
  const r = await run(store, AGENT, [[textTurn('I have written and verified docs/18.')], [textTurn('docs/18 now conforms to docs/21 §0.')]], index => {
    if (index === 0) queuePendingMessage(AGENT, 'The shared Runtime Contract is now written in docs/21 §0. Read it now and make docs/18 conform exactly.', store.set)
  })
  check('the run made two model calls: the queued message became the next turn', r.calls.length === 2, `${r.calls.length} — the queued_message rule in src/engine/loop/turn/noToolReply.ts must hand a crewmate's pending messages (queuePendingMessage in src/engine/tasks/local-agent/crewmateTask.tsx) to a new turn when a reply ends without tool calls`)
  check('the run ended completed, after the second turn, never between', r.terminal.reason === 'completed', `${JSON.stringify(r.terminal)} — the run must end only after the queued turn is answered; see the queued_message rule in src/engine/loop/turn/noToolReply.ts`)
  const second = textsOf(r.calls[1]?.messages ?? [])
  check('the second call carries the queued message as its newest row', second.at(-1)?.includes('make docs/18 conform exactly') === true, `${JSON.stringify(second.slice(-2))} — the queued_message rule in src/engine/loop/turn/noToolReply.ts must append the message as the last row of the next request`)
  check('the first call carried no such row', !textsOf(r.calls[0]?.messages ?? []).some(text => text.includes('conform exactly')), 'the message is queued during call 0, so only a later call may carry it; check where the queued_message rule in src/engine/loop/turn/noToolReply.ts reads the queue')
  check('the queue is empty once the message rode a turn', pendingOf(store, AGENT).length === 0, `${JSON.stringify(pendingOf(store, AGENT))} — the queued_message rule in src/engine/loop/turn/noToolReply.ts must drain the messages it hands over`)
  check('the queued message reached the transcript as a row', r.yields.some(m => textsOf([m]).some(text => text.includes('conform exactly'))), 'the queued_message rule in src/engine/loop/turn/noToolReply.ts must also yield each handed-over message as a row of the run')
  const assistantTexts = r.yields.filter(m => m.type === 'assistant').map(m => JSON.stringify((m.message as { content: unknown }).content))
  check('both replies stand in the transcript', assistantTexts.some(t => t.includes('verified docs/18')) && assistantTexts.some(t => t.includes('conforms to docs/21')), 'the run must yield the assistant replies of both turns; see the turn loop in src/engine/loop/turn-machine.ts')
}

section('§2 nothing queued, nothing invented: a quiet run ends on its first reply; the main agent is untouched')
{
  const store = makeStore({ [AGENT]: agentTask(AGENT) })
  const r = await run(store, AGENT, [[textTurn('done')]], () => {})
  check('one call, completed', r.calls.length === 1 && r.terminal.reason === 'completed', `${r.calls.length} ${JSON.stringify(r.terminal)} — with nothing queued the queued_message rule in src/engine/loop/turn/noToolReply.ts must decide nothing and let the reply stand`)
  const main = makeStore({ [AGENT]: agentTask(AGENT) })
  const m = await run(main, undefined, [[textTurn('done')]], index => {
    if (index === 0) queuePendingMessage(AGENT, 'for the crewmate, not for the lead', main.set)
  })
  check("the lead's own run never drains a crewmate's queue", m.calls.length === 1 && pendingOf(main, AGENT).length === 1, `${m.calls.length} ${JSON.stringify(pendingOf(main, AGENT))} — a run with no agent id must not read any crewmate's pendingMessages; see getAgentPendingMessageAttachments in src/engine/attachments/queuedCommands.ts`)
}

section('§3 two messages queued in one turn ride one new turn, in order; a third queued during that turn rides a third')
{
  const store = makeStore({ [AGENT]: agentTask(AGENT) })
  const r = await run(store, AGENT, [[textTurn('first reply')], [textTurn('second reply')], [textTurn('third reply')]], index => {
    if (index === 0) {
      queuePendingMessage(AGENT, 'guidance one', store.set)
      queuePendingMessage(AGENT, 'guidance two', store.set)
    }
    if (index === 1) queuePendingMessage(AGENT, 'guidance three', store.set)
  })
  check('three calls', r.calls.length === 3, `${r.calls.length} — each reply that ends without tool calls and finds queued messages must start another turn (queued_message rule, src/engine/loop/turn/noToolReply.ts)`)
  const second = textsOf(r.calls[1]?.messages ?? [])
  const oneAt = second.findIndex(text => text.includes('guidance one'))
  const twoAt = second.findIndex(text => text.includes('guidance two'))
  check('the second call carries both earlier messages in order', oneAt >= 0 && twoAt > oneAt && !second.some(text => text.includes('guidance three')), `${JSON.stringify(second.slice(-3))} — the queued_message rule in src/engine/loop/turn/noToolReply.ts must hand over every message queued so far, in queue order, and none queued later`)
  check('the third call carries the third', textsOf(r.calls[2]?.messages ?? []).some(text => text.includes('guidance three')), 'a message queued during the second turn must ride a third turn; see the queued_message rule in src/engine/loop/turn/noToolReply.ts')
  check('completed with an empty queue', r.terminal.reason === 'completed' && pendingOf(store, AGENT).length === 0, `${JSON.stringify(r.terminal)} ${JSON.stringify(pendingOf(store, AGENT))} — the run must end completed with every queued message drained (queued_message rule, src/engine/loop/turn/noToolReply.ts)`)
}

section("§4 the lifecycle's end-of-run drain takes exactly what it peeked; later arrivals stay queued")
{
  const store = makeStore({ a1: agentTask('a1') })
  queuePendingMessage('a1', 'peeked one', store.set)
  queuePendingMessage('a1', 'peeked two', store.set)
  const peeked = [...pendingOf(store, 'a1')]
  queuePendingMessage('a1', 'arrived during the resume', store.set)
  const drained = drainPendingMessages('a1', store.get, store.set, peeked.length)
  check('the bounded drain returns the peeked messages only', JSON.stringify(drained) === JSON.stringify(['peeked one', 'peeked two']), `${JSON.stringify(drained)} — drainPendingMessages in src/engine/tasks/local-agent/crewmateTask.tsx must take only the first limit messages`)
  check('the message that arrived after the peek stays queued for the next run', JSON.stringify(pendingOf(store, 'a1')) === JSON.stringify(['arrived during the resume']), `${JSON.stringify(pendingOf(store, 'a1'))} — drainPendingMessages in src/engine/tasks/local-agent/crewmateTask.tsx must leave pendingMessages beyond the limit in place`)
  check('an unbounded drain still takes everything', JSON.stringify(drainPendingMessages('a1', store.get, store.set)) === JSON.stringify(['arrived during the resume']) && pendingOf(store, 'a1').length === 0, 'drainPendingMessages in src/engine/tasks/local-agent/crewmateTask.tsx must take every pending message when no limit is given')
  queueOperatorMessage('a1', 'operator one', store.set)
  queueOperatorMessage('a1', 'operator two', store.set)
  const taken = takeOperatorMessages('a1', store.get, store.set, 1)
  const left = ((store.state.tasks as Record<string, { operatorMessages?: string[] }>).a1?.operatorMessages ?? [])
  check('the operator lane drains by count the same way', JSON.stringify(taken) === JSON.stringify(['operator one']) && JSON.stringify(left) === JSON.stringify(['operator two']), `${JSON.stringify([taken, left])} — takeOperatorMessages in src/engine/tasks/local-agent/crewmateTask.tsx must honour its limit like drainPendingMessages`)
  const t = await import('../core-runtime/turnScenarios.ts')
  const { NO_TOOL_RULES, readReply } = await import('../../src/engine/loop/turn/noToolReply.ts')
  const queuedRule = NO_TOOL_RULES.find(entry => entry.name === 'queued_message')!
  const atTheNaturalEnd = async (plan: Parameters<typeof t.plantReply>[0]) => {
    const planted = await t.plantReply(plan)
    const out = await t.drain(queuedRule.decide(planted.run as never, planted.iter as never, readReply(planted.iter as never)))
    planted.close()
    return out
  }
  const crew = await atTheNaturalEnd({ agentId: t.fixtures.agent(), querySource: 'agent:custom', appState: t.fixtures.crewTask(['read the contract', 'and conform to it']), script: [t.fixtures.yields(t.fixtures.says('the note is written.'))] })
  const filedUnderNoId = (): Record<string, unknown> => {
    const queue = t.fixtures.crewTask(['read the contract', 'and conform to it'])
    const task = Object.values(queue.tasks as Record<string, Record<string, unknown>>)[0]!
    return { ...queue, tasks: { [String(undefined)]: { ...task, id: String(undefined), agentId: String(undefined) } } }
  }
  const lead = await atTheNaturalEnd({ appState: filedUnderNoId(), script: [t.fixtures.yields(t.fixtures.says('the note is written.'))] })
  const handed = (crew.decision as { next?: { transition?: unknown; messages?: unknown[] } } | undefined)?.next
  check(
    'the turn machine reads a crewmate\'s queue at the natural end of a turn and continues with reason queued_message',
    t.reasonOf(crew.decision) === 'hand_over queued_message' && JSON.stringify(handed?.transition) === JSON.stringify({ reason: 'queued_message', count: 2 }) && crew.events.filter(event => event.kind === 'attachment').length === 2 && JSON.stringify(textsOf(handed?.messages ?? []).slice(-2)) === JSON.stringify(['read the contract', 'and conform to it']) && t.reasonOf(lead.decision) === 'nothing' && lead.events.length === 0,
    `a crewmate with two queued messages: ${t.reasonOf(crew.decision)} ${JSON.stringify(handed?.transition)}, ${crew.events.length} row(s); a run with no agent id, the same queue filed where an absent id would read it: ${t.reasonOf(lead.decision)}, ${lead.events.length} row(s) — the queued_message rule of src/engine/loop/turn/noToolReply.ts hands over with the count of the crewmate's own pending messages, each as a row of the next turn; for a run with no agent id getAgentPendingMessageAttachments (src/engine/attachments/queuedCommands.ts) answers nothing, and the rule decides nothing`,
  )
}

section('§5 ResumeCrewmate on a running crewmate joins the queue, even with a model or effort named, and says what is queued')
{
  const store = makeStore({ addbsftfg: agentTask('addbsftfg') })
  ;(store.state.agentNameRegistry as Map<string, string>).set('opus-consistency-c2', 'addbsftfg')
  const rig = makeCtx(store, undefined)
  const parent = createAssistantMessage({ content: 'resuming' })
  const first = await ResumeAgentTool.call({ to: 'opus-consistency-c2', effort: 'medium', message: 'Director rulings on your four decision items.' } as never, rig.ctx as never, allowAll as never, parent as never)
  const firstData = (first as { data: { success: boolean; message: string } }).data
  check('the call succeeds: the message is queued, nothing is refused', firstData.success === true, `${JSON.stringify(firstData)} — a running crewmate must accept the message with model or effort named; see the running branch of call in src/tools/resume-crewmate/ResumeAgentTool.ts`)
  check('the answer says the message was queued and when it is read', firstData.message.includes('the message was queued') && firstData.message.includes('next tool boundary') && firstData.message.includes('next turn when the current one ends'), `${firstData.message} — the success text of the running branch in src/tools/resume-crewmate/ResumeAgentTool.ts must say it was queued and when it is read`)
  check('the answer says the effort was not applied and where it would be', firstData.message.includes('effort medium was not applied') && firstData.message.includes('once it has finished'), `${firstData.message} — the kept-overrides sentence in src/tools/resume-crewmate/ResumeAgentTool.ts must name each override as not applied and say to name it again once the crewmate has finished`)
  check('the old refusal is gone', !firstData.message.includes('nothing was queued'), 'a running crewmate with no override named must not get the refusal text; see src/tools/resume-crewmate/ResumeAgentTool.ts')
  check('the queue holds the message as a crew notice', pendingOf(store, 'addbsftfg').length === 1 && pendingOf(store, 'addbsftfg')[0]!.includes('Director rulings on your four decision items.'), `${JSON.stringify(pendingOf(store, 'addbsftfg'))} — the running branch in src/tools/resume-crewmate/ResumeAgentTool.ts must call queuePendingMessage with the message`)
  const second = await ResumeAgentTool.call({ to: 'addbsftfg', message: 'And one more.' } as never, rig.ctx as never, allowAll as never, parent as never)
  const secondData = (second as { data: { success: boolean; message: string } }).data
  check('a second message names what is queued ahead of it', secondData.success === true && secondData.message.includes('1 earlier message is queued ahead of it') && !secondData.message.includes('not applied'), `${secondData.message} — the queue sentence in src/tools/resume-crewmate/ResumeAgentTool.ts must count the earlier pendingMessages and name no override when none was given`)
  check('both wait in order', pendingOf(store, 'addbsftfg').length === 2 && pendingOf(store, 'addbsftfg')[1]!.includes('And one more.'), 'the second message must be appended behind the first in pendingMessages; see queuePendingMessage in src/engine/tasks/local-agent/crewmateTask.tsx')
  const both = await ResumeAgentTool.call({ to: 'addbsftfg', model: 'claude-opus-4-8', effort: 'max', message: 'Third.' } as never, rig.ctx as never, allowAll as never, parent as never)
  const bothData = (both as { data: { success: boolean; message: string } }).data
  check('model and effort together are both named as kept for a finished resume', bothData.success === true && bothData.message.includes('model claude-opus-4-8 and effort max were not applied') && bothData.message.includes('2 earlier messages are queued ahead of it'), `${bothData.message} — the kept-overrides and queue sentences in src/tools/resume-crewmate/ResumeAgentTool.ts must name both overrides and the two earlier messages`)
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
rmSync(process.env.MERCURY_DAEMON_DIR!, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
