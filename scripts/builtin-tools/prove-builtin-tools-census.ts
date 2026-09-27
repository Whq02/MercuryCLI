#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const repoRoot = resolve(import.meta.dir, '..', '..')
const anchorPath = join(repoRoot, 'scripts', 'builtin-tools', 'fixtures', 'tool-census.json')

const { buildToolCensus, stableCensus, CENSUS_VERSION } = await import(
  '../../src/utils/capability/census.ts'
)
const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')
const { EXECUTION_DOMAIN_CENSUS } = await import(
  '../../src/services/primitives/executionCensus.ts'
)
const { isMutationOperation } = await import(
  '../../src/services/changeTransaction/contracts.ts'
)
const { resourceAdapterKinds } = await import('../../src/services/resources/registry.ts')

console.log('── arsenal census drift gate ──')

const census = buildToolCensus()
const live = { version: CENSUS_VERSION, rows: stableCensus(census) }
check('committed census anchor exists', existsSync(anchorPath), anchorPath)
let committed: typeof live | null = null
try {
  committed = JSON.parse(readFileSync(anchorPath, 'utf8')) as typeof live
} catch {
  committed = null
}
const liveJson = JSON.stringify(live, null, 2)
const committedJson = committed ? JSON.stringify(committed, null, 2) : ''
if (liveJson !== committedJson && committed) {
  const liveNames = new Set(live.rows.map(r => r.name))
  const committedNames = new Set(committed.rows.map(r => r.name))
  const added = [...liveNames].filter(n => !committedNames.has(n))
  const removed = [...committedNames].filter(n => !liveNames.has(n))
  check(
    'census anchor matches the live catalog',
    false,
    `run \`bun run scripts/builtin-tools/census-gen.ts\` and commit — ` +
      `${added.length ? `new: ${added.join(', ')}; ` : ''}` +
      `${removed.length ? `gone: ${removed.join(', ')}; ` : ''}` +
      `${!added.length && !removed.length ? 'row content changed' : ''}`,
  )
} else {
  check('census anchor matches the live catalog', liveJson === committedJson)
}

const missingProofs = census.rows
  .filter(r => r.proof !== null && !existsSync(join(repoRoot, r.proof)))
  .map(r => `${r.name} → ${r.proof}`)
check('every claimed proof path exists', missingProofs.length === 0, missingProofs.join('; '))

const flagNames = new Set(FLAG_REGISTRY.map((f: { env: string }) => f.env))
const executionKinds = new Set(
  EXECUTION_DOMAIN_CENSUS.map((e: { kind?: string }) => e.kind).filter(Boolean),
)
const resourceKinds = new Set(resourceAdapterKinds().map((k: { kind: string }) => k.kind))

const badFlags: string[] = []
const badExecution: string[] = []
const badResources: string[] = []
const badTransactions: string[] = []
for (const row of census.rows) {
  const d = row.declared
  if (!d) continue
  if (d.gate && !flagNames.has(d.gate)) badFlags.push(`${row.name} → ${d.gate}`)
  if (d.execution && !executionKinds.has(d.execution.kind)) {
    badExecution.push(`${row.name} → ${d.execution.kind}`)
  }
  for (const kind of d.resources ?? []) {
    if (!resourceKinds.has(kind)) badResources.push(`${row.name} → ${kind}`)
  }
  if (d.transaction?.receipts && !isMutationOperation(`${d.transaction.kind}.probe`)) {
    badTransactions.push(`${row.name} → ${d.transaction.kind}`)
  }
}
check('declared gate flags exist in flagRegistry', badFlags.length === 0, badFlags.join('; '))
check(
  'declared execution kinds are census-classified',
  badExecution.length === 0,
  badExecution.join('; '),
)
check(
  'declared resource kinds are registered adapters',
  badResources.length === 0,
  badResources.join('; '),
)
check(
  'declared receipt-minting transaction kinds are in the receipt vocabulary',
  badTransactions.length === 0,
  badTransactions.join('; '),
)

const ACKNOWLEDGED_UNDECLARED: string[] = [
]
const undeclared = census.rows.filter(r => r.declared === null).map(r => r.name)
const newUndeclared = undeclared.filter(n => !ACKNOWLEDGED_UNDECLARED.includes(n))
check(
  'no production tool without a declared capability contract (beyond the ratchet)',
  newUndeclared.length === 0,
  `undeclared: ${newUndeclared.join(', ')}`,
)

const RETIRED_TOOLS = ['RememberLesson', 'LaunchFleet']
const RETIRED_SCAN_ROOTS = ['src', 'docs', 'scripts/builtin-tools/fixtures', 'scripts/project-services/fixtures']
const TEXT_FILE = /\.(ts|tsx|js|mjs|cjs|json|md|txt|sh|ya?ml|tsv|csv)$/
function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      walk(path, out)
    } else if (TEXT_FILE.test(entry.name)) {
      out.push(path)
    }
  }
  return out
}
const survivors: string[] = []
for (const root of RETIRED_SCAN_ROOTS) {
  const dir = join(repoRoot, root)
  if (!existsSync(dir)) continue
  for (const file of walk(dir, [])) {
    const rel = file.slice(repoRoot.length + 1)
    const text = readFileSync(file, 'utf8')
    const hits = RETIRED_TOOLS.filter(name => rel.includes(name) || text.includes(name))
    if (hits.length > 0) survivors.push(`${rel} (${hits.join(', ')})`)
  }
}
check(
  'neither retired tool name survives in src/, docs/ or the roster fixtures: RememberLesson (plain memory writing and RecordConvention cover it) and LaunchFleet (TaskCreate once per subtask covers it)',
  survivors.length === 0,
  `${survivors.length} file(s): ${survivors.join('; ')}`,
)
check(
  'the live census rows name neither retired tool',
  !census.rows.some(r => RETIRED_TOOLS.includes(r.name)),
  census.rows.filter(r => RETIRED_TOOLS.includes(r.name)).map(r => r.name).join(', '),
)
check(
  'the census counts 73 tools: the 75 less RememberLesson and LaunchFleet',
  census.summary.tools === 73,
  `live census: ${census.summary.tools} tools`,
)

console.log(failures === 0 ? 'builtin-tools census: ALL GREEN' : `builtin-tools census: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
