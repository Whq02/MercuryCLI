#!/usr/bin/env bun
// ============================================================================
//  scripts/agents/prove-launch-plan.ts — the ONE typed subagent launch plan.
//
//  buildAgentLaunchPlan() is the frozen resolution every AgentTool dispatch
//  rides: canonical type decode (the SAME truth the teammate resolver uses —
//  the tool's private alias-map copy is absent), fork/default routing, the
//  Agent(x,y) restriction + denial band with byte-exact error surface, the
//  model + never-Haiku floor note, the isolation override order, the async
//  decision law, and the worker permission mode. deriveRunnerAgentDefinition
//  is the teammate side of plan assembly (canonical identity · team-essential
//  tool injection · role tool denials · 'default' permission mode).
//
//    §1 canonical decode — ONE truth with the teammate resolver
//    §2 lookup, restriction, and the denial band (byte-exact errors)
//    §3 model resolution + the never-Haiku floor note
//    §4 isolation · the async decision law · worker permission mode
//    §5 the runner's definition product
//    §6 seam ratchets — the consumers actually consume the plan
//
//  Run:  ~/.bun/bin/bun run scripts/agents/prove-launch-plan.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test' // pure resolution only — nothing reaches the API

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const ROOT = join(import.meta.dir, '..', '..')
const src = (...p: string[]) => readFileSync(join(ROOT, 'src', ...p), 'utf-8')

const { buildAgentLaunchPlan, deriveRunnerAgentDefinition, TEAM_ESSENTIAL_TOOLS } =
  await import('../../src/utils/swarm/agentLaunchPlan.ts')
