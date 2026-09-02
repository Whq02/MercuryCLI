
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
    if (!id || argv.length === 0) continue
    let match: RegExp | null = null
    if (typeof g.match === 'string' && g.match) {
      try {
        match = new RegExp(g.match, 'i')
      } catch {
        match = null
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
      gates = []
    }
  }
  cache.set(cwd, { gates, fingerprint, at: now })
  return gates
}

export function _resetDeclaredGatesForTesting(): void {
  cache.clear()
}

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
