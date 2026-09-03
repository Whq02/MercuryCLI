#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-workflow-permission-channel.ts
//  PROOF for the background-workflow permission channel — the fix for the
//  crash-shaped gap where a workflow subagent's 'ask' hit
//  `canUseTool is not a function` (WorkflowTool set canUseTool: undefined on
//  the background run context; the reference ships a fail-closed
//  permission_workflow channel for exactly this).
//
//  This is a SECURITY/GATE primitive, so the proof enumerates the input space
//  (per the standing fable-audit lesson): {headless, interactive} ×
//  {allow, deny, throw, never-resolves} × {agentId present/absent} +
//  forceDecision passthrough + pending-bookkeeping + env parsing + the
//  source-text wiring pins (WorkflowTool.tsx is bun-unloadable).
//
//  The channel module itself is bun-loadable BY DESIGN (zero runtime imports)
//  so every behavioral check below exercises the REAL code, not a mirror.
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-workflow-permission-channel.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  DEFAULT_WORKFLOW_PERMISSION_TIMEOUT_MS,
  makeWorkflowCanUseTool,
  workflowPermissionTimeoutMs,
} from '../../src/tools/WorkflowTool/workflowPermissionChannel.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── fake store implementing the setAppState contract ─────────────────────────
type AnyState = { tasks: Record<string, { pendingPermissions?: Map<string, unknown> }> }
function makeStore(taskId: string) {
  let state: AnyState = { tasks: { [taskId]: { pendingPermissions: new Map() } } }
  const setAppState = (updater: unknown): void => {
    state = typeof updater === 'function' ? (updater as (p: AnyState) => AnyState)(state) : (updater as AnyState)
  }
  return {
    setAppState: setAppState as never,
    pending: () => state.tasks[taskId]?.pendingPermissions,
    dropTask: () => { state = { tasks: {} } },
  }
}

const TOOL = { name: 'Bash' } as never
const MSG = {} as never
const ctx = (interactive: boolean, agentId?: string) =>
  ({ options: { isNonInteractiveSession: !interactive }, agentId }) as never

const ALLOW = { behavior: 'allow', updatedInput: {}, decisionReason: { type: 'mode', mode: 'default' } }
const DENY = { behavior: 'deny', message: 'no', decisionReason: { type: 'mode', mode: 'default' } }

function makeChannel(opts: {
  taskId?: string
  real: (...a: unknown[]) => Promise<unknown>
  controllers?: Map<string, AbortController>
  timeoutMs?: number
  store?: ReturnType<typeof makeStore>
}) {
  const taskId = opts.taskId ?? 't1'
  const store = opts.store ?? makeStore(taskId)
  const fn = makeWorkflowCanUseTool({
    taskId,
    setAppState: store.setAppState,
    realCanUseTool: opts.real as never,
    getAgentControllers: () => opts.controllers,
    timeoutMsOverride: opts.timeoutMs,
  })
  return { fn, store }
}

console.log('============================================================')
console.log(' workflow permission channel — fail-closed elicitation')
console.log('============================================================')

