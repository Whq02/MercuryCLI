#!/usr/bin/env bun
// ============================================================================
//  scripts/decisions/prove-decision-trace.ts — the owned decision engine's
//  DecisionTrace contract.
//
//  The behavior contract is frozen by prove-decision-matrix.ts (which drives
//  the public wrappers). THIS proof pins the ENGINE surface itself
//  (src/utils/permissions/decision/engine.ts):
//    • the PREFIX LAW — a trace's stage sequence is always an exact prefix of
//      DECISION_STAGE_ORDER for its entry, ending at the deciding stage
//      (every consulted stage recorded, in order, nothing skipped);
//    • decidedBy lands on the expected stage for each terminal outcome;
//    • DecisionPorts are honored (kill-switch · sandbox ask-rule fallthrough ·
//      verdict-resolution failure degrades to passthrough→ask, aborts rethrow);
//    • the ruleSubset entry yields null + decidedBy 'none' on no-objection and
//      (pinned as-is) never checks the abort signal, while the full entry
//      throws on a pre-aborted signal;
//    • the wrapper parity seam: hasPermissionsToUseTool returns the engine's
//      decision byte-identically on identity-wrapper modes.
//
//  Run:  ~/.bun/bin/bun run scripts/decisions/prove-decision-trace.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'decision-trace-'))

import { z } from 'zod/v4'

const { decideToolPermission, decideRuleBasedPermissions, defaultDecisionPorts } =
  await import('../../src/utils/permissions/decision/engine.ts')
const { DECISION_STAGE_ORDER, formatDecisionTrace } = await import(
  '../../src/utils/permissions/decision/trace.ts'
)
const { hasPermissionsToUseTool } = await import(
  '../../src/utils/permissions/permissions.ts'
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
  console.log('\n❌ TIMEOUT — trace proof exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()

// --------------------------------------------------------------------------
type Verdict =
  | { behavior: 'passthrough' }
  | { behavior: 'allow' }
  | { behavior: 'deny' }
  | { behavior: 'ask'; reason?: 'rule-ask' | 'safetyCheck' | 'plain' }
  | { behavior: 'throw' }

function makeTool(over: {
  name?: string
  verdict?: Verdict
  requiresUserInteraction?: boolean
  orgAskCeiling?: boolean
} = {}): unknown {
  const name = over.name ?? 'FakeTool'
  const verdict = over.verdict ?? { behavior: 'passthrough' }
  return {
    name,
    inputSchema: z.object({}).passthrough(),
    ...(over.requiresUserInteraction ? { requiresUserInteraction: () => true } : {}),
    ...(over.orgAskCeiling
      ? { mcpInfo: { serverName: 'srv', scope: 'project', effectiveMaxPermission: 'ask' } }
      : {}),
    checkPermissions: async () => {
      switch (verdict.behavior) {
        case 'throw':
          throw new Error('checkPermissions exploded')
        case 'allow':
          return { behavior: 'allow', updatedInput: { touched: true } }
        case 'deny':
          return { behavior: 'deny', message: 'tool said no', decisionReason: { type: 'other', reason: 'tool said no' } }
        case 'ask':
          if (verdict.reason === 'rule-ask') {
            return {
              behavior: 'ask',
              message: 'content ask rule',
              decisionReason: {
                type: 'rule',
                rule: {
                  source: 'userSettings',
                  ruleBehavior: 'ask',
                  ruleValue: { toolName: name, ruleContent: 'danger:*' },
                },
              },
            }
          }
          if (verdict.reason === 'safetyCheck') {
            return {
              behavior: 'ask',
              message: 'safety check',
              decisionReason: { type: 'safetyCheck', reason: 'protected path', classifierApprovable: false },
            }
          }
          return { behavior: 'ask', message: 'plain ask' }
        default:
          return { behavior: 'passthrough', message: 'no opinion' }
      }
    },
  }
}

function makeContext(opts: {
  mode?: string
  allow?: string[]
  deny?: string[]
  ask?: string[]
  bypassAvailable?: boolean
} = {}): unknown {
  const toolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    mode: (opts.mode ?? 'default') as never,
    alwaysAllowRules: opts.allow ? { userSettings: opts.allow } : {},
    alwaysDenyRules: opts.deny ? { userSettings: opts.deny } : {},
    alwaysAskRules: opts.ask ? { userSettings: opts.ask } : {},
    isBypassPermissionsModeAvailable: opts.bypassAvailable ?? false,
  }
  const appState = { toolPermissionContext, denialTracking: undefined }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    options: {},
  }
}

