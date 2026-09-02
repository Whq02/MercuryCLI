#!/usr/bin/env bun
// ============================================================================
//  scripts/permissions/prove-boot-add-dirs.ts — boot-time workspace-directory
//  admission (small-fix bundle items 2+3, DIRSX's finds).
//
//  The gap: initializeToolPermissionContext DECLARED addDirs but built a
//  fresh empty additionalWorkingDirectories map — a boot with --add-dir X
//  granted X's read scope only after an in-session /add-dir admit. The fix
//  threads the flag directories through the SHARED validator into the same
//  map the in-session admit writes (source 'cliArg').
//
//  Driven in a HERMETIC CHILD (scratch home, scratch project cwd, ambient
//  MERCURY_/CLAUDE_ flags stripped) because the settings/config modules
//  capture cwd + home at import: the child boots the REAL
//  initializeToolPermissionContext and reports the built context.
//
//  Run: ~/.bun/bin/bun run scripts/permissions/prove-boot-add-dirs.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const REPO = path.resolve(import.meta.dir, '../..')
const BUN = process.env.BUN ?? path.join(process.env.HOME ?? '', '.bun/bin/bun')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const SCRATCH = mkdtempSync(path.join(realpathSync(tmpdir()), 'mercury-boot-adddirs-'))
const HOME = path.join(SCRATCH, 'home')
const PROJECT = path.join(SCRATCH, 'project')
const OUTSIDE = path.join(SCRATCH, 'outside-root')
const INSIDE = path.join(PROJECT, 'inside-root')
mkdirSync(HOME, { recursive: true })
mkdirSync(PROJECT, { recursive: true })
mkdirSync(OUTSIDE, { recursive: true })
mkdirSync(INSIDE, { recursive: true })
writeFileSync(path.join(OUTSIDE, 'note.md'), 'outside note\n')

process.on('exit', () => {
  if (failures === 0) {
    try {
      rmSync(SCRATCH, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  } else {
    console.log(`[forensics] scratch kept: ${SCRATCH}`)
  }
})

// The hermetic driver: boots the REAL context constructor and reports what
// it built. DRV_ADD_DIRS = JSON list handed to addDirs; DRV_PROBE = a path
// whose read scope is asked of the BUILT context via the real predicate.
const DRIVER = path.join(SCRATCH, 'driver.ts')
writeFileSync(
  DRIVER,
  `
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { enableConfigs } from '${REPO}/src/utils/config/globalConfig.js'
enableConfigs()
const { initializeToolPermissionContext } = await import('${REPO}/src/utils/permissions/permissionSetup.js')
const { pathInAllowedWorkingPath } = await import('${REPO}/src/utils/permissions/filesystem.js')
const init = await initializeToolPermissionContext({
  allowedToolsCli: [],
  disallowedToolsCli: [],
  permissionMode: 'default',
  allowDangerouslySkipPermissions: false,
  addDirs: JSON.parse(process.env.DRV_ADD_DIRS ?? '[]'),
})
const ctx = init.toolPermissionContext
const probe = process.env.DRV_PROBE
console.log(
  JSON.stringify({
    dirs: [...ctx.additionalWorkingDirectories.entries()],
    warnings: init.warnings,
    probeAllowed: probe ? pathInAllowedWorkingPath(probe, ctx) : null,
    addedDirectories: init.admittedDirectories,
  }),
)
`,
)

interface DriverReport {
  dirs: Array<[string, { path: string; source: string }]>
  warnings: string[]
  probeAllowed: boolean | null
  addedDirectories: string[]
}

function boot(env: Record<string, string>): DriverReport | null {
  const res = spawnSync(BUN, ['run', DRIVER], {
    encoding: 'utf8',
    timeout: 60_000,
    cwd: PROJECT,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => !/^(MERCURY_|CLAUDE_|ANTHROPIC_|HERMES_)/.test(k),
        ),
      ),
      MERCURY_CONFIG_DIR: HOME,
      ...env,
    },
  })
  const lastLine = res.stdout.trim().split('\n').pop() ?? ''
  try {
    return JSON.parse(lastLine) as DriverReport
  } catch {
    check('driver produced a report', false, `stdout: ${res.stdout.slice(-200)} stderr: ${String(res.stderr).slice(-300)}`)
    return null
  }
}

console.log('============================================================')
console.log(' boot add-dirs — the flag reaches the tool-permission context')
console.log('============================================================')

section('(1) --add-dir X: X enters the map (source cliArg) and grants read scope pre-admit')
{
  const report = boot({
    DRV_ADD_DIRS: JSON.stringify([OUTSIDE]),
    DRV_PROBE: path.join(OUTSIDE, 'note.md'),
  })
  if (report) {
    const entry = report.dirs.find(([key]) => key === OUTSIDE)
    check('the directory is IN additionalWorkingDirectories', entry !== undefined, JSON.stringify(report.dirs))
    check('…keyed by its resolved absolute path', entry?.[1]?.path === OUTSIDE)
    check("…attributed to source 'cliArg'", entry?.[1]?.source === 'cliArg', entry?.[1]?.source)
    check(
      'a file under X passes the REAL read-scope predicate at boot (pre-admit)',
      report.probeAllowed === true,
    )
    check('no warnings for a valid directory', report.warnings.length === 0, JSON.stringify(report.warnings))
  }
}

