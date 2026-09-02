#!/usr/bin/env bun
// ============================================================================
//  scripts/decisions/prove-decision-matrix.ts — the permission decision-chain
//  matrix.
//
//  Drives the REAL engine (hasPermissionsToUseTool + checkRuleBasedPermissions
//  — live-loadable: no feature() blockers remain) with fake tools over a decision table: modes × rule kinds ×
//  tool-verdict kinds. What gets frozen is the ORDERED STAGE CONTRACT:
//
//    0   capability kill-switch
//    1a  tool-level DENY rule            (bypass-immune)
//    1b  tool-level ASK rule             (fires even in bypass; beats allow)
//    1c  tool.checkPermissions           (schema parse; errors → passthrough)
//    1d  tool deny                       (bypass-immune)
//    1e  requiresUserInteraction ask     (bypass-immune)
//    1f  content ask-RULE                (bypass-immune)
//    1f' MCP org ask-ceiling             (bypass-immune)
//    1g  safetyCheck ask                 (bypass-immune)
//    2a  bypass-posture modes            (bypassPermissions · autopilot ·
//                                         plan+bypassAvailable) → allow
//    2b  tool-level ALLOW rule → allow
//    3   passthrough → ask
//  wrapper: dontAsk converts ask→deny · auto-mode floors force a HUMAN ask
//  BEFORE any classifier (ask-rule floor, PowerShell guard, headless deny) ·
//  the acceptEdits fast-path allows without a classifier call.
//
//  Auto-mode rows deliberately stop at pre-classifier paths — the classifier
//  itself is covered by scripts/permissions/prove-classifier-*.
//
//  Run:  ~/.bun/bin/bun run scripts/decisions/prove-decision-matrix.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'decisions-home-'))

import { z } from 'zod/v4'

const { hasPermissionsToUseTool, checkRuleBasedPermissions } = await import(
  '../../src/utils/permissions/permissions.ts'
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
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — matrix exceeded 90s (a row reached a live API path?)')
  process.exit(1)
}, 90_000)
guard.unref?.()

// ---------------------------------------------------------------------------
type Verdict =
  | { behavior: 'passthrough' }
  | { behavior: 'allow' }
  | { behavior: 'deny' }
  | { behavior: 'ask'; reason?: 'rule-ask' | 'safetyCheck' | 'plain' }
  | { behavior: 'allow-under-acceptEdits' }
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
    checkPermissions: async (
      _input: unknown,
      ctx: { getAppState: () => { toolPermissionContext: { mode: string } } },
    ) => {
      switch (verdict.behavior) {
        case 'throw':
          throw new Error('checkPermissions exploded')
        case 'allow':
          return { behavior: 'allow', updatedInput: { touched: true } }
        case 'deny':
          return { behavior: 'deny', message: 'tool said no', decisionReason: { type: 'other', reason: 'tool said no' } }
        case 'allow-under-acceptEdits':
          if (ctx.getAppState().toolPermissionContext.mode === 'implement') {
            return { behavior: 'allow', updatedInput: { via: 'implement' } }
          }
          return { behavior: 'ask', message: 'needs approval' }
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
  avoidPrompts?: boolean
} = {}): unknown {
  const toolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    mode: (opts.mode ?? 'default') as never,
    alwaysAllowRules: opts.allow ? { userSettings: opts.allow } : {},
    alwaysDenyRules: opts.deny ? { userSettings: opts.deny } : {},
    alwaysAskRules: opts.ask ? { userSettings: opts.ask } : {},
    isBypassPermissionsModeAvailable: opts.bypassAvailable ?? false,
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
  }
}

const ASSISTANT = { message: { id: 'msg_matrix' } } as never
const decide = (tool: unknown, ctx: unknown): Promise<{ behavior: string; decisionReason?: { type?: string; mode?: string }; message?: string; updatedInput?: unknown }> =>
  hasPermissionsToUseTool(tool as never, {}, ctx as never, ASSISTANT, 'toolu_matrix') as never

console.log('============================================================')
console.log(' Permission decision matrix — the ordered stage contract')
console.log('============================================================')

