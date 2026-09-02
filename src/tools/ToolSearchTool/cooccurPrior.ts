import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getMemoryBaseDir } from '../../memdir/paths.js'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { flagEnv } from '../../substrate/flagRegistry.js'


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
  }
}

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

export function recordToolDiscovery(loaded: string[]): void {
  if (!toolSearchCooccurEnabled()) return
  try {
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
  }
}

export function __resetCooccurForTest(): void {
  sessionDiscovered.clear()
  tableCache = null
}
