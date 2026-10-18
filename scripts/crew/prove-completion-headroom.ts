#!/usr/bin/env bun
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = resolve(process.argv[2] ?? join(import.meta.dir, '../..'))
const home = mkdtempSync(join(tmpdir(), 'completion-headroom-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.BROWSER = '/usr/bin/true'
for (const name of ['MERCURY_HOME', 'MERCURY_MODEL', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_BARE', 'NODE_ENV']) delete process.env[name]
const load = (file: string): Promise<any> => import(join(root, file))
const { enableConfigs } = await load('src/utils/config/globalConfig.ts')
enableConfigs()
const { createAssistantMessage, createUserMessage } = await load('src/utils/messages.ts')
const tasks = await load('src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const queue = await load('src/utils/messageQueueManager.ts')
const { getQueuedCommandAttachments } = await load('src/utils/attachments/queuedCommands.ts')
const { getAgentTranscriptPath } = await load('src/utils/sessionStorage/paths.ts')
const { getSessionId } = await load('src/bootstrap/state.ts')
const { encodeSeedTranscript } = await load('scripts/lib/seedTranscript.ts')
const { agentAdapter } = await load('src/services/resources/adapters/agent.ts')
const { parseMercuryRef: parseRef } = await load('src/services/resources/contracts.ts')
const { getDefaultAppState } = await load('src/state/AppStateStore.ts')
const { runTools } = await load('src/services/tools/toolOrchestration.ts')
const { buildRequestContextPlan } = await load('src/services/run/requestContextPlan.ts')
const { processMainOwner } = await load('src/services/run/resolveOwner.ts')
const { AgentTool } = await load('src/tools/AgentTool/AgentTool.tsx')
const { createFileStateCacheWithSizeLimit } = await load('src/utils/fileStateCache.ts')
const { createContentReplacementState } = await load('src/utils/toolResultStorage.ts')
const { z } = await import('zod')
const MODEL = 'claude-fable-5-1'
let failures = 0
function check(label: string, yes: boolean, detail = ''): void {
  if (!yes) failures++
  console.log(`[${yes ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const report = (id: string): string => `${id} first\n${'report line\n'.repeat(300)}${id} last`
const parent = (used: number): any => {
  const message = createAssistantMessage({ content: [{ type: 'text', text: 'Waiting for the reports.' }] })
  message.message.model = MODEL
  message.message.usage = { input_tokens: used, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  return message
}
let app = getDefaultAppState()
const setAppState = (update: any): void => { app = update(app) }
function notice(id: string, text: string): any {
  tasks.registerAsyncAgent({ agentId: id, description: id, prompt: 'fixture', setAppState })
  const answer = createAssistantMessage({ content: [{ type: 'text', text }] })
  const path = getAgentTranscriptPath(id)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, encodeSeedTranscript([answer], getSessionId()))
  tasks.completeAgentTask({ agentId: id }, setAppState)
  tasks.enqueueAgentNotification({ taskId: id, description: id, status: 'completed', finalMessage: text, setAppState })
  return queue.dequeue()
}
const inline = (value: string): string => /<result>([\s\S]*)<\/result>/.exec(value)?.[1] ?? ''
try {
  console.log('\ncompletion batch')
  const commands = Array.from({ length: 8 }, (_, i) => notice(`report-${i}`, report(`report-${i}`)))
  const original = JSON.stringify(commands)
  const rows = await getQueuedCommandAttachments(commands, { messages: [parent(990_000)], model: MODEL })
  check('eight reports share half the remaining 40,000 characters', rows.length === 8 && rows.every((row: any) => inline(row.prompt).length <= 2_500), rows.map((row: any) => inline(row.prompt).length).join(','))
  check('delivery leaves the queued commands unchanged', JSON.stringify(commands) === original)
  for (let i = 0; i < rows.length; i++) {
    const id = `report-${i}`
    const ref = `mercury://agent/${id}?child=report`
    check(`${id} cut names its durable report`, inline(rows[i].prompt).includes(ref))
    const parsed = parseRef(ref)
    const answer = await agentAdapter.resolve(parsed, { getAppState: () => app })
    check(`${id} report ref reads every report byte`, answer.state === 'ok' && answer.resource.text === report(id), answer.state)
  }
  console.log('\nforeground completion batch')
  const fake = { name: AgentTool.name, inputSchema: z.object({ id: z.string() }), isReadOnly: () => true, isConcurrencySafe: () => true, maxResultSizeChars: AgentTool.maxResultSizeChars, call: async (input: { id: string }) => ({ data: { status: 'completed', agentId: input.id, content: [{ type: 'text', text: report(input.id) }] } }), mapToolResultToToolResultBlockParam: AgentTool.mapToolResultToToolResultBlockParam }
  const calls = Array.from({ length: 8 }, (_, i) => ({ type: 'tool_use', id: `call-${i}`, name: fake.name, input: { id: `report-${i}` } }))
  const assistant = parent(990_000)
  assistant.message.content = calls
  const context = { options: { engineModel: MODEL, tools: [fake], commands: [], mcpClients: [], mcpResources: {}, agentDefinitions: { activeAgents: [], allAgents: [] }, isNonInteractiveSession: true }, abortController: new AbortController(), messages: [], readFileState: createFileStateCacheWithSizeLimit(100), contentReplacementState: createContentReplacementState(), getAppState: () => app, setAppState, setResponseLength: () => {}, setInProgressToolUseIDs: () => {} }
  const emitted: any[] = []
  for await (const update of runTools(calls, [assistant], async (_tool: any, input: any) => ({ behavior: 'allow', updatedInput: input }), context)) {
    if (update.message?.type === 'user') emitted.push(update.message)
  }
  const plan = await buildRequestContextPlan({ messages: [assistant, ...emitted], owner: processMainOwner(), querySource: 'sdk', contentReplacementState: context.contentReplacementState, engineModel: MODEL, skipToolNames: new Set(), preserveBodies: true }, 'apply')
  const results = plan.messages.filter((m: any) => m.type === 'user').flatMap((m: any) => m.message.content.filter((b: any) => b.type === 'tool_result'))
  const words = (b: any): string => typeof b.content === 'string' ? b.content : b.content.map((t: any) => t.text ?? '').join('\n')
  check('foreground reports share the same headroom per delivery', results.length === 8 && results.every(b => words(b).length <= 2_500), results.map(b => words(b).length).join(','))
  check('every cut foreground report names its report ref', results.every(b => words(b).includes(`mercury://agent/report-${b.tool_use_id.slice(-1)}?child=report`)))

  const replay = await buildRequestContextPlan({ messages: [parent(999_999), assistant, ...emitted], owner: processMainOwner(), querySource: 'sdk', contentReplacementState: context.contentReplacementState, engineModel: MODEL, skipToolNames: new Set(), preserveBodies: true }, 'apply')
  const replayResults = replay.messages.filter((m: any) => m.type === 'user').flatMap((m: any) => m.message.content.filter((b: any) => b.type === 'tool_result'))
  check('completion replacements replay byte for byte without another cut', JSON.stringify(replayResults) === JSON.stringify(results))
  for (let i = 0; i < results.length; i++) {
    const path = /full tool result: ([^\]]+)/.exec(words(results[i]))?.[1]
    const originalBlock = emitted.flatMap(m => m.message.content).find((b: any) => b.tool_use_id === results[i].tool_use_id)
    check('a foreground cut preserves its complete original block on disk', path !== undefined && JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) === JSON.stringify(originalBlock.content))
  }
  const mixed = await buildRequestContextPlan({ messages: [assistant, ...emitted.slice(0, 2)], owner: processMainOwner(), querySource: 'sdk', contentReplacementState: createContentReplacementState(), engineModel: MODEL, skipToolNames: new Set(), preserveBodies: true }, 'apply')
  check('two completed reports share as two, not as eight planned calls', JSON.stringify(mixed.messages) === JSON.stringify([assistant, ...emitted.slice(0, 2)]))
  const { heldAgentNotices } = await load('src/tasks/LocalAgentTask/launchReceipts.ts')
  const recorded = encodeSeedTranscript(commands.map((command: any) => ({ type: 'queue-operation', operation: 'enqueue', content: command.value, mode: command.mode, agentCompletion: command.agentCompletion })), getSessionId())
  const held = heldAgentNotices(recorded.split('\n'), new Set(commands.map((_: any, i: number) => 'report-' + i)))
  const carried = await getQueuedCommandAttachments([...held.values()].map((notice: any) => ({ value: notice.value, mode: 'task-notification', agentCompletion: notice.agentCompletion })), { messages: [parent(990_000)], model: MODEL })
  check('completion delivery metadata survives the queue record and restart reader', carried.length === 8 && carried.every((row: any) => inline(row.prompt).length <= 2_500))

  console.log('\nrefusals')
  const ample = await getQueuedCommandAttachments([commands[0]], { messages: [parent(100_000)], model: MODEL })
  check('one completion with ample headroom is byte-identical', ample[0].prompt === commands[0].value)
  const small = notice('short-report', 'unchanged short report')
  const under = await getQueuedCommandAttachments([small], { messages: [parent(999_999)], model: MODEL })
  check('a short report stays byte-identical even at the floor', under[0].prompt === small.value)
  const floor = await getQueuedCommandAttachments(commands, { messages: [parent(1_100_000)], model: MODEL })
  check('exhausted headroom still grants a 2,000-character share', floor.every((row: any) => inline(row.prompt).length > 1_800 && inline(row.prompt).length <= 2_000))
  for (const bad of [null, {}, { agentId: '../outside', start: 0, end: 999999 }, { agentId: '/outside', start: 0, end: 1 }, { agentId: 'C:\\outside', start: 0, end: 1 }, { agentId: 'name;quote\"', start: 0, end: 1 }, { ...commands[0].agentCompletion, start: -1 }, { ...commands[0].agentCompletion, end: Infinity }]) {
    const broken = { ...commands[0], agentCompletion: bad }
    const result = await getQueuedCommandAttachments([broken], { messages: [parent(999_999)], model: MODEL })
    check('malformed completion identity or span is not used to cut or open a path', result[0].prompt === broken.value, JSON.stringify(bad))
  }
  const operator = { ...commands[0], mode: 'prompt' }
  const keep = await getQueuedCommandAttachments([operator], { messages: [parent(1_100_000)], model: MODEL })
  check('operator text resembling a notice is never cut', keep[0].prompt === operator.value)
  const message = { value: tasks.agentMessageNotice({ taskId: 'report-0', summary: 'a note', text: report('note') }), mode: 'task-notification' }
  const notes = await getQueuedCommandAttachments([message], { messages: [parent(1_100_000)], model: MODEL })
  check('SendMessage text is not a completion summary', notes[0].prompt === message.value)
  const unknown = await getQueuedCommandAttachments(commands, { messages: [], model: 'local/not-listed' })
  check('an unknown parent window keeps the old delivery', unknown.every((row: any, i: number) => row.prompt === commands[i].value))
  check('the full report still stands after every delivery', readFileSync(getAgentTranscriptPath('report-0'), 'utf8').includes(report('report-0').replaceAll('\n', '\\n')))
} finally {
  queue.resetCommandQueue()
  rmSync(home, { recursive: true, force: true })
}
console.log(`\n${failures ? 'FAIL' : 'PASS'} completion-headroom: ${failures} failed`)
process.exit(failures ? 1 : 0)
