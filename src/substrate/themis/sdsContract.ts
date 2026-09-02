/* ============================================================================
   THEMIS SDS contract — CodeTeam's machine-checkable design spec, validated
   deterministically.

   Adapted from "CodeTeam" (Wang et al., arXiv:2606.22082) §SDS. The SDS
   (Software Design Specification) is the single source of truth a repo-
   generation pipeline builds against. CodeTeam's own framing is that the SDS
   is a machine-checkable CONTRACT — this module IS that checker, hosted in
   THEMIS because "P2 runs ON P1": an LLM architect produces SDS candidates;
   only deterministic validation (parse, set membership, graph arithmetic)
   decides which are structurally valid. Consumed by the DAEDALUS workflow
   (paper-triad Slice C) via the `themis` VM global; pure and serializable so
   every function is unit-provable without agents (scripts/themis/).

   Contract shape (the paper's mandatory fields):
     { tech_stack, repo_tree[], developer_plan[], files[] }
     file entry: { path, purpose, public_api[], depends_on["file::symbol"],
                   owner }

   STRUCTURAL VALIDITY (all four, per the paper): every files[].path is in
   repo_tree; every owner is in developer_plan; every depends_on edge resolves
   to a declared file (and, when a symbol is named, to that file's public_api);
   the file-level dependency graph is ACYCLIC after collapsing same-file
   symbol refs. Invalid candidates are excluded with typed errors — never
   repaired silently (the paper: "parseable = valid JSON without repair").
   ============================================================================ */

export interface SdsFile {
  path: string
  purpose: string
  public_api: string[]
  /** Edges 'other/file.ts::symbol' (or bare 'other/file.ts'). */
  depends_on: string[]
  owner: string
}

export interface Sds {
  tech_stack: string
  repo_tree: string[]
  developer_plan: string[]
  files: SdsFile[]
}

export type SdsErrorKind =
  | 'PARSE'
  | 'MISSING_FIELD'
  | 'BAD_SHAPE'
  | 'PATH_NOT_IN_TREE'
  | 'UNKNOWN_OWNER'
  | 'UNRESOLVED_DEP'
  | 'UNRESOLVED_SYMBOL'
  | 'DUPLICATE_PATH'
  | 'CYCLIC'

export interface SdsError {
  kind: SdsErrorKind
  detail: string
}

export type SdsValidation = { ok: true; sds: Sds } | { ok: false; errors: SdsError[] }

const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '')

/** Split 'file::symbol' → [file, symbol?]. A bare file ref carries no symbol. */
export function splitDepRef(ref: string): { file: string; symbol?: string } {
  const i = ref.indexOf('::')
  if (i === -1) return { file: normPath(ref) }
  return { file: normPath(ref.slice(0, i)), symbol: ref.slice(i + 2) || undefined }
}

/**
 * Validate a raw SDS candidate (a JSON string or an already-parsed object).
 * Returns EVERY violation found, not just the first — the CTO stage logs the
 * full error set when excluding a candidate. Never throws; never repairs.
 */
