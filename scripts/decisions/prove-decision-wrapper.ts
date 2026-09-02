#!/usr/bin/env bun
// ============================================================================
//  scripts/decisions/prove-decision-wrapper.ts — the owned MODE-WRAPPER band.
//
//  prove-decision-matrix.ts freezes the wrapper's pre-classifier behavior
//  through the public entry (dontAsk conversion · the four floors · the
//  acceptEdits fast-path · headless structured denies). THIS proof drives
//  decideToolPermissionWithModes (decision/wrapper.ts) with INJECTED
//  WrapperPorts to pin the paths that need a live API or hook system:
//    • the classifier verdicts — allowed · blocked · unavailable with the
//      iron gate closed (deny) and open (fall back to the human ask) ·
//      transcript-too-long (manual fallback; headless ABORTS);
//    • denial tracking — blocked increments, allow resets, the consecutive
//      denial limit falls back to prompting with the review warning;
//    • the fast-path ports (acceptEdits · allowlist) and the plan+auto twin
//      gate (isAutoModeActive);
//    • the headless hook band — hook allow/deny honored, null ⇒ auto-deny;
//    • the WRAPPER TRACE subsequence law — consulted stages are an ordered
//      subsequence of WRAPPER_STAGE_ORDER; decidedBy 'engine' ⇔ pass-through.
//
//  Run:  ~/.bun/bin/bun run scripts/decisions/prove-decision-wrapper.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'decision-wrapper-'))

import { z } from 'zod/v4'

const { decideToolPermissionWithModes, defaultWrapperPorts } = await import(
  '../../src/utils/permissions/decision/wrapper.ts'
)
const { WRAPPER_STAGE_ORDER } = await import(
  '../../src/utils/permissions/decision/trace.ts'
)
const { hasPermissionsToUseTool } = await import(
  '../../src/utils/permissions/permissions.ts'
)
const { DENIAL_LIMITS } = await import(
  '../../src/utils/permissions/denialTracking.ts'
)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { AbortError } = await import('../../src/utils/errors.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — wrapper proof exceeded 60s (a row reached a live API path?)')
  process.exit(1)
}, 60_000)
guard.unref?.()

//
function makeTool(over: { name?: string; behavior?: 'passthrough' | 'ask' } = {}): unknown {
  const name = over.name ?? 'FakeTool'
  return {
    name,
    inputSchema: z.object({}).passthrough(),
    checkPermissions: async () =>
      over.behavior === 'ask'
        ? { behavior: 'ask', message: 'plain ask' }
        : { behavior: 'passthrough', message: 'no opinion' },
  }
}

function makeContext(opts: {
  mode?: string
  avoidPrompts?: boolean
  denial?: { consecutiveDenials: number; totalDenials: number }
} = {}): unknown {
  const toolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    mode: (opts.mode ?? 'flow') as never,
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...(opts.avoidPrompts ? { shouldAvoidPermissionPrompts: true } : {}),
  }
  const appState = { toolPermissionContext, denialTracking: undefined }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    options: {},
    ...(opts.denial ? { localDenialTracking: { ...opts.denial } } : {}),
  }
}

const ASSISTANT = { message: { id: 'msg_wrapper' } } as never

type Ports = typeof defaultWrapperPorts
/** Ports that never reach a live path: allowlist off, acceptEdits probe asks,
 *  classifier must be provided per-row. */
function makePorts(over: Partial<Ports>): Ports {
  return {
    ...defaultWrapperPorts,
    isAllowlistedTool: () => false,
    resolveAcceptEditsVerdict: async () => ({ behavior: 'ask', message: 'still ask' }),
    classify: async () => {
      throw new Error('classifier must not be reached by this row')
    },
    runHeadlessHooks: async () => null,
    ...over,
  }
}

const classifierResult = (over: Record<string, unknown>): never =>
  ({ shouldBlock: false, unavailable: false, reason: 'r', model: 'fake-model', ...over }) as never

type Outcome = {
  decision: { behavior: string; message?: string; decisionReason?: { type?: string; reason?: string } }
  engineTrace: { decidedBy: string }
  wrapper: { stages: Array<{ stage: string; outcome: string; note?: string }>; decidedBy: string }
}
const run = (tool: unknown, ctx: unknown, ports: Ports): Promise<Outcome> =>
  decideToolPermissionWithModes(tool as never, {}, ctx as never, ASSISTANT, 'toolu_wrapper', ports) as never

