#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'terminal-outcome-home-'))

await import('../../src/engine/tasks/tasks.js')
const {
  deriveAgentTerminalOutcome,
  finalizeAgentTool,
  runAsyncAgentLifecycle,
  PROMOTED_NARRATION_NOTE,
} = await import('../../src/tools/crewmate/crewmateLifecycle.js')
const { createAttachmentMessage } = await import('../../src/engine/attachments/turnAttachments.js')
const { AgentTool } = await import('../../src/tools/crewmate/CrewmateTool.js')
const { registerAsyncAgent } = await import('../../src/engine/tasks/local-agent/crewmateTask.js')
const { createAssistantMessage, createAssistantAPIErrorMessage } = await import(
  '../../src/engine/message-shapes/factories.js'
)
const { getCommandQueueSnapshot, resetCommandQueue } = await import(
  '../../src/daemon/runner/messageQueueManager.js'
)
const taskNotifications = () =>
  getCommandQueueSnapshot().filter(c => c.mode === 'task-notification')

import type { Message as MessageType } from '../../src/engine/message-shapes/message.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const REAL_USAGE = {
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  server_tool_use: null,
  service_tier: null,
  cache_creation: null,
  inference_geo: null,
  iterations: null,
  speed: null,
}

const userMsg = (text: string): MessageType =>
  ({ type: 'user', message: { role: 'user', content: text }, uuid: crypto.randomUUID() }) as never
const realReport = (text: string): MessageType =>
  createAssistantMessage({ content: text, usage: REAL_USAGE as never }) as never
const toolTail = (): MessageType =>
  createAssistantMessage({
    content: [{ type: 'tool_use', id: 'toolu_tail', name: 'Bash', input: {} }] as never,
  }) as never
const declineTail = (text: string): MessageType =>
  createAssistantAPIErrorMessage({ content: text }) as never

const META = {
  prompt: 'do the work',
  resolvedAgentModel: 'claude-opus-5',
  isBuiltInAgent: false,
  startTime: Date.now(),
  agentType: 'mercury-crew',
  isAsync: false,
}

section('§A ONE derivation: decline fails, promotion is labeled, report survives')
{
  const clean = [userMsg('go'), realReport('the final report')]
  const o = deriveAgentTerminalOutcome(clean)
  check('clean tail derives completed', o.status === 'completed', `${JSON.stringify(o)} — fix deriveAgentTerminalOutcome in src/tools/crewmate/crewmateLifecycle.ts`)
  const r = finalizeAgentTool(clean, 'ag-clean', META)
  check('clean finalize: outcome completed, not promoted',
    r.outcome?.status === 'completed' && r.outcome.promotedNarration === false,
    `${JSON.stringify(r.outcome)} — fix finalizeAgentTool in src/tools/crewmate/crewmateLifecycle.ts`)
  check('clean finalize: content is the final report',
    r.content.map(c => c.text).join('') === 'the final report',
    `${r.content.map(c => c.text).join('')} — fix finalizeAgentTool in src/tools/crewmate/crewmateLifecycle.ts`)
}
{
  const promoted = [userMsg('go'), realReport('earlier narration'), toolTail()]
  const r = finalizeAgentTool(promoted, 'ag-promoted', META)
  check('tool-call tail: outcome completed with promotedNarration=true',
    r.outcome?.status === 'completed' && r.outcome.promotedNarration === true,
    `${JSON.stringify(r.outcome)} — fix finalizeAgentTool or deriveAgentTerminalOutcome in src/tools/crewmate/crewmateLifecycle.ts`)
  check('tool-call tail: earlier narration is the content (fallback preserved)',
    r.content.map(c => c.text).join('') === 'earlier narration',
    `${r.content.map(c => c.text).join('')} — fix finalizeAgentTool in src/tools/crewmate/crewmateLifecycle.ts`)
}
{
  const declined = [userMsg('go'), realReport('the real partial report'), declineTail('API Error: 529 overloaded')]
  const o = deriveAgentTerminalOutcome(declined)
  check('decline tail derives failed/provider-declined',
    o.status === 'failed' && o.reason === 'provider-declined' && /529/.test(o.error),
    `${JSON.stringify(o)} — fix deriveAgentTerminalOutcome in src/tools/crewmate/crewmateLifecycle.ts`)
  const r = finalizeAgentTool(declined, 'ag-declined', META)
  check('declined finalize: outcome failed with the decline text',
    r.outcome?.status === 'failed' && /529/.test(r.outcome.error),
    `${JSON.stringify(r.outcome)} — fix finalizeAgentTool in src/tools/crewmate/crewmateLifecycle.ts`)
  check('declined finalize: the REAL report survives as content (not displaced)',
    r.content.map(c => c.text).join('') === 'the real partial report',
    `${r.content.map(c => c.text).join('').slice(0, 60)} — fix finalizeAgentTool in src/tools/crewmate/crewmateLifecycle.ts`)
  check('declined finalize: usage anchors on the real message (non-zero tokens)',
    r.totalTokens === 150, `${String(r.totalTokens)} — fix finalizeAgentTool in src/tools/crewmate/crewmateLifecycle.ts`)
}
{
  const immediate = [userMsg('go'), declineTail('API Error: 400 context')]
  const r = finalizeAgentTool(immediate, 'ag-immediate', META)
  check('immediate decline: failed outcome with empty content (nothing fabricated)',
    r.outcome?.status === 'failed' && r.content.length === 0,
    JSON.stringify({ outcome: r.outcome, content: r.content }))
}

