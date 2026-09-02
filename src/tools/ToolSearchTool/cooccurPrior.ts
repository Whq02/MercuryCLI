import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getMemoryBaseDir } from '../../memdir/paths.js'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

// ============================================================================
//  ToolSearch co-occurrence prior (sovereign-harness W4 — SING, arXiv
//  2606.16591, the databank's 'tool_next' slice): boost a candidate tool when
//  it historically chains with tools ALREADY DISCOVERED this session.
//
//  ToolSearch is the discovery chokepoint, so this module owns the session's
//  discovered set itself — no message threading. Each successful search both
//  READS the prior (boost against the current session set) and WRITES it
//  (new pairs discovered-now × discovered-before, persisted counts).
//
//  Bounds (the databank's clamps, so the prior can only break ties / surface
//  chains — never outrank a genuine name match):
//   - boost applies ONLY to candidates that already matched (score > 0)
//   - boost = min(3, log2(1 + Σ pair counts)) — below the searchHint weight
//     (4) and far below name-part weights (10/12)
//   - table capped at 400 pairs (lowest counts pruned on write)
//
//  Gate: MERCURY_TOOLSEARCH_COOCCUR (opt-in) + fork. OFF ⇒ every entry point
//  returns 0/no-ops ⇒ scoring byte-identical. Never-throws: a broken table
//  must not be able to break tool search. Writes are tmp+rename (atomic);
//  concurrent sessions last-write-wins — acceptable for a counts cache.
// ============================================================================

// Unit separator — cannot appear in tool names, so pair keys can't collide.
const PAIR_SEP = '\u001f'
const MAX_PAIRS = 400
const MAX_BOOST = 3

export function toolSearchCooccurEnabled(): boolean {
  const v = flagEnv('MERCURY_TOOLSEARCH_COOCCUR')
  return (v === '1' || v === 'true' || v === 'on')
}

function tablePath(): string {
  return (
    flagEnv('MERCURY_TOOLSEARCH_COOCCUR_PATH') ||
    join(getMemoryBaseDir(), 'toolsearch-cooccur.json')
  )
}

const sessionDiscovered = new Set<string>()
let tableCache: Record<string, number> | null = null

function pairKey(a: string, b: string): string {
  return a < b ? `${a}${PAIR_SEP}${b}` : `${b}${PAIR_SEP}${a}`
}

function loadTable(): Record<string, number> {
  if (tableCache) return tableCache
  try {
    const parsed = JSON.parse(readFileSync(tablePath(), 'utf8')) as unknown
    tableCache =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>).filter(
              ([, v]) => typeof v === 'number' && Number.isFinite(v) && v > 0,
            ),
          ) as Record<string, number>
        : {}
  } catch {
    tableCache = {}
  }
  return tableCache
}

function saveTable(table: Record<string, number>): void {
  try {
    let entries = Object.entries(table)
    if (entries.length > MAX_PAIRS) {
      entries = entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_PAIRS)
    }
    const pruned = Object.fromEntries(entries)
    durableAtomicPublishSync(tablePath(), JSON.stringify(pruned))
    tableCache = pruned
  } catch {
    // never-throws
  }
}

/**
 * The prior for one candidate against the current session set.
 * 0 unless enabled; clamped to MAX_BOOST.
 */
export function cooccurBoostFor(candidate: string): number {
  if (!toolSearchCooccurEnabled()) return 0
  try {
    if (sessionDiscovered.size === 0) return 0
    const table = loadTable()
    let total = 0
    for (const partner of sessionDiscovered) {
      if (partner === candidate) continue
      total += table[pairKey(candidate, partner)] ?? 0
    }
    return total > 0 ? Math.min(MAX_BOOST, Math.log2(1 + total)) : 0
  } catch {
    return 0
  }
}

/**
 * Record a discovery event: the freshly loaded names pair with everything
 * discovered earlier this session, then join the session set.
 */
export function recordToolDiscovery(loaded: string[]): void {
  if (!toolSearchCooccurEnabled()) return
  try {
    // Only genuinely-new names count: re-loading an already-discovered tool
    // must not re-increment its pairs (the proof caught the double-count).
    const fresh = loaded.filter(
      n => typeof n === 'string' && n.length > 0 && !sessionDiscovered.has(n),
    )
    if (fresh.length === 0) return
    if (sessionDiscovered.size > 0) {
      const table = { ...loadTable() }
      let touched = false
      for (const n of fresh) {
        for (const prior of sessionDiscovered) {
          if (prior === n) continue
          const k = pairKey(n, prior)
          table[k] = (table[k] ?? 0) + 1
          touched = true
        }
      }
      if (touched) saveTable(table)
    }
    for (const n of fresh) sessionDiscovered.add(n)
  } catch {
    // never-throws
  }
}

/** test-only */
export function __resetCooccurForTest(): void {
  sessionDiscovered.clear()
  tableCache = null
}
