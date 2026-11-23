#!/usr/bin/env bun
import { join } from 'node:path'
import { basenameCensus } from './gen-basename-census.ts'

const ROOT = join(import.meta.dir, '..', '..')
let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

const census = basenameCensus(ROOT)
const forbidden = census.sites.filter(s => s.cls === 'FORBIDDEN')
check(
  '§B zero FORBIDDEN rows (the project-.claude-join ban is mechanical)',
  forbidden.length === 0,
  String(forbidden.length),
)
if (forbidden.length > 0) {
  for (const s of forbidden) console.log(`    ${s.file} (${s.needle}) ${s.excerpt}`)
  console.log('    remove the forbidden basename or move it behind src/sessions/instructions/adapters/claudeCode.ts')
}
const unclassified = census.sites.filter(s => s.cls === 'UNCLASSIFIED')
check('§B zero UNCLASSIFIED rows', unclassified.length === 0, String(unclassified.length))
if (unclassified.length > 0) {
  for (const s of unclassified) console.log(`    ${s.file} (${s.needle}) ${s.excerpt}`)
  console.log('    classify it in RULES in scripts/consistency-census/gen-basename-census.ts, or route through the home/project-dirs owner')
}
const OWNER_FILES = new Set([
  'src/platform/environment/env.ts',
  'src/platform/environment/envUtils.ts',
  'src/platform/settings/projectConfig.ts',
  'src/boot/entrypoints/cli.tsx',
])
const strayOwners = census.sites.filter(
  s => s.cls === 'owner-internal' && !OWNER_FILES.has(s.file) && !/getMercuryHome|configHome|homeDir/.test(''),
)
const ownerFilesSeen = new Set(census.sites.filter(s => s.cls === 'owner-internal').map(s => s.file))
check(
  `§C the owner-internal family stays bounded (${ownerFilesSeen.size} file(s))`,
  ownerFilesSeen.size <= 10,
  `more than 10 files carry owner-internal rows; move the extra basename sites behind the owner files or reclassify them in RULES in scripts/consistency-census/gen-basename-census.ts: ${[...ownerFilesSeen].join(', ')}`,
)
void strayOwners

console.log(failed === 0 ? '\n ✅ BASENAME-CENSUS RATCHET HOLDS' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
