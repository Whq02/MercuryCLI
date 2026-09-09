#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

const censusPath = join(ROOT, 'scripts/consistency-census/shellstring-census.json')
const before = readFileSync(censusPath, 'utf8')
execFileSync(process.execPath, [join(ROOT, 'scripts/consistency-census/gen-shellstring-census.ts')], {
  cwd: ROOT,
  stdio: 'pipe',
})
const after = readFileSync(censusPath, 'utf8')
if (before !== after) writeFileSync(censusPath, before)
check('§A regeneration reproduces the SHELL-STRING census byte-for-byte', before === after)
type Site = { cls: string; file: string; mechanism: string; excerpt: string }
const census = JSON.parse(after) as { sites: Site[] }
if (before !== after) {
  const rows = (sites: Site[]): Map<string, { site: Site; count: number }> => {
    const out = new Map<string, { site: Site; count: number }>()
    for (const site of sites) {
      const key = JSON.stringify(site)
      const row = out.get(key) ?? { site, count: 0 }
      row.count++
      out.set(key, row)
    }
    return out
  }
  const committed = rows((JSON.parse(before) as { sites: Site[] }).sites)
  const regenerated = rows(census.sites)
  const name = (s: Site): string => `${s.file} (${s.mechanism}) ${s.excerpt}`
  const surplus = (a: Map<string, { site: Site; count: number }>, b: Map<string, { site: Site; count: number }>): Site[] =>
    [...a].filter(([k, row]) => (b.get(k)?.count ?? 0) < row.count).map(([, row]) => row.site)
  const stale = surplus(committed, regenerated)
  const unrecorded = surplus(regenerated, committed)
  for (const s of stale.slice(0, 20)) console.log(`    committed but not in the tree: ${name(s)}`)
  for (const s of unrecorded.slice(0, 20)) console.log(`    in the tree but not committed: ${name(s)}`)
  const order = stale.length === 0 && unrecorded.length === 0 ? ' (the same rows in a different order or shape)' : ''
  console.log(`    ${stale.length} stale row(s), ${unrecorded.length} unrecorded row(s)${order} — regenerate with scripts/consistency-census/gen-shellstring-census.ts`)
}
check(
  '§B zero unclassified sites',
  census.sites.every(s => s.cls !== 'UNCLASSIFIED'),
  String(census.sites.filter(s => s.cls === 'UNCLASSIFIED').length),
)

const renderTui = readFileSync(join(ROOT, 'scripts/ui/render-tui.ts'), 'utf8')
check('§C render-tui consumes the capture-driver contract', renderTui.includes('resolveCaptureDriver('))
const baselineGen = readFileSync(join(ROOT, 'scripts/ui/generate-visual-baseline.ts'), 'utf8')
check('§C the baseline generator consumes it too', baselineGen.includes('resolveCaptureDriver('))
const doctor = readFileSync(join(ROOT, 'src/utils/healthReport.ts'), 'utf8')
check('§C /health probes through the shared lookup owner (PATHEXT-aware)', doctor.includes("whichSync('python3')"))
check('§C /health names the ConPTY/hosted remedy on Windows source', doctor.includes('scripts/winreg') && doctor.includes('windows-ui workflow'))
check('§C the remedy spelling is the registry-canonical MERCURY_PYTHON', doctor.includes('point MERCURY_PYTHON at one'))

console.log(failed === 0 ? '\n ✅ SHELL-STRING CENSUS RATCHET HOLDS' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
