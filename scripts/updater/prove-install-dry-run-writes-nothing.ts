#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { stageInstall } from '../lib/stagedInstall.ts'

if (process.platform === 'win32') {
  console.log('prove-install-dry-run-writes-nothing: [SKIP] the staged release archive is the POSIX one; the Windows launchers are walked by hand')
  process.exit(0)
}

const { cmdLauncher, parseEnginesNode } = (await import('../release/launcherTemplates.mjs')) as {
  cmdLauncher: (policy: unknown) => string
  parseEnginesNode: (range: string | undefined) => unknown
}

const TREE = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'dry-')))
const archive = stageInstall('release', join(SCRATCH, 'archive'))
const launcher = join(dirname(archive.bundle), 'mercury')
const node = join(dirname(archive.bundle), 'vendor', 'node', 'bin', 'node')
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
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail} — fix isInstallDryRunArgv in src/boot/sessionArgs.ts and its readers in src/boot/main.tsx (the config home and the config file) and src/boot/entrypoints/cli.tsx (the cache with no launcher), or the line above the compile-cache block of each launcher in scripts/release/launcherTemplates.mjs and the probe SPLASH_VERSION_TTY_PROBE_JS there (the cache)`}`)
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

  console.log('── only the verb with its flag turns the cache off ──')
  const cached = (home: string): boolean => existsSync(join(home, '.mercury', 'compile-cache'))
  const prompt = fresh('prompt')
  run(launcher, prompt, ['install the package with --dry-run', '--version'])
  check('a prompt that only holds the words keeps its compile cache', cached(prompt), held(prompt).slice(0, 6).join(' · '))
  const ended = fresh('ended')
  run(launcher, ended, ['install', '--', '--dry-run'])
  check('--dry-run after -- is not the flag: the cache stays on', cached(ended), held(ended).slice(0, 6).join(' · '))
  const bare = fresh('bare')
  const unlaunched = run(node, bare, [archive.bundle, 'install', '--dry-run'])
  check('the bundle started with no launcher writes nothing either', unlaunched.status === 0 && held(bare).length === 0, `exit ${unlaunched.status}: ${held(bare).slice(0, 6).join(' · ')}${unlaunched.stderr.slice(-200)}`)

  console.log('── the cmd launcher: the probe weighs the arguments, and %* stands inside no parenthesis ──')
  const { engines } = JSON.parse(readFileSync(join(TREE, 'package.json'), 'utf8')) as { engines?: { node?: string } }
  const cmd = cmdLauncher(parseEnginesNode(engines?.node)).split('\r\n')
  const probeLine = cmd.find(line => line.startsWith('"%NODEBIN%" -e "') && line.includes('process.stdin.isTTY')) ?? ''
  const probe = probeLine.slice('"%NODEBIN%" -e "'.length, probeLine.indexOf('" >"%MERCURY_PROBE_OUT%"'))
  const dry = (args: string[]): string => (spawnSync(node, ['-e', probe, '--', ...args], { encoding: 'utf8', timeout: 30_000 }).stdout.trim().split(' ')[2] ?? '')
  const verdicts = ([
    [['install', '--dry-run'], '1'],
    [['install', '--dry-run', '--json'], '1'],
    [['install', '--json', '--dry-run'], '1'],
    [['install'], '0'],
    [['install', '--', '--dry-run'], '0'],
    [['install', '*'], '0'],
    [['install the package with --dry-run'], '0'],
    [['run', 'a)b'], '0'],
    [['run', 'foo(bar)'], '0'],
    [['-p', '{"n":"a)b"}'], '0'],
    [['run', '--dry-run'], '0'],
  ] as const).map(([args, want]) => ({ args, want, got: dry([...args]) }))
  check('the probe says 1 for install with --dry-run before --, and 0 for every other argv', probe !== '' && verdicts.every(row => row.got === row.want), verdicts.filter(row => row.got !== row.want).map(row => `${JSON.stringify(row.args)} → ${row.got}`).join(' · '))
  const carriers = cmd.filter(line => line.includes('%*') && !line.startsWith('rem '))
  check('%* stands on the probe line and the boot line alone, outside every parenthesis', carriers.length === 2 && carriers.every(line => !/[()]/.test(line.replace(/"[^"]*"/g, ''))), carriers.map(line => line.slice(0, 80)).join(' · '))
  check('the cache is turned off by the probe\'s word alone', cmd.includes('if "%NODEDRY%"=="1" set "NODE_DISABLE_COMPILE_CACHE=1"') && !cmd.some(line => /for %%\w in \(%\*\)/.test(line)))
} finally {
  removeScratch(SCRATCH)
}

console.log(failures === 0 ? '\nprove-install-dry-run-writes-nothing: ALL HOLD' : `\nprove-install-dry-run-writes-nothing: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