export function validateSDS(raw: unknown): SdsValidation {
  const errors: SdsError[] = []
  let candidate: unknown = raw
  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw)
    } catch (e) {
      return { ok: false, errors: [{ kind: 'PARSE', detail: `not valid JSON: ${String(e).slice(0, 120)}` }] }
    }
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, errors: [{ kind: 'BAD_SHAPE', detail: 'SDS must be a JSON object' }] }
  }
  const o = candidate as Record<string, unknown>
  for (const field of ['tech_stack', 'repo_tree', 'developer_plan', 'files'] as const) {
    if (o[field] === undefined) errors.push({ kind: 'MISSING_FIELD', detail: `mandatory field ${field} absent` })
  }
  if (errors.length) return { ok: false, errors }
  if (typeof o.tech_stack !== 'string' || !Array.isArray(o.repo_tree) || !Array.isArray(o.developer_plan) || !Array.isArray(o.files)) {
    return { ok: false, errors: [{ kind: 'BAD_SHAPE', detail: 'tech_stack: string, repo_tree/developer_plan/files: arrays' }] }
  }

  const tree = new Set((o.repo_tree as unknown[]).filter((p): p is string => typeof p === 'string').map(normPath))
  const owners = new Set((o.developer_plan as unknown[]).filter((d): d is string => typeof d === 'string'))
  const files: SdsFile[] = []
  const declared = new Map<string, SdsFile>()

  for (const [i, f] of (o.files as unknown[]).entries()) {
    if (f === null || typeof f !== 'object') {
      errors.push({ kind: 'BAD_SHAPE', detail: `files[${i}] is not an object` })
      continue
    }
    const fe = f as Record<string, unknown>
    if (typeof fe.path !== 'string' || !fe.path) {
      errors.push({ kind: 'BAD_SHAPE', detail: `files[${i}] has no path` })
      continue
    }
    const file: SdsFile = {
      path: normPath(fe.path),
      purpose: typeof fe.purpose === 'string' ? fe.purpose : '',
      public_api: Array.isArray(fe.public_api) ? fe.public_api.filter((s): s is string => typeof s === 'string') : [],
      depends_on: Array.isArray(fe.depends_on) ? fe.depends_on.filter((s): s is string => typeof s === 'string') : [],
      owner: typeof fe.owner === 'string' ? fe.owner : '',
    }
    if (declared.has(file.path)) {
      errors.push({ kind: 'DUPLICATE_PATH', detail: `${file.path} declared more than once` })
      continue
    }
    declared.set(file.path, file)
    files.push(file)
  }

  for (const f of files) {
    if (!tree.has(f.path)) errors.push({ kind: 'PATH_NOT_IN_TREE', detail: `${f.path} not in repo_tree` })
    if (!f.owner || !owners.has(f.owner)) errors.push({ kind: 'UNKNOWN_OWNER', detail: `${f.path} owner '${f.owner}' not in developer_plan` })
    for (const ref of f.depends_on) {
      const { file, symbol } = splitDepRef(ref)
      const target = declared.get(file)
      if (!target) {
        errors.push({ kind: 'UNRESOLVED_DEP', detail: `${f.path} depends on undeclared file ${file}` })
        continue
      }
      if (symbol && !target.public_api.includes(symbol)) {
        errors.push({ kind: 'UNRESOLVED_SYMBOL', detail: `${f.path} depends on ${file}::${symbol}, not in its public_api` })
      }
    }
  }

  // Acyclicity on the FILE-level graph (same-file symbol refs collapsed).
  const cycle = findCycle(fileDepGraph(files))
  if (cycle) errors.push({ kind: 'CYCLIC', detail: `dependency cycle: ${cycle.join(' → ')}` })

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    sds: {
      tech_stack: o.tech_stack as string,
      repo_tree: [...tree].sort(),
      developer_plan: (o.developer_plan as string[]).slice(),
      files,
    },
  }
}

/** File-level dependency graph: path → the set of paths it depends on. */
export function fileDepGraph(files: readonly SdsFile[]): Map<string, Set<string>> {
  const g = new Map<string, Set<string>>()
  const known = new Set(files.map(f => f.path))
  for (const f of files) {
    const deps = new Set<string>()
    for (const ref of f.depends_on) {
      const { file } = splitDepRef(ref)
      if (file !== f.path && known.has(file)) deps.add(file)
    }
    g.set(f.path, deps)
  }
  return g
}

/** First cycle found (as a path list), or null when the graph is a DAG. */
function findCycle(g: Map<string, Set<string>>): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const visit = (n: string): string[] | null => {
    state.set(n, 'visiting')
    stack.push(n)
    for (const d of g.get(n) ?? []) {
      if (state.get(d) === 'done') continue
      if (state.get(d) === 'visiting') return [...stack.slice(stack.indexOf(d)), d]
      const c = visit(d)
      if (c) return c
    }
    stack.pop()
    state.set(n, 'done')
    return null
  }
  for (const n of g.keys()) {
    if (!state.has(n)) {
      const c = visit(n)
      if (c) return c
    }
  }
  return null
}

/**
 * Normalize a VALID SDS into the pipeline's single source of truth: canonical
 * sorted file order, deduped symbol/dep lists, the materialized ownership map,
 * and the file-level dependency graph (the paper's normalize step). Call only
 * with validateSDS-accepted input; re-validates cheaply and returns null on a
 * violation rather than repairing.
 */
export interface NormalizedSds {
  sds: Sds
  /** path → owner (exclusive file ownership). */
  ownership: Record<string, string>
  /** path → sorted direct dependencies (file-level). */
  depGraph: Record<string, string[]>
}

