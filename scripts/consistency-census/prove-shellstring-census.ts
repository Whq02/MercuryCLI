#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shellstringCensus } from './gen-shellstring-census.ts'

const ROOT = join(import.meta.dir, '..', '..')
let failed = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
}

const census = shellstringCensus(ROOT)
const unclassified = census.sites.filter(s => s.cls === 'UNCLASSIFIED')
check('§B zero unclassified sites', unclassified.length === 0, String(unclassified.length))
if (unclassified.length > 0) {
  for (const s of unclassified) console.log(`    ${s.file} (${s.mechanism}) ${s.excerpt}`)
  console.log('    add a rule for it to RULES in scripts/consistency-census/gen-shellstring-census.ts, or change the call')
}
const renderTui = readFileSync(join(ROOT, 'scripts/ui/render-tui.ts'), 'utf8')
check('§C render-tui consumes the capture-driver contract', renderTui.includes('resolveCaptureDriver('), '', 'make scripts/ui/render-tui.ts call resolveCaptureDriver( again')
const baselineGen = readFileSync(join(ROOT, 'scripts/ui/generate-visual-baseline.ts'), 'utf8')
check('§C the baseline generator consumes it too', baselineGen.includes('resolveCaptureDriver('), '', 'make scripts/ui/generate-visual-baseline.ts call resolveCaptureDriver( again')
const { healthContext } = await import('../../src/platform/health/healthReport.ts')
const { proofsChecks } = await import('../../src/platform/health/sections/proofs.ts')
const { whichSync } = await import('../../src/platform/processes/which.ts')
const rendersRow = proofsChecks(await healthContext()).find(row => row.id === 'renders')
const python = whichSync('python3') ?? whichSync('python')
const rendersHere = await rendersRow?.run()
check('§C /health probes through the shared lookup owner (PATHEXT-aware)', rendersHere !== undefined && (python === null ? !/python (?:at|present)/.test(rendersHere.evidence) : rendersHere.evidence.includes(process.platform === 'win32' ? `python present: ${python}` : `python at ${python}`)), rendersHere?.evidence, 'the renders row in src/platform/health/sections/proofs.ts must find python through whichSync in src/platform/processes/which.ts and report it in its evidence')
const platformNow = Object.getOwnPropertyDescriptor(process, 'platform')!
Object.defineProperty(process, 'platform', { ...platformNow, value: 'win32' })
let rendersOnWindows: Awaited<ReturnType<NonNullable<typeof rendersRow>['run']>> | undefined
try {
  rendersOnWindows = await rendersRow?.run()
} finally {
  Object.defineProperty(process, 'platform', platformNow)
}
check('§C /health names the ConPTY/hosted remedy on Windows source', rendersOnWindows?.fix === 'Capture UI frames via scripts/winreg locally, or the hosted windows-ui workflow.', JSON.stringify(rendersOnWindows), 'the renders row fix text for win32 in src/platform/health/sections/proofs.ts must read exactly as this check spells it')
const pathNow = process.env.PATH
process.env.PATH = join(ROOT, 'scripts', 'consistency-census')
if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...platformNow, value: 'linux' })
let rendersNoPython: Awaited<ReturnType<NonNullable<typeof rendersRow>['run']>> | undefined
try {
  rendersNoPython = await rendersRow?.run()
} finally {
  process.env.PATH = pathNow
  Object.defineProperty(process, 'platform', platformNow)
}
check('§C the remedy spelling is the registry-canonical MERCURY_PYTHON', rendersNoPython?.status === 'warn' && rendersNoPython.fix?.includes('point MERCURY_PYTHON at one') === true, JSON.stringify(rendersNoPython), 'with no python on PATH the renders row in src/platform/health/sections/proofs.ts must warn and its fix must say point MERCURY_PYTHON at one')

console.log(failed === 0 ? '\n ✅ SHELL-STRING CENSUS RATCHET HOLDS' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
