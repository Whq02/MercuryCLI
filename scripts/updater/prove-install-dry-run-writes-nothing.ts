#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { stageInstall } from '../lib/stagedInstall.ts'

if (process.platform === 'win32') {
  console.log('prove-install-dry-run-writes-nothing: [SKIP] the staged release archive is the POSIX one; the Windows launchers are walked by hand')
  process.exit(0)
}

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'dry-')))
const archive = stageInstall('release', join(SCRATCH, 'archive'))
const launcher = join(dirname(archive.bundle), 'mercury')
const NOTE = 'note: no changes made (dry run); configuration and sessions are never touched'

const run = (command: string, home: string, args: string[]): { status: number | null; stdout: string; stderr: string } =>
  spawnSync(command, args, { env: { ...archive.env, HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }, encoding: 'utf8', timeout: 120_000 })
const held = (home: string): string[] =>
  (readdirSync(home, { recursive: true }) as string[]).sort().map(name => {
    const entry = lstatSync(join(home, name))
    return entry.isDirectory() ? name : `${name} ${entry.size} ${entry.mtimeMs}`
  })
const fresh = (name: string): string => {
  const home = join(SCRATCH, name)
  mkdirSync(home)
  return home
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail} — fix isInstallDryRunArgv in src/boot/sessionArgs.ts and its three readers in src/boot/main.tsx (the config home and the config file), or the line above the compile-cache block of posixLauncher in scripts/release/launcherTemplates.mjs (the cache)`}`)
}

console.log('============================================================')
console.log(' mercury install --dry-run writes nothing')
console.log('============================================================')
try {
  const never = fresh('never')
  const told = run(launcher, never, ['install', '--dry-run'])
  check('in a home never installed the dry run ends on its own note, exit 0', told.status === 0 && told.stdout.trimEnd().endsWith(NOTE), `exit ${told.status}: ${told.stdout.slice(-300)}${told.stderr.slice(-300)}`)
  check('and that home is as empty as it was', held(never).length === 0, held(never).slice(0, 8).join(' · '))

  const json = fresh('json')
  const described = run(launcher, json, ['install', '--dry-run', '--json'])
  check('the JSON dry run answers the same plan', described.status === 0 && (JSON.parse(described.stdout) as { state?: string; wouldInstallTo?: string }).wouldInstallTo === join(json, '.mercury', 'versions', basename(dirname(archive.bundle))), `exit ${described.status}: ${described.stdout.slice(0, 400)}`)
  check('and its home is as empty as it was', held(json).length === 0, held(json).slice(0, 8).join(' · '))

  const installed = fresh('installed')
  const made = run(launcher, installed, ['install', '--allow-unsigned'])
  const before = held(installed)
  const again = run(join(installed, '.local', 'bin', 'mercury'), installed, ['install', '--dry-run'])
  const after = held(installed)
  check('in an installed home the installed command\'s dry run answers, exit 0', made.status === 0 && again.status === 0 && again.stdout.includes('would install to:'), `install exit ${made.status}: ${made.stderr.slice(-300)} · dry run exit ${again.status}: ${again.stdout.slice(-300)}${again.stderr.slice(-300)}`)
  check('and every file of that home is as it was', before.length > 0 && before.join('\n') === after.join('\n'), [...after.filter(row => !before.includes(row)), ...before.filter(row => !after.includes(row))].slice(0, 8).join(' · '))
} finally {
  removeScratch(SCRATCH)
}

console.log(failures === 0 ? '\nprove-install-dry-run-writes-nothing: ALL HOLD' : `\nprove-install-dry-run-writes-nothing: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