type Trace = {
  entry: string
  toolName: string
  mode: string
  stages: Array<{ stage: string; outcome: string; note?: string }>
  decidedBy: string
}
const full = (tool: unknown, ctx: unknown, ports?: unknown): Promise<{ decision: { behavior: string }; trace: Trace }> =>
  decideToolPermission(tool as never, {}, ctx as never, (ports ?? defaultDecisionPorts) as never) as never
const subset = (tool: unknown, ctx: unknown, ports?: unknown): Promise<{ decision: { behavior: string } | null; trace: Trace }> =>
  decideRuleBasedPermissions(tool as never, {}, ctx as never, (ports ?? defaultDecisionPorts) as never) as never

/** The prefix law: stages are an exact prefix of the entry's order, every
 *  record before the last is 'pass', and the last record matches decidedBy. */
function checkPrefixLaw(label: string, trace: Trace): void {
  const order = DECISION_STAGE_ORDER[trace.entry as 'full' | 'ruleSubset'] as readonly string[]
  const ids = trace.stages.map(s => s.stage)
  const isPrefix =
    ids.length <= order.length && ids.every((id, i) => id === order[i])
  const last = trace.stages[trace.stages.length - 1]
  const terminalOk =
    trace.decidedBy === 'none'
      ? trace.stages.every(s => s.outcome === 'pass')
      : last?.stage === trace.decidedBy &&
        last?.outcome === 'decided' &&
        trace.stages.slice(0, -1).every(s => s.outcome === 'pass')
  check(`${label} — prefix law + terminal marking`, isPrefix && terminalOk, formatDecisionTrace(trace as never))
}

console.log('============================================================')
console.log(' DecisionTrace — the owned engine surface')
console.log('============================================================')

// --------------------------------------------------------------------------
section('full entry — decidedBy lands on the expected stage per terminal outcome')
{
  const rows: Array<[string, unknown, unknown, string, string]> = [
    ['deny rule', makeTool(), makeContext({ deny: ['FakeTool'] }), 'toolDenyRule', 'deny'],
    ['ask rule', makeTool(), makeContext({ ask: ['FakeTool'] }), 'toolAskRule', 'ask'],
    ['tool deny', makeTool({ verdict: { behavior: 'deny' } }), makeContext({}), 'toolVerdictDeny', 'deny'],
    [
      'requiresUserInteraction ask',
      makeTool({ verdict: { behavior: 'ask', reason: 'plain' }, requiresUserInteraction: true }),
      makeContext({}),
      'userInteractionAsk',
      'ask',
    ],
    [
      'content ask-rule',
      makeTool({ verdict: { behavior: 'ask', reason: 'rule-ask' } }),
      makeContext({}),
      'contentAskRule',
      'ask',
    ],
    ['org ask-ceiling', makeTool({ orgAskCeiling: true }), makeContext({}), 'orgAskCeiling', 'ask'],
    [
      'safetyCheck ask',
      makeTool({ verdict: { behavior: 'ask', reason: 'safetyCheck' } }),
      makeContext({}),
      'safetyCheckAsk',
      'ask',
    ],
    ['bypass posture', makeTool(), makeContext({ mode: 'sovereign' }), 'bypassPosture', 'allow'],
    ['allow rule', makeTool(), makeContext({ allow: ['FakeTool'] }), 'toolAllowRule', 'allow'],
    ['passthrough → ask at resolution', makeTool(), makeContext({}), 'resolution', 'ask'],
    ['tool allow stands at resolution', makeTool({ verdict: { behavior: 'allow' } }), makeContext({}), 'resolution', 'allow'],
  ]
  for (const [label, tool, ctx, wantStage, wantBehavior] of rows) {
    const { decision, trace } = await full(tool, ctx)
    check(
      `${label} → decidedBy ${wantStage} (${wantBehavior})`,
      trace.decidedBy === wantStage && decision.behavior === wantBehavior,
      j({ decidedBy: trace.decidedBy, behavior: decision.behavior }),
    )
    checkPrefixLaw(label, trace)
  }
}

