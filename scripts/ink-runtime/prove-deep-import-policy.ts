#!/usr/bin/env bun
// ============================================================================
//  scripts/ink-runtime/prove-deep-import-policy.ts —
//  the terminal runtime's import policy.
//
//  The ratified policy: `src/ink.ts` is the
//  PUBLIC terminal facade (56 exports, logic-free — prove-facade-inventory
//  pins it). In-repo product code may ALSO import specific runtime modules
//  directly ("deep imports") — that is sanctioned module-level API, not a
//  facade violation — but the SET of runtime modules reachable from outside
//  the runtime is self-accounting: this prover scans every production import
//  of `src/ink/**` from outside `src/ink/` and compares the MODULE set
//  against the recorded inventory. A module disappearing from the set is
//  fine (fewer dependencies); a NEW module joining fails until recorded
//  deliberately with --record.
//
//  Run:            ~/.bun/bin/bun run scripts/ink-runtime/prove-deep-import-policy.ts
//  Regen (review): … --record
// ============================================================================
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const INVENTORY = join(import.meta.dir, 'deep-import-inventory.json')
const record = process.argv.includes('--record')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

// Every import specifier reaching into src/ink/** from a production file
// outside src/ink/ (the facade src/ink.ts is excluded — its re-exports ARE
// the facade).
const modules = new Set<string>()
function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (full.endsWith(`src${'/'}ink`)) continue
      walk(full)
      continue
    }
    if (!/\.(ts|tsx|mts|mjs)$/.test(name)) continue
    if (full === join(ROOT, 'src', 'ink.ts')) continue
    const src = readFileSync(full, 'utf8')
    for (const m of src.matchAll(/from\s+['"]([^'"]*\/ink\/[^'"]+)['"]/g)) {
      const spec = m[1]!
      const idx = spec.indexOf('/ink/')
      modules.add(spec.slice(idx + '/ink/'.length).replace(/\.js$/, ''))
    }
  }
}
walk(join(ROOT, 'src'))
const scanned = [...modules].sort()

console.log('bedrock deep-import policy — the sanctioned runtime-module set')
console.log(`  ${scanned.length} runtime modules imported from outside the runtime`)

// grouped contracts: the inventory is groups of {why, modules}. A new
// module recorded via --record lands in 'unclassified' — moving it to a
// justified group (or re-routing it through the facade) is the deliberate act.
type Inventory = { comment?: string; groups: Record<string, { why: string; modules: string[] }> }
function readInventory(): Inventory {
  return JSON.parse(readFileSync(INVENTORY, 'utf8')) as Inventory
}
function flatModules(inv: Inventory): string[] {
  return Object.values(inv.groups).flatMap(g => g.modules)
}

if (record) {
  const inv: Inventory = existsSync(INVENTORY)
    ? readInventory()
    : { groups: {} }
  const known = new Set(flatModules(inv))
  const additions = scanned.filter(m => !known.has(m))
  if (additions.length > 0) {
    const bucket = (inv.groups['unclassified'] ??= {
      why: 'UNCLASSIFIED — justify into a real group or re-route through the facade',
      modules: [],
    })
    bucket.modules.push(...additions)
    bucket.modules.sort()
  }
  // Shrink: drop recorded modules no longer imported (empty groups die too).
  for (const [name, g] of Object.entries(inv.groups)) {
    g.modules = g.modules.filter(m => modules.has(m))
    if (g.modules.length === 0) delete inv.groups[name]
  }
  writeFileSync(INVENTORY, JSON.stringify(inv, null, 2) + '\n')
  console.log(`  recorded → ${INVENTORY} (+${additions.length} new, grouped inventory)`)
} else {
  check('inventory exists (run --record once)', existsSync(INVENTORY))
  if (existsSync(INVENTORY)) {
    const inv = readInventory()
    const recorded = flatModules(inv)
    const recordedSet = new Set(recorded)
    check('every recorded module carries a group justification (no unclassified group)',
      !('unclassified' in inv.groups),
      `unclassified: ${inv.groups['unclassified']?.modules.join(', ') ?? ''}`)
    const additions = scanned.filter(m => !recordedSet.has(m))
    check(
      'no unrecorded runtime module joined the deep-import set',
      additions.length === 0,
      `new: ${additions.join(', ')} — record deliberately with --record`,
    )
    const gone = recorded.filter(m => !modules.has(m))
    check(
      'no recorded module is stale (the ratchet re-shrinks on contact)',
      gone.length === 0,
      `stale: ${gone.join(', ')} — re-record to shrink`,
    )
  }
}

if (failures > 0) {
  console.log(`\nbedrock deep-import policy: RED (${failures} failure${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('\nbedrock deep-import policy: green')
