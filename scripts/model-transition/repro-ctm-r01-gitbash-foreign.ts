#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/repro-ctm-r01-gitbash-foreign.ts — R01
//  expect-red driver (Rider 1: the git-bash/PowerShell flags are raw
//  unregistered env reads whose FOREIGN spelling leaks into user-facing
//  text; field-proven fresh-install foot-gun).
//
//  Mechanism under test: every runtime environment flag must be registered
//  through substrate/flagRegistry (MERCURY_* canonical; external
//  foreign spellings boundary-decoded via the typed `compat`
//  pairing). The two foreign gitbash/powershell env spellings
//  are read RAW (windowsPaths, shellToolUtils, PowerShellTool, tipRegistry)
//  with no registry row, and the requires-git-bash error + the tip
//  advertise the foreign spelling. The packaged README's Windows section
//  never names the git-bash prerequisite at all.
//
//    §A DEFECT: no MERCURY_GIT_BASH_PATH / MERCURY_USE_POWERSHELL_TOOL
//       registry rows (and no row pairs the foreign spellings)
//    §B DEFECT: raw process.env reads at the four sites
//    §C DEFECT: user-facing text advertises the foreign spelling
//    §D DEFECT: the packaged README omits the git-bash prerequisite
//
//  Exit 0 = defect REPRODUCED (the recorded red for R01's before-state).
//  Exit 1 = not reproduced. Not part of the green gate (repro-*, not prove-*).
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
// Foreign env prefix, composed so vocabulary sweeps never match this repro.
const FOREIGN = ['CLAUDE', 'CODE'].join('_')

const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

// §A — no registry rows, canonical or compat-paired.
const spellings = ['MERCURY_GIT_BASH_PATH', 'MERCURY_USE_POWERSHELL_TOOL']
for (const env of spellings) {
  check(`§A REPRODUCED: no registry row for ${env}`, !FLAG_REGISTRY.some(s => s.env === env))
}
for (const compat of [`${FOREIGN}_GIT_BASH_PATH`, `${FOREIGN}_USE_POWERSHELL_TOOL`]) {
  check(
    `§A REPRODUCED: no registry row pairs ${compat}`,
    !FLAG_REGISTRY.some(s => s.compat === compat),
  )
}

// §B — the raw read sites (the registry decodes at ONE boundary; these are
// scattered direct reads).
const rawSites: Array<[string, string]> = [
  ['src/utils/windowsPaths.ts', `process.env.${FOREIGN}_GIT_BASH_PATH`],
  ['src/utils/shell/shellToolUtils.ts', `process.env.${FOREIGN}_USE_POWERSHELL_TOOL`],
  ['src/tools/PowerShellTool/PowerShellTool.tsx', `process.env.${FOREIGN}_GIT_BASH_PATH`],
  ['src/services/tips/tipRegistry.ts', `process.env.${FOREIGN}_USE_POWERSHELL_TOOL`],
]
for (const [file, needle] of rawSites) {
  check(
    `§B REPRODUCED: raw env read in ${file}`,
    readFileSync(join(ROOT, file), 'utf8').includes(needle),
  )
}

// §C — user-facing foreign spelling: the requires-git-bash message and the
// tip text NAME the foreign spelling to the operator.
const windowsPaths = readFileSync(join(ROOT, 'src/utils/windowsPaths.ts'), 'utf8')
check(
  '§C REPRODUCED: the requires-git-bash message advertises the foreign gitbash path',
  new RegExp(`requires git-bash[\\s\\S]{0,300}${FOREIGN}_GIT_BASH_PATH=`).test(windowsPaths),
)
const tips = readFileSync(join(ROOT, 'src/services/tips/tipRegistry.ts'), 'utf8')
check(
  '§C REPRODUCED: the tip advertises the foreign powershell opt-in',
  tips.includes(`Set ${FOREIGN}_USE_POWERSHELL_TOOL=1`),
)

// §D — the packaged README (launcherTemplates readmeFirst) has no git-bash
// Windows prerequisite.
const readme = readFileSync(join(ROOT, 'scripts/release/launcherTemplates.mjs'), 'utf8')
check(
  '§D REPRODUCED: the packaged README never names git-bash',
  !/git[- ]?bash/i.test(readme),
)

console.log(
  failed === 0
    ? '\n REPRODUCED — R01 red recorded (unregistered foreign-spelled git-bash flags)'
    : '\n NOT REPRODUCED',
)
process.exit(failed === 0 ? 0 : 1)