section('interactive: direct passthrough (operator answers the dialog), pending tracked')
{
  let sawPendingDuringCall = false
  const { fn, store } = makeChannel({
    real: async () => {
      sawPendingDuringCall = (store.pending()?.size ?? 0) === 1
      return ALLOW
    },
  })
  const store2 = store
  const r = (await fn(TOOL, {}, ctx(true, 'ag1'), MSG, 'tu1')) as typeof ALLOW
  check('allow passes through', r.behavior === 'allow')
  check('pending entry visible WHILE the ask is in flight', sawPendingDuringCall)
  check('pending cleared after resolution', (store2.pending()?.size ?? 0) === 0)
}
{
  const { fn } = makeChannel({ real: async () => DENY })
  const r = (await fn(TOOL, {}, ctx(true), MSG, 'tu2')) as typeof DENY
  check('deny passes through', r.behavior === 'deny')
}
{
  let got: unknown
  const { fn } = makeChannel({ real: async (...a: unknown[]) => { got = a[5]; return ALLOW } })
  await fn(TOOL, {}, ctx(true), MSG, 'tu3', DENY as never)
  check('forceDecision forwarded (interactive)', got === DENY)
}
{
  const { fn, store } = makeChannel({ real: async () => { throw new Error('real broke') } })
  let threw = false
  try { await fn(TOOL, {}, ctx(true), MSG, 'tu4') } catch { threw = true }
  check('a throwing real canUseTool propagates (never masked as allow)', threw)
  check('pending cleared even on throw', (store.pending()?.size ?? 0) === 0)
}
{
  // The corrected invariant: an INTERACTIVE ask has NO timeout — the operator
  // answers the visible dialog. A hung real fn must NOT resolve on its own
  // (a timeout here would wedge the shared FIFO permission queue). Race the
  // channel against a short sentinel; the sentinel MUST win.
  const { fn } = makeChannel({ real: () => new Promise<never>(() => {}), timeoutMs: 40 })
  const sentinel = new Promise<'no-timeout'>(res => setTimeout(() => res('no-timeout'), 200))
  const outcome = await Promise.race([
    fn(TOOL, {}, ctx(true, 'agI'), MSG, 'tuI').then(() => 'resolved' as const),
    sentinel,
  ])
  check('interactive ask does NOT self-resolve on a timeout (queue never wedged)', outcome === 'no-timeout')
}

section('headless: resolution before the timeout')
{
  const { fn } = makeChannel({ real: async () => ALLOW, timeoutMs: 5000 })
  const r = (await fn(TOOL, {}, ctx(false, 'ag1'), MSG, 'tu5')) as typeof ALLOW
  check('allow before timeout → allow', r.behavior === 'allow')
}
{
  const { fn } = makeChannel({ real: async () => DENY, timeoutMs: 5000 })
  const r = (await fn(TOOL, {}, ctx(false), MSG, 'tu6')) as typeof DENY
  check('deny before timeout → deny', r.behavior === 'deny')
}
{
  let got: unknown
  const { fn } = makeChannel({ real: async (...a: unknown[]) => { got = a[5]; return ALLOW }, timeoutMs: 5000 })
  await fn(TOOL, {}, ctx(false), MSG, 'tu7', DENY as never)
  check('forceDecision forwarded (headless)', got === DENY)
}

section('headless: TIMEOUT — the fail-closed core (a blocking prompt-tool)')
{
  const controllers = new Map<string, AbortController>()
  const ac = new AbortController()
  controllers.set('ag9', ac)
  const never = () => new Promise<never>(() => {})
  const { fn, store } = makeChannel({ real: never, controllers, timeoutMs: 60 })
  const r = (await fn(TOOL, {}, ctx(false, 'ag9'), MSG, 'tu8')) as {
    behavior: string; message: string; decisionReason?: { type?: string; reason?: string }; toolUseID?: string
  }
  check('times out to DENY (never allow, never hang)', r.behavior === 'deny')
  check('deny message names the tool + the timeout', /Bash/.test(r.message) && /timed out/.test(r.message))
  check('decisionReason is asyncAgent/workflow-permission-timeout',
    r.decisionReason?.type === 'asyncAgent' && r.decisionReason?.reason === 'workflow-permission-timeout')
  check('toolUseID carried on the deny', r.toolUseID === 'tu8')
  check("the ASKING AGENT's controller was aborted (skip blast radius)",
    ac.signal.aborted && String(ac.signal.reason) === 'workflow-permission-timeout')
  check('pending cleared after timeout', (store.pending()?.size ?? 0) === 0)
}
{
  // no agentId on the context — must still fail closed without crashing
  const { fn } = makeChannel({ real: () => new Promise<never>(() => {}), timeoutMs: 60 })
  const r = (await fn(TOOL, {}, ctx(false), MSG, 'tu9')) as { behavior: string }
  check('timeout with NO agentId still denies cleanly', r.behavior === 'deny')
}
{
  // controllers map missing the agent — still denies, no throw
  const { fn } = makeChannel({ real: () => new Promise<never>(() => {}), controllers: new Map(), timeoutMs: 60 })
  const r = (await fn(TOOL, {}, ctx(false, 'ghost'), MSG, 'tu10')) as { behavior: string }
  check('timeout with unknown agent controller still denies', r.behavior === 'deny')
}

