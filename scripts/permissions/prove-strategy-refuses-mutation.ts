#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'strategy-refuses-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { z } from 'zod/v4'

const { decideToolPermission, decideRuleBasedPermissions } = await import('../../src/utils/permissions/decision/engine.ts')
const { decideToolPermissionWithModes, defaultWrapperPorts } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { permissionModeFromString, permissionModeTitle } = await import('../../src/utils/permissions/PermissionMode.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Map ? Object.fromEntries(x) : x))

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — a row reached a live path')
  process.exit(1)
}, 60_000)
guard.unref?.()

const REFUSAL = `${permissionModeTitle('strategy')} refused running`

type Rules = Record<string, string[]>
type Ctx = {
  mode: string
  bypassAvailable?: boolean
  allow?: Rules
}
function makeContext(opts: Ctx): unknown {
  const toolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    mode: opts.mode as never,
    alwaysAllowRules: opts.allow ?? {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: opts.bypassAvailable === true,
  }
  const appState = { toolPermissionContext, denialTracking: undefined }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    options: {},
    localDenialTracking: { consecutiveDenials: 0, totalDenials: 0 },
  }
}

const bashLikeTool = {
  name: 'Bash',
  inputSchema: z.object({ command: z.string() }).passthrough(),
  checkPermissions: async (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) =>
    bashToolHasPermission(input, context.getAppState().toolPermissionContext as never),
}

type Decision = { behavior: string; message?: string; decisionReason?: { type?: string; mode?: string; rule?: unknown } }
type EngineOutcome = { decision: Decision; trace: { decidedBy: string; stages: Array<{ stage: string; outcome: string; note?: string }> } }
type WrapperOutcome = { decision: Decision; engineTrace: EngineOutcome['trace']; wrapper: { decidedBy: string } }

const engine = (command: string, ctx: Ctx): Promise<EngineOutcome> =>
  decideToolPermission(bashLikeTool as never, { command }, makeContext(ctx) as never) as never

const refused = (d: Decision, segment: string): boolean =>
  d.behavior === 'deny' &&
  (d.message ?? '').startsWith(`${REFUSAL} \`${segment}\``) &&
  d.decisionReason?.type === 'mode' &&
  d.decisionReason.mode === 'strategy'

const MUTATION = 'rm -rf build'
const COMMIT = 'git commit -m x'

console.log('============================================================')
console.log(' Strategy mode refuses a shell command that modifies files')
console.log('============================================================')

section('§1 road 1 — the bypass-available posture stands every ask down; the refusal must survive it')
{
  const r = await engine(MUTATION, { mode: 'strategy', bypassAvailable: true })
  check(
    `strategy + bypass available: \`${MUTATION}\` is REFUSED with the mode's words`,
    refused(r.decision, MUTATION),
    `behavior=${r.decision.behavior} decidedBy=${r.trace.decidedBy} message=${j(r.decision.message)}`,
  )
  check('the refusal is the tool verdict deny (the bypass-immune band), not a posture answer', r.trace.decidedBy === 'toolVerdictDeny', `decidedBy=${r.trace.decidedBy}`)
  check('the refusal names what to do instead (present the plan)', /ExitStrategyMode/.test(r.decision.message ?? ''), j(r.decision.message))
}

section('§2 road 2 — a standing allow rule is matched in strategy mode as in any other')
{
  const content = await engine(COMMIT, { mode: 'strategy', allow: { localSettings: ['Bash(git commit:*)'] } })
  check(
    `strategy + Bash(git commit:*) allow rule: \`${COMMIT}\` is REFUSED before the rule can allow it`,
    refused(content.decision, COMMIT),
    `behavior=${content.decision.behavior} decidedBy=${content.trace.decidedBy} reason=${j(content.decision.decisionReason)}`,
  )
  const whole = await engine(MUTATION, { mode: 'strategy', allow: { localSettings: ['Bash'] } })
  check(
    `strategy + whole-tool Bash allow rule: \`${MUTATION}\` is REFUSED before the tool allow rule`,
    refused(whole.decision, MUTATION),
    `behavior=${whole.decision.behavior} decidedBy=${whole.trace.decidedBy}`,
  )
}

section('§3 road 3 — flow engaged under strategy has the machinery answer the ask')
{
  const ports = {
    ...defaultWrapperPorts,
    isAutoModeActive: () => true,
    isAllowlistedTool: () => false,
    classify: async () => ({ shouldBlock: false, unavailable: false, reason: 'stub allowed', model: 'stub-model' }) as never,
    runHeadlessHooks: async () => null,
  }
  const r = (await decideToolPermissionWithModes(
    bashLikeTool as never,
    { command: MUTATION },
    makeContext({ mode: 'strategy' }) as never,
    { message: { id: 'msg_strategy' } } as never,
    'toolu_strategy_flow',
    ports,
  )) as unknown as WrapperOutcome
  check(
    `strategy + flow engaged: \`${MUTATION}\` is REFUSED before the classifier or a fast-path can allow it`,
    refused(r.decision, MUTATION),
    `behavior=${r.decision.behavior} wrapper=${r.wrapper.decidedBy} engine=${r.engineTrace.decidedBy}`,
  )
  check('the wrapper passed the engine deny through untouched', r.wrapper.decidedBy === 'engine' && r.engineTrace.decidedBy === 'toolVerdictDeny', `wrapper=${r.wrapper.decidedBy} engine=${r.engineTrace.decidedBy}`)
}

