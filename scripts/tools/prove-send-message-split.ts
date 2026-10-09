import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'send-message-split-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
await import('../../src/tasks.ts')
const { SendMessageTool } = await import('../../src/tools/SendMessageTool/SendMessageTool.ts')
const resumePath = join(import.meta.dir, '../../src/tools/ResumeAgentTool/ResumeAgentTool.ts')
const ResumeAgentTool = existsSync(resumePath) ? (await import(resumePath)).ResumeAgentTool as typeof SendMessageTool : undefined
const { getPrompt } = await import('../../src/tools/SendMessageTool/prompt.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { registerAsyncAgent, registerAgentName, killAsyncAgent } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { generateTaskId } = await import('../../src/Task.ts')
const { getAgentTranscriptPath, writeAgentMetadata } = await import('../../src/utils/sessionStorage/paths.ts')
const { asAgentId } = await import('../../src/types/ids.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')
const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
const { ordinalOf } = await import('../../src/fabric/ordinal.ts')
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
type AppState = import('../../src/state/AppStateStore.ts').AppState
type Output = { success: boolean; message: string }
let failures = 0
let checks = 0
const check = (label: string, yes: boolean, detail = '') => {
  checks++
  if (!yes) failures++
  console.log(`[${yes ? 'PASS' : 'FAIL'}] ${label}${!yes && detail ? ` — ${detail}` : ''}`)
}
let state = { ...getDefaultAppState(), toolPermissionContext: getEmptyToolPermissionContext() } as AppState
const setState = (update: (prev: AppState) => AppState) => { state = update(state) }
const context = (agentId?: string) => ({
  getAppState: () => state, setAppState: setState, setAppStateForTasks: setState,
  options: { tools: [], commands: [], mcpClients: [], engineModel: 'fixture-model' },
  messages: [], abortController: new AbortController(), readFileState: new Map(), agentId,
}) as never
const call = async (tool: typeof SendMessageTool, to: string, message = 'the unchanged message\nwith a second line', agentId?: string) => {
  const answer = await tool.call({ to, message }, context(agentId), undefined as never, { requestId: 'split-proof' } as never) as { data: Output }
  const mapped = tool.mapToolResultToToolResultBlockParam(answer.data, 'split-call')
  check(`${tool.name} maps words alone and flags only a refusal`, Array.isArray(mapped.content) && mapped.content.length === 1 && (mapped.content[0] as { text?: string }).text === answer.data.message && mapped.is_error === (answer.data.success ? undefined : true), JSON.stringify(mapped))
  return answer.data
}
const launch = (name: string) => {
  const id = generateTaskId('local_agent')
  registerAsyncAgent({ agentId: id, description: name, prompt: 'work', setAppState: setState as never })
  registerAgentName(name, id, setState as never)
  return id
}
const pending = (id: string) => (state.tasks[id] as unknown as { pendingMessages: string[] }).pendingMessages
const mark = (id: string, status: string, error?: string) => {
  state = { ...state, tasks: { ...state.tasks, [id]: { ...state.tasks[id], status, ...(error ? { error } : {}) } as never } }
}
let ordinal = 0
const seed = (id: string) => {
  const path = getAgentTranscriptPath(asAgentId(id))
  mkdirSync(dirname(path), { recursive: true })
  const sessionId = String(getSessionId())
  const first = crypto.randomUUID()
  const entries = [
    { type: 'user', uuid: first, parentUuid: null, message: { role: 'user', content: 'work' } },
    { type: 'assistant', uuid: crypto.randomUUID(), parentUuid: first, message: { id: 'msg_split', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } } },
  ]
  writeFileSync(path, entries.map(entry => JSON.stringify(entryToRecord({ ...entry, isSidechain: true, agentId: id, sessionId, timestamp: new Date().toISOString() } as never, { sessionId, nextOrdinal: () => ordinalOf(++ordinal), observedAt: new Date().toISOString(), source: { channel: 'interactive' } } as never))).join('\n') + '\n')
}
const evict = (id: string) => {
  const tasks = { ...state.tasks }
  delete tasks[id]
  state = { ...state, tasks, agentNameRegistry: new Map([...state.agentNameRegistry].filter(([, value]) => String(value) !== id)) }
}
const stop = (id: string) => killAsyncAgent(id, setState as never)
const guard = setTimeout(() => { console.log('[FAIL] split proof exceeded 120 seconds'); process.exit(1) }, 120_000)
guard.unref()

