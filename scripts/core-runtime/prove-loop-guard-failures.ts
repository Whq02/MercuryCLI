#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mock } from 'bun:test'
import { z } from 'zod/v4'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
assert.ok(!process.env.MERCURY_HOME || process.env.MERCURY_HOME !== join(homedir(), '.mercury'), 'MERCURY_HOME must not be the real home')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'loop-failures-'))
const cwd = join(scratch, 'project')
mkdirSync(cwd)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const key of ['MERCURY_BARE', 'MERCURY_SCRIPTED_STREAM', 'NODE_ENV']) delete process.env[key]
globalThis.fetch = Object.assign(async () => { throw new Error('network is not part of this fixture') }, globalThis.fetch)

const watchdog = setTimeout(() => { console.error('Fixture exceeded 90 seconds'); process.exit(1) }, 90_000)
watchdog.unref?.()
const queryModule = await import('../../src/query.ts')
const realQuery = queryModule.query
let scriptedDeps: Record<string, unknown> = {}
mock.module('../../src/query.ts', () => ({
  ...queryModule,
  query: (params: Record<string, unknown>) => realQuery({ ...params, deps: { ...(params.deps as object), ...scriptedDeps } } as never),
}))
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(cwd)
bootstrap.setCwdState(cwd)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setPathTrusted } = await import('../../src/utils/config/trust.ts')
setPathTrusted(cwd)
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages/factories.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { refreshHooksSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.ts')
const { getSettingsFilePathForSource } = await import('../../src/utils/settings/settings.ts')
const { runAgent } = await import('../../src/tools/AgentTool/runAgent.ts')
const { finalizeAgentTool } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const { enqueueAgentNotification } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const queue = await import('../../src/input-core/command-queue.ts')
const { flushSessionStorage } = await import('../../src/utils/sessionStorage.ts')

type Message = import('../../src/types/message.ts').Message
type SystemMessage = import('../../src/types/message.ts').SystemMessage
type AppState = import('../../src/state/AppStateStore.ts').AppState
type Step = { name: string; input: Record<string, unknown> }
type Mode = 'error' | 'permission' | 'hook' | 'changing' | 'success-between' | 'success'
const MODEL = 'claude-opus-4-8'
const ERROR = 'Fixture command failed.\nThe fixture has no such target.'
const DENIED = 'Permission refused by the fixture.'
const HOOK = 'Guard fixture refused this command.'
const INPUT = { command: 'fixture-check', description: 'Check the fixture' }
const AGAIN = 'change something before sending it again'
let mode: Mode = 'error'
let executions = 0
let sequence = 0
let failures = 0
let checks = 0
function check(name: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${!ok ? ' — ' + JSON.stringify(detail) : ''}`)
}
function setSettings(hook = false, loopGuard?: boolean): void {
  const path = getSettingsFilePathForSource('userSettings')!
  mkdirSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true })
  writeFileSync(path, JSON.stringify({
    ...(loopGuard === undefined ? {} : { turns: { loopGuard } }),
    ...(hook ? { events: { hooks: { 'tool.before': [{ name: 'fixture refusal', match: 'Bash', run: `echo '${HOOK}' >&2; exit 2` }] } } } : {}),
  }))
  resetSettingsCache()
  refreshHooksSnapshot()
}
function tool(name: string): never {
  return {
    name, description: async () => 'fixture only', prompt: async () => 'fixture only',
    inputSchema: z.object({}).catchall(z.unknown()), userFacingName: () => name,
    isEnabled: () => true, isConcurrencySafe: () => false, isReadOnly: () => true, isMcp: false,
    needsPermissions: () => false, validateInput: async () => ({ result: true }),
    call: async () => {
      const index = executions++
      return { data: { error: mode !== 'success' && !(mode === 'success-between' && index === 2), text: mode === 'changing' ? `${ERROR}\nAttempt ${index}` : ERROR } }
    },
    mapToolResultToToolResultBlockParam: (data: { error: boolean; text: string }, id: string) => ({ type: 'tool_result', tool_use_id: id, is_error: data.error, content: data.text }),
  } as never
}
const tools = [tool('Bash'), tool('Other'), tool('Sleep')]
const allow = async (_tool: unknown, input: unknown) => mode === 'permission'
  ? { behavior: 'deny', message: DENIED }
  : { behavior: 'allow', updatedInput: input }
function context(agentId?: string): never {
  let state = { ...getDefaultAppState(), effortValue: 'max' } as AppState
  const set = (update: (prev: AppState) => AppState): void => { state = update(state) }
  return {
    abortController: new AbortController(), agentId,
    options: { commands: [], tools, engineModel: MODEL, thinkingConfig: { type: 'enabled', budgetTokens: 4096 }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: false, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => state, setAppState: set, setAppStateForTasks: set, messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100), setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
  } as never
}
const repeats = (count: number, name = 'Bash'): Step[] => Array.from({ length: count }, (_, index) => ({ name, input: index % 2 ? { description: INPUT.description, command: INPUT.command } : INPUT }))
async function run(steps: Step[], options: { headless?: boolean; oculus?: boolean; agent?: boolean; mode?: Mode; loopGuard?: boolean } = {}) {
  bootstrap.setIsInteractive(!options.headless)
  bootstrap.setSessionKind(options.oculus ? 'oculus' : 'headless')
  queue.resetCommandQueue()
  mode = options.mode ?? 'error'
  executions = 0
  setSettings(mode === 'hook', options.loopGuard)
  const calls: unknown[][] = []
  scriptedDeps = {
    uuid: () => crypto.randomUUID(),
    async *callModel(request: { messages: unknown[] }) {
      const index = calls.length
      calls.push([...request.messages])
      const step = steps[index]
      const message = createAssistantMessage({ content: step ? [{ type: 'tool_use', id: `failure_${++sequence}`, name: step.name, input: step.input }] as never : 'done' })
      message.message.stop_reason = step ? 'tool_use' : 'end_turn'
      yield message
    },
    autocompact: async () => ({ wasCompacted: false }),
    microcompact: async (messages: unknown[]) => ({ messages }),
  }
  const prompt = [createUserMessage({ content: 'Run the fixture.' })]
  const agentId = `failure-agent-${++sequence}`
  const stream = options.agent ? runAgent({
    agentDefinition: { agentType: 'mercury-crew', whenToUse: 'fixture', source: 'projectSettings', getSystemPrompt: () => 'Run the fixture.' } as never,
    promptMessages: prompt, toolUseContext: context(), canUseTool: allow as never,
    isAsync: true, canShowPermissionPrompts: true, querySource: 'agent:custom:failure-fixture' as never,
    availableTools: tools, useExactTools: true, model: MODEL, override: { agentId }, description: 'failure fixture', cwd,
  }) : realQuery({
    messages: prompt, systemPrompt: ['fixture'] as never, userContext: {}, systemContext: {},
    canUseTool: allow as never, toolUseContext: context(), querySource: 'sdk', deps: scriptedDeps as never,
  })
  const yields: Message[] = []
  let next = await stream.next()
  while (!next.done) {
    yields.push(next.value as Message)
    next = await stream.next()
  }
  return { calls, yields, terminal: next.value, agentId, executions }
}
function notices(result: Awaited<ReturnType<typeof run>>): SystemMessage[] {
  return result.yields.filter((row): row is SystemMessage => row.type === 'system' && 'content' in row && row.content.includes(AGAIN))
}
function stopped(result: Awaited<ReturnType<typeof run>>) {
  return result.yields.find(row => row.type === 'attachment' && row.attachment.type === 'loop_stopped') as { attachment: { message: string; cycle: string[] } } | undefined
}
const same = await run(repeats(9))
check('foreground runs all nine failed calls and completes', same.calls.length === 10 && !stopped(same), same.terminal)
check('first identical failure repeat is reminded before request three, not before request two', JSON.stringify(same.calls[2]).includes(AGAIN) && !JSON.stringify(same.calls[1]).includes(AGAIN))
check('the reminder carries the complete tool error and arguments', notices(same).some(row => 'content' in row && row.content.includes(ERROR) && row.content.includes(INPUT.command)), notices(same))
const headless = await run(repeats(4), { headless: true })
check('headless stops on the third failure without requesting a fourth', headless.calls.length === 3 && (headless.terminal as { reason?: string })?.reason === 'loop_stopped', headless.terminal)
const cockpit = await run(repeats(9), { headless: true, oculus: true })
check('the daemon-hosted runner behind a screen (non-interactive process, oculus session) runs all nine failed calls and is never stopped', cockpit.calls.length === 10 && !stopped(cockpit) && notices(cockpit).length > 0, { calls: cockpit.calls.length, stop: stopped(cockpit) })
const cockpitCrew = await run(repeats(4), { headless: true, oculus: true, agent: true })
check('a crewmate of that same screen session still stops on three', cockpitCrew.calls.length === 3 && Boolean(stopped(cockpitCrew)), { calls: cockpitCrew.calls.length })
check('the stopped sentence carries the tool, count, arguments and complete error', Boolean(stopped(headless)?.attachment.message.includes(ERROR) && stopped(headless)?.attachment.message.includes('Bash') && stopped(headless)?.attachment.message.includes('3') && stopped(headless)?.attachment.message.includes(INPUT.command)), stopped(headless))
const crew = await run(repeats(4), { agent: true })
check('runAgent stops the crewmate on three even in an interactive process', crew.calls.length === 3 && Boolean(stopped(crew)), { calls: crew.calls.length, stop: stopped(crew) })
const final = finalizeAgentTool(crew.yields, crew.agentId, { prompt: 'fixture', resolvedAgentModel: MODEL, isBuiltInAgent: true, startTime: Date.now(), agentType: 'mercury-crew', isAsync: true })
const failure = final.outcome?.status === 'failed' ? final.outcome : undefined
check('crewmate finalization preserves the loop-stopped cause', failure?.reason === 'loop-stopped' && failure.error === stopped(crew)?.attachment.message, final.outcome)
const parent = AgentTool.mapToolResultToToolResultBlockParam({ ...final, status: 'failed', prompt: 'fixture', error: failure?.error } as never, 'parent-fixture')
check('the parent tool result is an error with the repeated call and cause', parent.is_error === true && JSON.stringify(parent.content).includes(INPUT.command) && JSON.stringify(parent.content).includes(ERROR.split('\n')[0]!), parent)

for (const kind of ['permission', 'hook'] as const) {
  const result = await run(repeats(4), { agent: true, mode: kind })
  const expected = kind === 'hook' ? HOOK : DENIED
  check(`${kind} refusals stop on three without executing the tool`, result.calls.length === 3 && result.executions === 0 && Boolean(stopped(result)), { calls: result.calls.length, executions: result.executions })
  check(`${kind} refusal text reaches the second-call reminder and the stop`, notices(result).some(row => 'content' in row && row.content.includes(expected)) && Boolean(stopped(result)?.attachment.message.includes(expected)))
}
const changed = await run(repeats(4).map((step, i) => ({ ...step, input: { ...step.input, command: i < 2 ? INPUT.command : INPUT.command + ' ' } })), { agent: true })
check('a one-byte argument difference resets the count', changed.calls.length === 5 && !stopped(changed))
const success = await run(repeats(5), { agent: true, mode: 'success-between' })
check('success between failures with byte-identical arguments resets the count', success.calls.length === 6 && !stopped(success))
const changedError = await run(repeats(4), { agent: true, mode: 'changing' })
check('changing error detail does not disguise the same failing call', changedError.calls.length === 3 && stopped(changedError)?.attachment.message.includes('Attempt 2') === true)
const other = await run([...repeats(2), ...repeats(1, 'Other'), ...repeats(2)], { agent: true })
check('a different tool resets consecutive failures', other.calls.length === 6 && !stopped(other))
const successful = await run(repeats(9), { agent: true, mode: 'success', loopGuard: true })
check('successful identical calls never trigger the failure stop, including with loopGuard enabled', successful.calls.length === 10 && !stopped(successful) && notices(successful).length === 0)
const foregroundKey = await run(repeats(9), { loopGuard: true })
check('loopGuard enabled does not stop foreground identical failures', foregroundKey.calls.length === 10 && !stopped(foregroundKey))
for (const name of ['Sleep', 'UnavailableFixture']) {
  const result = await run(repeats(4, name), { agent: true })
  check(`${name} failures are counted`, result.calls.length === 3 && stopped(result)?.attachment.cycle[0] === name)
}

setSettings()
queue.resetCommandQueue()
let appState = { ...getDefaultAppState(), tasks: { [crew.agentId]: { id: crew.agentId, type: 'local_agent', status: 'failed', notified: false, endTime: Date.now() } } } as unknown as AppState
enqueueAgentNotification({ taskId: crew.agentId, description: 'failure fixture', status: 'failed', error: failure?.error, setAppState: update => { appState = update(appState) } })
const completion = String(queue.getCommandQueue()[0]?.value ?? '')
check('the real completion notification carries the cause instead of silence', completion.includes(INPUT.command) && completion.includes(ERROR), completion)
queue.resetCommandQueue()

const frameArg = process.argv.indexOf('--frames')
if (frameArg >= 0) {
  const frames = process.argv[frameArg + 1]!
  mkdirSync(frames, { recursive: true })
  const React = (await import('react')).default
  const { renderToAnsiString } = await import('../../src/utils/staticRender.tsx')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { SystemTextMessage } = await import('../../src/components/messages/SystemTextMessage.tsx')
  const { UserTextMessage } = await import('../../src/components/messages/UserTextMessage.tsx')
  const { MessageMetaProvider } = await import('../../src/components/messages/TranscriptNameplate.tsx')
  const reminder = notices(same)[0]
  writeFileSync(join(frames, 'observed.json'), JSON.stringify({ reminder, completion }))
  for (const columns of [80, 120]) {
    for (const name of ['reminder', 'completion'] as const) {
      const body = name === 'reminder'
        ? reminder ? React.createElement(SystemTextMessage, { message: reminder, verbose: false }) : null
        : React.createElement(UserTextMessage, { addMargin: false, param: { type: 'text', text: completion }, verbose: true, notice: true })
      const node = React.createElement(AppStateProvider, { initialState: getDefaultAppState(), children: React.createElement(MessageMetaProvider, { message: { type: name === 'reminder' ? 'system' : 'user' }, children: body }) })
      const frame = await renderToAnsiString(node, columns)
      const plain = frame.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      writeFileSync(join(frames, `${name}-${columns}.ansi`), frame)
      writeFileSync(join(frames, `${name}-${columns}.txt`), plain)
      check(`${name} paints the cause at ${columns} columns`, plain.includes(ERROR.split('\n')[0]!) && plain.includes(INPUT.command), plain)
    }
  }
}
await flushSessionStorage()
rmSync(scratch, { recursive: true, force: true })
console.log(`LOOP-GUARD-FAILURES: ${checks - failures}/${checks} passed`)
process.exit(failures ? 1 : 0)