export function normalizeSDS(input: Sds): NormalizedSds | null {
  const v = validateSDS(input as unknown)
  if (!v.ok) return null
  const files = v.sds.files
    .map(f => ({
      ...f,
      public_api: [...new Set(f.public_api)].sort(),
      depends_on: [...new Set(f.depends_on.map(r => {
        const { file, symbol } = splitDepRef(r)
        return symbol ? `${file}::${symbol}` : file
      }))].sort(),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const ownership: Record<string, string> = {}
  for (const f of files) ownership[f.path] = f.owner
  const depGraph: Record<string, string[]> = {}
  for (const [p, deps] of fileDepGraph(files)) depGraph[p] = [...deps].sort()
  return { sds: { ...v.sds, files }, ownership, depGraph }
}

/**
 * Kahn layering over the file-level graph: layer N contains every file whose
 * dependencies all sit in layers < N — the Dev stage's ready-queue batches.
 * Returns null on a cycle (validateSDS should have caught it).
 */
export function topoLayers(depGraph: Record<string, readonly string[]>): string[][] | null {
  const remaining = new Map<string, Set<string>>()
  for (const [p, deps] of Object.entries(depGraph)) {
    // Object.hasOwn, not `in`: a dep literally named 'toString'/'constructor'
    // would resolve via the prototype chain and become a phantom edge that
    // reads as a cycle. Non-array values (model-JSON via the VM boundary)
    // degrade to no-deps instead of TypeErroring out of the host.
    const list = Array.isArray(deps) ? deps : []
    remaining.set(p, new Set(list.filter(d => typeof d === 'string' && Object.hasOwn(depGraph, d))))
  }
  const layers: string[][] = []
  const placed = new Set<string>()
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, deps]) => [...deps].every(d => placed.has(d))).map(([p]) => p).sort()
    if (ready.length === 0) return null // cycle
    layers.push(ready)
    for (const p of ready) {
      placed.add(p)
      remaining.delete(p)
    }
  }
  return layers
}

/**
 * The paper's scheduling priority: prio(f) = (depth = longest DOWNSTREAM
 * dependent chain, fanout = direct dependents, −order in the SDS). Files that
 * unblock the most (deepest/widest) work go first; SDS order breaks ties.
 */
export interface TaskPriority {
  path: string
  depth: number
  fanout: number
  order: number
}

export function taskPriority(depGraph: Record<string, readonly string[]>, sdsOrder: readonly string[]): TaskPriority[] {
  // Reverse graph: path → direct dependents.
  const dependents = new Map<string, string[]>()
  for (const p of Object.keys(depGraph)) dependents.set(p, [])
  for (const [p, deps] of Object.entries(depGraph)) {
    for (const d of Array.isArray(deps) ? deps : []) if (dependents.has(d)) dependents.get(d)!.push(p)
  }
  const depth = new Map<string, number>()
  const depthOf = (p: string, seen: Set<string>): number => {
    if (depth.has(p)) return depth.get(p)!
    if (seen.has(p)) return 0 // cycle guard; validate catches real ones
    seen.add(p)
    const ds = dependents.get(p) ?? []
    const v = ds.length === 0 ? 0 : 1 + Math.max(...ds.map(d => depthOf(d, seen)))
    depth.set(p, v)
    return v
  }
  const orderIdx = new Map(sdsOrder.map((p, i) => [normPath(p), i]))
  const out: TaskPriority[] = Object.keys(depGraph).map(p => ({
    path: p,
    depth: depthOf(p, new Set()),
    fanout: (dependents.get(p) ?? []).length,
    order: orderIdx.get(p) ?? Number.MAX_SAFE_INTEGER,
  }))
  out.sort(compareTaskPriority)
  return out
}

export function compareTaskPriority(a: TaskPriority, b: TaskPriority): number {
  if (a.depth !== b.depth) return b.depth - a.depth
  if (a.fanout !== b.fanout) return b.fanout - a.fanout
  if (a.order !== b.order) return a.order - b.order
  return a.path.localeCompare(b.path)
}

/**
 * Exclusive-ownership scope check for one lane (P1's scan-diff gate shape,
 * applied to P2's ownership map): every path the lane actually changed must
 * be owned by that lane's developer. Deterministic set arithmetic over an
 * agent-COLLECTED input (the lane's `git diff --name-only`) — the check
 * itself trusts no agent claim.
 */
export function verifyOwnership(
  ownership: Record<string, string>,
  lane: { owner: string; changedPaths: readonly string[] },
): { ok: boolean; violations: Array<{ path: string; declaredOwner: string | null }> } {
  const violations: Array<{ path: string; declaredOwner: string | null }> = []
  for (const raw of lane.changedPaths) {
    const p = normPath(raw)
    // Own-property read: an inherited name ('constructor', …) must read as
    // unowned, not as whatever sits on the prototype chain.
    const declared = Object.hasOwn(ownership, p) ? ownership[p] : undefined
    if (declared === undefined) violations.push({ path: p, declaredOwner: null })
    else if (declared !== lane.owner) violations.push({ path: p, declaredOwner: declared })
  }
  return { ok: violations.length === 0, violations }
}

