#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'send-plain-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_BARE = '1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
process.env.BROWSER = '/usr/bin/true'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the plain-string SendMessage proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { SendMessageTool } = await import('../../src/tools/SendMessageTool/SendMessageTool.ts')
const { DESCRIPTION, getPrompt } = await import('../../src/tools/SendMessageTool/prompt.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { registerAsyncAgent, registerAgentName } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { generateTaskId } = await import('../../src/Task.ts')
await import('../../src/tasks.ts')
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
type AppState = import('../../src/state/AppStateStore.ts').AppState

type Verdict = { result: boolean; message?: string; errorCode?: number }
type Answer = { data: { success: boolean; message: string } }
const validate = (input: Record<string, unknown>): Promise<Verdict> => (SendMessageTool as { validateInput: (i: unknown) => Promise<Verdict> }).validateInput(input)
let state: AppState = { ...getDefaultAppState(), toolPermissionContext: getEmptyToolPermissionContext() } as AppState
const setState = (u: (prev: AppState) => AppState): void => {
  state = u(state)
}
const makeContext = (agentId?: string): unknown => ({
  options: { tools: [], commands: [], mcpClients: [], engineModel: 'fixture-model' },
  abortController: new AbortController(),
  readFileState: new Map(),
  messages: [],
  getAppState: () => state,
  setAppState: setState,
  setAppStateForTasks: setState,
  agentId,
})
const call = (input: Record<string, unknown>, ctx: unknown, requestId: string): Promise<Answer> =>
  (SendMessageTool as unknown as { call: (i: unknown, c: unknown, u: unknown, m: unknown) => Promise<Answer> }).call(input, ctx, undefined, { requestId })
const THREE_LINES = 'first line of the message\nsecond line with more detail\nthird line'

section('§1 VALIDATION — a plain string is the whole message; no summary is asked for')
{
  const bare = await validate({ to: 'researcher', message: THREE_LINES })
  check('a plain string message validates', bare.result === true, `${bare.message ?? ''} (errorCode ${bare.errorCode ?? '-'})`)
  const empty = await validate({ to: '  ', message: THREE_LINES })
  check('the recipient law stands: an empty "to" refuses', empty.result === false && /must not be empty/.test(empty.message ?? ''), empty.message ?? '')
  const schema = JSON.stringify(zodToJsonSchema(SendMessageTool.inputSchema as never))
  check('the schema the model sees has to and message, and no summary field', schema.includes('"to"') && schema.includes('"message"') && !schema.includes('summary'), schema)
}

section('§2 DELIVERY — a plain string to a running crewmate of this session is queued for its next tool boundary')
{
  const id = generateTaskId('local_agent')
  registerAsyncAgent({ agentId: id, description: 'the researcher', prompt: 'map the auth flow', setAppState: setState as never })
  registerAgentName('researcher', id, setState as never)
  const byName = await call({ to: 'researcher', message: THREE_LINES }, makeContext(), 'req_name')
  check('the message to the name is delivered', byName.data.success === true && /^Delivered to researcher \(id /.test(byName.data.message), byName.data.message)
  const task = state.tasks[id] as { pendingMessages?: unknown[] } | undefined
  check('the message waits on the running task for its next tool boundary', Array.isArray(task?.pendingMessages) && task.pendingMessages.length === 1, JSON.stringify(task?.pendingMessages).slice(0, 200))
  const byId = await call({ to: id, message: 'a second line' }, makeContext(), 'req_id')
  check('the id reaches the same agent', byId.data.success === true && byId.data.message.includes(id), byId.data.message)
  const self = await call({ to: 'researcher', message: 'to myself' }, makeContext(id), 'req_self')
  check('a crewmate addressing its own name is refused as its own address', self.data.success === false && /own address/.test(self.data.message), self.data.message)
  const selfById = await call({ to: id, message: 'to myself' }, makeContext(id), 'req_self_id')
  check('…and its own id the same', selfById.data.success === false && /own address/.test(selfById.data.message), selfById.data.message)
  const unknown = await call({ to: 'nobody-here', message: 'hello' }, makeContext(), 'req_unknown')
  check('an unknown name is refused naming the agents this session has', unknown.data.success === false && /no agent named nobody-here/.test(unknown.data.message) && unknown.data.message.includes('researcher'), unknown.data.message)
  const toMain = await call({ to: 'main', message: 'done' }, makeContext(), 'req_main')
  check('"main" from the main agent itself is refused with the reason', toMain.data.success === false && /only a background crewmate reaches its main agent/.test(toMain.data.message), toMain.data.message)
}

section('§3 THE WORDS — the description and the prompt say a plain message, by id or name, and name no summary')
{
  check('the description names a crewmate by id or name', /crewmate/.test(DESCRIPTION) && /id or name/.test(DESCRIPTION), DESCRIPTION)
  const prompt = getPrompt()
  check('the prompt example is to + message alone', /"to": "researcher", "message":/.test(prompt) && !/summary/.test(prompt), prompt.split('\n').find(line => line.startsWith('Example')) ?? '')
  const { getPrompt: resumePrompt } = await import('../../src/tools/ResumeAgentTool/prompt.ts')
  check('the prompts separate delivery timing from an ended crewmate resume', /next tool boundary/.test(prompt) && /It never starts work/.test(prompt) && /resumed from its transcript/.test(resumePrompt()))
}

console.log(`\nprove-send-message-plain-string: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
