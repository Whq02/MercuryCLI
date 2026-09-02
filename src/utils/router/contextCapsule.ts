// ============================================================================
//  router/contextCapsule — bounded, immutable context capsules + the synthesis
//  packet (route-fabric context engineering).
// ----------------------------------------------------------------------------
//  A worker process is DISPOSABLE (model change / context renewal / crash are
//  normal transitions); the ROUTE is durable. The capsule is what crosses the
//  process boundary: objective + the exact node contract + bounded predecessor
//  digests — never the retired transcript. Rules enforced here, not hoped:
//    - strict byte ceiling (CAPSULE_MAX_BYTES) with RECORDED truncation
//      (`omitted` names what was dropped — absent optional context is omitted
//      + recorded, never fabricated);
//    - stable canonical digest (stableDigest) — immutable after build; a
//      revision builds a NEW capsule id;
//    - the delivery frame separates objective / ownership / context /
//      acceptance / return contract so a fresh child can orient in one read.
//  The synthesis packet is the same doctrine pointed at the reviewer: typed
//  completion digests, never a re-read of every executor transcript.
// ============================================================================
import { stableDigest, type RouteNode, type TaskRoutePlan } from './contracts.js'

/** Hard capsule ceiling (bytes of the serialized capsule). */
export const CAPSULE_MAX_BYTES = 24_000
/** Per-list caps (entries are clamped before the byte ceiling applies). */
export const CAPSULE_LIST_CAP = 12
export const CAPSULE_ENTRY_CAP = 600

export interface RouteResultDigest {
  nodeId: string
  title: string
  summary: string
  checksReported: string[]
  changedAreas: string[]
  unresolved: string[]
}

export interface RouteContextCapsule {
  version: 1
  id: string
  planId: string
  nodeId: string
  attempt: number
  objective: string
  nodeContract: string
  decisions: string[]
  constraints: string[]
  relevantPaths: string[]
  predecessorResults: RouteResultDigest[]
  knownFailures: string[]
  acceptance: Array<{ id: string; description: string }>
  /** What the bounds dropped — recorded, never silent. */
  omitted: string[]
  createdAt: number
  digest: string
}

const clampStr = (s: string, cap = CAPSULE_ENTRY_CAP): string =>
  s.length > cap ? `${s.slice(0, cap - 1)}…` : s

function clampList(list: readonly string[], omitted: string[], label: string): string[] {
  const out = list.slice(0, CAPSULE_LIST_CAP).map(s => clampStr(s))
  if (list.length > CAPSULE_LIST_CAP) {
    omitted.push(`${label}: ${list.length - CAPSULE_LIST_CAP} entr(ies) over the list cap`)
  }
  return out
}

export function digestOfCompletion(node: RouteNode): RouteResultDigest | null {
  if (!node.completion) return null
  return {
    nodeId: node.id,
    title: clampStr(node.title, 120),
    summary: clampStr(node.completion.summary),
    checksReported: node.completion.checksReported.slice(0, CAPSULE_LIST_CAP).map(s => clampStr(s, 200)),
    changedAreas: node.completion.changedAreas.slice(0, CAPSULE_LIST_CAP).map(s => clampStr(s, 200)),
    unresolved: node.completion.unresolved.slice(0, CAPSULE_LIST_CAP).map(s => clampStr(s, 200)),
  }
}

export function buildContextCapsule(i: {
  plan: TaskRoutePlan
  node: RouteNode
  decisions?: string[]
  constraints?: string[]
  knownFailures?: string[]
  now: number
}): RouteContextCapsule {
  const omitted: string[] = []
  const predecessors = i.node.dependsOn
    .map(dep => i.plan.nodes.find(n => n.id === dep))
    .filter((n): n is RouteNode => n !== undefined)
    .map(digestOfCompletion)
    .filter((d): d is RouteResultDigest => d !== null)
  for (const dep of i.node.dependsOn) {
    const depNode = i.plan.nodes.find(n => n.id === dep)
    if (depNode && !depNode.completion) {
      omitted.push(`predecessor '${dep}' has no typed completion digest yet`)
    }
  }
  const body = {
    version: 1 as const,
    planId: i.plan.id,
    nodeId: i.node.id,
    attempt: i.node.attempt,
    objective: clampStr(i.plan.objective),
    nodeContract: clampStr(i.node.task, 4000),
    decisions: clampList(i.decisions ?? [], omitted, 'decisions'),
    constraints: clampList(i.constraints ?? [], omitted, 'constraints'),
    relevantPaths: clampList(i.node.ownsPaths, omitted, 'relevantPaths'),
    predecessorResults: predecessors,
    knownFailures: clampList(i.knownFailures ?? [], omitted, 'knownFailures'),
    acceptance: i.node.acceptance.map(a => ({ id: a.id, description: clampStr(a.description, 300) })),
    omitted,
    createdAt: i.now,
  }
  // Byte ceiling: shed the largest optional lists first, recording each shed.
  let capsule = body
  const size = (): number => JSON.stringify(capsule).length
  const shedOrder: Array<keyof typeof body> = ['knownFailures', 'decisions', 'constraints', 'predecessorResults']
  for (const key of shedOrder) {
    if (size() <= CAPSULE_MAX_BYTES) break
    const list = capsule[key] as unknown[]
    if (Array.isArray(list) && list.length > 0) {
      omitted.push(`${String(key)}: shed ${list.length} entr(ies) for the byte ceiling`)
      capsule = { ...capsule, [key]: [] }
    }
  }
  if (size() > CAPSULE_MAX_BYTES) {
    omitted.push('nodeContract: truncated for the byte ceiling')
    capsule = { ...capsule, nodeContract: clampStr(capsule.nodeContract, 2000) }
  }
  const digest = stableDigest(capsule)
  return { ...capsule, id: `cap-${i.plan.id}-${i.node.id}-a${i.node.attempt}`, digest }
}

