#!/usr/bin/env bun
// gate-watch: src/boot/main.tsx src/platform/update-channel/installLayout.ts src/boot/launchGraph.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { firstPtyVisibility, requireDist, runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'

const COMPOSER_READY = 'Type a prompt'
const SHIM_MARKER = 'mercury-managed-shim'
const SECONDS = 15

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 700) : ''}`)
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const distPath = arg('--dist')

if (process.platform === 'win32') {
  console.log('prove-boot-leaves-no-launcher-without-an-install: SKIPPED — the arena drives a POSIX terminal, and the launcher folder read here is the POSIX one')
  process.exit(0)
}
if (distPath === undefined) requireDist()

const squash = (s: string): string => s.replace(/\s+/g, '')
const unfired = (run: ArenaRun): string => `${run.outcome.reason ?? 'complete'} · unfired ${JSON.stringify(run.outcome.report?.unfired ?? [])}`

interface Boot {
  run: ArenaRun
  configDir: string
  launcher: string
}

async function boot(seed: (configDir: string) => void): Promise<Boot> {
  let configDir = ''
  const run = await runArtifactArena({
    turns: [],
    sends: [],
    seconds: SECONDS,
    cols: 120,
    rows: 40,
    keep: true,
    anchor: null,
    ...(distPath !== undefined ? { distPath } : {}),
    seedHome: dir => {
      configDir = dir
      seed(dir)
    },
    extraEnv: { BROWSER: '/usr/bin/true', MERCURY_UPDATE_NOTICE: '0' },
  })
  return { run, configDir, launcher: join(run.paths.home, '.local', 'bin', 'mercury') }
}

function reachedTheNodes(b: Boot, name: string): void {
  check(`${name}: the build booted to the chat`, firstPtyVisibility(b.run.ptyReads, squash(COMPOSER_READY), 0) !== undefined, 'the built dist/mercury.mjs never reached the chat composer in the arena, see the unfired sends: ' + unfired(b.run))
  check(
    `${name}: the boot ran its background work past the launcher step (the invocation record, written by the step registered after it, is on disk)`,
    existsSync(join(b.configDir, 'invocation-record.json')),
    `the boot background steps did not run to the invocation record, so a step before it stalled or threw; nothing at ${join(b.configDir, 'invocation-record.json')} after ${SECONDS} s`,
  )
}

section('§1 a build that no managed install stands behind (Homebrew, an archive run in place): a start leaves no launcher in ~/.local/bin')
const bare = await boot(() => {})
try {
  reachedTheNodes(bare, 'no install')
  check(
    'no install: there is no versions pointer under the home, as on a Homebrew install',
    !existsSync(join(bare.configDir, 'versions', 'current.txt')),
    'the fixture home must have no versions/current.txt pointer, the arena seeding wrote one or the boot created it',
  )
  check(
    'no install: the start wrote NO ~/.local/bin/mercury (the managed launcher can only fail there, and ahead of Homebrew on PATH it is the command the shell runs)',
    !existsSync(bare.launcher),
    existsSync(bare.launcher) ? `change the boot launcher step so it writes no ~/.local/bin/mercury when no managed install (versions/current.txt) stands behind it; ${bare.launcher} exists: ${readFileSync(bare.launcher, 'utf8').split('\n').slice(0, 2).join(' | ')}` : '',
  )
} finally {
  bare.run.cleanup()
}

section('§2 the control: with a managed install behind it, the same start still writes the launcher')
const managed = await boot(configDir => {
  const versions = join(configDir, 'versions')
  mkdirSync(join(versions, '9.9.9'), { recursive: true })
  writeFileSync(join(versions, '9.9.9', 'mercury'), '#!/bin/sh\nexit 0\n')
  writeFileSync(join(versions, 'current.txt'), '9.9.9\n')
})
try {
  reachedTheNodes(managed, 'managed')
  check(
    'managed: the start wrote the stable launcher into ~/.local/bin, carrying the managed marker',
    existsSync(managed.launcher) && readFileSync(managed.launcher, 'utf8').includes(SHIM_MARKER),
    existsSync(managed.launcher) ? 'the boot launcher step must still write the launcher with the mercury-managed-shim marker (SHIM_MARKER_FAMILY in src/platform/update-channel/installLayout.ts); the file lacks the marker' : `the boot launcher step must write the launcher when a managed install exists; nothing at ${managed.launcher}`,
  )
} finally {
  managed.run.cleanup()
}


console.log('')
if (failures > 0) {
  console.log(`❌ prove-boot-leaves-no-launcher-without-an-install — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-boot-leaves-no-launcher-without-an-install — all checks pass')
