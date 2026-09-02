#!/usr/bin/env bun
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