section('bookkeeping edge: task missing from the store')
{
  const store = makeStore('t1')
  store.dropTask()
  const { fn } = makeChannel({ real: async () => ALLOW, store })
  const r = (await fn(TOOL, {}, ctx(false), MSG, 'tu11')) as typeof ALLOW
  check('missing task → tracking is a no-op, decision still flows', r.behavior === 'allow')
}

section('env parsing (MERCURY_WORKFLOW_PERMISSION_TIMEOUT_MS, live-read)')
{
  const prev = process.env.MERCURY_WORKFLOW_PERMISSION_TIMEOUT_MS
  delete process.env.MERCURY_WORKFLOW_PERMISSION_TIMEOUT_MS
  check('unset → default 600000', workflowPermissionTimeoutMs() === DEFAULT_WORKFLOW_PERMISSION_TIMEOUT_MS)
  process.env.MERCURY_WORKFLOW_PERMISSION_TIMEOUT_MS = 'soon'
  check('garbage → default', workflowPermissionTimeoutMs() === DEFAULT_WORKFLOW_PERMISSION_TIMEOUT_MS)
  process.env.MERCURY_WORKFLOW_PERMISSION_TIMEOUT_MS = '-5'
  check('negative → default', workflowPermissionTimeoutMs() === DEFAULT_WORKFLOW_PERMISSION_TIMEOUT_MS)
  process.env.MERCURY_WORKFLOW_PERMISSION_TIMEOUT_MS = '10'
  check('tiny → clamped to the 5s floor (typo cannot insta-deny every ask)', workflowPermissionTimeoutMs() === 5000)
  process.env.MERCURY_WORKFLOW_PERMISSION_TIMEOUT_MS = '120000'
  check('honest value honored', workflowPermissionTimeoutMs() === 120000)
  if (prev === undefined) delete process.env.MERCURY_WORKFLOW_PERMISSION_TIMEOUT_MS
  else process.env.MERCURY_WORKFLOW_PERMISSION_TIMEOUT_MS = prev
}