{
  let result: ReturnType<typeof finalizeAgentTool> | undefined
  const failure = { status: 'failed' as const, reason: 'provider-declined' as const, error: 'typed overload cut' }
  try { result = finalizeAgentTool([userMsg('go')], 'ag-cut-before-answer', META, failure) } catch {}
  check('a declared failure before the first assistant reply finalizes without inventing output or usage', result?.outcome === failure && result.content.length === 0 && result.totalTokens === 0 && result.totalToolUseCount === 0, `${JSON.stringify(result)} — fix finalizeAgentTool in src/tools/crewmate/crewmateLifecycle.ts to accept a declared failure with no assistant message`)
}

section('§B refusals — the parent transcript never presents partial work as a conclusion')
type Mapper = (data: unknown, toolUseID: string) => { is_error?: boolean; content: Array<{ type: string; text: string }> }
const map = (AgentTool as unknown as { mapToolResultToToolResultBlockParam: Mapper })
  .mapToolResultToToolResultBlockParam.bind(AgentTool)
{
  const failed = map(
    {
      status: 'failed',
      error: 'API Error: 529 overloaded',
      prompt: 'p',
      agentId: 'ag1',
      agentType: 'mercury-crew',
      outcome: { status: 'failed', reason: 'provider-declined', error: 'API Error: 529 overloaded' },
      content: [{ type: 'text', text: 'the real partial report' }],
      totalToolUseCount: 3,
      totalDurationMs: 1000,
      totalTokens: 150,
      usage: REAL_USAGE,
    },
    'toolu_1',
  )
  check('failed result is an ERROR tool_result', failed.is_error === true, 'fix mapToolResultToToolResultBlockParam in src/tools/crewmate/CrewmateTool.tsx')
  const text = failed.content.map(c => c.text).join('\n')
  check('failed result carries the failure text', /Crewmate execution failed: API Error: 529/.test(text), `${text.slice(0, 300)} — fix mapToolResultToToolResultBlockParam in src/tools/crewmate/CrewmateTool.tsx`)
  check('failed result carries the partial report', /the real partial report/.test(text), `${text.slice(0, 300)} — fix mapToolResultToToolResultBlockParam in src/tools/crewmate/CrewmateTool.tsx`)
  check('failed result labels the partial as not-final', /partial work and must not be read as a conclusion/.test(text), `${text} — fix mapToolResultToToolResultBlockParam in src/tools/crewmate/CrewmateTool.tsx`)
}
{
  const promoted = map(
    {
      status: 'completed',
      prompt: 'p',
      agentId: 'ag2',
      agentType: 'custom-x',
      outcome: { status: 'completed', promotedNarration: true },
      content: [{ type: 'text', text: 'earlier narration' }],
      totalToolUseCount: 3,
      totalDurationMs: 1000,
      totalTokens: 150,
      usage: REAL_USAGE,
    },
    'toolu_2',
  )
  const text = promoted.content.map(c => c.text).join('\n')
  check('promoted narration is LABELED in the parent transcript',
    text.includes(PROMOTED_NARRATION_NOTE) && text.indexOf(PROMOTED_NARRATION_NOTE) < text.indexOf('earlier narration'), `${text.slice(0, 300)} — fix mapToolResultToToolResultBlockParam in src/tools/crewmate/CrewmateTool.tsx to put PROMOTED_NARRATION_NOTE before the content`)
  check('promoted completion is not an error result', promoted.is_error !== true, 'fix mapToolResultToToolResultBlockParam in src/tools/crewmate/CrewmateTool.tsx')
}
{
  const plain = map(
    {
      status: 'completed',
      prompt: 'p',
      agentId: 'ag3',
      agentType: 'custom-x',
      outcome: { status: 'completed', promotedNarration: false },
      content: [{ type: 'text', text: 'the final report' }],
      totalToolUseCount: 3,
      totalDurationMs: 1000,
      totalTokens: 150,
      usage: REAL_USAGE,
    },
    'toolu_3',
  )
  const text = plain.content.map(c => c.text).join('\n')
  check('a plain completion carries NO promotion label', !text.includes(PROMOTED_NARRATION_NOTE), `${text.slice(0, 300)} — fix mapToolResultToToolResultBlockParam in src/tools/crewmate/CrewmateTool.tsx to add the note only when outcome.promotedNarration is true`)
  check('legacy results without outcome still map (resume compat)', (() => {
    const legacy = map(
      {
        status: 'completed', prompt: 'p', agentId: 'ag4',
        content: [{ type: 'text', text: 'old result' }],
        totalToolUseCount: 1, totalDurationMs: 1, totalTokens: 1, usage: REAL_USAGE,
      },
      'toolu_4',
    )
    return legacy.content.some(c => /old result/.test(c.text)) && legacy.is_error !== true
  })(), 'fix mapToolResultToToolResultBlockParam in src/tools/crewmate/CrewmateTool.tsx to map a result with no outcome field')
}

