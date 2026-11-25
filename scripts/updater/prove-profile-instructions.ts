#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { stageInstall } from '../lib/stagedInstall.ts'

const [mode, userHome = '', ...rest] = process.argv.slice(2)

if (mode === undefined) {
  if (process.platform === 'win32') {
    console.log('prove-profile-instructions: [SKIP] the scene stages the POSIX source deploy')
    process.exit(0)
  }
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'profile-instructions-')))
  const home = join(scratch, 'user')
  mkdirSync(home)
  try {
    const child = spawnSync(process.execPath, [import.meta.path, '--scene', home], { stdio: 'inherit', env: { ...process.env, HOME: home, USERPROFILE: home, MERCURY_CREDENTIAL_STORE: 'file' } })
    process.exit(child.status ?? 1)
  } finally {
    removeScratch(scratch)
  }
}

if (userHome === '' || homedir() !== userHome) {
  console.error(`prove-profile-instructions: SAFETY: the scratch HOME ${userHome} was not in place before this process started (the home is ${homedir()}); nothing was run`)
  process.exit(1)
}
const first = join(userHome, '.mercury')
const second = `${first}2`

if (mode === '--read') {
  process.env.MERCURY_CONFIG_DIR = rest[0] ?? ''
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  const { getInstructionFilePath, getUserRulesDir } = await import('../../src/platform/config/derived.ts')
  const { getInstructionFiles } = await import('../../src/sessions/instructions/instructionFiles.ts')
  const { isInstructionEstatePath } = await import('../../src/permissions/rules/filesystem.ts')
  enableConfigs()
  const files = await getInstructionFiles()
  console.log(JSON.stringify({ userFile: getInstructionFilePath('User'), rulesDir: getUserRulesDir(), read: files.map(file => ({ type: file.type, origin: file.origin, path: file.path, content: file.content })), estate: rest.slice(1).map(path => isInstructionEstatePath(path)) }))
  process.exit(0)
}

process.env.MERCURY_CONFIG_DIR = first
process.argv[1] = stageInstall('source', userHome).bundle
const { createProfile } = await import('../../src/platform/profiles/profiles.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail} — fix firstProfileHome in src/platform/profiles/profiles.ts, or its use by the user file and the user rules folder in src/platform/config/derived.ts and by isProductConfigPath in src/permissions/rules/filesystem.ts`}`)
}
const show = (value: unknown): string => JSON.stringify(value)
const here = join(userHome, 'work', 'here')
mkdirSync(here, { recursive: true })
const SAID = { file: 'Profile 1 says: answer in plain words.', rule: 'Profile 1 rules: no tabs.', own: 'A file of that name in the home of profile 2.', ownRule: 'A rule in the home of profile 2.', stray: 'A home with no marker says this.', strayRule: 'A home with no marker rules this.' }
type Reading = { userFile: string; rulesDir: string; read: Array<{ type: string; origin?: string; path: string; content: string }>; estate: boolean[] }
const reading = (home: string, ...asked: string[]): Reading => {
  const ran = spawnSync(process.execPath, [import.meta.path, '--read', userHome, home, ...asked], { encoding: 'utf8', cwd: here, env: process.env, timeout: 120_000 })
  if (ran.status !== 0) throw new Error(`the instruction files could not be read under ${home}: ${ran.stderr.slice(-400)}`)
  return JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}') as Reading
}
const sources = (seen: Reading): string => show(seen.read.map(entry => [entry.type, entry.origin, entry.path, Object.values(SAID).filter(words => entry.content.includes(words))]))
const instruct = (home: string, words: string, rule: string): void => {
  mkdirSync(join(home, 'rules'), { recursive: true })
  writeFileSync(join(home, 'MERCURY.md'), `${words}\n`)
  writeFileSync(join(home, 'rules', 'house.md'), `${rule}\n`)
}
const OF_FIRST = show([['User', 'user', join(first, 'MERCURY.md'), [SAID.file]], ['User', 'user-rules', join(first, 'rules', 'house.md'), [SAID.rule]]])

