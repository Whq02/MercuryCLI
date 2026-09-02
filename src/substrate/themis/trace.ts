/* ============================================================================
   THEMIS traceability — requirement → file → test, with a DERIVED drift check.

   Adapted from arXiv:2606.26924 §"requirement→file→test traceability", and
   deliberately EXCEEDING its trust boundary: the paper's file→AC linkage is
   COOPERATIVE (the agent calls trace-update; a non-compliant agent's edits are
   only noticed at the next drift check). Here the linkage table is still
   declared, but the check is DERIVED — scanDiff() compares the DECLARED file
   set against the ACTUAL changed-path set (from `git diff --name-only` or a
   workflow lane's diff), so unregistered edits are detected mechanically by
   set arithmetic, not by hoping the agent reported them.

   The dominant real gap the paper found — implementation-without-test-trace —
   is exactly what verifyTraceComplete() blocks: an acceptance criterion with
   implementing files but no verifying test cannot pass the gate.

   Pure + serializable (the trace.json shape); persistence is the caller's
   choice. Violations are returned, never thrown (warn-vs-enforce is the
   caller's policy; determinism is in the verdict).
   ============================================================================ */

export interface TraceCriterion {
  /** Acceptance-criterion id, e.g. 'AC-3'. */
  id: string
  text?: string
  files: string[]
  tests: string[]
  status: 'open' | 'implemented' | 'verified'
}

export interface TraceTableState {
  version: 1
  /** Content hash of the spec at approval time (spec_hash) — binds the table
   *  to the spec revision it traces. */
  specHash?: string
  criteria: TraceCriterion[]
}

export interface TraceViolation {
  kind: 'NO_FILES' | 'NO_TESTS' | 'UNKNOWN_AC'
  acId: string
  detail: string
}

export interface TraceTable {
  addCriterion(id: string, text?: string): void
  linkFile(acId: string, path: string): boolean
  linkTest(acId: string, test: string): boolean
  setStatus(acId: string, status: TraceCriterion['status']): boolean
  setSpecHash(hash: string): void
  /** The paper's gate: every AC must carry ≥1 file AND ≥1 test. */
  verifyTraceComplete(): { ok: true } | { ok: false; violations: TraceViolation[] }
  /** All file paths any AC declares (for scanDiff). */
  declaredFiles(): string[]
  state(): TraceTableState
}

export function createTraceTable(initial?: TraceTableState): TraceTable {
  const st: TraceTableState = initial
    ? (JSON.parse(JSON.stringify(initial)) as TraceTableState)
    : { version: 1, criteria: [] }
  const find = (id: string): TraceCriterion | undefined => st.criteria.find(c => c.id === id)
  return {
    addCriterion(id, text) {
      if (!find(id)) st.criteria.push({ id, text, files: [], tests: [], status: 'open' })
    },
    linkFile(acId, path) {
      const c = find(acId)
      if (!c) return false
      if (!c.files.includes(path)) c.files.push(path)
      return true
    },
    linkTest(acId, test) {
      const c = find(acId)
      if (!c) return false
      if (!c.tests.includes(test)) c.tests.push(test)
      return true
    },
    setStatus(acId, status) {
      const c = find(acId)
      if (!c) return false
      c.status = status
      return true
    },
    setSpecHash(hash) {
      st.specHash = hash
    },
    verifyTraceComplete() {
      const violations: TraceViolation[] = []
      for (const c of st.criteria) {
        if (c.files.length === 0) {
          violations.push({ kind: 'NO_FILES', acId: c.id, detail: `${c.id} has no implementing files` })
        }
        if (c.tests.length === 0) {
          violations.push({ kind: 'NO_TESTS', acId: c.id, detail: `${c.id} has no verifying tests (the implementation-without-test-trace gap)` })
        }
      }
      return violations.length === 0 ? { ok: true } : { ok: false, violations }
    },
    declaredFiles() {
      const out = new Set<string>()
      for (const c of st.criteria) for (const f of c.files) out.add(f)
      return [...out].sort()
    },
    state() {
      return JSON.parse(JSON.stringify(st)) as TraceTableState
    },
  }
}

/**
 * The derived scope check — pure set arithmetic. `declared` is what the trace
 * table (or an ownership map) registers; `actual` is what really changed
 * (git diff --name-only, a lane's file list). Paths are compared after a
 * light normalization (./ stripped, backslashes folded).
 *
 *   undeclared — changed but not registered to any AC ⇒ scope creep
 *   missing    — declared but not touched (informational: work not started)
 */
export function scanDiff(
  declared: readonly string[],
  actual: readonly string[],
): { ok: boolean; undeclared: string[]; missing: string[] } {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '')
  const d = new Set(declared.map(norm))
  const a = new Set(actual.map(norm))
  const undeclared = [...a].filter(p => !d.has(p)).sort()
  const missing = [...d].filter(p => !a.has(p)).sort()
  return { ok: undeclared.length === 0, undeclared, missing }
}