section('§C async lifecycle: task state + notification + envelope agree')

type Store = { state: { tasks: Record<string, unknown>; speculation: { status: string } } }
function makeStore(): Store & { set: (fn: (prev: never) => never) => void } {
  const store: Store & { set: (fn: (prev: never) => never) => void } = {
    state: { tasks: {}, speculation: { status: 'idle' } },
    set(fn) {
      store.state = (fn as (p: unknown) => Store['state'])(store.state)
    },
  }
  return store
}

const FAKE_AGENT_DEF = {
  agentType: 'mercury-crew',
  source: 'built-in',
  whenToUse: '',
  systemPrompt: '',
} as never

async function lifecycleCase(
  name: string,
  stream: MessageType[],
  expect: { status: string; notifStatus: string; inNotif: RegExp; notInNotif?: RegExp },
): Promise<{ status: string; error?: string; paused?: { why?: string } } | undefined> {
  resetCommandQueue()
  const store = makeStore()
  const taskId = `ag-life-${name}`
  const registered = registerAsyncAgent({
    agentId: taskId,
    description: `lifecycle ${name}`,
    prompt: 'work',
    selectedAgent: FAKE_AGENT_DEF,
    setAppState: store.set as never,
  })
  await runAsyncAgentLifecycle({
    taskId,
    abortController: registered.abortController,
    makeStream: () =>
      (async function* () {
        for (const m of stream) yield m
      })() as never,
    metadata: { ...META, isAsync: true },
    description: `lifecycle ${name}`,
    toolUseContext: { options: { tools: [] }, toolUseId: 'toolu_life' } as never,
    rootSetAppState: store.set as never,
    agentIdForCleanup: taskId,
    enableSummarization: false,
    getWorktreeResult: async () => ({}),
  })
  const task = store.state.tasks[taskId] as { status: string; error?: string } | undefined
  check(`${name}: task state settled '${expect.status}'`, task?.status === expect.status, `${String(task?.status)} — fix runAsyncAgentLifecycle in src/tools/crewmate/crewmateLifecycle.ts`)
  const notifs = taskNotifications()
  const body = notifs.map(n => (n as { value?: string }).value ?? '').join('\n')
  check(`${name}: ONE notification enqueued`, notifs.length === 1, `${String(notifs.length)} — fix runAsyncAgentLifecycle in src/tools/crewmate/crewmateLifecycle.ts to enqueue exactly one task-notification`)
  check(`${name}: notification status is '${expect.notifStatus}'`,
    body.includes(`<status>${expect.notifStatus}</status>`), `${body.slice(0, 200)} — fix runAsyncAgentLifecycle in src/tools/crewmate/crewmateLifecycle.ts`)
  check(`${name}: notification carries the expected text`, expect.inNotif.test(body), `${body.slice(0, 300)} — fix runAsyncAgentLifecycle in src/tools/crewmate/crewmateLifecycle.ts`)
  if (expect.notInNotif) {
    check(`${name}: notification does NOT carry the displaced text`, !expect.notInNotif.test(body), `${body.slice(0, 300)} — fix runAsyncAgentLifecycle in src/tools/crewmate/crewmateLifecycle.ts`)
  }
  return store.state.tasks[taskId] as { status: string; error?: string; paused?: { why?: string } } | undefined
}

