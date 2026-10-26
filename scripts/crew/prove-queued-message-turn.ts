#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'queued-message-turn-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'queued-message-turn-daemon-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const k of ['MERCURY_BARE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'NODE_ENV', 'MERCURY_HOME']) delete process.env[k]

const { query } = await import('../../src/query.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
await import('../../src/tasks.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { drainPendingMessages, queueOperatorMessage, queuePendingMessage, takeOperatorMessages } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { ResumeAgentTool } = await import('../../src/tools/ResumeAgentTool/ResumeAgentTool.ts')
import type { AppState } from '../../src/state/AppStateStore.ts'

const ROOT = new URL('../../', import.meta.url).pathname
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
  check('the run made two model calls: the queued message became the next turn', r.calls.length === 2, String(r.calls.length))
  check('the run ended completed, after the second turn, never between', r.terminal.reason === 'completed', JSON.stringify(r.terminal))
  const second = textsOf(r.calls[1]?.messages ?? [])
  check('the second call carries the queued message as its newest row', second.at(-1)?.includes('make docs/18 conform exactly') === true, JSON.stringify(second.slice(-2)))
  check('the first call carried no such row', !textsOf(r.calls[0]?.messages ?? []).some(text => text.includes('conform exactly')))
  check('the queue is empty once the message rode a turn', pendingOf(store, AGENT).length === 0, JSON.stringify(pendingOf(store, AGENT)))
  check('the queued message reached the transcript as a row', r.yields.some(m => textsOf([m]).some(text => text.includes('conform exactly'))))
  const assistantTexts = r.yields.filter(m => m.type === 'assistant').map(m => JSON.stringify((m.message as { content: unknown }).content))
  check('both replies stand in the transcript', assistantTexts.some(t => t.includes('verified docs/18')) && assistantTexts.some(t => t.includes('conforms to docs/21')))
}

section('§2 nothing queued, nothing invented: a quiet run ends on its first reply; the main agent is untouched')
{
  const store = makeStore({ [AGENT]: agentTask(AGENT) })
  const r = await run(store, AGENT, [[textTurn('done')]], () => {})
  check('one call, completed', r.calls.length === 1 && r.terminal.reason === 'completed', `${r.calls.length} ${JSON.stringify(r.terminal)}`)
  const main = makeStore({ [AGENT]: agentTask(AGENT) })
  const m = await run(main, undefined, [[textTurn('done')]], index => {
    if (index === 0) queuePendingMessage(AGENT, 'for the crewmate, not for the lead', main.set)
  })
  check("the lead's own run never drains a crewmate's queue", m.calls.length === 1 && pendingOf(main, AGENT).length === 1, `${m.calls.length} ${JSON.stringify(pendingOf(main, AGENT))}`)
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
  check('three calls', r.calls.length === 3, String(r.calls.length))
  const second = textsOf(r.calls[1]?.messages ?? [])
  const oneAt = second.findIndex(text => text.includes('guidance one'))
  const twoAt = second.findIndex(text => text.includes('guidance two'))
  check('the second call carries both earlier messages in order', oneAt >= 0 && twoAt > oneAt && !second.some(text => text.includes('guidance three')), JSON.stringify(second.slice(-3)))
  check('the third call carries the third', textsOf(r.calls[2]?.messages ?? []).some(text => text.includes('guidance three')))
  check('completed with an empty queue', r.terminal.reason === 'completed' && pendingOf(store, AGENT).length === 0)
}

section("§4 the lifecycle's end-of-run drain takes exactly what it peeked; later arrivals stay queued")
{
  const store = makeStore({ a1: agentTask('a1') })
  queuePendingMessage('a1', 'peeked one', store.set)
  queuePendingMessage('a1', 'peeked two', store.set)
  const peeked = [...pendingOf(store, 'a1')]
  queuePendingMessage('a1', 'arrived during the resume', store.set)
  const drained = drainPendingMessages('a1', store.get, store.set, peeked.length)
  check('the bounded drain returns the peeked messages only', JSON.stringify(drained) === JSON.stringify(['peeked one', 'peeked two']), JSON.stringify(drained))
  check('the message that arrived after the peek stays queued for the next run', JSON.stringify(pendingOf(store, 'a1')) === JSON.stringify(['arrived during the resume']), JSON.stringify(pendingOf(store, 'a1')))
  check('an unbounded drain still takes everything', JSON.stringify(drainPendingMessages('a1', store.get, store.set)) === JSON.stringify(['arrived during the resume']) && pendingOf(store, 'a1').length === 0)
  queueOperatorMessage('a1', 'operator one', store.set)
  queueOperatorMessage('a1', 'operator two', store.set)
  const taken = takeOperatorMessages('a1', store.get, store.set, 1)
  const left = ((store.state.tasks as Record<string, { operatorMessages?: string[] }>).a1?.operatorMessages ?? [])
  check('the operator lane drains by count the same way', JSON.stringify(taken) === JSON.stringify(['operator one']) && JSON.stringify(left) === JSON.stringify(['operator two']), JSON.stringify([taken, left]))
  const lifecycle = readFileSync(join(ROOT, 'src/tools/AgentTool/agentToolUtils.ts'), 'utf8')
  check('the lifecycle drains by the counts it peeked and marks a run that went on with the parent\'s guidance', /drainPendingMessages\(taskId, stateReader, rootSetAppState, pending\.length\)/.test(lifecycle) && /takeOperatorMessages\(taskId, stateReader, rootSetAppState, operator\.length\)/.test(lifecycle) && /continuedOnGuidance = pending\.length > 0/.test(lifecycle))
  check('a run that went on with queued guidance sends no completion notice; the resumed run sends its own when its queue is empty', /const notifies = \(overloadEpisode === null \|\| overloadDeathNotifies\(overloadEpisode\)\) && !continuedOnGuidance/.test(lifecycle))
  const machine = readFileSync(join(ROOT, 'src/run-core/turn-machine.ts'), 'utf8')
  check('the turn machine reads a crewmate\'s queue at the natural end of a turn and continues with reason queued_message', /if \(toolUseContext\.agentId\) \{\s*\n\s*const queued = getAgentPendingMessageAttachments\(toolUseContext\)/.test(machine) && /transition: \{ reason: 'queued_message', count: queued\.length \}/.test(machine))
}

section('§5 ResumeCrewmate on a running crewmate joins the queue, even with a model or effort named, and says what is queued')
{
  const store = makeStore({ addbsftfg: agentTask('addbsftfg') })
  ;(store.state.agentNameRegistry as Map<string, string>).set('opus-consistency-c2', 'addbsftfg')
  const rig = makeCtx(store, undefined)
  const parent = createAssistantMessage({ content: 'resuming' })
  const first = await ResumeAgentTool.call({ to: 'opus-consistency-c2', effort: 'medium', message: 'Director rulings on your four decision items.' } as never, rig.ctx as never, allowAll as never, parent as never)
  const firstData = (first as { data: { success: boolean; message: string } }).data
  check('the call succeeds: the message is queued, nothing is refused', firstData.success === true, JSON.stringify(firstData))
  check('the answer says the message was queued and when it is read', firstData.message.includes('the message was queued') && firstData.message.includes('next tool boundary') && firstData.message.includes('next turn when the current one ends'), firstData.message)
  check('the answer says the effort was not applied and where it would be', firstData.message.includes('effort medium was not applied') && firstData.message.includes('once it has finished'), firstData.message)
  check('the old refusal is gone', !firstData.message.includes('nothing was queued'))
  check('the queue holds the message as a crew notice', pendingOf(store, 'addbsftfg').length === 1 && pendingOf(store, 'addbsftfg')[0]!.includes('Director rulings on your four decision items.'), JSON.stringify(pendingOf(store, 'addbsftfg')))
  const second = await ResumeAgentTool.call({ to: 'addbsftfg', message: 'And one more.' } as never, rig.ctx as never, allowAll as never, parent as never)
  const secondData = (second as { data: { success: boolean; message: string } }).data
  check('a second message names what is queued ahead of it', secondData.success === true && secondData.message.includes('1 earlier message is queued ahead of it') && !secondData.message.includes('not applied'), secondData.message)
  check('both wait in order', pendingOf(store, 'addbsftfg').length === 2 && pendingOf(store, 'addbsftfg')[1]!.includes('And one more.'))
  const both = await ResumeAgentTool.call({ to: 'addbsftfg', model: 'claude-opus-4-8', effort: 'max', message: 'Third.' } as never, rig.ctx as never, allowAll as never, parent as never)
  const bothData = (both as { data: { success: boolean; message: string } }).data
  check('model and effort together are both named as kept for a finished resume', bothData.success === true && bothData.message.includes('model claude-opus-4-8 and effort max were not applied') && bothData.message.includes('2 earlier messages are queued ahead of it'), bothData.message)
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
rmSync(process.env.MERCURY_DAEMON_DIR!, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
