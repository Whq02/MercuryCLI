import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorld, bootLead, LEAD_MODEL, toolResultOf, userTextsOf } from './crew-world.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`) }
const childPrompt = 'engine-resume-child-only'
const switched = 'claude-opus-5-5'
const world = await makeWorld('resume-engine-options', [
  { kind: 'text', text: 'CHILD-FIRST-COMPLETE', whenSaid: childPrompt, model: LEAD_MODEL },
  { kind: 'text', text: 'CHILD-SWITCH-COMPLETE', whenSaid: childPrompt, model: switched },
  { kind: 'text', text: 'CHILD-KEEP-COMPLETE', whenSaid: childPrompt, model: switched },
  { kind: 'tool_use', name: 'Crewmate', id: 'launch-engine-child', input: { name: 'engine-child', description: 'engine child', prompt: childPrompt, run_in_background: true, effort: 'high' }, whenSaid: 'parent-launch', model: LEAD_MODEL },
  { kind: 'text', text: 'LAUNCH-NOTED', whenSaid: 'parent-launch', model: LEAD_MODEL },
  { kind: 'tool_use', name: 'ResumeCrewmate', id: 'switch-engine-child', input: { to: 'engine-child', message: 'next turn', model: switched, effort: 'max' }, whenSaid: 'parent-switch', model: LEAD_MODEL },
  { kind: 'text', text: 'SWITCH-NOTED', whenSaid: 'parent-switch', model: LEAD_MODEL },
  { kind: 'tool_use', name: 'ResumeCrewmate', id: 'unknown-engine-child', input: { to: 'engine-child', message: 'do not launch', model: 'unknown-fixture-model' }, whenSaid: 'parent-unknown', model: LEAD_MODEL },
  { kind: 'text', text: 'UNKNOWN-NOTED', whenSaid: 'parent-unknown', model: LEAD_MODEL },
  { kind: 'tool_use', name: 'ResumeCrewmate', id: 'effort-engine-child', input: { to: 'engine-child', message: 'do not lower effort', model: 'claude-haiku-4-5', effort: 'xhigh' }, whenSaid: 'parent-effort', model: LEAD_MODEL },
  { kind: 'text', text: 'EFFORT-NOTED', whenSaid: 'parent-effort', model: LEAD_MODEL },
  { kind: 'tool_use', name: 'ResumeCrewmate', id: 'keep-engine-child', input: { to: 'engine-child', message: 'continue unchanged' }, whenSaid: 'parent-keep', model: LEAD_MODEL },
  { kind: 'text', text: 'KEEP-NOTED', whenSaid: 'parent-keep', model: LEAD_MODEL },
  ...Array.from({ length: 16 }, () => ({ kind: 'text' as const, text: 'PARENT-NOTED', model: LEAD_MODEL })),
])
const lead = bootLead(world, ['--sovereign'], ['Crewmate', 'ResumeCrewmate'])
const childRequests = (): any[] => world.fixture.messageRequests().filter(request => {
  const body = request.body as { messages?: unknown[] }
  const text = JSON.stringify(body.messages)
  return text.includes(childPrompt) && !text.includes('parent-launch')
}).map(request => request.body)
try {
  lead.submit('parent-launch')
  await lead.waitFor('initial child completion', () => userTextsOf(world).some(text => text.includes('<result>CHILD-FIRST-COMPLETE</result>')))
  const first = childRequests()[0]
  lead.submit('parent-switch')
  await lead.waitFor('resume tool settled', () => toolResultOf(world, 'switch-engine-child') !== null)
  await lead.waitFor('resumed child request', () => childRequests().length >= 2)
  const second = childRequests()[1]
  check('resume sends the named model and max effort', second.model === switched && second.output_config?.effort === 'max', JSON.stringify({ model: second.model, effort: second.output_config?.effort }))
  check('the complete prior transcript reaches the new model', JSON.stringify(second.messages).includes(childPrompt) && JSON.stringify(second.messages).includes('CHILD-FIRST-COMPLETE'))
  check('model switch keeps the recorded system prefix', JSON.stringify(first.system) === JSON.stringify(second.system))
  if (second.model !== switched) {
    console.log('[record] checkpoint ignored the optional override; refusal and unchanged-model checks require the adopted schema')
  } else {
    await lead.waitFor('switched child completion', () => userTextsOf(world).some(text => text.includes('<result>CHILD-SWITCH-COMPLETE</result>')))
    console.log('\nrefusals')
    const before = childRequests().length
    lead.submit('parent-unknown')
    await lead.waitFor('unknown model refusal', () => toolResultOf(world, 'unknown-engine-child') !== null)
    const unknown = toolResultOf(world, 'unknown-engine-child')!
    check('unknown model is refused with the model ladder', unknown.text.includes('could not be resumed') && unknown.text.includes('names no model: no provider family declares it') && unknown.text.includes('mercury://models'), unknown.text)
    lead.submit('parent-effort')
    await lead.waitFor('unsupported effort refusal', () => toolResultOf(world, 'effort-engine-child') !== null)
    const effort = toolResultOf(world, 'effort-engine-child')!
    check('unsupported effort is refused instead of clamped', effort.text.includes('could not be resumed') && effort.text.includes('effort') && effort.text.includes('mercury://models'), effort.text)
    check('refusals create no child request', childRequests().length === before)
    lead.submit('parent-keep')
    await lead.waitFor('unchanged child completion', () => userTextsOf(world).some(text => text.includes('<result>CHILD-KEEP-COMPLETE</result>')))
    const third = childRequests()[2]
    check('omitting both overrides keeps the last model and effort', third.model === switched && third.output_config?.effort === 'max')
    check('the next resume carries both previous answers', JSON.stringify(third.messages).includes('CHILD-FIRST-COMPLETE') && JSON.stringify(third.messages).includes('CHILD-SWITCH-COMPLETE'))
    const { ResumeAgentTool: DirectResumeTool } = await import('../../src/tools/ResumeAgentTool/ResumeAgentTool.ts')
    const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
    const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
    const { registerAsyncAgent, registerAgentName, killAsyncAgent } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
    const { generateTaskId } = await import('../../src/Task.ts')
    const { getAgentTranscriptPath, writeAgentMetadata, readAgentMetadata } = await import('../../src/utils/sessionStorage/paths.ts')
    const { asAgentId } = await import('../../src/types/ids.ts')
    const { getSessionId } = await import('../../src/bootstrap/state.ts')
    const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
    const { ordinalOf } = await import('../../src/fabric/ordinal.ts')
    const { writeFileSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    let state = { ...getDefaultAppState(), toolPermissionContext: getEmptyToolPermissionContext() }
    const setState = (update: (prev: typeof state) => typeof state) => { state = update(state) }
    const wtId = generateTaskId('local_agent')
    const wtDir = join(world.dir, 'preserved-worktree')
    mkdirSync(wtDir, { recursive: true })
    registerAsyncAgent({ agentId: wtId, description: 'wt-child', prompt: 'work', setAppState: setState as never })
    registerAgentName('wt-child', wtId, setState as never)
    state = { ...state, tasks: { ...state.tasks, [wtId]: { ...state.tasks[wtId], status: 'completed' } as never } }
    const wtTranscript = getAgentTranscriptPath(asAgentId(wtId))
    mkdirSync(dirname(wtTranscript), { recursive: true })
    const sid = String(getSessionId())
    const firstUuid = crypto.randomUUID()
    let ord = 0
    const seedRows = [
      { type: 'user', uuid: firstUuid, parentUuid: null, message: { role: 'user', content: 'work' } },
      { type: 'assistant', uuid: crypto.randomUUID(), parentUuid: firstUuid, message: { id: 'msg_wt', role: 'assistant', model: LEAD_MODEL, content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]
    writeFileSync(wtTranscript, seedRows.map(entry => JSON.stringify(entryToRecord({ ...entry, isSidechain: true, agentId: wtId, sessionId: sid, timestamp: new Date().toISOString() } as never, { sessionId: sid, nextOrdinal: () => ordinalOf(++ord), observedAt: new Date().toISOString(), source: { channel: 'interactive' } } as never))).join('\n') + '\n')
    await writeAgentMetadata(asAgentId(wtId), { agentType: 'mercury-crew', name: 'wt-child', description: 'wt-child', worktreePath: wtDir, model: LEAD_MODEL, effortOverride: 'medium', launchedAt: Date.now() })
    const wtCtx = { getAppState: () => state, setAppState: setState, setAppStateForTasks: setState, options: { tools: [], commands: [], mcpClients: [], engineModel: LEAD_MODEL, agentDefinitions: { activeAgents: [], allAgents: [] } }, messages: [], abortController: new AbortController(), readFileState: new Map() } as never
    const wtResumed = await DirectResumeTool.call({ to: 'wt-child', message: 'continue in worktree', model: 'claude-opus-4-7', effort: 'high' }, wtCtx, (async () => ({ behavior: 'allow', updatedInput: {} })) as never, { requestId: 'wt-proof' } as never)
    let wtMeta = await readAgentMetadata(asAgentId(wtId))
    const wtDeadline = Date.now() + vshotBudgetMs(2_000)
    while (Date.now() < wtDeadline && wtMeta?.model !== 'claude-opus-4-7') {
      await new Promise(resolve => setTimeout(resolve, 10))
      wtMeta = await readAgentMetadata(asAgentId(wtId))
    }
    killAsyncAgent(wtId, setState as never)
    check('resumed crewmate on an unlisted valid model id keeps its recorded worktree and updates model and effort', wtResumed.data.success && wtMeta?.worktreePath === wtDir && wtMeta?.model === 'claude-opus-4-7' && wtMeta?.effortOverride === 'high', JSON.stringify({ res: wtResumed.data, meta: wtMeta }))
  }
  check('the parent process closes cleanly', await lead.end() === 0)
  const { ResumeAgentTool } = await import('../../src/tools/ResumeAgentTool/ResumeAgentTool.ts')
  let changed = 0
  const runningContext = { getAppState: () => ({ tasks: { busy: { id: 'busy', agentId: 'busy', type: 'local_agent', status: 'running', description: 'busy fixture' } }, agentNameRegistry: new Map() }), setAppState: () => { changed++ }, messages: [], options: { engineModel: LEAD_MODEL } } as never
  const refused = await ResumeAgentTool.call({ to: 'busy', message: 'do not queue', model: switched, effort: 'max' }, runningContext, (async () => ({ behavior: 'allow' })) as never, {} as never)
  check('running-crewmate overrides refuse without queuing or starting twice', !refused.data.success && refused.data.message.includes('finished crewmate') && changed === 0)
  check('max is admitted by the optional schema', ResumeAgentTool.inputSchema.safeParse({ to: 'busy', message: 'next', effort: 'max' }).success)
  check('an unknown effort word is refused by the shared ladder', !ResumeAgentTool.inputSchema.safeParse({ to: 'busy', message: 'next', effort: 'not-an-effort' }).success)
} catch (error) {
  check('the resumed-engine journey completes', false, String(error))
} finally {
  await lead.terminate()
  await world.fixture.close()
  rmSync(world.dir, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} resume-engine-options: ${failures} failed`)
process.exit(failures ? 1 : 0)