/** Render the capsule as the worker's first-read delivery frame. Sectioned so
 *  a fresh process orients in one pass; the acceptance block IS the contract. */
export function renderCapsuleFrame(c: RouteContextCapsule): string {
  const lines: string[] = []
  lines.push(`[route ${c.planId} · node ${c.nodeId} · attempt ${c.attempt}]`)
  lines.push('', 'OBJECTIVE', c.objective)
  lines.push('', 'YOUR NODE (the exact unit of work — do not broaden into sibling nodes)', c.nodeContract)
  if (c.relevantPaths.length > 0) {
    lines.push('', 'OWNERSHIP (paths this node may change; others are out of scope)', ...c.relevantPaths.map(p => `- ${p}`))
  }
  if (c.decisions.length > 0) lines.push('', 'DECISIONS ALREADY MADE', ...c.decisions.map(d => `- ${d}`))
  if (c.constraints.length > 0) lines.push('', 'CONSTRAINTS', ...c.constraints.map(d => `- ${d}`))
  if (c.predecessorResults.length > 0) {
    lines.push('', 'PREDECESSOR RESULTS (digests; inspect source for detail)')
    for (const p of c.predecessorResults) {
      lines.push(`- ${p.nodeId} ${p.title}: ${p.summary}${p.unresolved.length ? ` · unresolved: ${p.unresolved.join('; ')}` : ''}`)
    }
  }
  if (c.knownFailures.length > 0) lines.push('', 'KNOWN FAILURES (do not repeat)', ...c.knownFailures.map(d => `- ${d}`))
  lines.push('', 'ACCEPTANCE (completion is judged against THESE, literally)')
  for (const a of c.acceptance) lines.push(`- [${a.id}] ${a.description}`)
  lines.push(
    '',
    'RETURN CONTRACT',
    'Report exactly one structured progress envelope when done: status done|failed, and a detail that leads with a JSON object {"summary": "...", "checks": ["..."], "changedAreas": ["..."], "unresolved": ["..."]} followed by any prose. Address every acceptance id.',
  )
  if (c.omitted.length > 0) lines.push('', `[capsule omissions: ${c.omitted.join(' · ')}]`)
  return lines.join('\n')
}

export interface SynthesisPacket {
  planId: string
  objective: string
  profile: string
  nodes: Array<RouteResultDigest & { state: RouteNode['state']; attempt: number }>
  unresolved: string[]
  /** Nodes lacking a typed completion (the packet never invents one). */
  missingCompletions: string[]
}

/** Bounded reviewer input assembled from typed completions only. */
export function buildSynthesisPacket(plan: TaskRoutePlan): SynthesisPacket {
  const nodes: SynthesisPacket['nodes'] = []
  const missing: string[] = []
  for (const n of plan.nodes) {
    const d = digestOfCompletion(n)
    if (d) nodes.push({ ...d, state: n.state, attempt: n.attempt })
    else missing.push(n.id)
  }
  return {
    planId: plan.id,
    objective: plan.objective,
    profile: plan.profile,
    nodes,
    unresolved: nodes.flatMap(n => n.unresolved),
    missingCompletions: missing,
  }
}

/** Parse a typed completion payload from a progress envelope's detail text —
 *  the JSON object may LEAD the detail (prose may follow). Total: null when no
 *  parseable payload exists (the caller falls back to prose-as-summary,
 *  recorded as such — never fabricated checks). */
export function parseCompletionDetail(detail: string | undefined): {
  summary: string
  checks: string[]
  changedAreas: string[]
  unresolved: string[]
} | null {
  const t = (detail ?? '').trim()
  if (!t.startsWith('{')) return null
  // Balance braces to find the leading JSON object (prose may follow).
  let depth = 0
  let end = -1
  let inStr = false
  let esc = false
  for (let ix = 0; ix < t.length; ix++) {
    const ch = t[ix]
    if (esc) {
      esc = false
      continue
    }
    if (ch === '\\') {
      esc = true
      continue
    }
    if (ch === '"') inStr = !inStr
    if (inStr) continue
    if (ch === '{') depth++
    if (ch === '}') {
      depth--
      if (depth === 0) {
        end = ix
        break
      }
    }
  }
  if (end < 0) return null
  try {
    const parsed = JSON.parse(t.slice(0, end + 1)) as Record<string, unknown>
    if (typeof parsed.summary !== 'string') return null
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, CAPSULE_LIST_CAP) : []
    return {
      summary: parsed.summary,
      checks: arr(parsed.checks),
      changedAreas: arr(parsed.changedAreas),
      unresolved: arr(parsed.unresolved),
    }
  } catch {
    return null
  }
}