// ---------------------------------------------------------------------------
section('stage 3 + 2a — mode outcomes for an opinion-less tool')
{
  const rows: Array<[string, Record<string, unknown>, string, string | undefined]> = [
    ['default → ask', { mode: 'default' }, 'ask', undefined],
    ['acceptEdits + passthrough → ask', { mode: 'implement' }, 'ask', undefined],
    ['strategy (no bypass) + passthrough → ask', { mode: 'strategy' }, 'ask', undefined],
    ['bypassPermissions → allow (mode reason)', { mode: 'sovereign' }, 'allow', 'mode'],
    ['autopilot → allow (bypass-posture twin)', { mode: 'autopilot' }, 'allow', 'mode'],
    ['strategy + bypassAvailable → allow', { mode: 'strategy', bypassAvailable: true }, 'allow', 'mode'],
    ['dontAsk converts ask → deny', { mode: 'dontAsk' }, 'deny', 'mode'],
  ]
  for (const [label, ctxOpts, want, wantReason] of rows) {
    const r = await decide(makeTool(), makeContext(ctxOpts))
    check(
      label,
      r.behavior === want && (wantReason === undefined || r.decisionReason?.type === wantReason),
      j({ behavior: r.behavior, reason: r.decisionReason }),
    )
  }
}

// ---------------------------------------------------------------------------
section('stages 1a/1b/2b — tool-level rules and their precedence')
{
  let r = await decide(makeTool(), makeContext({ deny: ['FakeTool'] }))
  check('deny rule → deny with rule reason', r.behavior === 'deny' && r.decisionReason?.type === 'rule', j(r.decisionReason))

  r = await decide(makeTool(), makeContext({ mode: 'sovereign', deny: ['FakeTool'] }))
  check('deny rule is BYPASS-IMMUNE (1a before 2a)', r.behavior === 'deny', j(r))

  r = await decide(makeTool(), makeContext({ allow: ['FakeTool'] }))
  check('allow rule → allow with rule reason', r.behavior === 'allow' && r.decisionReason?.type === 'rule', j(r.decisionReason))

  r = await decide(makeTool(), makeContext({ ask: ['FakeTool'] }))
  check('ask rule → ask with rule reason', r.behavior === 'ask' && r.decisionReason?.type === 'rule', j(r.decisionReason))

  r = await decide(makeTool(), makeContext({ deny: ['FakeTool'], allow: ['FakeTool'] }))
  check('deny beats allow', r.behavior === 'deny', j(r))

  r = await decide(makeTool(), makeContext({ ask: ['FakeTool'], allow: ['FakeTool'] }))
  check('ask rule beats allow rule (1b before 2b)', r.behavior === 'ask', j(r))

  r = await decide(makeTool(), makeContext({ mode: 'sovereign', ask: ['FakeTool'] }))
  check('tool-level ask rule fires EVEN IN BYPASS (1b before 2a, as-is)', r.behavior === 'ask', j(r))

  r = await decide(makeTool({ name: 'mcp__srv__thing' }), makeContext({ deny: ['mcp__srv'] }))
  check('MCP server-level deny matches server tools', r.behavior === 'deny', j(r))
}

// ---------------------------------------------------------------------------
section('stages 1c–1g — tool-verdict handling and bypass immunity')
{
  let r = await decide(makeTool({ verdict: { behavior: 'deny' } }), makeContext({ mode: 'sovereign' }))
  check('tool deny is bypass-immune (1d)', r.behavior === 'deny', j(r))

  r = await decide(makeTool({ verdict: { behavior: 'allow' } }), makeContext({}))
  check('tool allow flows through with its updatedInput', r.behavior === 'allow' && j(r.updatedInput) === j({ touched: true }), j(r))

  r = await decide(
    makeTool({ verdict: { behavior: 'ask', reason: 'plain' }, requiresUserInteraction: true }),
    makeContext({ mode: 'sovereign' }),
  )
  check('requiresUserInteraction ask is bypass-immune (1e)', r.behavior === 'ask', j(r))

  r = await decide(makeTool({ verdict: { behavior: 'ask', reason: 'rule-ask' } }), makeContext({ mode: 'sovereign' }))
  check('content ask-RULE is bypass-immune (1f)', r.behavior === 'ask', j(r))

  r = await decide(makeTool({ orgAskCeiling: true }), makeContext({ mode: 'sovereign' }))
  check("MCP org ask-ceiling is bypass-immune (1f')", r.behavior === 'ask', j(r))

  r = await decide(makeTool({ verdict: { behavior: 'ask', reason: 'safetyCheck' } }), makeContext({ mode: 'sovereign' }))
  check('safetyCheck ask is bypass-immune (1g)', r.behavior === 'ask', j(r))

  r = await decide(makeTool({ verdict: { behavior: 'throw' } }), makeContext({}))
  check('checkPermissions failure degrades to passthrough → ask (never allow)', r.behavior === 'ask', j(r))

  r = await decide(makeTool({ verdict: { behavior: 'ask', reason: 'plain' } }), makeContext({ mode: 'sovereign' }))
  check('PLAIN tool ask (no rule/safety reason) IS bypassed → allow (as-is)', r.behavior === 'allow', j(r))
}