// --------------------------------------------------------------------------
section('ruleSubset entry — null on no-objection, subset order, no abort gate')
{
  let r = await subset(makeTool(), makeContext({}))
  check('no objection → null decision', r.decision === null, j(r.decision))
  check("no objection → decidedBy 'none'", r.trace.decidedBy === 'none', j(r.trace))
  checkPrefixLaw('subset no-objection', r.trace)

  r = await subset(makeTool({ verdict: { behavior: 'ask', reason: 'plain' } }), makeContext({}))
  check('plain tool ask → null (mode layer decides later)', r.decision === null)

  r = await subset(makeTool({ orgAskCeiling: true }), makeContext({ mode: 'sovereign' }))
  check('org ask-ceiling → decidedBy orgAskCeiling', r.trace.decidedBy === 'orgAskCeiling', j(r.trace))
  checkPrefixLaw('subset org-ceiling', r.trace)

  // The subset never consulted the abort signal pre-cutover — pinned as-is.
  const aborted = makeContext({}) as { abortController: AbortController }
  aborted.abortController.abort()
  let threw = false
  try {
    r = await subset(makeTool(), aborted)
  } catch {
    threw = true
  }
  check('pre-aborted signal does NOT throw on the subset (as-is)', !threw && r.decision === null)
}

// --------------------------------------------------------------------------
section('full entry — abort gate')
{
  const aborted = makeContext({}) as { abortController: AbortController }
  aborted.abortController.abort()
  let threw = false
  try {
    await full(makeTool(), aborted)
  } catch {
    threw = true
  }
  check('pre-aborted signal throws on the full entry', threw)
}

// --------------------------------------------------------------------------
section('DecisionPorts are honored')
{
  const killPorts = { ...defaultDecisionPorts, isToolKilled: () => true }
  let r = await full(makeTool(), makeContext({ mode: 'sovereign' }), killPorts)
  check(
    'injected kill-switch decides at killSwitch, even in bypass',
    r.trace.decidedBy === 'killSwitch' && r.decision.behavior === 'deny',
    j({ decidedBy: r.trace.decidedBy, behavior: r.decision.behavior }),
  )
  checkPrefixLaw('kill-switch', r.trace)

  const sandboxPorts = { ...defaultDecisionPorts, sandboxAutoAllows: () => true }
  r = await full(makeTool(), makeContext({ ask: ['FakeTool'] }), sandboxPorts)
  const askRecord = r.trace.stages.find(s => s.stage === 'toolAskRule')
  check(
    'sandbox policy lets the ask rule fall through (noted in the trace)',
    r.trace.decidedBy === 'resolution' &&
      askRecord?.outcome === 'pass' &&
      (askRecord?.note ?? '').includes('sandbox'),
    j(r.trace),
  )

  const failPorts = {
    ...defaultDecisionPorts,
    resolveToolVerdict: async () => {
      throw new Error('port exploded')
    },
  }
  r = await full(makeTool({ verdict: { behavior: 'allow' } }), makeContext({}), failPorts)
  const verdictRecord = r.trace.stages.find(s => s.stage === 'toolVerdict')
  check(
    'verdict-resolution failure degrades to passthrough → ask (never allow)',
    r.decision.behavior === 'ask' && (verdictRecord?.note ?? '').includes('failed'),
    j({ behavior: r.decision.behavior, note: verdictRecord?.note }),
  )

  const abortPorts = {
    ...defaultDecisionPorts,
    resolveToolVerdict: async () => {
      throw new AbortError()
    },
  }
  let threw = false
  try {
    await full(makeTool(), makeContext({}), abortPorts)
  } catch (e) {
    threw = e instanceof AbortError
  }
  check('an AbortError from verdict resolution rethrows (abort totality)', threw)
}

// --------------------------------------------------------------------------
section('wrapper parity — the public entry returns the engine decision')
{
  for (const [label, tool, ctx] of [
    ['default mode ask', makeTool(), makeContext({})],
    ['bypass allow', makeTool(), makeContext({ mode: 'sovereign' })],
    ['deny rule', makeTool(), makeContext({ deny: ['FakeTool'] })],
  ] as Array<[string, unknown, unknown]>) {
    const engine = await full(tool, ctx)
    const wrapper = await (hasPermissionsToUseTool as never as (
      ...a: unknown[]
    ) => Promise<unknown>)(tool, {}, ctx, { message: { id: 'msg_trace' } }, 'toolu_trace')
    check(`${label}: wrapper === engine decision`, j(wrapper) === j(engine.decision), j({ wrapper, engine: engine.decision }))
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ DECISION TRACE GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} DECISION TRACE FAILURE(S)`)
process.exit(1)
