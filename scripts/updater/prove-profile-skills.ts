#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { stageInstall } from '../lib/stagedInstall.ts'

const [mode, userHome = '', ...rest] = process.argv.slice(2)

if (mode === undefined) {
  if (process.platform === 'win32') {
    console.log('prove-profile-skills: [SKIP] the scene stages the POSIX source deploy')
    process.exit(0)
  }
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'profile-skills-')))
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
  console.error(`prove-profile-skills: SAFETY: the scratch HOME ${userHome} was not in place before this process started (the home is ${homedir()}); nothing was run`)
  process.exit(1)
}
const first = join(userHome, '.mercury')
const second = `${first}2`

if (mode === '--kit') {
  const [home = '', op = '', folder = '', name = '', state = ''] = rest
  process.env.MERCURY_CONFIG_DIR = home
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  const { getProjectConfigForWorkspace } = await import('../../src/platform/config/projectConfig.ts')
  const { DEFAULT_PROJECT_CONFIG } = await import('../../src/platform/config/schema.ts')
  const { setPathTrusted } = await import('../../src/platform/config/trust.ts')
  const { kitDeltasForWorkspace, setMcpServerEnabledForWorkspace, setSkillStateForWorkspace } = await import('../../src/integrations/mcp/kitStore.ts')
  const { offSkillNamesOf } = await import('../../src/integrations/skills/kitGovernance.ts')
  const { deriveSessionKitForWorkspace } = await import('../../src/daemon/session-seat/sessionKit.ts')
  enableConfigs()
  if (op === 'skill' && (state === 'on' || state === 'off' || state === 'invocable')) setSkillStateForWorkspace(folder, name, state)
  if (op === 'mcp') setMcpServerEnabledForWorkspace(folder, name, false)
  if (op === 'trust') setPathTrusted(folder)
  const record = getProjectConfigForWorkspace(folder)
  const deltas = kitDeltasForWorkspace(folder)
  console.log(JSON.stringify({ off: offSkillNamesOf(deriveSessionKitForWorkspace(folder), []).sort(), states: deltas.skillStates, mcpOff: deltas.mcpOff, trusted: record.hasTrustDialogAccepted === true, theConstant: record === DEFAULT_PROJECT_CONFIG }))
  process.exit(0)
}

