import { check, cleanup, finish, loadEval, makeContext, setup, within } from './lib.js'

const checkWithHint = (label: string, cond: boolean, detail: string, hint: string) => check(label, cond, cond ? detail : detail ? `${detail}. ${hint}` : hint)
const { work } = setup()
const { evalKernelManager } = await loadEval()
const { EvalTool } = await import('../../src/tools/eval/EvalTool.ts')
const { buildTool } = await import('../../src/tools/kit/tool.ts')
const { z } = await import('zod/v4')
const { setCwd } = await import('../../src/platform/shell/shellExec.ts')
const { createProgressTracker, updateProgressFromMessage, getProgressUpdate } = await import('../../src/engine/tasks/local-agent/crewmateTask.tsx')
const { countToolUses } = await import('../../src/tools/crewmate/crewmateLifecycle.ts')
const { createAssistantMessage } = await import('../../src/engine/messages/messages.ts')
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
const messages: import('../../src/engine/message-shapes/message.ts').Message[] = [parent]
const progress = (row: { toolUseID: string; data: unknown }) => {
  const message = { type: 'progress', toolUseID: row.toolUseID, parentToolUseID: 'eval-progress', data: row.data } as import('../../src/engine/message-shapes/message.ts').Message
  messages.push(message)
  updateProgressFromMessage(tracker, message)
  updateProgressFromMessage(tracker, message)
}
try {
  const running = EvalTool.call({ language: 'js', code: 'await tool.FixtureBridgeProgress({}); await tool.FixtureBridgeProgress({}); await tool.FixtureBridgeProgress({});', timeoutSeconds: 30 }, context, (async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input })) as never, parent, progress as never)
  await within('third bridge tool starts', 20_000, third)
  checkWithHint('the existing crew count advances before the cell finishes', getProgressUpdate(tracker).toolUseCount === 4, String(getProgressUpdate(tracker).toolUseCount), 'expected 4 (the Eval call plus three bridge calls); look at updateProgressFromMessage in src/engine/tasks/local-agent/crewmateTask.tsx, which must count nested bridge tool ids (evalNestedToolIds) while the cell is still running')
  await new Promise(resolve => setTimeout(resolve, 80))
  unblock()
  const result = await within('bridge cell finishes', 20_000, running)
  const text = String(EvalTool.mapToolResultToToolResultBlockParam(result.data, 'eval-progress').content)
  const metrics = (result.data as typeof result.data & { bridgeTools?: { calls: number; elapsedMs: number } }).bridgeTools
  checkWithHint('the cell succeeds', result.data.status === 'ok', text, 'the Eval cell failed, so read the cell output above and the call path in src/tools/eval/EvalTool.ts')
  checkWithHint('the result counts all three tools and their elapsed time', metrics?.calls === 3 && metrics.elapsedMs >= 80 && /Bridge tools: 3 calls/.test(text), text, 'expected bridgeTools.calls 3 with elapsedMs of at least 80 and a Bridge tools line; look at the bridgeTools field built in call() and its text line in src/tools/eval/EvalTool.ts')
  checkWithHint('replayed progress does not double-count nested calls', getProgressUpdate(tracker).toolUseCount === 4, '', 'each progress row is fed twice; the seen-id set (bridgeToolUseIds) in updateProgressFromMessage in src/engine/tasks/local-agent/crewmateTask.tsx must count a nested tool id once')
  checkWithHint('settled total keeps the nested calls', countToolUses(messages) === 4, String(countToolUses(messages)), 'expected 4; countToolUses in src/tools/crewmate/crewmateLifecycle.ts must add the distinct nested ids from evalNestedToolIds to the assistant tool_use blocks')
  const prompt = await EvalTool.prompt({ tools: [fixture, EvalTool] } as never)
  checkWithHint('the prompt explains summed bridge time and live counting', prompt.includes('parallel call durations are summed') && prompt.includes('existing tool-use total'), '', 'restore the phrases parallel call durations are summed and existing tool-use total in the Eval prompt in src/tools/eval/prompt.ts')
} finally {
  unblock()
  await evalKernelManager.disposeAll()
  cleanup()
}
finish('EVAL BRIDGE PROGRESS')
