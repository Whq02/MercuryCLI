// ============================================================================
//  projectGates — typed project-local verification-gate declarations + the
//  ecosystem discovery adapters.
//
//  Authority order for "is this workspace verifiable, and is this command a
//  verify?":
//    (1) explicit project-local gate DECLARATIONS (this module) — stable IDs
//        + argv, authored in <project>/.mercury/gates.json (resolved via projectConfig);
//    (2) ecosystem adapters discovered from project files (Godot's
//        project.godot here; Node/Make/vitest/... live in workspaceVerifiable);
//    (3) the curated command families (classifyVerifySegment);
//    (4) MERCURY_VERIFY_PATTERN — retained compatibility input.
//
//  This module is CONSULTED BY the one vocabulary owner
//  (verificationState.classifyVerifySegment) — it is not a parallel
//  recognizer: a declared gate resolves through the same classify call every
//  consumer (evidence mint, commit gate, stop demand) already makes.
//
//  Declaration file shape (schema 1, bounded):
//    { "schema": 1, "gates": [ { "id": "scene-gates", "argv": ["godot",
//      "--headless", "--script", "tests/run_gates.gd"], "scope": "test",
//      "coverage": "the seven scene gates", "minRuns": 1, "match":
//      "godot .*--script tests/" } ] }
//  · id       stable gate identity (receipts, soak counting) — [a-z0-9-_.]
//  · argv     canonical invocation; a command segment matches when it
//             contains every argv token in order (quoting-insensitive)
//  · match    optional case-insensitive regex — the escape for wrapper
//             scripts the argv law can't name
//  · scope    optional VerificationScope (default 'check')
//  · coverage optional human-readable coverage line (default the id)
//  · minRuns  optional soak floor: N green runs since the last mutation
//             before the gate reads satisfied (the field father_soak case —
//             one green run cannot satisfy a min-5 gate)
// ============================================================================

import { readFileSync, statSync } from 'node:fs'
import { projectConfigCandidates } from '../projectConfig.js'
import type { VerificationScope } from './verificationState.js'

export interface DeclaredGate {
  id: string
  argv: string[]
  match: RegExp | null
  scope: VerificationScope
  coverage: string
  minRuns: number
}

const MAX_GATES = 32
const GATE_ID_RE = /^[a-z0-9][a-z0-9-_.]{0,63}$/i
const SCOPES: ReadonlySet<string> = new Set([
  'full-gate', 'typecheck', 'suite', 'proof', 'build', 'artifact-smoke',
  'fast', 'test', 'lint', 'check',
])

interface CacheEntry {
  gates: DeclaredGate[]
  /** Content fingerprint of the winning file (mtimeMs:size), '' when absent. */
  fingerprint: string
  at: number
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 5_000

function fingerprintOf(path: string): string | null {
  try {
    const s = statSync(path)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return null
  }
}

function parseGates(raw: string): DeclaredGate[] {
  const parsed = JSON.parse(raw) as {
    schema?: number
    gates?: Array<Record<string, unknown>>
  }
  if (parsed.schema !== 1 || !Array.isArray(parsed.gates)) return []
  const out: DeclaredGate[] = []
  for (const g of parsed.gates.slice(0, MAX_GATES)) {
    const id = typeof g.id === 'string' && GATE_ID_RE.test(g.id) ? g.id : null
    const argv = Array.isArray(g.argv)
      ? g.argv.filter((a): a is string => typeof a === 'string' && a.length > 0)
      : []
    if (!id || argv.length === 0) continue // a gate is its id + its argv
    let match: RegExp | null = null
    if (typeof g.match === 'string' && g.match) {
      try {
        match = new RegExp(g.match, 'i')
      } catch {
        match = null // an unparseable regex never disables the argv law
      }
    }
    const scope = typeof g.scope === 'string' && SCOPES.has(g.scope)
      ? (g.scope as VerificationScope)
      : 'check'
    out.push({
      id,
      argv,
      match,
      scope,
      coverage: typeof g.coverage === 'string' && g.coverage ? g.coverage : `declared gate ${id}`,
      minRuns: typeof g.minRuns === 'number' && Number.isInteger(g.minRuns) && g.minRuns > 1
        ? Math.min(g.minRuns, 100)
        : 1,
    })
  }
  return out
}

/**
 * The project's declared gates, content-fingerprinted: a changed/created/
 * deleted gates.json is honored within CACHE_TTL_MS (and immediately when the
 * verifiable cache is invalidated by an observed mutation — the negative-
 * discovery law lives in workspaceVerifiable, which calls this fresh).
 */
export function loadDeclaredGates(cwd: string): DeclaredGate[] {
  const now = Date.now()
  const cached = cache.get(cwd)
  const candidates = projectConfigCandidates(cwd, 'gates.json')
  const winner = candidates.find(p => fingerprintOf(p) !== null) ?? null
  const fingerprint = winner ? fingerprintOf(winner) ?? '' : ''
  if (cached && now - cached.at < CACHE_TTL_MS && cached.fingerprint === fingerprint) {
    return cached.gates
  }
  let gates: DeclaredGate[] = []
  if (winner) {
    try {
      gates = parseGates(readFileSync(winner, 'utf8'))
    } catch {
      gates = [] // absent/corrupt declares nothing — honest fall-through
    }
  }
  cache.set(cwd, { gates, fingerprint, at: now })
  return gates
}

/** Test seam: drop the declaration cache. */
export function _resetDeclaredGatesForTesting(): void {
  cache.clear()
}

/** Quoting-insensitive containment: every argv token appears in order. */
function segmentCarriesArgv(segment: string, argv: string[]): boolean {
  const hay = segment.replace(/["']/g, '')
  let from = 0
  for (const tok of argv) {
    const at = hay.indexOf(tok, from)
    if (at === -1) return false
    from = at + tok.length
  }
  return true
}

/**
 * Match ONE control-op-free segment against the project's declared gates.
 * First declaration wins (declaration order is authority order).
 */
export function matchDeclaredGate(
  segment: string,
  cwd: string,
): { scope: VerificationScope; coverage: string; gateId: string; minRuns: number } | null {
  for (const gate of loadDeclaredGates(cwd)) {
    if (segmentCarriesArgv(segment, gate.argv) || (gate.match?.test(segment) ?? false)) {
      return { scope: gate.scope, coverage: gate.coverage, gateId: gate.id, minRuns: gate.minRuns }
    }
  }
  return null
}