process.env.MERCURY_CONFIG_DIR = first
const staged = stageInstall('source', userHome)
process.argv[1] = staged.bundle
const { createProfile, removeProfile } = await import('../../src/platform/profiles/profiles.ts')
const { inheritSkills } = await import('../../src/integrations/skills/inheritSkills.ts')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail} — fix inheritSkills in src/integrations/skills/inheritSkills.ts, unseenProjectConfig in src/platform/config/projectConfig.ts, or its use in src/platform/config/trust.ts`}`)
}
const show = (value: unknown): string => JSON.stringify(value)
const tree = (root: string): string => {
  const walk = (dir: string): Array<[string, string]> => readdirSync(dir).sort().flatMap(name => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [[relative(root, join(dir, name)), readFileSync(join(dir, name), 'base64')] as [string, string]]))
  return existsSync(root) ? show(walk(root)) : 'no folder'
}
const skill = (dir: string, body: string): void => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\ndescription: ${body}\n---\n${body}\n`)
}
type Kit = { off: string[]; states: Record<string, string>; mcpOff: string[]; trusted: boolean; theConstant: boolean }
const kit = (home: string, op: string, folder: string, ...more: string[]): Kit => {
  const ran = spawnSync(process.execPath, [import.meta.path, '--kit', userHome, home, op, folder, ...more], { encoding: 'utf8', env: process.env, timeout: 120_000 })
  if (ran.status !== 0) throw new Error(`the kit could not be read under ${home}: ${ran.stderr.slice(-400)}`)
  return JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}') as Kit
}
const folder = (name: string): string => {
  const dir = join(userHome, 'work', name)
  mkdirSync(dir, { recursive: true })
  return dir
}
const [here, elsewhere, toggled, trusted] = [folder('here'), folder('elsewhere'), folder('toggled'), folder('trusted')]

console.log('============================================================')
console.log(' A new profile inherits the user-made skills, switched off')
console.log('============================================================')
skill(join(first, 'skills', 'alpha'), 'the first')
skill(join(first, 'skills', 'shelf', 'beta'), 'the second, one folder down')
skill(join(first, 'skills', 'attic', 'zeta'), 'the third, found before the second')
skill(join(first, 'skills', 'attic', 'alpha'), 'a second folder of the first one\'s name')
skill(join(first, 'skills', 'not a skill name'), 'a folder the kit cannot name')
writeFileSync(join(first, 'skills', 'notes.txt'), 'kept beside the skills\n')
const firstSkills = tree(join(first, 'skills'))
const firstKit = kit(first, 'skill', here, 'alpha', 'invocable')
const firstConfig = readFileSync(join(first, '.mercury.json'), 'base64')
process.chdir(here)

console.log('── create, then the copy ──')
const made = createProfile()
check('create says it made the home', made.ok && made.adopted === false && made.profile.home === second, show(made))
const copied = await inheritSkills(second)
check('the copy answers the skills it holds off: each name once, in order, the one the kit cannot name left out', show(copied) === show({ ok: true, skills: ['alpha', 'beta', 'zeta'] }), show(copied))
check('the new home holds the skills folder byte for byte, and nothing half-made beside it', tree(join(second, 'skills')) === firstSkills && !readdirSync(second).some(name => name.startsWith('skills.')), show(readdirSync(second)))

console.log('── under the new home, the kit ──')
const ALL = show(['alpha', 'beta', 'zeta'])
check('off in the folder the create was made from', show(kit(second, 'read', here).off) === ALL, show(kit(second, 'read', here)))
check('off in a folder the new home has never seen', show(kit(second, 'read', elsewhere).off) === ALL, show(kit(second, 'read', elsewhere)))
const on = kit(second, 'skill', elsewhere, 'alpha', 'on')
check('switched on there it is on there, and the other inherited skills stay off', show(on.off) === show(['beta', 'zeta']) && show(kit(second, 'read', elsewhere).off) === show(['beta', 'zeta']), show(on))
check('and it is still off in the first folder', show(kit(second, 'read', here).off) === ALL, show(kit(second, 'read', here)))
const dialled = kit(second, 'mcp', toggled, 'some-server')
check('after an MCP toggle wrote a third folder its first record, all are still off there', show(dialled.off) === ALL && dialled.mcpOff.includes('some-server'), show(dialled))
const trust = kit(second, 'trust', trusted)
check('after trusting a fourth folder wrote its first record, all are still off there', trust.trusted && show(trust.off) === ALL, show(trust))
kit(second, 'skill', elsewhere, 'beta', 'on')
const allOn = kit(second, 'skill', elsewhere, 'zeta', 'on')
check('with the last one switched on there nothing is off in that folder, and it stays so', allOn.off.length === 0 && !allOn.theConstant && kit(second, 'read', elsewhere).off.length === 0, show(allOn))
skill(join(second, 'skills', 'gamma'), 'added in the new profile later')
check('a skill added to the new profile later is not held off', show(kit(second, 'read', folder('later')).off) === ALL, show(kit(second, 'read', folder('later'))))

console.log('── Profile 1 ──')
const own = kit(first, 'read', elsewhere)
check('its skills folder and its config file are byte for byte as they were', tree(join(first, 'skills')) === firstSkills && readFileSync(join(first, '.mercury.json'), 'base64') === firstConfig)
check('its own kit record stands as it set it, and nothing is held off for it', show(kit(first, 'read', here).states) === show({ alpha: 'invocable' }) && show(firstKit.states) === show({ alpha: 'invocable' }) && own.off.length === 0, show([kit(first, 'read', here), own]))
check('a folder it has no record for reads as the same constant as before', own.theConstant && show(own.states) === show({}), show(own))

console.log('── adopted homes ──')
const kept = tree(join(second, 'skills'))
const dropped = removeProfile(2)
const again = createProfile()
const none = await inheritSkills(second)
check('a second create adopts the home, and the copy leaves its skills folder as it stands', dropped.ok && again.ok && again.adopted === true && show(none) === show({ ok: true, skills: [] }) && tree(join(second, 'skills')) === kept, show([again, none]))
skill(join(`${first}3`, 'skills', 'own'), 'this folder had skills of its own')
const third = tree(join(`${first}3`, 'skills'))
check('an adopted home with a skills folder and no config: nothing is copied', createProfile().ok && show(await inheritSkills(`${first}3`)) === show({ ok: true, skills: [] }) && tree(join(`${first}3`, 'skills')) === third && !existsSync(join(`${first}3`, '.mercury.json')), tree(join(`${first}3`, 'skills')))
mkdirSync(`${first}4`)
writeFileSync(join(`${first}4`, '.mercury.json'), '{}\n')
check('an adopted home with a config and no skills folder: nothing is copied or written', createProfile().ok && show(await inheritSkills(`${first}4`)) === show({ ok: true, skills: [] }) && !existsSync(join(`${first}4`, 'skills')) && readFileSync(join(`${first}4`, '.mercury.json'), 'utf8') === '{}\n', show(readdirSync(`${first}4`)))
writeFileSync(join(first, 'skills', 'zz-locked'), 'no one may read this\n')
chmodSync(join(first, 'skills', 'zz-locked'), 0o000)
const fifth = createProfile()
const failed = fifth.ok ? await inheritSkills(fifth.profile.home) : fifth
check('a copy that fails half way says so in one sentence and leaves nothing of itself in the new home', fifth.ok && !failed.ok && /^[A-Z][^\n]+\.$/.test(failed.reason) && show(readdirSync(fifth.profile.home)) === show(['profile.json']), show([failed, fifth.ok ? readdirSync(fifth.profile.home) : fifth]))
rmSync(join(first, 'skills'), { recursive: true })
const bare = createProfile()
check('a home with no skills of its own hands nothing on, and writes nothing into the new home', bare.ok && bare.adopted === false && show(await inheritSkills(bare.profile.home)) === show({ ok: true, skills: [] }) && show(readdirSync(bare.profile.home)) === show(['profile.json']), bare.ok ? show(readdirSync(bare.profile.home)) : show(bare))

console.log(failures === 0 ? '\nprove-profile-skills: ALL HOLD' : `\nprove-profile-skills: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