section('§4 the hook-laundering road — a rewritten input is re-checked by the rule band')
{
  const r = (await decideRuleBasedPermissions(bashLikeTool as never, { command: MUTATION }, makeContext({ mode: 'strategy', bypassAvailable: true }) as never)) as unknown as {
    decision: Decision | null
  }
  check('strategy: the rule band objects to a hook-rewritten mutation (deny, never silence)', r.decision !== null && refused(r.decision, MUTATION), j(r.decision))
}

section('§5 the compound is judged segment by segment; the redirect leg is judged too')
{
  const compound = await engine(`git status && ${MUTATION}`, { mode: 'strategy', bypassAvailable: true })
  check('`git status && rm -rf build`: refused, naming the mutating segment alone', refused(compound.decision, MUTATION), j(compound.decision.message))
  const redirect = await engine('ls -la; echo hi > notes.md', { mode: 'strategy', bypassAvailable: true })
  check('`ls -la; echo hi > notes.md`: refused, naming the write redirection', refused(redirect.decision, '> notes.md'), j(redirect.decision.message))
  const piped = await engine("find . -name '*.o' | xargs rm", { mode: 'strategy', bypassAvailable: true })
  check('`find . | xargs rm`: refused on the xargs segment', refused(piped.decision, 'xargs rm'), j(piped.decision.message))
}

section('§6 the read-only control — strategy mode keeps allowing what it allowed')
{
  const readOnly = await engine('git status && ls -la', { mode: 'strategy', bypassAvailable: true })
  check('`git status && ls -la` is still allowed in strategy mode', readOnly.decision.behavior === 'allow', `behavior=${readOnly.decision.behavior} decidedBy=${readOnly.trace.decidedBy}`)
  const search = await engine('rg -n "strategy" src/', { mode: 'strategy' })
  check('`rg -n strategy src/` is still allowed in strategy mode (read-only allowlist)', search.decision.behavior === 'allow', `behavior=${search.decision.behavior}`)
  const scratch = await engine('echo hi > /tmp/strategy-scratch.txt', { mode: 'strategy' })
  check('a redirect into the temp dir is not refused (it keeps its ordinary road)', scratch.decision.behavior !== 'deny', `behavior=${scratch.decision.behavior} message=${j(scratch.decision.message)}`)
  const unprovable = await engine('bun run typecheck', { mode: 'strategy' })
  check('an unprovable command keeps its ask (never a refusal, never an allow)', unprovable.decision.behavior === 'ask' && !(unprovable.decision.message ?? '').startsWith(REFUSAL), `behavior=${unprovable.decision.behavior}`)
}

section('§7 every other mode is unchanged')
{
  const expectations: Array<[string, string, Ctx]> = [
    ['default', 'ask', { mode: 'default' }],
    ['implement', 'allow', { mode: 'implement' }],
    ['sovereign', 'allow', { mode: 'sovereign' }],
    ['autopilot', 'allow', { mode: 'autopilot' }],
    ['flow', 'ask', { mode: 'flow' }],
    ['dontAsk', 'ask', { mode: 'dontAsk' }],
    ['apollo', 'ask', { mode: 'apollo' }],
    ['default + bypass available', 'ask', { mode: 'default', bypassAvailable: true }],
    ['default + whole-tool Bash allow rule', 'allow', { mode: 'default', allow: { localSettings: ['Bash'] } }],
  ]
  for (const [label, behavior, ctx] of expectations) {
    const r = await engine(MUTATION, ctx)
    check(
      `${label}: \`${MUTATION}\` → ${behavior}, never the strategy refusal`,
      r.decision.behavior === behavior && !(r.decision.message ?? '').startsWith(REFUSAL),
      `behavior=${r.decision.behavior} decidedBy=${r.trace.decidedBy} message=${j(r.decision.message)}`,
    )
  }
  const ruled = await engine(COMMIT, { mode: 'default', allow: { localSettings: ['Bash(git commit:*)'] } })
  check(
    `default + Bash(git commit:*) allow rule: \`${COMMIT}\` → allow by the rule, never the strategy refusal`,
    ruled.decision.behavior === 'allow' && j(ruled.decision.decisionReason).includes('"ruleContent":"git commit:*"'),
    `behavior=${ruled.decision.behavior} decidedBy=${ruled.trace.decidedBy} reason=${j(ruled.decision.decisionReason)}`,
  )
}

section('§8 the retired spelling decodes to the same mode, so the refusal follows the alias')
{
  const decoded = permissionModeFromString('plan')
  check("'plan' decodes to 'strategy' at the read boundary", decoded === 'strategy', decoded)
  const r = await engine(MUTATION, { mode: decoded, bypassAvailable: true })
  check('a session resumed under the retired spelling refuses the same mutation', refused(r.decision, MUTATION), `behavior=${r.decision.behavior}`)
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-strategy-refuses-mutation: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-strategy-refuses-mutation: all green')