// ---------------------------------------------------------------------------
section('auto mode — pre-classifier floors and fast paths')
{
  // Ask-RULE floor: a content ask rule forces the HUMAN prompt, no classifier.
  let r = await decide(makeTool({ verdict: { behavior: 'ask', reason: 'rule-ask' } }), makeContext({ mode: 'flow' }))
  check('auto: content ask-rule floors to a human ask', r.behavior === 'ask', j(r))

  // Same floor headless: deny with the asyncAgent reason.
  r = await decide(
    makeTool({ verdict: { behavior: 'ask', reason: 'rule-ask' } }),
    makeContext({ mode: 'flow', avoidPrompts: true }),
  )
  check('auto+headless: the floor becomes a structured deny (asyncAgent)', r.behavior === 'deny' && r.decisionReason?.type === 'asyncAgent', j(r))

  // Non-approvable safetyCheck: immune to every auto path.
  r = await decide(makeTool({ verdict: { behavior: 'ask', reason: 'safetyCheck' } }), makeContext({ mode: 'flow' }))
  check('auto: non-approvable safetyCheck stays a human ask', r.behavior === 'ask', j(r))

  // PowerShell guard: never classified.
  r = await decide(makeTool({ name: 'PowerShell', verdict: { behavior: 'ask', reason: 'plain' } }), makeContext({ mode: 'flow' }))
  check('auto: PowerShell asks the human (never the classifier)', r.behavior === 'ask', j(r))

  // implement fast path: allowed WITHOUT a classifier call, mode-flow reason.
  r = await decide(makeTool({ verdict: { behavior: 'allow-under-acceptEdits' } }), makeContext({ mode: 'flow' }))
  check(
    'flow: implement fast-path allows without a classifier (mode flow reason)',
    r.behavior === 'allow' && r.decisionReason?.type === 'mode' && (r.decisionReason as { mode?: string }).mode === 'flow',
    j(r),
  )

  // Tool-level ask rule floors too (hasAskRuleReason covers 1b's reason).
  r = await decide(makeTool(), makeContext({ mode: 'flow', ask: ['FakeTool'] }))
  check('flow: tool-level ask rule floors to a human ask', r.behavior === 'ask', j(r))
}

// ---------------------------------------------------------------------------
section('checkRuleBasedPermissions — the hook-allow guard path')
{
  const rb = (tool: unknown, ctx: unknown): Promise<{ behavior?: string; decisionReason?: { type?: string } } | null> =>
    checkRuleBasedPermissions(tool as never, {}, ctx as never) as never

  check('clean tool + no rules → null (hook allow may proceed)', (await rb(makeTool(), makeContext({}))) === null)
  check('deny rule → deny', (await rb(makeTool(), makeContext({ deny: ['FakeTool'] })))?.behavior === 'deny')
  check('ask rule → ask', (await rb(makeTool(), makeContext({ ask: ['FakeTool'] })))?.behavior === 'ask')
  check('tool deny → deny', (await rb(makeTool({ verdict: { behavior: 'deny' } }), makeContext({})))?.behavior === 'deny')
  check('content ask-rule → ask', (await rb(makeTool({ verdict: { behavior: 'ask', reason: 'rule-ask' } }), makeContext({})))?.behavior === 'ask')
  check("org ask-ceiling → ask", (await rb(makeTool({ orgAskCeiling: true }), makeContext({})))?.behavior === 'ask')
  check('safetyCheck → ask', (await rb(makeTool({ verdict: { behavior: 'ask', reason: 'safetyCheck' } }), makeContext({})))?.behavior === 'ask')
  check('plain tool ask → null (mode layer decides later)', (await rb(makeTool({ verdict: { behavior: 'ask', reason: 'plain' } }), makeContext({}))) === null)
}

// ---------------------------------------------------------------------------
section('abort totality')
{
  const ctx = makeContext({}) as { abortController: AbortController }
  ctx.abortController.abort()
  let threw = false
  try {
    await decide(makeTool(), ctx)
  } catch {
    threw = true
  }
  check('pre-aborted signal throws (never a silent verdict)', threw)
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ DECISION MATRIX GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} DECISION MATRIX FAILURE(S)`)
process.exit(1)
