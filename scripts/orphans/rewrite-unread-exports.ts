#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GRAPH_ROOT } from './graph.ts'
import { rewriteFile, runCensus, treeOptions, type ExportRow } from './exportCensus.ts'

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const prefixes = args.filter(a => !a.startsWith('--')).map(p => (p.endsWith('/') || p.includes('.') ? p : `${p}/`))
if (prefixes.length === 0) {
  console.error('usage: bun scripts/orphans/rewrite-unread-exports.ts [--dry] <top-level folder or file prefix> …   (e.g. src/services  src/components  scripts/lib)')
  process.exit(2)
}

const census = runCensus(treeOptions())
const byFile = new Map<string, ExportRow[]>()
for (const r of census.rows) {
  if (r.class !== 'candidate') continue
  if (!prefixes.some(p => r.file.startsWith(p) || r.file === p.replace(/\/$/, ''))) continue
  const list = byFile.get(r.file)
  if (list) list.push(r)
  else byFile.set(r.file, [r])
}

let files = 0
let modifiers = 0
let names = 0
let inventory = 0
for (const [rel, rows] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
  const result = rewriteFile(GRAPH_ROOT, rel, rows)
  if (result.removed === 0) continue
  files++
  modifiers += result.removed
  names += result.names.length
  inventory += rows.filter(r => r.inventory).length
  console.log(`${DRY ? '[dry] ' : ''}${rel}: ${result.removed} modifier${result.removed === 1 ? '' : 's'} — ${result.names.join(', ')}`)
  if (!DRY) writeFileSync(join(GRAPH_ROOT, rel), result.after)
}
console.log(`\n${DRY ? 'would remove' : 'removed'} ${modifiers} export modifier${modifiers === 1 ? '' : 's'} (${names} name${names === 1 ? '' : 's'}) in ${files} file${files === 1 ? '' : 's'} under ${prefixes.join(' ')}${inventory ? ` · ${inventory} name${inventory === 1 ? '' : 's'} recorded in scripts/ownership/contract-inventory.json (regenerate: bun scripts/ownership/prove-contract-inventory.ts --record)` : ''}`)