const { resolveTeammateRole } = await import('../../src/utils/swarm/roleResolver.ts')
const { getBuiltInAgents } = await import('../../src/tools/AgentTool/builtInAgents.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

const FORK_STUB = {
  agentType: 'fork-stub',
  whenToUse: 'fork stub',
  source: 'built-in',
  getSystemPrompt: () => 'fork',
} as never
const SCOUT = {
  agentType: 'mercury-scout',
  whenToUse: 'recon',
  source: 'built-in',
  tools: ['Read', 'Grep'],
  disallowedTools: ['Edit', 'Write'],
  model: 'sonnet',
  getSystemPrompt: () => 'scout prompt',
} as never as Record<string, unknown>
const GENERAL = {
  agentType: 'general-purpose',
  whenToUse: 'anything',
  source: 'built-in',
  getSystemPrompt: () => 'gp prompt',
} as never as Record<string, unknown>
const HAIKU_PINNED = {
  agentType: 'legacy-haiku-role',
  whenToUse: 'legacy frontmatter pin',
  source: 'projectSettings',
  model: 'haiku',
  getSystemPrompt: () => 'legacy',
} as never as Record<string, unknown>
const BG_ROLE = {
  agentType: 'bg-role',
  whenToUse: 'always background',
  source: 'projectSettings',
  background: true,
  isolation: 'worktree',
  permissionMode: 'strategy',
  getSystemPrompt: () => 'bg',
} as never as Record<string, unknown>

const ACTIVE = [SCOUT, GENERAL, HAIKU_PINNED, BG_ROLE] as never[]

function base(over: Record<string, unknown> = {}): never {
  return {
    activeAgents: ACTIVE,
    toolPermissionContext: getEmptyToolPermissionContext(),
    forkGateOn: false,
    forkAgent: FORK_STUB,
    defaultAgentType: 'general-purpose',
    mainLoopModel: 'claude-opus-4-8',
    backgroundTasksDisabled: false,
    forceAsync: false,
    ...over,
  } as never
}

console.log('============================================================')
console.log(' Agent launch plan — one typed resolution for every dispatch')
console.log('============================================================')

section('§1 — canonical decode: ONE truth with the teammate resolver')
{
  const plan = buildAgentLaunchPlan(base({ requestedType: 'Explore' }))
  check("legacy 'Explore' decodes to the canonical Mercury id", plan.agentType === 'mercury-scout', plan.agentType)
  const teammate = resolveTeammateRole({
    teammateName: 'x',
    requestedAgentType: 'Explore',
    agents: getBuiltInAgents() as never,
    prompt: 'p',
  })
  check('the subagent plan and the teammate resolver agree on the decode', plan.agentType === teammate.agentType)
  check('explicit canonical type resolves to its definition', buildAgentLaunchPlan(base({ requestedType: 'mercury-scout' })).definition === (SCOUT as never))
}

section('§2 — lookup, restriction, and the denial band')
{
  let err: Error | undefined
  try {
    buildAgentLaunchPlan(base({ requestedType: 'no-such-agent' }))
  } catch (e) {
    err = e as Error
  }
  check(
    'unknown type → the not-found error lists the available roster',
    err?.message === `Agent type 'no-such-agent' not found. Available agents: mercury-scout, general-purpose, legacy-haiku-role, bg-role`,
    err?.message,
  )

  const denyCtx = {
    ...getEmptyToolPermissionContext(),
    alwaysDenyRules: { userSettings: ['Agent(mercury-scout)'] },
  }
  err = undefined
  try {
    buildAgentLaunchPlan(base({ requestedType: 'mercury-scout', toolPermissionContext: denyCtx }))
  } catch (e) {
    err = e as Error
  }
  check(
    'denied type → the denial error names the rule and its source',
    err?.message === `Agent type 'mercury-scout' has been denied by permission rule 'Agent(mercury-scout)' from userSettings.`,
    err?.message,
  )

  err = undefined
  try {
    buildAgentLaunchPlan(base({ requestedType: 'mercury-scout', allowedAgentTypes: ['general-purpose'] }))
  } catch (e) {
    err = e as Error
  }
  // Characterized legacy shape (verbatim from AgentTool): a restriction-
  // excluded type that IS registered reports as denied-with-'settings' —
  // the exists-but-filtered branch fires before the unknown-type branch.
  check(
    'an Agent(x,y) tool-spec restriction excludes unlisted types (legacy denied-shape error)',
    err?.message === `Agent type 'mercury-scout' has been denied by permission rule 'Agent(mercury-scout)' from settings.`,
    err?.message,
  )

  check('stamp gate ON + no type → the fork path with the injected definition', (() => {
    const p = buildAgentLaunchPlan(base({ forkGateOn: true }))
    return p.isForkPath && p.definition === (FORK_STUB as never)
  })())
  check('stamp gate OFF + no type → the default type', (() => {
    const p = buildAgentLaunchPlan(base({}))
    return !p.isForkPath && p.agentType === 'general-purpose'
  })())
}

section('§3 — model resolution + the never-Haiku floor note')
{
  const floored = buildAgentLaunchPlan(base({ requestedType: 'legacy-haiku-role' }))
  check('a legacy haiku frontmatter pin is FLOORED, never run', !/haiku/i.test(floored.model), floored.model)
  check('the floor is SURFACED: flooredFrom + the caller-visible note', !!floored.flooredFrom && !!floored.modelNote && floored.modelNote.includes("below Mercury's never-Haiku floor"), floored.modelNote)

  const explicit = buildAgentLaunchPlan(base({ requestedType: 'general-purpose', modelParam: 'opus' }))
  check('an explicit model param resolves without a floor note', /opus/i.test(explicit.model) && explicit.modelNote === undefined, explicit.model)
  const defPin = buildAgentLaunchPlan(base({ requestedType: 'mercury-scout' }))
  check("the definition's model pin resolves when no param is given", /sonnet/i.test(defPin.model), defPin.model)
}

section('§4 — isolation · the async decision law · worker permission mode')
{
  check('explicit isolation param wins over the definition', buildAgentLaunchPlan(base({ requestedType: 'bg-role', isolationParam: 'remote' })).isolation === 'remote')
  check("the definition's isolation carries when no param is given", buildAgentLaunchPlan(base({ requestedType: 'bg-role' })).isolation === 'worktree')
  check('no isolation anywhere → undefined', buildAgentLaunchPlan(base({ requestedType: 'general-purpose' })).isolation === undefined)

  check('run_in_background → async', buildAgentLaunchPlan(base({ requestedType: 'general-purpose', runInBackground: true })).shouldRunAsync === true)
  check('background:true definition → async', buildAgentLaunchPlan(base({ requestedType: 'bg-role' })).shouldRunAsync === true)
  check('forceAsync → async', buildAgentLaunchPlan(base({ requestedType: 'general-purpose', forceAsync: true })).shouldRunAsync === true)
  check('nothing forcing → sync', buildAgentLaunchPlan(base({ requestedType: 'general-purpose' })).shouldRunAsync === false)
  check('backgroundTasksDisabled kills EVERY async route', buildAgentLaunchPlan(base({ requestedType: 'bg-role', runInBackground: true, forceAsync: true, backgroundTasksDisabled: true })).shouldRunAsync === false)

  check("the worker mode is the definition's permissionMode", buildAgentLaunchPlan(base({ requestedType: 'bg-role' })).workerPermissionMode === 'strategy')
  check("no definition mode → the 'implement' worker default", buildAgentLaunchPlan(base({ requestedType: 'general-purpose' })).workerPermissionMode === 'implement')
}

section("§5 — the runner's definition product")
{
  const role = resolveTeammateRole({
    teammateName: 'scout-7',
    requestedAgentType: 'mercury-scout',
    agents: getBuiltInAgents() as never,
    prompt: 'p',
  })
  const def = deriveRunnerAgentDefinition({
    role,
    agentDefinition: role.definition,
    displayName: 'scout-7',
    systemPrompt: 'COMPOSED PROMPT',
  })
  check('canonical role id, never the display name', def.agentType === 'mercury-scout', def.agentType)
  check('the composed prompt is the definition prompt', def.getSystemPrompt() === 'COMPOSED PROMPT')
  // The real scout has no explicit tool list (denials only) ⇒ all tools.
  check('a denial-only role keeps the all-tools list', Array.isArray(def.tools) && def.tools[0] === '*')
  check('role tool DENIALS survive in-process', Array.isArray(def.disallowedTools) && def.disallowedTools.includes('Edit'))
  // An EXPLICIT role tool list gets the team-essential union.
  const explicitDef = deriveRunnerAgentDefinition({
    agentDefinition: SCOUT as never,
    displayName: 'listed',
    systemPrompt: 's',
  })
  check('team-essential tools ride explicit role tool lists', TEAM_ESSENTIAL_TOOLS.every(t => explicitDef.tools?.includes(t)))
  check('the role tool contract survives beside them', ['Read', 'Grep'].every(t => explicitDef.tools?.includes(t)))
  check("the base permission mode is 'default' (full tool access; live task mode overlays per turn)", def.permissionMode === 'default')
  check("the role's model pin propagates", typeof def.model === 'string' && def.model !== 'haiku')

  const bare = deriveRunnerAgentDefinition({ displayName: 'freeform', systemPrompt: 's' })
  check('no role/definition → display-name identity + all tools', bare.agentType === 'freeform' && Array.isArray(bare.tools) && bare.tools[0] === '*')
}

section('§6 — seam ratchets: the consumers consume the plan')
{
  const agentTool = src('tools', 'AgentTool', 'AgentTool.tsx')
  check('AgentTool resolves through buildAgentLaunchPlan', agentTool.includes('buildAgentLaunchPlan({'))
  check('AgentTool keeps NO alias-map copy (decode has ONE home)', !agentTool.includes('LEGACY_SUBAGENT_ALIASES'))
  check('AgentTool no longer resolves the model inline', !agentTool.includes('getAgentModelWithFloorNote('))
  const runner = src('utils', 'swarm', 'inProcessRunner.ts')
  check('the runner consumes deriveRunnerAgentDefinition', runner.includes('deriveRunnerAgentDefinition({'))
  check('the runner keeps NO inline definition literal', !runner.includes("whenToUse: `In-process teammate"))
  const planSrc = src('utils', 'swarm', 'agentLaunchPlan.ts')
  check('the plan builder decodes via the ONE truth (roleResolver.decodeAgentType)', planSrc.includes('decodeAgentType(i.requestedType)'))

  // 7.3 — AgentTool.tsx owns schema/launch/presentation ONLY; the foreground
  // execution machine (sync loop · backgrounding race · summarization · SDK
  // bookend) lives in foregroundExecution.tsx.
  const fg = src('tools', 'AgentTool', 'foregroundExecution.tsx')
  check('AgentTool dispatches foreground runs to the execution module', agentTool.includes('runForegroundAgentExecution({'))
  for (const landmark of ['registerAgentForeground(', 'BackgroundHint', 'agentIterator', 'backgroundRace']) {
    check(`the execution machine landmark '${landmark}' lives in foregroundExecution, not the tool`, fg.includes(landmark) && !agentTool.includes(landmark))
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ LAUNCH PLAN GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} LAUNCH-PLAN FAILURE(S)`)
process.exit(1)
