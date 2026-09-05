#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'terminal-outcome-home-'))

const ROOT = join(import.meta.dir, '..', '..')
await import('../../src/tasks.js')
const {
  deriveAgentTerminalOutcome,
  finalizeAgentTool,
  runAsyncAgentLifecycle,
  PROMOTED_NARRATION_NOTE,
  REPETITION_STOP_WORDS,
} = await import('../../src/tools/AgentTool/agentToolUtils.js')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.js')
const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.js')
const { registerAsyncAgent } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')
const { createAssistantMessage, createAssistantAPIErrorMessage } = await import(
  '../../src/utils/messages/factories.js'
)
const { getCommandQueueSnapshot, resetCommandQueue } = await import(
  '../../src/utils/messageQueueManager.js'
)
const taskNotifications = () =>
  getCommandQueueSnapshot().filter(c => c.mode === 'task-notification')

import type { Message as MessageType } from '../../src/types/message.js'

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
  agentType: 'general-purpose',
  isAsync: false,
}

section('§A ONE derivation: decline fails, promotion is labeled, report survives')
{
  const clean = [userMsg('go'), realReport('the final report')]
  const o = deriveAgentTerminalOutcome(clean)
  check('clean tail derives completed', o.status === 'completed')
  const r = finalizeAgentTool(clean, 'ag-clean', META)
  check('clean finalize: outcome completed, not promoted',
    r.outcome?.status === 'completed' && r.outcome.promotedNarration === false)
  check('clean finalize: content is the final report',
    r.content.map(c => c.text).join('') === 'the final report')
}
{
  const promoted = [userMsg('go'), realReport('earlier narration'), toolTail()]
  const r = finalizeAgentTool(promoted, 'ag-promoted', META)
  check('tool-call tail: outcome completed with promotedNarration=true',
    r.outcome?.status === 'completed' && r.outcome.promotedNarration === true,
    JSON.stringify(r.outcome))
  check('tool-call tail: earlier narration is the content (fallback preserved)',
    r.content.map(c => c.text).join('') === 'earlier narration')
}
{
  const declined = [userMsg('go'), realReport('the real partial report'), declineTail('API Error: 529 overloaded')]
  const o = deriveAgentTerminalOutcome(declined)
  check('decline tail derives failed/provider-declined',
    o.status === 'failed' && o.reason === 'provider-declined' && /529/.test(o.error),
    JSON.stringify(o))
  const r = finalizeAgentTool(declined, 'ag-declined', META)
  check('declined finalize: outcome failed with the decline text',
    r.outcome?.status === 'failed' && /529/.test(r.outcome.error))
  check('declined finalize: the REAL report survives as content (not displaced)',
    r.content.map(c => c.text).join('') === 'the real partial report',
    r.content.map(c => c.text).join('').slice(0, 60))
  check('declined finalize: usage anchors on the real message (non-zero tokens)',
    r.totalTokens === 150, String(r.totalTokens))
}
{
  const cause = 'the model ran the identical Bash call 3 times with the identical failure; the turn stopped'
  const breaker = (): unknown => createAttachmentMessage({ type: 'repetition_breaker', toolName: 'Bash', outcome: 'failure', streak: 3, cause })
  const stopped = [userMsg('go'), realReport('partial words before the loop'), breaker()]
  const o = deriveAgentTerminalOutcome(stopped as never)
  check('a repetition-breaker tail derives failed/repetition-stop carrying the breaker\'s cause',
    o.status === 'failed' && o.reason === 'repetition-stop' && o.error === cause,
    JSON.stringify(o))
  const recovered = [userMsg('go'), breaker(), realReport('the report after a later turn')]
  check('a breaker answered by a later assistant row is not a stop (the last turn decides)',
    deriveAgentTerminalOutcome(recovered as never).status === 'completed')
  check('the crew row\'s stop words are the one export the settle writes',
    REPETITION_STOP_WORDS === 'stopped by the repetition breaker')
  const src = readFileSync(join(ROOT, 'src/tools/AgentTool/foregroundExecution.tsx'), 'utf8')
  check('the foreground settle hands a derived failure\'s reason to the record (the row\'s tail says why)',
    src.includes('stopReason: REPETITION_STOP_WORDS') && src.includes('settleAgentForeground(foregroundTask.taskId, status, rootSetAppState, getProgressUpdate(tracker), why)'))
}
{
  const immediate = [userMsg('go'), declineTail('API Error: 400 context')]
  const r = finalizeAgentTool(immediate, 'ag-immediate', META)
  check('immediate decline: failed outcome with empty content (nothing fabricated)',
    r.outcome?.status === 'failed' && r.content.length === 0,
    JSON.stringify({ outcome: r.outcome, content: r.content }))
}