/**
 * QA repair routing — the paper's root-cause criteria IN SEQUENCE:
 *   (1) interface consistency: an issue naming a symbol routes to the file
 *       that EXPORTS it (the provider, not the consumer);
 *   (2) dependency directionality: otherwise the most UPSTREAM suspected
 *       file wins (its fix propagates down);
 *   (3) structural validity: suspects outside the SDS are dropped (named in
 *       the rationale, never silently);
 *   (4) minimal repair scope: final tie-break is the smallest set — the
 *       first remaining suspect, alone.
 * Dependents requeue ONLY on declared public-API/import/shared-config impact.
 * Returns null when no suspected file resolves into the SDS.
 */
export interface RepairIssue {
  symptom: string
  suspectedFiles: readonly string[]
  /** Symbol the failure names (an import error, a signature mismatch). */
  symbol?: string
  /** Public API / import path / shared config impacted ⇒ dependents requeue. */
  publicApiImpact?: boolean
}

export interface RepairRoute {
  targetFile: string
  owner: string
  requeueDependents: boolean
  /** Which criterion decided (1-based, the paper's sequence). */
  decidedBy: 1 | 2 | 4
  rationale: string
}

export const REPAIR_ROUND_CAP = 2

/** The paper's convergence data (+3.5, +1.4, then ≤0.8): rounds beyond the cap
 *  are refused — termination is clean ∨ cap ∨ budget, decided by the caller. */
export function repairRoundPermitted(round: number, cap: number = REPAIR_ROUND_CAP): boolean {
  return Number.isInteger(round) && round >= 1 && round <= cap
}

export function routeRepair(issue: RepairIssue, normalized: NormalizedSds): RepairRoute | null {
  const byPath = new Map(normalized.sds.files.map(f => [f.path, f]))
  // Own-property owner read: `normalized` can arrive as model JSON through
  // the VM boundary, where a path named like a prototype member would
  // otherwise resolve to an inherited value.
  const ownerOf = (p: string): string => {
    const o = normalized.ownership
    return Object.hasOwn(o, p) && typeof o[p] === 'string' ? o[p]! : ''
  }
  const inSds = issue.suspectedFiles.map(normPath).filter(p => byPath.has(p))
  const dropped = issue.suspectedFiles.map(normPath).filter(p => !byPath.has(p))
  if (inSds.length === 0) return null
  const droppedNote = dropped.length ? ` (dropped ${dropped.length} suspect(s) outside the SDS: ${dropped.join(', ')})` : ''

  // (1) interface consistency — the exporter of the named symbol.
  if (issue.symbol) {
    const provider = inSds.find(p => byPath.get(p)!.public_api.includes(issue.symbol!))
    if (provider) {
      return {
        targetFile: provider,
        owner: ownerOf(provider),
        requeueDependents: issue.publicApiImpact === true,
        decidedBy: 1,
        rationale: `exports ${issue.symbol} named by the failure${droppedNote}`,
      }
    }
  }

  // (2) dependency directionality — the most upstream suspect (earliest layer).
  if (inSds.length > 1) {
    const layers = topoLayers(normalized.depGraph)
    if (layers) {
      const layerOf = new Map<string, number>()
      layers.forEach((layer, i) => layer.forEach(p => layerOf.set(p, i)))
      const sorted = [...inSds].sort(
        (a, b) => (layerOf.get(a) ?? 0) - (layerOf.get(b) ?? 0) || a.localeCompare(b),
      )
      const target = sorted[0]!
      const rest = sorted.slice(1)
      if ((layerOf.get(target) ?? 0) < (layerOf.get(rest[0]!) ?? 0)) {
        return {
          targetFile: target,
          owner: ownerOf(target),
          requeueDependents: issue.publicApiImpact === true,
          decidedBy: 2,
          rationale: `most upstream of ${inSds.length} suspects (layer ${layerOf.get(target)})${droppedNote}`,
        }
      }
    }
  }

  // (4) minimal repair scope — the first remaining suspect, alone. (Criterion
  // 3, structural validity, already acted by dropping non-SDS suspects.)
  const target = inSds[0]!
  return {
    targetFile: target,
    owner: ownerOf(target),
    requeueDependents: issue.publicApiImpact === true,
    decidedBy: 4,
    rationale: `minimal scope: first in-SDS suspect${droppedNote}`,
  }
}
