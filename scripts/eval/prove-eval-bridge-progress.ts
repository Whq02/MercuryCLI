import { check, cleanup, finish, loadEval, makeContext, setup, within } from './lib.js'

const { work } = setup()
const { evalKernelManager } = await loadEval()
const { EvalTool } = await import('../../src/tools/EvalTool/EvalTool.ts')
const { buildTool } = await import('../../src/Tool.ts')
const { z } = await import('zod/v4')
const { setCwd } = await import('../../src/utils/Shell.ts')
const { createProgressTracker, updateProgressFromMessage, getProgressUpdate } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { countToolUses } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const { createAssistantMessage } = await import('../../src/utils/messages.ts')
setCwd(work)
let unblock = () => {}
const gate = new Promise<void>(resolve => { unblock = resolve })
let calls = 0
let reached = () => {}
const third = new Promise<void>(resolve => { reached = resolve })
const fixture = buildTool({
  name: 'FixtureBridgeProgress',
  inputSchema: z.object({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async description() { return 'fixture' },
  async prompt() { return 'fixture' },
  async call() { calls++; if (calls === 3) { reached(); await gate }; return { data: { text: 'done' } } },
  mapToolResultToToolResultBlockParam(output: { text: string }, tool_use_id: string) { return { type: 'tool_result', tool_use_id, content: output.text } },
} as never)
const context = await makeContext({ tools: [fixture, EvalTool] })
context.toolUseId = 'eval-progress'
const tracker = createProgressTracker()
const parent = createAssistantMessage({ content: [{ type: 'tool_use', id: 'eval-progress', name: 'Eval', input: {} }] as never })
updateProgressFromMessage(tracker, parent)
const messages: import('../../src/types/message.ts').Message[] = [parent]
const progress = (row: { toolUseID: string; data: unknown }) => {
  const message = { type: 'progress', toolUseID: row.toolUseID, parentToolUseID: 'eval-progress', data: row.data } as import('../../src/types/message.ts').Message
  messages.push(message)
  updateProgressFromMessage(tracker, message)
  updateProgressFromMessage(tracker, message)
}
try {
  const running = EvalTool.call({ language: 'js', code: 'await tool.FixtureBridgeProgress({}); await tool.FixtureBridgeProgress({}); await tool.FixtureBridgeProgress({});', timeoutSeconds: 30 }, context, (async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input })) as never, parent, progress as never)
  await within('third bridge tool starts', 20_000, third)
  check('the existing crew count advances before the cell finishes', getProgressUpdate(tracker).toolUseCount === 4, String(getProgressUpdate(tracker).toolUseCount))
  await new Promise(resolve => setTimeout(resolve, 80))
  unblock()
  const result = await within('bridge cell finishes', 20_000, running)
  const text = String(EvalTool.mapToolResultToToolResultBlockParam(result.data, 'eval-progress').content)
  const metrics = (result.data as typeof result.data & { bridgeTools?: { calls: number; elapsedMs: number } }).bridgeTools
  check('the cell succeeds', result.data.status === 'ok', text)
  check('the result counts all three tools and their elapsed time', metrics?.calls === 3 && metrics.elapsedMs >= 80 && /Bridge tools: 3 calls/.test(text), text)
  check('replayed progress does not double-count nested calls', getProgressUpdate(tracker).toolUseCount === 4)
  check('settled total keeps the nested calls', countToolUses(messages) === 4, String(countToolUses(messages)))
  const prompt = await EvalTool.prompt({ tools: [fixture, EvalTool] } as never)
  check('the prompt explains summed bridge time and live counting', prompt.includes('parallel call durations are summed') && prompt.includes('existing tool-use total'))
} finally {
  unblock()
  await evalKernelManager.disposeAll()
  cleanup()
}
finish('EVAL BRIDGE PROGRESS')