check('ResumeAgent exists as a separate verb', ResumeAgentTool !== undefined)
const id = launch('researcher')
const delivered = await call(SendMessageTool, 'researcher')
const delivery = `Delivered to researcher (id ${id}); it reads it at its next tool boundary.`
check('running delivery has one canonical spelling', delivered.success && delivered.message === delivery, delivered.message)
check('the running road queues the unchanged receiver notice', pending(id).length === 1 && pending(id)[0]!.includes('<status>message</status>') && pending(id)[0]!.includes('<message>the unchanged message\nwith a second line</message>'))
check('the id prints the known name too', (await call(SendMessageTool, id)).message === delivery)
for (const tool of [SendMessageTool, ResumeAgentTool].filter(Boolean) as typeof SendMessageTool[]) {
  for (const to of [id, 'researcher']) check(`${tool.name} refuses self by ${to === id ? 'id' : 'name'}`, !(await call(tool, to, 'self', id)).success)
  for (const [input, words] of [
    [{ to: ' ', message: 'x' }, 'Recipient ("to") must not be empty.'],
    [{ to: 'researcher', message: ' \n ' }, 'The message must not be empty.'],
  ] as const) {
    const verdict = await tool.validateInput!(input, context())
    check(`${tool.name} validates blank fields`, verdict.result === false && verdict.message === words && verdict.errorCode === 9, JSON.stringify(verdict))
  }
  const socket = await tool.validateInput!({ to: 'uds:', message: 'x' }, context())
  check(`${tool.name} treats a socket spelling as an ordinary unknown name`, socket.result === true && !(await call(tool, 'uds:')).success)
  check(`${tool.name} refuses unknown with the session names`, !(await call(tool, 'nobody-here')).success)
}
check('main cannot deliver to itself', !(await call(SendMessageTool, 'MAIN')).success)
const sender = launch('sender')
check('a crewmate delivers to main with the exact timing words', (await call(SendMessageTool, 'MAIN', 'hello', sender)).message === 'Delivered to the main agent; it reads it at its next tool boundary, or between turns starts a turn for it.')
if (ResumeAgentTool) {
  check('main is never resumed', !(await call(ResumeAgentTool, 'main', 'hello', sender)).success)
  const before = pending(id).length
  const running = await call(ResumeAgentTool, 'researcher')
  check('a running receiver is delivered to, never registered twice', running.message === `Agent researcher (id ${id}) is still running, so nothing was resumed: the message was delivered and it reads it at its next tool boundary.` && pending(id).length === before + 1)
}
seed(id)
mark(id, 'completed')
const finished = await call(SendMessageTool, 'researcher')
check('SendMessage to a completed task refuses without starting work', !finished.success && finished.message === `Not delivered: researcher (id ${id}) has completed, so no turn of it is running to read a message. To give it this message as a new turn, call ResumeAgent with the same to and message.` && state.tasks[id]?.status === 'completed', finished.message)
if (state.tasks[id]?.status === 'running') stop(id)
await writeAgentMetadata(asAgentId(id), { agentType: 'mercury-crew', name: 'architect', description: 'architect', launchedAt: Date.now() })
evict(id)
const disk = await call(SendMessageTool, 'architect')
check('an evicted id-shaped name resolves and delivery never resumes it', !disk.success && disk.message.includes(`architect (id ${id}) has completed`) && state.tasks[id] === undefined, disk.message)
if (ResumeAgentTool) {
  const resumed = await call(ResumeAgentTool, 'architect')
  check('the id-shaped name resumes the sidecar id from disk', resumed.success && resumed.message.startsWith(`Agent architect (id ${id}) had completed; it was resumed in the background with your message, and its completion notice will come to you. Output file: `) && state.tasks[id]?.status === 'running', resumed.message)
  stop(id)
  seed(id)
  registerAgentName('researcher', id, setState as never)
  mark(id, 'failed', 'fixture failed')
  const childResume = await call(ResumeAgentTool, 'researcher', 'retry', sender)
  check('failed crewmate resumes, and a crewmate sender is told where the completion goes', childResume.success && childResume.message.includes('had failed (fixture failed)') && childResume.message.includes('Its completion notice goes to the main agent, not to you.') && state.tasks[id]?.status === 'running', childResume.message)
  stop(id)
}
const missing = launch('missing-record')
mark(missing, 'completed')
evict(missing)
await writeAgentMetadata(asAgentId(missing), { name: 'missing-record', description: 'missing', launchedAt: Date.now() })
for (const tool of [SendMessageTool, ResumeAgentTool].filter(Boolean) as typeof SendMessageTool[]) {
  const absent = await call(tool, 'missing-record')
  check(`${tool.name} names a missing transcript`, !absent.success && absent.message.includes('no transcript on disk'), absent.message)
}
const { registerWorkflowTask } = await import('../../src/tasks/LocalWorkflowTask/LocalWorkflowTask.tsx')
const worker = generateTaskId('local_agent')
registerWorkflowTask({ taskId: 'split-workflow', script: 'fixture', workflowName: 'fixture-flow', workflowRunId: 'split-run', setAppState: setState as never })
state = { ...state, tasks: { ...state.tasks, 'split-workflow': { ...state.tasks['split-workflow'], agentControllers: new Map([[worker, new AbortController()]]) } as never } }
for (const tool of [SendMessageTool, ResumeAgentTool].filter(Boolean) as typeof SendMessageTool[]) {
  const refusal = await call(tool, worker)
  check(`${tool.name} refuses a live workflow worker with no folder before any transcript exists`, !refusal.success && refusal.message.includes('workflow owns its run') && refusal.message.endsWith('or resume it with ResumeAgent once the workflow has finished.'), refusal.message)
}
for (const status of ['failed', 'killed']) {
  const finishedId = launch(`ended-${status}`)
  mark(finishedId, status, status === 'failed' ? 'failure reason' : undefined)
  const answer = await call(SendMessageTool, `ended-${status}`)
  check(`SendMessage never resumes a ${status} task`, !answer.success && answer.message.includes(status === 'failed' ? 'has failed (failure reason)' : 'has stopped') && state.tasks[finishedId]?.status === status)
  if (ResumeAgentTool) {
    const failedResume = await call(ResumeAgentTool, `ended-${status}`)
    check('a resume exception is an error with a next step', !failedResume.success && failedResume.message.includes(`No transcript found for agent ${finishedId}`) && failedResume.message.endsWith('Launch a new crewmate with Agent if the work is still wanted.'), failedResume.message)
  }
}
const expectedSend = `Deliver a message to a running crewmate of this session. It never starts work: a crewmate that has finished is refused, and ResumeAgent gives it the message as a new turn.

Example: { "to": "researcher", "message": "The auth notes moved to docs/auth-v2.md; read that one." }

## Addressing
- to: the id a crewmate's launch receipt names, or the name its launch gave it — both reach the same agent (a name two launches carried reaches the newest).
- A background crewmate reaches the agent that launched it at "main".

## How communication works
- Plain output reaches no crewmate — words travel only through this tool and ResumeAgent.
- A running crewmate reads the message at its next tool boundary, else at the end of its turn. The main agent reads it the same way; between turns it starts a turn for it.
- Content relayed to you is already rendered to the user — do not re-quote it back.`
check('SendMessage prompt equals the new contract without TaskUpdate', getPrompt(new Set()) === expectedSend)
check('TaskUpdate line remains conditional', getPrompt(new Set(['TaskUpdate'])) === expectedSend + '\n- Structured status updates belong in TaskUpdate, not in a SendMessage message.')
const expectedSchemas = [
  { type: 'object', properties: { to: { type: 'string', description: 'The crewmate to send to: the id its launch receipt names or the name its launch gave it; "main" from a background crewmate reaches the agent that launched it' }, message: { type: 'string', description: 'The message' } }, required: ['to', 'message'] },
  { type: 'object', properties: { to: { type: 'string', description: 'The crewmate to resume: the id its launch receipt names or the name its launch gave it' }, message: { type: 'string', description: 'Its next turn: what to do, written as you would brief it' } }, required: ['to', 'message'] },
]
for (const [index, tool] of [SendMessageTool, ResumeAgentTool].entries()) {
  if (!tool) continue
  const schema = zodToJsonSchema(tool.inputSchema as never) as Record<string, unknown>
  delete schema.$schema
  check(`${tool.name} schema is byte-identical to the contract`, JSON.stringify(schema) === JSON.stringify(expectedSchemas[index]), JSON.stringify(schema))
  const description = await tool.prompt({ tools: [] } as never)
  const bytes = Buffer.byteLength(JSON.stringify({ name: tool.name, description, input_schema: schema, eager_input_streaming: true, defer_loading: true }))
  console.log(`${tool.name} definition bytes=${bytes}`)
  check(`${tool.name} definition has the specified byte budget`, bytes === [1337, 1378][index])
  check(`${tool.name} is deferred with a search hint`, tool.shouldDefer === true && Boolean(tool.searchHint))
}
for (const task of Object.values(state.tasks)) if (task.type === 'local_agent') stop(task.id)
clearTimeout(guard)
console.log(`send-message-split: ${checks} checks, ${failures} failed`)
rmSync(home, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
