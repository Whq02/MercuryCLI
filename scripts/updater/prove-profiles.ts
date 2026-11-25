#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { stageInstall, type StagedInstall } from '../lib/stagedInstall.ts'

const TREE = resolve(import.meta.dir, '..', '..')
const SCENES = ['checkout', 'source', 'release'] as const
const at = process.argv.indexOf('--scene')

if (at < 0) {
  if (process.platform === 'win32') {
    console.log('prove-profiles: [SKIP] the scenes stage the two POSIX installs; the Windows command files are walked by hand')
    process.exit(0)
  }
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'profiles-')))
  let worst = 0
  try {
    for (const scene of SCENES) {
      const userHome = join(scratch, scene)
      mkdirSync(userHome)
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: userHome, USERPROFILE: userHome, MERCURY_CREDENTIAL_STORE: 'file' }
      for (const name of ['MERCURY_HOME', 'MERCURY_VERSIONS_DIR', 'MERCURY_DAEMON_DIR']) delete env[name]
      const child = spawnSync(process.execPath, [import.meta.path, '--scene', scene, userHome], { stdio: 'inherit', env })
      if (child.status !== 0) worst = 1
    }
  } finally {
    removeScratch(scratch)
  }
  process.exit(worst)
}

const scene = process.argv[at + 1]
const userHome = process.argv[at + 2] ?? ''
if (userHome === '' || homedir() !== userHome) {
  console.error(`prove-profiles: SAFETY: the scratch HOME ${userHome} was not in place before this scene started (the home is ${homedir()}); nothing was run`)
  process.exit(1)
}
const home = join(userHome, '.mercury')
process.env.MERCURY_CONFIG_DIR = home

const { createProfile, listProfiles, removeProfile, renameProfile } = await import('../../src/platform/profiles/profiles.ts')