/** Wrapper subsequence law: stage ids appear in WRAPPER_STAGE_ORDER order;
 *  all records 'pass' except a single final 'decided' matching decidedBy
 *  (or decidedBy 'engine' with zero decided records). */
function checkSubsequenceLaw(label: string, wrapper: Outcome['wrapper']): void {
  const order = WRAPPER_STAGE_ORDER as readonly string[]
  let cursor = -1
  let inOrder = true
  for (const s of wrapper.stages) {
    const idx = order.indexOf(s.stage)
    if (idx <= cursor) inOrder = false
    cursor = idx
  }
  const decidedRecords = wrapper.stages.filter(s => s.outcome === 'decided')
  const last = wrapper.stages[wrapper.stages.length - 1]
  const terminalOk =
    wrapper.decidedBy === 'engine'
      ? decidedRecords.length === 0
      : decidedRecords.length === 1 && last?.stage === wrapper.decidedBy && last?.outcome === 'decided'
  check(`${label} — wrapper subsequence law`, inOrder && terminalOk, j(wrapper))
}

console.log('============================================================')
console.log(' Mode-wrapper band — ports, classifier orchestration, trace')
console.log('============================================================')

//
section('classifier verdicts (injected classify port)')
{
  // Allowed → allow with the classifier reason; denial streak resets.
  const denial = { consecutiveDenials: 2, totalDenials: 5 }
  const ctx = makeContext({ mode: 'flow', denial })
  let r = await run(makeTool(), ctx, makePorts({ classify: async () => classifierResult({ reason: 'safe action' }) }))
  check(
    'allowed → allow with classifier reason',
    r.decision.behavior === 'allow' && r.decision.decisionReason?.type === 'classifier',
    j(r.decision),
  )
  check('allowed → decidedBy classifier', r.wrapper.decidedBy === 'classifier', j(r.wrapper))
  check('allowed → consecutive denials reset in local tracking', (ctx as { localDenialTracking: { consecutiveDenials: number } }).localDenialTracking.consecutiveDenials === 0)
  checkSubsequenceLaw('classifier allowed', r.wrapper)

  // Blocked with a consent card available → the ASK returns to the operator
  // carrying the classifier reason (the card); denial recorded.
  const denial2 = { consecutiveDenials: 0, totalDenials: 0 }
  const ctx2 = makeContext({ mode: 'flow', denial: denial2 })
  r = await run(makeTool(), ctx2, makePorts({ classify: async () => classifierResult({ shouldBlock: true, reason: 'dangerous' }) }))
  check(
    'blocked (card available) → ask with classifier reason',
    r.decision.behavior === 'ask' && r.decision.decisionReason?.type === 'classifier' && r.decision.decisionReason.reason === 'dangerous',
    j(r.decision),
  )
  check('blocked → denial recorded in local tracking', (ctx2 as { localDenialTracking: { consecutiveDenials: number; totalDenials: number } }).localDenialTracking.consecutiveDenials === 1)
  checkSubsequenceLaw('classifier blocked', r.wrapper)

  // Blocked with NO consent card (prompt-less agent) → deny with the reason.
  const ctx2h = makeContext({ mode: 'flow', avoidPrompts: true, denial: { consecutiveDenials: 0, totalDenials: 0 } })
  r = await run(makeTool(), ctx2h, makePorts({ classify: async () => classifierResult({ shouldBlock: true, reason: 'dangerous' }) }))
  check(
    'blocked (no card) → deny with classifier reason',
    r.decision.behavior === 'deny' && r.decision.decisionReason?.type === 'classifier',
    j(r.decision),
  )
  checkSubsequenceLaw('classifier blocked headless', r.wrapper)

  // Unavailable + INTERACTIVE → the ask returns to the human regardless of
  // the iron gate (the flow-incident law: a present operator is
  // never locked behind a machine-denial retry loop; handing to a human is
  // fail-closed).
  r = await run(
    makeTool(),
    makeContext({ mode: 'flow' }),
    makePorts({
      classify: async () => classifierResult({ shouldBlock: true, unavailable: true }),
      ironGateClosed: () => true,
    }),
  )
  check(
    'unavailable + interactive → human ask (gate closed does not deny a present human)',
    r.decision.behavior === 'ask' && (r.decision.decisionReason?.reason ?? '').includes('unavailable'),
    j(r.decision),
  )
  check(
    'unavailable + interactive trace notes the human ask',
    (r.wrapper.stages.find(s => s.stage === 'classifier')?.note ?? '').includes('human ask'),
    j(r.wrapper),
  )

  // Unavailable + HEADLESS + iron gate CLOSED → deny (fail closed).
  r = await run(
    makeTool(),
    makeContext({ mode: 'flow', avoidPrompts: true }),
    makePorts({
      classify: async () => classifierResult({ shouldBlock: true, unavailable: true }),
      ironGateClosed: () => true,
    }),
  )
  check(
    'unavailable + headless + iron gate closed → deny (fail closed)',
    r.decision.behavior === 'deny' && (r.decision.decisionReason?.reason ?? '').includes('unavailable'),
    j(r.decision),
  )

  // Unavailable + HEADLESS + iron gate OPEN → the engine ask falls back (fail open).
  r = await run(
    makeTool(),
    makeContext({ mode: 'flow', avoidPrompts: true }),
    makePorts({
      classify: async () => classifierResult({ shouldBlock: true, unavailable: true }),
      ironGateClosed: () => false,
    }),
  )
  check('unavailable + headless + iron gate open → falls back to the channel ask', r.decision.behavior === 'ask', j(r.decision))
  check('fail-open trace notes it', (r.wrapper.stages.find(s => s.stage === 'classifier')?.note ?? '').includes('fail open'), j(r.wrapper))

  // Transcript too long → manual fallback ask with the 'other' reason.
  r = await run(
    makeTool(),
    makeContext({ mode: 'flow' }),
    makePorts({ classify: async () => classifierResult({ shouldBlock: true, transcriptTooLong: true }) }),
  )
  check(
    'transcript too long → manual-approval fallback ask',
    r.decision.behavior === 'ask' && (r.decision.decisionReason?.reason ?? '').includes('context window'),
    j(r.decision),
  )

  // Transcript too long + headless → ABORTS (permanent condition).
  let threw = false
  try {
    await run(
      makeTool(),
      makeContext({ mode: 'flow', avoidPrompts: true }),
      makePorts({ classify: async () => classifierResult({ shouldBlock: true, transcriptTooLong: true }) }),
    )
  } catch (e) {
    threw = e instanceof AbortError
  }
  check('transcript too long + headless → AbortError', threw)
}

