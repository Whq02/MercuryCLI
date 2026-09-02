#!/usr/bin/env bun
// ============================================================================
//  scripts/render-continuity/repro-pr01.ts — reproduction driver (D2).
//
//  Field report: replying to a COMPLETED local agent while attached could
//  leave the assistant answer invisible (task replaced unretained). The
//  close train landed the registerTask merge (framework.ts) + retain-gated
//  live append (agentToolUtils.ts). This driver reproduces the exact journey
//  against the REAL owners — registerAsyncAgent → complete → enterTeammateView
//  → appendMessageToLocalAgent → re-register (resume) → runAsyncAgentLifecycle
//  stream → settle — and records which continuity laws hold at HEAD:
//
//    §A original spawn completes; task terminal, unretained
//    §B enter view (retain) + reply appends the user row ONCE
//    §C resume re-register PRESERVES retain/messages/startTime (the merge)
//    §D live assistant delta lands in the viewed transcript (retain gate)
//    §E settlement keeps the transcript; once-only rows preserved
//    §F running-agent guidance: append + queue + drain order
//    §G switch-away release returns the stub (designed); re-enter re-arms
//
//  Run:  bun scripts/render-continuity/repro-pr01.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'poise-pr01-config-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'poise-pr01-teams-'))
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'poise-pr01-home-'))
process.env.MERCURY_CREW_DIR = mkdtempSync(join(tmpdir(), 'poise-pr01-crew-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
const projDir = mkdtempSync(join(tmpdir(), 'poise-pr01-proj-'))
bootstrap.setOriginalCwd(projDir)
bootstrap.setProjectRoot(projDir)

const { registerAsyncAgent } = await import(
  '../../src/tasks/LocalAgentTask/LocalAgentTask.tsx'
)
const {
  appendMessageToLocalAgent,
  queuePendingMessage,
  drainPendingMessages,
  isLocalAgentTask,
} = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { runAsyncAgentLifecycle } = await import(
  '../../src/tools/AgentTool/agentToolUtils.ts'
)
const { enterTeammateView, exitTeammateView } = await import(
  '../../src/state/teammateViewHelpers.ts'
)
const { createUserMessage, createAssistantMessage } = await import(
  '../../src/utils/messages/factories.ts'
)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

type AnyState = Record<string, unknown> & {
  tasks: Record<string, any>
  viewingAgentTaskId?: string
  viewSelectionMode?: string
}
let state: AnyState = {
  toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as const },
  sessionHooks: new Map(),
  tasks: {},
  todos: {},
  agentNameRegistry: new Map(),
  mcp: { clients: [], tools: [], commands: [], resources: {} },
  viewSelectionMode: 'none',
}
const setAppState = (updater: (prev: AnyState) => AnyState): void => {
  state = updater(state)
}

const AGENT_DEF = {
  agentType: 'general-purpose',
  whenToUse: 'poise repro',
  tools: ['*'],
  systemPrompt: 'poise fixture',
  source: 'built-in',
} as any

const toolUseContext = {
  toolUseId: 'toolu_poise_pr01',
  options: { tools: [] },
} as any

const AID = 'poise-d2-agent'

function task(): any {
  return state.tasks[AID]
}
function userRows(): any[] {
  return (task()?.messages ?? []).filter((m: any) => m.type === 'user')
}
function textOf(m: any): string {
  const c = m?.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('')
  }
  return ''
}

async function driveLifecycle(replyText: string): Promise<void> {
  await runAsyncAgentLifecycle({
    taskId: AID,
    abortController: task().abortController ?? new AbortController(),
    makeStream: async function* () {
      yield createAssistantMessage({ content: replyText })
    } as any,
    metadata: {
      prompt: 'poise repro',
      resolvedAgentModel: 'fixture-model',
      isBuiltInAgent: true,
      startTime: Date.now(),
      agentType: 'general-purpose',
      isAsync: true,
    } as any,
    description: 'poise repro agent',
    toolUseContext,
    rootSetAppState: setAppState,
    agentIdForCleanup: AID,
    enableSummarization: false,
    getWorktreeResult: async () => ({}),
  })
}

// ── §A original spawn + completion ──────────────────────────────────────────
section('§A original spawn completes; task terminal, unretained')
registerAsyncAgent({
  agentId: AID,
  description: 'poise repro agent',
  prompt: 'original question',
  selectedAgent: AGENT_DEF,
  setAppState,
})
check('registered as local_agent', isLocalAgentTask(task()))
check('freshly registered: retain=false', task().retain === false)
await driveLifecycle('original answer')
check('lifecycle settled the task terminal', task().status === 'completed', String(task().status))
check(
  'unretained run appended NOTHING to the UI transcript',
  task().messages === undefined,
  JSON.stringify(task().messages ?? null)?.slice(0, 80),
)
const startTime0 = task().startTime

// ── §B enter view + reply ───────────────────────────────────────────────────
section('§B enter view (retain) + reply appends the user row ONCE')
enterTeammateView(AID, setAppState)
check('viewing the agent', state.viewingAgentTaskId === AID)
check('retain=true on enter', task().retain === true)
const reply = createUserMessage({ content: 'follow-up question' })
appendMessageToLocalAgent(AID, reply as any, setAppState)
check('user row appears once', userRows().length === 1, `count=${userRows().length}`)
const replyUuid = (reply as any).uuid