let passed = 0
let failed = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (ok) passed++
  else failed++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail === '' ? '' : `${detail} — `}fix src/platform/profiles/profiles.ts (the scratch install is staged by scripts/lib/stagedInstall.ts)`}`)
}
const show = (value: unknown): string => JSON.stringify(value)
const sentence = (reason: string): boolean => /^[A-Z`][^\n]+\.$/.test(reason)
const record = join(home, 'profiles.json')
const home2 = `${home}2`

function checkout(): void {
  console.log('── a checkout run by node dist/mercury.mjs: no installed command ──')
  process.argv[1] = join(TREE, 'dist', 'mercury.mjs')
  const made = createProfile()
  check('create refuses with one sentence that names the installed command', !made.ok && sentence(made.reason) && made.reason.includes('`mercury`'), show(made))
  check('the refusal writes nothing: no second home, no record', !existsSync(home2) && !existsSync(record))
  check('the list is Profile 1 alone, current, with no command', show(listProfiles()) === show([{ id: 1, name: 'Profile 1', home, command: null, current: true }]), show(listProfiles()))
  check('a rename is a label in the record', renameProfile(1, 'Main').ok && listProfiles()[0]?.name === 'Main' && existsSync(record), show(listProfiles()))
  check('the default name back deletes the record', renameProfile(1, '').ok && listProfiles()[0]?.name === 'Profile 1' && !existsSync(record), show(listProfiles()))
  const first = removeProfile(1)
  const none = removeProfile(2)
  check('remove refuses Profile 1 and a profile that is not there, each with one sentence', !first.ok && sentence(first.reason) && !none.ok && sentence(none.reason), show([first, none]))
}

function walk(staged: StagedInstall): void {
  const word2 = join(staged.bin, 'mercury2')
  const program: NodeJS.ProcessEnv = staged.kind === 'source' ? { MERCURY_DIST: staged.bundle } : { MERCURY_VERSIONS_DIR: join(home, 'versions') }
  const version = (JSON.parse(readFileSync(join(TREE, 'dist', 'manifest.json'), 'utf8')) as { version: string }).version
  const run = (command: string, args: string[], extra: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } =>
    spawnSync(command, args, { env: { ...staged.env, ...extra }, encoding: 'utf8', timeout: 120_000 })
  const login = (command: string, extra: NodeJS.ProcessEnv = {}): string => {
    const listed = JSON.parse(run(command, ['auth', 'list', '--json'], extra).stdout) as { families: Array<{ id: string; signedIn: boolean; source: string }> }
    const row = listed.families.find(family => family.id === 'anthropic')
    return row?.signedIn ? row.source : 'none'
  }
  const asSecond = <T>(work: () => T): T => {
    Object.assign(process.env, { MERCURY_CONFIG_DIR: home2 }, staged.kind === 'release' ? program : {})
    try {
      return work()
    } finally {
      process.env.MERCURY_CONFIG_DIR = home
      delete process.env.MERCURY_VERSIONS_DIR
    }
  }
  const held = (): string => show(readdirSync(home2).sort().map(name => [name, statSync(join(home2, name)).mtimeMs]))
  process.argv[1] = staged.bundle

  console.log(`── ${staged.kind}: before the first create ──`)
  check('the list is Profile 1 alone, current, started by mercury', show(listProfiles()) === show([{ id: 1, name: 'Profile 1', home, command: 'mercury', current: true }]), show(listProfiles()))
  check('no record stands', !existsSync(record))

  console.log(`── ${staged.kind}: create ──`)
  const made = createProfile()
  check('create answers profile 2: the first home with 2 appended and the command mercury2', show(made) === show({ ok: true, profile: { id: 2, name: 'Profile 2', home: home2, command: 'mercury2', current: false } }), show(made))
  check('the home is a folder private to the user, with nothing copied into it', existsSync(home2) && (statSync(home2).mode & 0o777) === 0o700 && show(readdirSync(home2)) === show(['profile.json']), existsSync(home2) ? `${(statSync(home2).mode & 0o777).toString(8)} ${show(readdirSync(home2))}` : 'no folder')
  check('the command stands beside mercury and can be run', existsSync(word2) && (statSync(word2).mode & 0o111) !== 0 && show(readdirSync(staged.bin).sort()) === show(['mercury', 'mercury2']), show(readdirSync(staged.bin)))
  check('the record stands and the list has both', existsSync(record) && show(listProfiles().map(row => [row.id, row.command, row.current])) === show([[1, 'mercury', true], [2, 'mercury2', false]]), show(listProfiles()))

  console.log(`── ${staged.kind}: the command starts the one installed program on the second home ──`)
  const printed = run(word2, ['--version'])
  check(`mercury2 --version prints Mercury ${version}`, printed.status === 0 && printed.stdout.trim() === `Mercury ${version}`, show([printed.status, printed.stdout, printed.stderr.slice(-300)]))
  const health = run(word2, ['health', '--json'])
  const sections = health.status === 0 ? (JSON.parse(health.stdout) as { sections: Array<{ checks: Array<{ id: string; evidence?: string }> }> }).sections : []
  const named = sections.flatMap(section => section.checks).find(row => row.id === 'config-home')?.evidence ?? ''
  check('mercury2 health --json names the second home as its config home', named.startsWith(`${home2} via `), show([health.status, named, health.stderr.slice(-300)]))
  check('the second home holds no program of its own', !existsSync(join(home2, 'runtime')) && !existsSync(join(home2, 'versions')) && !existsSync(join(home2, 'bin')), show(readdirSync(home2)))

  console.log(`── ${staged.kind}: a login saved under one home is absent under the other (file store) ──`)
  check('a key is saved under Profile 1', run(staged.command, ['auth', 'login', 'anthropic', '--key', 'sk-ant-profile-one-00000000001111']).status === 0 && login(staged.command).includes('1111'), login(staged.command))
  check('profile 2 is not signed in', login(word2) === 'none', login(word2))
  check('a key saved under profile 2 leaves Profile 1 on its own', run(word2, ['auth', 'login', 'anthropic', '--key', 'sk-ant-profile-two-00000000002222']).status === 0 && login(word2).includes('2222') && login(staged.command).includes('1111'), show([login(staged.command), login(word2)]))

  console.log(`── ${staged.kind}: a rename shows in the list from both homes ──`)
  check('both profiles take a label', renameProfile(2, '  Work  ').ok && renameProfile(1, 'Main').ok && show(listProfiles().map(row => row.name)) === show(['Main', 'Work']), show(listProfiles()))
  const seen = asSecond(() => listProfiles())
  check('a session in the second home lists the same profiles and marks itself current', show(seen) === show([{ id: 1, name: 'Main', home, command: 'mercury', current: false }, { id: 2, name: 'Work', home: home2, command: 'mercury2', current: true }]), show(seen))
  const own = asSecond(() => removeProfile(2))
  check('remove refuses the profile the session runs in, and no profile 9 can be renamed', !own.ok && sentence(own.reason) && existsSync(word2) && !renameProfile(9, 'x').ok, show(own))
  check('the default name back for Profile 1 keeps the record while profile 2 stands', renameProfile(1, '').ok && listProfiles()[0]?.name === 'Profile 1' && existsSync(record), show(listProfiles()))

  console.log(`── ${staged.kind}: remove ──`)
  const before = held()
  const removed = removeProfile(2)
  const after = held()
  check('remove answers the folder it kept', show(removed) === show({ ok: true, keptHome: home2 }), show(removed))
  check('the command is deleted and mercury stands alone', !existsSync(word2) && show(readdirSync(staged.bin)) === show(['mercury']), show(readdirSync(staged.bin)))
  check('nothing inside the kept folder is touched', after === before, `${before} → ${after}`)
  check('the login saved in the kept folder is still there, and Profile 1 keeps its own', login(staged.command, { MERCURY_CONFIG_DIR: home2, ...program }).includes('2222') && login(staged.command).includes('1111'), show([login(staged.command, { MERCURY_CONFIG_DIR: home2, ...program }), login(staged.command)]))
  check('the record is gone and the list is Profile 1 alone', !existsSync(record) && show(listProfiles()) === show([{ id: 1, name: 'Profile 1', home, command: 'mercury', current: true }]), show(listProfiles()))

  console.log(`── ${staged.kind}: the next create adopts the kept folder; a stranger at the command's path stops it ──`)
  const again = createProfile()
  check('create takes number 2 again and the folder is adopted as it stands, its login with it', again.ok && again.profile.home === home2 && login(word2).includes('2222'), show([again, login(word2)]))
  check('that profile is removed again', removeProfile(2).ok && !existsSync(word2) && !existsSync(record))
  writeFileSync(word2, '#!/bin/sh\necho not mercury\n')
  const blocked = createProfile()
  check('create refuses with one sentence naming the file, and leaves it and the record alone', !blocked.ok && sentence(blocked.reason) && blocked.reason.includes(word2) && readFileSync(word2, 'utf8').includes('not mercury') && !existsSync(record), show(blocked))
}

console.log('============================================================')
console.log(` Profiles — ${scene}`)
console.log('============================================================')
if (scene === 'checkout') checkout()
else if (scene === 'source' || scene === 'release') walk(stageInstall(scene, userHome))
else failed++
console.log(`prove-profiles (${scene}): ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