//
section('the consecutive denial limit falls back to prompting')
{
  const denial = { consecutiveDenials: DENIAL_LIMITS.maxConsecutive - 1, totalDenials: 5 }
  const ctx = makeContext({ mode: 'flow', denial })
  const r = await run(makeTool(), ctx, makePorts({ classify: async () => classifierResult({ shouldBlock: true, reason: 'still dangerous' }) }))
  check(
    'limit reached → ask (fall back to prompting) with the review warning',
    r.decision.behavior === 'ask' && (r.decision.decisionReason?.reason ?? '').includes('consecutive actions were blocked'),
    j(r.decision),
  )
  check('limit path → decidedBy denialLimit', r.wrapper.decidedBy === 'denialLimit', j(r.wrapper))
  checkSubsequenceLaw('denial limit', r.wrapper)

  // Headless: the limit ABORTS instead of prompting.
  const ctx2 = makeContext({ mode: 'flow', avoidPrompts: true, denial: { ...denial } })
  let threw = false
  try {
    await run(makeTool(), ctx2, makePorts({ classify: async () => classifierResult({ shouldBlock: true, reason: 'still dangerous' }) }))
  } catch (e) {
    threw = e instanceof AbortError
  }
  check('limit reached + headless → AbortError', threw)
}

//
section('fast-path ports and the strategy+flow twin gate')
{
  // acceptEdits fast-path via the port.
  let r = await run(
    makeTool(),
    makeContext({ mode: 'flow' }),
    makePorts({ resolveAcceptEditsVerdict: async () => ({ behavior: 'allow', updatedInput: { via: 'port' } }) }),
  )
  check(
    'implement port allow → mode-flow allow without the classifier',
    r.decision.behavior === 'allow' && r.wrapper.decidedBy === 'acceptEditsFastPath',
    j({ decision: r.decision, decidedBy: r.wrapper.decidedBy }),
  )
  checkSubsequenceLaw('acceptEdits fast-path', r.wrapper)

  // Allowlist fast-path via the port.
  r = await run(makeTool(), makeContext({ mode: 'flow' }), makePorts({ isAllowlistedTool: () => true }))
  check(
    'allowlist port → mode-flow allow without the classifier',
    r.decision.behavior === 'allow' && r.wrapper.decidedBy === 'allowlistFastPath',
    j({ decision: r.decision, decidedBy: r.wrapper.decidedBy }),
  )

  // strategy mode engages the flow band ONLY when isAutoModeActive.
  r = await run(makeTool(), makeContext({ mode: 'strategy' }), makePorts({ isAutoModeActive: () => true, isAllowlistedTool: () => true }))
  check('strategy + isAutoModeActive → the flow band engages (allowlist allow)', r.decision.behavior === 'allow', j(r.decision))
  r = await run(makeTool(), makeContext({ mode: 'strategy' }), makePorts({ isAutoModeActive: () => false }))
  check('strategy + flow inactive → the engine ask stands (decidedBy engine)', r.decision.behavior === 'ask' && r.wrapper.decidedBy === 'engine', j(r.wrapper))
}

