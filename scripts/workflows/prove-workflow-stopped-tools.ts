#!/usr/bin/env bun
import { DIST, makeTally } from '../daemon/dupline-world.ts'
import { workflowStopWorld } from './workflow-stop-world.ts'

const tally = makeTally('prove-workflow-stopped-tools')
console.log(`build under proof: ${DIST}`)
const world = await workflowStopWorld()
const calls = new Set<string>()
const results = new Set<string>()
let observedCallRows = 0
for (const transcript of world.transcripts) for (const record of transcript.records) {
  const payload = record.payload ?? {}
  if (payload.kind === 'output' && Array.isArray(payload.content)) for (const block of payload.content) {
    if (block.kind === 'tool-use' && typeof block.callId === 'string') { calls.add(block.callId); observedCallRows++ }
  }
  if (payload.kind === 'tool-settlement') results.add(payload.callId)
  if (payload.kind === 'input' && Array.isArray(payload.content)) for (const block of payload.content) if (block.kind === 'tool-result') results.add(block.callId)
}
const detail = JSON.stringify({ returned: world.returned.length, calls: calls.size, results: results.size, observedCallRows, live: world.live?.totalToolCalls, terminal: world.terminal?.totalToolCalls, notification: /<tool_uses>(\d+)<\/tool_uses>/.exec(world.notification)?.[1] })
console.log(detail)
tally.check('four real tool calls returned, including a failure', world.returned.length === 4 && world.returned.some(result => result.isError), detail)
tally.check('the execution records retain every unique call and result', calls.size === 4 && results.size === 4 && world.returned.every(result => calls.has(result.toolUseId) && results.has(result.toolUseId)), detail)
tally.check('the worker stops while awaiting its next provider response', world.turn.exitCode === 0 && world.live?.agents?.some((a: any) => a.waiting === 'prefill') && world.terminal?.status === 'killed', world.turn.stderr.slice(-500))
tally.check('live accounting equals the unique execution count', world.live?.totalToolCalls === calls.size && calls.size > 0, detail)
tally.check('the settled record retains the live tool count', world.terminal?.totalToolCalls === calls.size && world.terminal?.agents?.reduce((sum: number, a: any) => sum + (a.toolCalls ?? 0), 0) === calls.size, detail)
tally.check('the stop notification reports the same count', Number(/<tool_uses>(\d+)<\/tool_uses>/.exec(world.notification)?.[1]) === calls.size && calls.size > 0, detail)
const { makeWorkflowHooks } = await import('../../src/tools/WorkflowTool/agentHooks.js')
const frames: any[] = []
const hooks = makeWorkflowHooks({
  toolUseContext: {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {} }, mcp: { tools: [] } }),
    options: { agentDefinitions: { activeAgents: [] } },
  },
  canUseTool: async () => ({ behavior: 'allow' }),
  emitProgress: (frame: any) => { if (frame.data?.type === 'workflow_agent') frames.push(frame.data) },
  seedPhaseTitles: [],
  spawnSubagentStream: async function* (args: any) {
    const a = { type: 'tool_use', id: 'call-a', name: 'Read', input: {} }
    const b = { type: 'tool_use', id: 'call-b', name: 'Read', input: {} }
    const message = (content: any[]) => ({ type: 'assistant', message: { id: 'response-tools', content, stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } } })
    yield message([a])
    yield message([a, b])
    yield message([a, b])
    args.onQueryProgress?.({ type: 'request_wait', wait: { kind: 'first-byte', budgetMs: 60_000, sinceMs: Date.now() } })
    yield { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: a.id, content: 'ok' }, { type: 'tool_result', tool_use_id: b.id, content: 'failed', is_error: true }] } }
    yield { type: 'assistant', message: { id: 'response-final', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 5 } } }
  },
} as never) as { agent: (prompt: string) => Promise<unknown> }
await hooks.agent('tool-call-identity')
tally.check('updated assistant rows count each call id once', frames.filter(frame => frame.lastToolName === 'Read').every(frame => frame.toolCalls >= 1 && frame.toolCalls <= 2) && frames.at(-1)?.toolCalls === 2, JSON.stringify(frames.map(frame => ({ state: frame.state, calls: frame.toolCalls, waiting: frame.waiting }))))
tally.check('wait frames keep both successful and failed calls', frames.some(frame => frame.waiting === 'prefill' && frame.toolCalls === 2))
tally.finish()