section('(2) containment + trailing separator: a dir inside cwd is silently absorbed; /x/ keys as /x')
{
  const report = boot({
    DRV_ADD_DIRS: JSON.stringify([INSIDE, `${OUTSIDE}${path.sep}`]),
    DRV_PROBE: path.join(INSIDE, 'anything.txt'),
  })
  if (report) {
    check('a dir inside the launch cwd never duplicates into the map', !report.dirs.some(([k]) => k === INSIDE))
    check('…and its scope is already granted through cwd', report.probeAllowed === true)
    check('a trailing separator resolves to the same single key', report.dirs.some(([k]) => k === OUTSIDE))
    check('no warnings for either spelling', report.warnings.length === 0, JSON.stringify(report.warnings))
  }
}

section('(3) an invalid entry warns and is skipped — the boot never aborts')
{
  const missing = path.join(SCRATCH, 'no-such-dir')
  const report = boot({ DRV_ADD_DIRS: JSON.stringify([missing, OUTSIDE]) })
  if (report) {
    check('the missing dir is NOT admitted', !report.dirs.some(([k]) => k === missing))
    check(
      'a warning names it',
      report.warnings.some(w => w.includes('no-such-dir') && w.includes('skipped')),
      JSON.stringify(report.warnings),
    )
    check('the valid sibling still lands (no abort)', report.dirs.some(([k]) => k === OUTSIDE))
  }
}

section("(4) `/add-dir --remember` boot reader: a remembered dir is present at the next boot")
{
  const remembered = path.join(SCRATCH, 'remembered-root')
  mkdirSync(remembered, { recursive: true })
  writeFileSync(path.join(remembered, 'fact.md'), 'remembered fact\n')
  const localDir = path.join(PROJECT, '.mercury')
  mkdirSync(localDir, { recursive: true })
  const settingsPath = path.join(localDir, 'settings.local.json')
  // The exact key `/add-dir --remember` persists (PermissionUpdate.ts).
  writeFileSync(settingsPath, JSON.stringify({ permissions: { additionalDirectories: [remembered] } }))
  const report = boot({ DRV_PROBE: path.join(remembered, 'fact.md') })
  if (report) {
    const entry = report.dirs.find(([key]) => key === remembered)
    check('the remembered dir is IN the permission context', entry !== undefined, JSON.stringify(report.dirs))
    check("…attributed to its settings source ('localSettings')", entry?.[1]?.source === 'localSettings', entry?.[1]?.source)
    check('…its read scope is granted at boot', report.probeAllowed === true)
    check(
      '…and it returns to the WORKSPACE list (instruction roots)',
      (report.addedDirectories ?? []).includes(remembered),
      JSON.stringify(report.addedDirectories ?? null),
    )
  }

  // Flag + remembered merge: both admitted, flag first, each with its source.
  const report2 = boot({ DRV_ADD_DIRS: JSON.stringify([OUTSIDE]) })
  if (report2) {
    check('flag + remembered BOTH admitted', report2.dirs.some(([k]) => k === OUTSIDE) && report2.dirs.some(([k]) => k === remembered))
    check(
      'the workspace list carries both, flag first',
      (report2.addedDirectories ?? [])[0] === OUTSIDE && (report2.addedDirectories ?? []).includes(remembered),
      JSON.stringify(report2.addedDirectories ?? null),
    )
  }

  // A remembered dir that vanished since it was saved: warn + skip, never abort.
  writeFileSync(
    settingsPath,
    JSON.stringify({ permissions: { additionalDirectories: [path.join(SCRATCH, 'vanished-root'), remembered] } }),
  )
  const report3 = boot({})
  if (report3) {
    check('a vanished remembered dir is skipped', !report3.dirs.some(([k]) => k.endsWith('vanished-root')))
    check(
      '…with a warning naming the key and source',
      report3.warnings.some(w => w.includes('permissions.additionalDirectories (localSettings)') && w.includes('vanished-root')),
      JSON.stringify(report3.warnings),
    )
    check('…and the surviving sibling still lands', report3.dirs.some(([k]) => k === remembered))
  }
  rmSync(settingsPath, { force: true })
}

section('(5) the bare-mode law: an explicitly named dir inside cwd still joins the WORKSPACE list')
{
  const report = boot({ DRV_ADD_DIRS: JSON.stringify([INSIDE]) })
  if (report) {
    check('the contained dir stays OUT of the permission map (scope already granted)', !report.dirs.some(([k]) => k === INSIDE))
    check(
      '…but the workspace list records the explicit naming (bare mode must not refuse it)',
      (report.addedDirectories ?? []).includes(INSIDE),
      JSON.stringify(report.addedDirectories ?? null),
    )
  }
}

section('(6) main.tsx wires the returned list into setAddedDirectories (not the raw flag values)')
{
  const mainSrc = (await import('node:fs')).readFileSync(path.join(REPO, 'src/main.tsx'), 'utf8')
  check(
    'setAddedDirectories consumes the admission pass (permissionInit.admittedDirectories)',
    mainSrc.includes('setAddedDirectories(permissionInit.admittedDirectories)'),
  )
  check(
    'the raw-flag spelling is gone',
    !mainSrc.includes('setAddedDirectories((opts.addDir as string[] | undefined) ?? [])'),
  )
}

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ BOOT ADD-DIRS GREEN' : `❌ ${failures} BOOT-ADD-DIRS CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
