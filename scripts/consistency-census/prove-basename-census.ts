#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

const censusPath = join(ROOT, 'scripts/consistency-census/basename-census.json')
const committed = readFileSync(censusPath, 'utf8')
const scratch = join(mkdtempSync(join(tmpdir(), 'basename-census-')), 'basename-census.json')
execFileSync(process.execPath, [join(ROOT, 'scripts/consistency-census/gen-basename-census.ts'), '--out', scratch], {
  cwd: ROOT,
  stdio: 'pipe',
})
const after = readFileSync(scratch, 'utf8')
type Site = { file: string; line: number; needle: string; cls: string; why?: string; excerpt?: string }
type Census = { counts: Record<string, number>; needles: string[]; sites: Site[] }
const committedCensus = JSON.parse(committed) as Census
const census = JSON.parse(after) as Census
const siteKey = (x: Site): string => [x.file, x.needle, x.cls, x.why ?? '', x.excerpt ?? ''].join('\u0000')
const committedKeys = committedCensus.sites.map(siteKey).sort()
const regeneratedKeys = census.sites.map(siteKey).sort()
const missing = committedKeys.filter(k => !regeneratedKeys.includes(k))
const added = regeneratedKeys.filter(k => !committedKeys.includes(k))
check(
  '§A regeneration reproduces the committed BASENAME census sites (line numbers excluded)',
  missing.length === 0 && added.length === 0 && JSON.stringify(committedCensus.needles) === JSON.stringify(census.needles),
  `${missing.length} committed site(s) gone, ${added.length} new site(s): ${[...missing, ...added].map(k => k.split('\u0000').slice(0, 3).join(' · ')).join(' | ').slice(0, 400)}`,
)
if (committed !== after) {
  console.log('     (line numbers drifted — refresh the tracked file with: bun scripts/consistency-census/gen-basename-census.ts)')
}
check(
  '§B zero FORBIDDEN rows (the project-.claude-join ban is mechanical)',
  (census.counts['FORBIDDEN'] ?? 0) === 0,
  String(census.counts['FORBIDDEN']),
)
check('§B zero UNCLASSIFIED rows', (census.counts['UNCLASSIFIED'] ?? 0) === 0)

const OWNER_FILES = new Set([
  'src/utils/env.ts',
  'src/utils/envUtils.ts',
  'src/utils/projectConfig.ts',
  'src/entrypoints/cli.tsx',
])
const strayOwners = census.sites.filter(
  s => s.cls === 'owner-internal' && !OWNER_FILES.has(s.file) && !/getMercuryHome|configHome|homeDir/.test(''),
)
const ownerFilesSeen = new Set(census.sites.filter(s => s.cls === 'owner-internal').map(s => s.file))
check(
  `§C the owner-internal family stays bounded (${ownerFilesSeen.size} file(s))`,
  ownerFilesSeen.size <= 10,
  [...ownerFilesSeen].join(', '),
)
void strayOwners

console.log(failed === 0 ? '\n ✅ BASENAME-CENSUS RATCHET HOLDS' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