section('§B the parent transcript speaks the same outcome')
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
      agentType: 'general-purpose',
      outcome: { status: 'failed', reason: 'provider-declined', error: 'API Error: 529 overloaded' },
      content: [{ type: 'text', text: 'the real partial report' }],
      totalToolUseCount: 3,
      totalDurationMs: 1000,
      totalTokens: 150,
      usage: REAL_USAGE,
    },
    'toolu_1',
  )
  check('failed result is an ERROR tool_result', failed.is_error === true)
  const text = failed.content.map(c => c.text).join('\n')
  check('failed result carries the failure text', /Agent execution failed: API Error: 529/.test(text))
  check('failed result carries the partial report', /the real partial report/.test(text))
  check('failed result labels the partial as not-final', /partial work, not a final answer/.test(text))
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
    text.includes(PROMOTED_NARRATION_NOTE) && text.indexOf(PROMOTED_NARRATION_NOTE) < text.indexOf('earlier narration'))
  check('promoted completion is not an error result', promoted.is_error !== true)
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
  check('a plain completion carries NO promotion label', !text.includes(PROMOTED_NARRATION_NOTE))
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
  })())
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
  agentType: 'general-purpose',
  source: 'built-in',
  whenToUse: '',
  systemPrompt: '',
} as never

async function lifecycleCase(
  name: string,
  stream: MessageType[],
  expect: { status: string; notifStatus: string; inNotif: RegExp; notInNotif?: RegExp },
): Promise<void> {
  resetCommandQueue()
  const store = makeStore()
  const taskId = `ag-life-${name}`
  registerAsyncAgent({
    agentId: taskId,
    description: `lifecycle ${name}`,
    prompt: 'work',
    selectedAgent: FAKE_AGENT_DEF,
    setAppState: store.set as never,
  })
  await runAsyncAgentLifecycle({
    taskId,
    abortController: new AbortController(),
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
  check(`${name}: task state settled '${expect.status}'`, task?.status === expect.status, String(task?.status))
  const notifs = taskNotifications()
  const body = notifs.map(n => (n as { value?: string }).value ?? '').join('\n')
  check(`${name}: ONE notification enqueued`, notifs.length === 1, String(notifs.length))
  check(`${name}: notification status is '${expect.notifStatus}'`,
    body.includes(`<status>${expect.notifStatus}</status>`), body.slice(0, 200))
  check(`${name}: notification carries the expected text`, expect.inNotif.test(body), body.slice(0, 300))
  if (expect.notInNotif) {
    check(`${name}: notification does NOT carry the displaced text`, !expect.notInNotif.test(body))
  }
}

await lifecycleCase(
  'declined',
  [userMsg('go'), realReport('partial findings so far'), declineTail('API Error: 529 overloaded')],
  {
    status: 'failed',
    notifStatus: 'failed',
    inNotif: /partial findings so far/,
  },
)
{
  const notifs = taskNotifications()
  const body = notifs.map(n => (n as { value?: string }).value ?? '').join('\n')
  check('declined: envelope block says failed', /status="failed"/.test(body), body.slice(-400))
  check('declined: the error rides the notification', /529 overloaded/.test(body))
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

section('§D wiring pins (source locks on the threaded surfaces)')
{
  const fg = readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'AgentTool', 'foregroundExecution.tsx'), 'utf8')
  check('SDK bookend derives its clean-exit status from the ONE derivation (the outcome kept, its reason handed to the settle)',
    fg.includes('const outcome = heldError === undefined ? deriveAgentTerminalOutcome(agentMessages) : null') && fg.includes(': outcome!.status'))
  check('backgrounded closure settles by outcome (fail path wired)',
    fg.includes("failAsyncAgent(backgroundedTaskId, declined.error"))
  check('sync result forks failed/completed on the same outcome',
    fg.includes("status: 'failed' as const,") && fg.includes('error: failureText'))
  const runner = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'swarm', 'inProcessRunner.ts'), 'utf8')
  check("in-process teammate: a declined tail reports idleReason 'failed'",
    runner.includes('isSyntheticApiErrorMessage(lastAssistant)') && runner.includes("sendIdleNotificationToLead(identity, 'failed'"))
  const ui = readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'AgentTool', 'UI.tsx'), 'utf8')
  check('transcript row renders Failed for the failed status (no silent blank)',
    ui.includes("`Failed (${result.join(' · ')}) — ${data.error}`"))
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} TERMINAL-OUTCOME PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL TERMINAL-OUTCOME PROOFS PASS')
