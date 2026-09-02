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
const census = JSON.parse(after) as { sites: Array<{ cls: string; file: string }> }
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
check('§C the remedy spelling is the registry-canonical MERCURY_PYTHON', doctor.includes('point MERCURY_PYTHON at one') && !doctor.includes(['HER', 'MES_PYTHON'].join('')))

console.log(failed === 0 ? '\n ✅ SHELL-STRING CENSUS RATCHET HOLDS' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
