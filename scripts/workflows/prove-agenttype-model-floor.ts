#!/usr/bin/env bun
// ============================================================================
//  scripts/workflows/prove-agenttype-model-floor.ts
//  PROOF: the workflow engine's half of the hard "NEVER Haiku" fork directive.
//
//  agent({agentType:'Explore'}) resolves the SAME registry the Agent tool uses,
//  and the built-in Explore definition pins model:'haiku' for speed. Two layers
//  keep a fork workflow agent off Haiku; this proof pins the FIRST (which had
//  zero regression coverage — it was held only by a code comment):
//    1. defaultResolveCustomAgentType (agentHooks.ts) splices {model:'inherit'}
//       over ANY custom agentType definition when the build stamp — the
//       agent rides the main-loop model instead of a low-tier pin;
//    2. runAgent's getAgentModel wraps every resolution in
//       enforceSubagentModelFloor (proven by scripts/model-floor/).
//
//  Exercised through the REAL makeWorkflowHooks agent() path with an injected
//  capture-fake spawnSubagentStream (the sanctioned dep seam) — NOT a mirror of
//  the resolver. Sensitivity is proven by the bare-stamp branch: with the build
//  macro absent the SAME call must pass the Haiku pin through unchanged (base
//  parity), so the stamped assertion cannot pass vacuously.
//
//  Run:  ~/.bun/bin/bun run scripts/workflows/prove-agenttype-model-floor.ts
// ============================================================================

// Fork-sim BEFORE import; the build stamp reads MACRO live per call, so the
// bare-stamp branch below flips this global between hook builds.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { makeWorkflowHooks } = await import('../../src/tools/WorkflowTool/agentHooks.js')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

console.log('============================================================')
console.log(' workflow agentType model floor — proof')
console.log('============================================================')

// The Haiku-pinned built-in shape (mirrors exploreAgent.ts: model:'haiku' for
// non-ants). The proof plants it in the active registry and watches what the
// spawn seam receives.
const HAIKU_PINNED_EXPLORE = {
  agentType: 'Explore',
  whenToUse: 'read-only exploration',
  tools: ['Read', 'Grep', 'Glob'],
  model: 'haiku',
  getSystemPrompt: () => 'You are a read-only explorer.',
}

type CapturedSpawn = { agentDefinition: unknown; model?: string }
const captured: CapturedSpawn[] = []

// Capture-fake spawn: records the resolved definition, then yields one minimal
// successful assistant turn so agent() resolves normally.
const fakeSpawn = async function* (args: { agentDefinition: unknown; model?: string }) {
  captured.push({ agentDefinition: args.agentDefinition, model: args.model })
  yield {
    type: 'assistant' as const,
    message: {
      content: [{ type: 'text', text: 'probe-ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
    },
  }
}

function freshHooks() {
  return makeWorkflowHooks({
    toolUseContext: {
      abortController: new AbortController(),
      options: {
        agentDefinitions: { activeAgents: [HAIKU_PINNED_EXPLORE] },
        mainLoopModel: 'claude-opus-4-8',
      },
    },
    canUseTool: async () => ({ behavior: 'allow' }),
    emitProgress: () => {},
    workflowRunId: undefined,
    onAgentController: () => {},
    seedPhaseTitles: [],
    args: undefined,
    spawnSubagentStream: fakeSpawn as never,
  } as never)
}

// ── stamp branch: the Haiku pin must be overridden to 'inherit' ──────────────
{
  captured.length = 0
  const hooks = freshHooks() as { agent: (p: string, o?: Record<string, unknown>) => Promise<unknown> }
  const result = await hooks.agent('probe the registry', { agentType: 'Explore' })
  const def = (captured[0]?.agentDefinition ?? {}) as { model?: string; agentType?: string }
  check('agent() resolved the planted Explore definition', def.agentType === 'Explore')
  check("stamped build: Haiku pin overridden to model:'inherit' at the spawn seam", def.model === 'inherit', `got model=${JSON.stringify(def.model)}`)
  check('agent() resolves with the fake stream', typeof result === 'string' && result.includes('probe-ok'))
}

// ── bare stamp: the floor is stamp-independent ───────────
{
  // the never-Haiku floor holds under ANY stamp, so a mis-stamped build
  // cannot silently drop the model-floor protection.
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-src' }
  captured.length = 0
  const hooks = freshHooks() as { agent: (p: string, o?: Record<string, unknown>) => Promise<unknown> }
  await hooks.agent('probe again', { agentType: 'Explore' })
  const def = (captured[0]?.agentDefinition ?? {}) as { model?: string }
  check("bare stamp: Haiku pin STILL overridden to 'inherit' (stamp-independence)", def.model === 'inherit', `got model=${JSON.stringify(def.model)}`)
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
}

// ── unknown agentType still refuses loudly (registry contract intact) ───────
{
  const hooks = freshHooks() as { agent: (p: string, o?: Record<string, unknown>) => Promise<unknown> }
  let threw = ''
  try {
    await hooks.agent('probe', { agentType: 'NoSuchAgent' })
  } catch (e) {
    threw = String(e)
  }
  check('unknown agentType throws with the available-agents message', /not found/.test(threw), threw.slice(0, 80))
}

console.log('\n' + '═'.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} AGENTTYPE-FLOOR CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL AGENTTYPE-FLOOR PROOFS PASS')