// ── §C resume re-register preserves the view-held state ─────────────────────
section('§C resume re-register PRESERVES retain/messages/startTime (the merge)')
registerAsyncAgent({
  agentId: AID,
  description: 'poise repro agent',
  prompt: 'follow-up question',
  selectedAgent: AGENT_DEF,
  setAppState,
})
check('status running after re-register', task().status === 'running', String(task().status))
check('retain SURVIVES the replacement', task().retain === true)
check(
  'user row SURVIVES the replacement (once)',
  userRows().length === 1 && userRows()[0].uuid === replyUuid,
  `count=${userRows().length}`,
)
check('startTime preserved (panel sort stable)', task().startTime === startTime0)

// ── §D live assistant delta visible in the viewed transcript ────────────────
section('§D live assistant delta lands in the viewed transcript (retain gate)')
await driveLifecycle('resumed answer')
const msgs = task().messages ?? []
const assistantRows = msgs.filter((m: any) => m.type === 'assistant')
check('assistant reply IS visible', assistantRows.length === 1, `count=${assistantRows.length}`)
check('reply text intact', textOf(assistantRows[0]) === 'resumed answer', textOf(assistantRows[0]))
check(
  'order: user row precedes assistant reply',
  msgs.findIndex((m: any) => m.uuid === replyUuid) <
    msgs.findIndex((m: any) => m.type === 'assistant'),
)

// ── §E settlement keeps the transcript ──────────────────────────────────────
section('§E settlement keeps the transcript; once-only preserved')
check('settled back to completed', task().status === 'completed', String(task().status))
check('user row still once', userRows().length === 1, `count=${userRows().length}`)
check('retain still held while viewing', task().retain === true)
check('no eviction deadline while retained', task().evictAfter === undefined, String(task().evictAfter))

// ── §F: running-agent guidance ────────────────────────────────────────
section('§F PR-02: running-agent guidance — append + queue + drain order')
let releaseStream: (() => void) | undefined
const gate = new Promise<void>(r => {
  releaseStream = r
})
registerAsyncAgent({
  agentId: AID,
  description: 'poise repro agent',
  prompt: 'round three',
  selectedAgent: AGENT_DEF,
  setAppState,
})
const lifecycleP = runAsyncAgentLifecycle({
  taskId: AID,
  abortController: task().abortController ?? new AbortController(),
  makeStream: async function* () {
    await gate
    yield createAssistantMessage({ content: 'guided answer' })
  } as any,
  metadata: {
    prompt: 'round three',
    resolvedAgentModel: 'fixture-model',
    isBuiltInAgent: true,
    startTime: Date.now(),
    agentType: 'general-purpose',
    isAsync: true,
  } as any,
  description: 'poise repro agent',
  toolUseContext,
  rootSetAppState: setAppState,
  agentIdForCleanup: AID,
  enableSummarization: false,
  getWorktreeResult: async () => ({}),
})
// Mid-turn guidance exactly as REPL.onAgentSubmit does for a RUNNING task:
const guidance = createUserMessage({ content: 'mid-turn guidance' })
appendMessageToLocalAgent(AID, guidance as any, setAppState)
queuePendingMessage(AID, 'mid-turn guidance', setAppState)
check('guidance row visible immediately', userRows().some((m: any) => m.uuid === (guidance as any).uuid))
check('guidance queued for the agent', task().pendingMessages.length === 1)
releaseStream!()
await lifecycleP
const finalMsgs = task().messages ?? []
check(
  'guided answer visible after guidance row',
  finalMsgs.findIndex((m: any) => textOf(m) === 'guided answer') >
    finalMsgs.findIndex((m: any) => m.uuid === (guidance as any).uuid),
)
const drained = drainPendingMessages(AID, () => state as any, setAppState)
check('drain returns the guidance once', drained.length === 1 && drained[0] === 'mid-turn guidance')
check('drain empties the queue', task().pendingMessages.length === 0)

// ── §G switch-away release + re-enter ───────────────────────────────────────
section('§G switch-away release returns the stub (designed); re-enter re-arms')
const preExitCount = (task().messages ?? []).length
exitTeammateView(setAppState)
check('exit clears the view', state.viewingAgentTaskId === undefined)
check('release drops retain', task().retain === false)
check(
  'release clears messages to stub (CURRENT design — PO-12 scope)',
  task().messages === undefined,
  `pre-exit rows=${preExitCount}`,
)
check('terminal task gets an eviction deadline', typeof task().evictAfter === 'number')
enterTeammateView(AID, setAppState)
check('re-enter re-arms retain', task().retain === true)
check('re-enter clears the eviction deadline', task().evictAfter === undefined)
check('re-enter needs disk bootstrap (diskLoaded=false)', task().diskLoaded === false)

console.log(
  failures === 0
    ? '\n ✅ PR-01/PR-02 REPRODUCTION: all legs GREEN at HEAD'
    : `\n ❌ PR-01/PR-02: ${failures} leg(s) RED at HEAD — D2 remaining scope`,
)
process.exit(failures === 0 ? 0 : 1)