const declinedRow = await lifecycleCase(
  'declined',
  [userMsg('go'), realReport('partial findings so far'), declineTail('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')],
  {
    status: 'failed',
    notifStatus: 'paused',
    inNotif: /partial findings so far/,
  },
)
{
  const notifs = taskNotifications()
  const body = notifs.map(n => (n as { value?: string }).value ?? '').join('\n')
  check('declined on a pause: the envelope block says paused, as the notice does', /<envelope v="\d+" status="paused">/.test(body) && !/status="failed"/.test(body), `${body.slice(-400)} — fix runAsyncAgentLifecycle in src/tools/crewmate/crewmateLifecycle.ts`)
  check("declined on the provider's overload: the notice is the calm paused line naming the overload and the probing, not the error", /paused — .* is overloaded \(HTTP 529\); its work so far is kept and rides below; Mercury probes the provider/.test(body) && !/failed: API Error/.test(body), `${body.slice(0, 400)} — fix runAsyncAgentLifecycle in src/tools/crewmate/crewmateLifecycle.ts`)
  check("declined on the provider's overload: the row wears the pause", declinedRow?.paused?.why === 'provider overloaded', `${JSON.stringify(declinedRow?.paused)} — fix runAsyncAgentLifecycle in src/tools/crewmate/crewmateLifecycle.ts`)
}
await lifecycleCase(
  'declined-plain',
  [userMsg('go'), realReport('partial findings so far'), declineTail('API Error: 400 context')],
  {
    status: 'failed',
    notifStatus: 'failed',
    inNotif: /partial findings so far/,
  },
)
{
  const notifs = taskNotifications()
  const body = notifs.map(n => (n as { value?: string }).value ?? '').join('\n')
  check('declined-plain: envelope block says failed', /status="failed"/.test(body), `${body.slice(-400)} — fix runAsyncAgentLifecycle in src/tools/crewmate/crewmateLifecycle.ts`)
  check('declined-plain: the error rides the notification', /400 context/.test(body), `${body.slice(0, 300)} — fix runAsyncAgentLifecycle in src/tools/crewmate/crewmateLifecycle.ts`)
}
await lifecycleCase(
  'clean',
  [userMsg('go'), realReport('all done, shipped')],
  { status: 'completed', notifStatus: 'completed', inNotif: /all done, shipped/ },
)
await lifecycleCase(
  'promoted',
  [userMsg('go'), realReport('latest narration'), toolTail()],
  {
    status: 'completed',
    notifStatus: 'completed',
    inNotif: /most recent narration, not a final report/,
  },
)
resetCommandQueue()


rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} TERMINAL-OUTCOME PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL TERMINAL-OUTCOME PROOFS PASS')
