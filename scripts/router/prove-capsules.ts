#!/usr/bin/env bun
// ============================================================================
//  scripts/router/prove-capsules.ts
//  PROOF: context capsules are BOUNDED and digest-stable; truncation is
//  RECORDED (omitted[]), never silent; the delivery frame carries the five
//  sections a fresh process orients from; the synthesis packet is assembled
//  from typed completions ONLY (missing completions are named, never invented);
//  parseCompletionDetail is total (leading-JSON + trailing prose parses;
//  prose-only → null → the caller records prose-as-summary honestly).
//  Run: ~/.bun/bin/bun run scripts/router/prove-capsules.ts
// ============================================================================
import {
  CAPSULE_MAX_BYTES,
  buildContextCapsule,
  buildSynthesisPacket,
  parseCompletionDetail,
  renderCapsuleFrame,
} from '../../src/utils/router/contextCapsule.js'
import type { RouteNode, TaskRoutePlan } from '../../src/utils/router/contracts.js'

let failures = 0
const check = (cond: boolean, msg: string): void => {
  if (cond) console.log(`  [PASS] ${msg}`)
  else {
    failures++
    console.error(`  [FAIL] ${msg}`)
  }
}

const NOW = 1_800_000_000_000
const node = (id: string, over: Partial<RouteNode> = {}): RouteNode => ({
  id,
  title: `node ${id}`,
  task: `do the ${id} work`,
  dependsOn: [],
  ownsPaths: [`src/${id}.ts`],
  acceptance: [{ id: `${id}-a1`, description: 'tests green', kind: 'report' }],
  state: 'ready',
  attempt: 1,
  expectedResult: 'a typed completion',
  ...over,
})
const plan = (nodes: RouteNode[]): TaskRoutePlan => ({
  version: 1,
  id: 'rp-cap',
  revision: 1,
  mode: 'party',
  title: 'capsule test',
  objective: 'prove the capsule bounds',
  features: {
    taskShape: 'bounded',
    ambiguity: 0,
    coupling: 0,
    parallelism: 1,
    contextDemand: 1,
    verificationDemand: 1,
    estimatedFiles: 1,
    explicitPaths: [],
    requiresSynthesis: true,
  },
  profile: 'dependency-graph',
  nodes,
  synthesis: { required: true, owner: 'router', acceptance: [] },
  decision: {
    policyVersion: 'router-1',
    source: 'structured-intent',
    posture: 'adaptive',
    selectedProfile: 'dependency-graph',
    selectedModels: [],
    decisiveReasons: [],
    displayReasons: [],
    adjustments: [],
  },
  state: 'running',
  createdAt: NOW,
  updatedAt: NOW,
})

// ── Bounds + recorded truncation ─────────────────────────────────────────────
{
  const huge = Array.from({ length: 60 }, (_, ix) => `decision ${ix}: ${'x'.repeat(700)}`)
  const p = plan([node('n1', { task: 'y'.repeat(9000) })])
  const cap = buildContextCapsule({ plan: p, node: p.nodes[0]!, decisions: huge, knownFailures: huge, now: NOW })
  const bytes = JSON.stringify({ ...cap, id: undefined, digest: undefined }).length
  check(bytes <= CAPSULE_MAX_BYTES + 2_000, `oversized inputs stay near the ceiling (${bytes}B vs ${CAPSULE_MAX_BYTES}B cap)`)
  check(cap.omitted.length > 0, `truncation RECORDED (${cap.omitted.length} omission note(s)), never silent`)
  check(cap.decisions.length <= 12, 'list cap applied')
}

// ── Digest stability + revision identity ─────────────────────────────────────
{
  const p = plan([node('n1')])
  const a = buildContextCapsule({ plan: p, node: p.nodes[0]!, decisions: ['keep it simple'], now: NOW })
  const b = buildContextCapsule({ plan: p, node: p.nodes[0]!, decisions: ['keep it simple'], now: NOW })
  check(a.digest === b.digest && a.id === b.id, 'same inputs ⇒ same digest + id (stable canonical serialization)')
  const p2 = plan([node('n1', { attempt: 2 })])
  const c = buildContextCapsule({ plan: p2, node: p2.nodes[0]!, decisions: ['keep it simple'], now: NOW })
  check(c.id !== a.id, 'a revision (new attempt) gets a NEW capsule id')
}

// ── Delivery frame sections ──────────────────────────────────────────────────
{
  const p = plan([
    node('n0', {
      state: 'accepted',
      completion: { summary: 'schema shipped', checksReported: ['PASS'], changedAreas: ['src/n0.ts'], unresolved: ['one TODO'], reportedAt: NOW },
    }),
    node('n1', { dependsOn: ['n0'] }),
  ])
  const cap = buildContextCapsule({ plan: p, node: p.nodes[1]!, constraints: ['no new deps'], now: NOW })
  const frame = renderCapsuleFrame(cap)
  for (const section of ['OBJECTIVE', 'YOUR NODE', 'OWNERSHIP', 'CONSTRAINTS', 'PREDECESSOR RESULTS', 'ACCEPTANCE', 'RETURN CONTRACT']) {
    check(frame.includes(section), `frame carries the ${section} section`)
  }
  check(frame.includes('schema shipped'), 'predecessor digest rides the frame (summary, not transcript)')
}

// ── Synthesis packet honesty ─────────────────────────────────────────────────
{
  const p = plan([
    node('n0', { state: 'accepted', completion: { summary: 'done a', checksReported: [], changedAreas: [], unresolved: ['loose end'], reportedAt: NOW } }),
    node('n1', { state: 'working' }),
  ])
  const packet = buildSynthesisPacket(p)
  check(packet.nodes.length === 1 && packet.missingCompletions.includes('n1'), 'packet names missing completions, never invents one')
  check(packet.unresolved.includes('loose end'), 'unresolved items aggregate into the packet')
}

// ── parseCompletionDetail totality ───────────────────────────────────────────
{
  const lead = parseCompletionDetail('{"summary":"s","checks":["c1"],"changedAreas":["a"],"unresolved":[]} and then some prose')
  check(lead !== null && lead.summary === 's' && lead.checks[0] === 'c1', 'leading JSON + trailing prose parses')
  check(parseCompletionDetail('plain prose only') === null, 'prose-only detail → null (caller records prose-as-summary)')
  check(parseCompletionDetail('{"nosummary":true}') === null, 'JSON without summary → null')
  check(parseCompletionDetail('{"summary":"nested {brace} in \\"string\\""} tail') !== null, 'braces inside strings balance correctly')
  check(parseCompletionDetail(undefined) === null, 'undefined detail → null')
}

console.log('════════════════════════════════════════════════════════════════════════════')
if (failures > 0) {
  console.error(`❌ ${failures} capsule invariant(s) violated`)
  process.exit(1)
}
console.log('✅ ALL CAPSULE INVARIANTS HOLD')