console.log('============================================================')
console.log(" A profile reads Profile 1's own instruction files")
console.log('============================================================')
instruct(first, SAID.file, SAID.rule)
const before = reading(first)
check('Profile 1 reads its own MERCURY.md and its rule as the user source', sources(before) === OF_FIRST && before.userFile === join(first, 'MERCURY.md') && before.rulesDir === join(first, 'rules'), show(before))

const made = createProfile()
instruct(second, SAID.own, SAID.ownRule)
const under = reading(second)
check('under profile 2 the instruction files name the file and the rule of Profile 1 as the user source, and carry their sentences', made.ok && made.profile.home === second && sources(under) === OF_FIRST, show([made, under]))
check('a MERCURY.md and a rule standing in the home of profile 2 are not read', !under.read.some(entry => entry.path.startsWith(`${second}${sep}`) || entry.content.includes(SAID.own) || entry.content.includes(SAID.ownRule)), sources(under))
check('the page that edits them is handed the file and the folder of Profile 1', under.userFile === join(first, 'MERCURY.md') && under.rulesDir === join(first, 'rules'), show([under.userFile, under.rulesDir]))
check('Profile 1 reads as before', show(reading(first)) === show(before), show(reading(first)))

const stray = `${first}9`
instruct(stray, SAID.stray, SAID.strayRule)
const apart = reading(stray)
check('a home with no marker, whatever its name, takes its own file and folder as today', apart.userFile === join(stray, 'MERCURY.md') && apart.rulesDir === join(stray, 'rules') && sources(apart) === show([['User', 'user', join(stray, 'MERCURY.md'), [SAID.stray]], ['User', 'user-rules', join(stray, 'rules', 'house.md'), [SAID.strayRule]]]), show(apart))

rmSync(join(first, 'MERCURY.md'))
rmSync(join(first, 'rules'), { recursive: true })
const none = reading(second)
check('with no such file in the home of Profile 1 there is no user source under profile 2', none.read.length === 0 && none.userFile === join(first, 'MERCURY.md'), show(none))

console.log('── the instruction estate, in a family whose first home is not named .mercury ──')
const plain = join(userHome, 'own name', 'home')
const [plainTwo, apartFromIt] = [`${plain}2`, join(userHome, 'own name', 'other')]
instruct(plain, SAID.file, SAID.rule)
instruct(plainTwo, SAID.own, SAID.ownRule)
instruct(apartFromIt, SAID.stray, SAID.strayRule)
writeFileSync(join(plainTwo, 'profile.json'), `${JSON.stringify({ first: plain, id: 2 })}\n`)
const guarded = [join(plain, 'MERCURY.md'), join(plain, 'rules', 'house.md'), join(plainTwo, 'rules', 'house.md')]
const underTwo = reading(plainTwo, ...guarded)
check('under profile 2 the rule it reads from the home of Profile 1 is in the instruction estate, as its own home is', sources(underTwo) === show([['User', 'user', join(plain, 'MERCURY.md'), [SAID.file]], ['User', 'user-rules', join(plain, 'rules', 'house.md'), [SAID.rule]]]) && show(underTwo.estate) === show([true, true, true]), show([sources(underTwo), underTwo.estate]))
check('under Profile 1 every answer is what it was', show(reading(plain, ...guarded).estate) === show([true, true, false]), show(reading(plain, ...guarded).estate))
check('in a home with no marker every answer is what it was', show(reading(apartFromIt, ...guarded, join(apartFromIt, 'rules', 'house.md')).estate) === show([true, false, false, true]), show(reading(apartFromIt, ...guarded, join(apartFromIt, 'rules', 'house.md')).estate))

console.log(failures === 0 ? '\nprove-profile-instructions: ALL HOLD' : `\nprove-profile-instructions: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