//
section('the headless hook band')
{
  // Hook allow honored.
  let r = await run(
    makeTool(),
    makeContext({ mode: 'default', avoidPrompts: true }),
    makePorts({ runHeadlessHooks: async () => ({ behavior: 'allow', updatedInput: {}, decisionReason: { type: 'hook', hookName: 'PermissionRequest' } }) as never }),
  )
  check('hook allow → decidedBy headlessHooks', r.decision.behavior === 'allow' && r.wrapper.decidedBy === 'headlessHooks', j(r.wrapper))

  // Hook deny honored.
  r = await run(
    makeTool(),
    makeContext({ mode: 'default', avoidPrompts: true }),
    makePorts({ runHeadlessHooks: async () => ({ behavior: 'deny', message: 'hook says no', decisionReason: { type: 'hook', hookName: 'PermissionRequest' } }) as never }),
  )
  check('hook deny → deny', r.decision.behavior === 'deny' && r.decision.message === 'hook says no', j(r.decision))

  // No hook decision → the auto-deny.
  r = await run(makeTool(), makeContext({ mode: 'default', avoidPrompts: true }), makePorts({}))
  check(
    'no hook decision → asyncAgent auto-deny',
    r.decision.behavior === 'deny' && r.decision.decisionReason?.type === 'asyncAgent',
    j(r.decision),
  )
  check('auto-deny → decidedBy headlessAutoDeny after a headlessHooks pass', r.wrapper.decidedBy === 'headlessAutoDeny' && r.wrapper.stages.some(s => s.stage === 'headlessHooks' && s.outcome === 'pass'), j(r.wrapper))
  checkSubsequenceLaw('headless auto-deny', r.wrapper)
}

//
section('pass-through identity + public-entry parity (default ports)')
{
  // Non-auto interactive ask: the wrapper passes the engine result through.
  const r = await run(makeTool(), makeContext({ mode: 'default' }), makePorts({}))
  check("default mode ask → decidedBy 'engine', no wrapper stages consulted", r.wrapper.decidedBy === 'engine' && r.wrapper.stages.length === 0, j(r.wrapper))

  // The public entry returns the same decision (default ports, identity modes).
  for (const mode of ['default', 'sovereign', 'dontAsk']) {
    const a = await run(makeTool(), makeContext({ mode }), defaultWrapperPorts)
    const b = await (hasPermissionsToUseTool as never as (...x: unknown[]) => Promise<unknown>)(
      makeTool(),
      {},
      makeContext({ mode }),
      ASSISTANT,
      'toolu_wrapper',
    )
    check(`${mode}: hasPermissionsToUseTool === wrapper decision`, j(b) === j(a.decision), j({ a: a.decision, b }))
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ DECISION WRAPPER GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} DECISION WRAPPER FAILURE(S)`)
process.exit(1)
