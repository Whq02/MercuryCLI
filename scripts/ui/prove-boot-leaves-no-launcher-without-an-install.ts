#!/usr/bin/env bun
// gate-watch: src/main.tsx src/services/privateChannel/installLayout.ts src/boot/launchGraph.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { firstPtyVisibility, requireDist, runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'

const ROOT = join(import.meta.dir, '..', '..')
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
  check(`${name}: the build booted to the chat`, firstPtyVisibility(b.run.ptyReads, squash(COMPOSER_READY), 0) !== undefined, unfired(b.run))
  check(
    `${name}: the boot ran its background work past the launcher step (the invocation record, written by the step registered after it, is on disk)`,
    existsSync(join(b.configDir, 'invocation-record.json')),
    `nothing at ${join(b.configDir, 'invocation-record.json')} after ${SECONDS} s`,
  )
}

section('§1 a build that no managed install stands behind (Homebrew, an archive run in place): a start leaves no launcher in ~/.local/bin')
const bare = await boot(() => {})
try {
  reachedTheNodes(bare, 'no install')
  check(
    'no install: there is no versions pointer under the home, as on a Homebrew install',
    !existsSync(join(bare.configDir, 'versions', 'current.txt')),
  )
  check(
    'no install: the start wrote NO ~/.local/bin/mercury (the managed launcher can only fail there, and ahead of Homebrew on PATH it is the command the shell runs)',
    !existsSync(bare.launcher),
    existsSync(bare.launcher) ? `${bare.launcher} exists: ${readFileSync(bare.launcher, 'utf8').split('\n').slice(0, 2).join(' | ')}` : '',
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
    existsSync(managed.launcher) ? 'the file lacks the marker' : `nothing at ${managed.launcher}`,
  )
} finally {
  managed.run.cleanup()
}

section('§3 the source: the start-up step goes through the guarded heal, and the entry never writes the launcher set itself')
const main = readFileSync(join(ROOT, 'src', 'main.tsx'), 'utf8')
const nodeAt = main.indexOf("registerBackgroundNode('shim-reconcile'")
const nodeBody = nodeAt === -1 ? '' : main.slice(nodeAt, main.indexOf('})', nodeAt))
check('the shim-reconcile step calls reconcileManagedShims', nodeBody.includes('reconcileManagedShims('), nodeBody)
check('src/main.tsx calls writeShimSet nowhere', !main.includes('writeShimSet'))
const layout = readFileSync(join(ROOT, 'src', 'services', 'privateChannel', 'installLayout.ts'), 'utf8')
const healAt = layout.indexOf('export function reconcileManagedShims(')
const heal = healAt === -1 ? '' : layout.slice(healAt, layout.indexOf('\n}\n', healAt))
check('reconcileManagedShims writes nothing where no current version is named', /if \(readCurrentVersion\(roots\) === null\) return null\s*return writeShimSet\(roots\)/.test(heal), heal)

console.log('')
if (failures > 0) {
  console.log(`❌ prove-boot-leaves-no-launcher-without-an-install — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-boot-leaves-no-launcher-without-an-install — all checks pass')