section('source-text pins (bun-unloadable wiring)')
{
  const root = join(import.meta.dir, '..', '..')
  const tool = readFileSync(join(root, 'src', 'tools', 'WorkflowTool', 'WorkflowTool.tsx'), 'utf-8')
  const task = readFileSync(join(root, 'src', 'tasks', 'LocalWorkflowTask', 'LocalWorkflowTask.tsx'), 'utf-8')
  const flags = readFileSync(join(root, 'src', 'substrate', 'flagRegistry.ts'), 'utf-8')
  check('call() captures the session canUseTool (3rd param)',
    /async call\(input: WorkflowInput, context: ToolUseContext, canUseTool: CanUseToolFn\)/.test(tool))
  check('runCtx wraps it via makeWorkflowCanUseTool (no bare undefined)',
    /canUseTool: makeWorkflowCanUseTool\(\{/.test(tool) && !/canUseTool: undefined,/.test(tool))
  check('wrapper gets the LIVE agentControllers map',
    /getAgentControllers: \(\) => task\.agentControllers/.test(tool))
  check('registerWorkflowTask seeds pendingPermissions',
    /pendingPermissions: new Map<string, PendingWorkflowPermission>\(\)/.test(task))
  check('terminal transition clears pendingPermissions',
    /agentControllers: undefined,\s*\n\s*pendingPermissions: undefined,/.test(task))
  check('timeout env registered in the flag registry',
    /MERCURY_WORKFLOW_PERMISSION_TIMEOUT_MS/.test(flags))
}

section('the ask LABEL: the consent card names the workflow and the agent')
{
  const { workflowAskBadgeName } = await import(
    '../../src/tools/WorkflowTool/workflowPermissionChannel.ts'
  )
  const task = {
    workflowName: 'daedalus',
    workflowProgress: [
      { type: 'workflow_agent', index: 0, agentId: 'a1234567890', label: 'scan:alpha' },
    ],
  }
  check('badge = workflow · agent label', workflowAskBadgeName(task, 'a1234567890') === 'daedalus · scan:alpha')
  check('unknown agent falls back to its id prefix', workflowAskBadgeName(task, 'zz9876543210') === 'daedalus · zz987654')
  check('nameless run still says workflow', workflowAskBadgeName(undefined, undefined) === 'workflow')
  check(
    'summary stands in for a missing name',
    workflowAskBadgeName({ summary: 'audit the tree' }, undefined) === 'audit the tree',
  )

  // Behavioral: the wrapper stamps the badge onto the per-call context
  // BEFORE delegating, so the interactive handler can lift it onto the card.
  const taskId = 'wf-badge-task'
  const store = makeStore(taskId)
  ;(store as { pendingState?: unknown }).pendingState = undefined
  let seenBadge: unknown
  const wrapped = makeWorkflowCanUseTool({
    taskId,
    setAppState: store.setAppState,
    realCanUseTool: (async (_t: unknown, _i: unknown, tuc: unknown) => {
      seenBadge = (tuc as { workflowAskBadge?: unknown }).workflowAskBadge
      return ALLOW
    }) as never,
    getAgentControllers: () => undefined,
    getAppState: () => ({
      tasks: {
        [taskId]: {
          workflowName: 'daedalus',
          workflowProgress: [
            { type: 'workflow_agent', index: 0, agentId: 'agent-1', label: 'scan:alpha' },
          ],
        },
      },
    }),
  })
  const tuc = ctx(true, 'agent-1')
  await wrapped(TOOL, {}, tuc, MSG, 'badge-ask-1')
  check(
    'wrapper stamps { name: workflow · agent, color } on the ask context',
    JSON.stringify(seenBadge) === JSON.stringify({ name: 'daedalus · scan:alpha', color: 'yellow' }),
    JSON.stringify(seenBadge),
  )
  const handler = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'hooks', 'toolPermission', 'handlers', 'interactiveHandler.ts'),
    'utf-8',
  )
  check('interactive handler lifts the badge onto the card entry', /workflowAskBadge/.test(handler) && /workerBadge/.test(handler))
  const board = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'components', 'tasks', 'WorkflowsBoard.tsx'),
    'utf-8',
  )
  check(
    "the /workflows board offers the ANSWER route (key 'a' on rows with pending asks)",
    /key: 'a',\s*\n\s*label: 'answer ask'/.test(board) && /pendingPermissions\?\.size \?\? 0\) > 0/.test(board),
  )
}

section('mode-follow: workflow agents ride the MAIN session permission mode')
{
  // The subagent definition pins NO permissionMode, so agentGetAppState
  // passes the parent's LIVE mode through unchanged — the ruling
  // "workflow agents follow the main session's permission mode".
  const hooks = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'tools', 'WorkflowTool', 'agentHooks.ts'),
    'utf-8',
  )
  const defBlock = hooks.slice(hooks.indexOf('export const WORKFLOW_SUBAGENT_DEF'), hooks.indexOf('export const WORKFLOW_SUBAGENT_SCHEMA_DEF'))
  check('WORKFLOW_SUBAGENT_DEF declares no permissionMode override', !/permissionMode/.test(defBlock))
  const runner = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'tools', 'AgentTool', 'runAgent.ts'),
    'utf-8',
  )
  // The derivation lives in the posture owner (agentPermissionPosture.ts):
  // the runner hands the definition's mode to composeAgentAppState, and the
  // owner overrides the parent's mode ONLY when the definition names one —
  // no definition mode ⇒ the parent's live mode rides through unchanged.
  const posture = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'tools', 'AgentTool', 'agentPermissionPosture.ts'),
    'utf-8',
  )
  check(
    'runner derives the agent mode from the PARENT state when no definition mode',
    /const parentGetAppState = toolUseContext.getAppState/.test(runner) &&
      /composeAgentAppState\(state, \{\s*definitionMode,/.test(runner) &&
      /facts\.definitionMode &&/.test(posture) &&
      /mode: facts\.definitionMode/.test(posture),
  )
  check(
    'a pending ask heartbeats the inactivity watchdog (ask ≠ silence)',
    /A PENDING PERMISSION ASK IS NOT SILENCE/.test(runner) && /canUseToolAskLively/.test(runner),
  )
}

console.log('')
if (failures > 0) {
  console.log(`RESULT: RED — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('RESULT: GREEN — permission channel fail-closed across the input space')
