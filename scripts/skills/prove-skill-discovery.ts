#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '0.0.0-proof' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

const OTHER_HOME = '.other-tool'
const OTHER_DIR_TOKEN = '${OTHER_TOOL_SKILL_DIR}'
const OTHER_SESSION_TOKEN = '${OTHER_TOOL_SESSION_ID}'
const MERCURY_DIR_TOKEN = '${MERCURY_SKILL_DIR}'
const MERCURY_SESSION_TOKEN = '${MERCURY_SESSION_ID}'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-skill-discovery-'))
const home = join(scratch, 'home')
const configHome = join(home, '.mercury')
const project = join(home, 'project')
mkdirSync(configHome, { recursive: true })
mkdirSync(project, { recursive: true })
delete process.env.NODE_ENV
delete process.env.CI
process.env.HOME = home
process.env.MERCURY_CONFIG_DIR = configHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.chdir(project)
;(await import('../../src/boot/process-state/processState.ts')).setSessionTrustAccepted(true)

const BODY = [
  `dir mercury=${MERCURY_DIR_TOKEN}`,
  `dir other=${OTHER_DIR_TOKEN}`,
  `session mercury=${MERCURY_SESSION_TOKEN}`,
  `session other=${OTHER_SESSION_TOKEN}`,
].join('\n')
function skill(dir: string, name: string, extra = ''): void {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: proof skill ${name}\n${extra}---\n${BODY}\n`)
}
skill(join(project, '.mercury', 'skills'), 'project-real')
skill(join(project, OTHER_HOME, 'skills'), 'project-other')
skill(join(configHome, 'skills'), 'user-real')
skill(join(home, OTHER_HOME, 'skills'), 'user-other')
skill(join(project, 'sub', '.mercury', 'skills'), 'dyn-real')
skill(join(project, 'sub', OTHER_HOME, 'skills'), 'dyn-other')
skill(join(project, '.mercury', 'skills', 'shipping'), 'land-it')
skill(join(project, '.mercury', 'skills', 'debugging', 'strategies'), 'tdd')
skill(join(project, '.mercury', 'skills', 'project-real', 'references'), 'not-a-skill')
skill(join(project, OTHER_HOME, 'skills', 'shipping'), 'other-nested')
skill(join(project, '.mercury', 'skills'), 'scoped-globs', 'globs: "src/**/*.tsx"\n')
skill(join(project, 'sub', '.mercury', 'skills'), 'dyn-cond', 'paths: "lib/**"\n')
skill(join(project, 'sub2', '.mercury', 'skills'), 'dyn-cond-touched', 'paths: "lib/**"\n')

const loader = await import('../../src/integrations/skills/loadSkillsDir.ts')
const { getSessionId } = await import('../../src/boot/process-state/processState.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(" skill discovery — Mercury's homes alone; Mercury's tokens alone")
console.log('============================================================')

const MERCURY_NAMES = ['project-real', 'user-real']
const OTHER_NAMES = ['project-other', 'user-other']
const carriesMercuryOnly = (names: Set<string>): boolean =>
  MERCURY_NAMES.every(n => names.has(n)) && OTHER_NAMES.every(n => !names.has(n))
const expandsMercuryOnly = (text: string, dir: string, sessionId: string): boolean =>
  text.includes(`dir mercury=${dir}`) &&
  text.includes(`session mercury=${sessionId}`) &&
  text.includes(`dir other=${OTHER_DIR_TOKEN}`) &&
  text.includes(`session other=${OTHER_SESSION_TOKEN}`) &&
  !text.includes(MERCURY_DIR_TOKEN) &&
  !text.includes(MERCURY_SESSION_TOKEN)
const walksMercuryOnly = (dirs: string[]): boolean =>
  dirs.includes(join(project, 'sub', '.mercury', 'skills')) &&
  dirs.every(d => !d.includes(`${sep}${OTHER_HOME}${sep}`))

console.log("[1] the catalogue carries Mercury's homes and never a foreign tool's folder")
const commands = await loader.getSkillDirCommands(project)
const names = new Set(commands.map(c => c.name))
check('the Mercury twins load: project, user', MERCURY_NAMES.every(n => names.has(n)), [...names].join(', ') + ' — getSkillDirCommands in src/integrations/skills/loadSkillsDir.ts must load the project and user skill homes')
for (const n of OTHER_NAMES) check(`a foreign tool's folder is never read: ${n} absent`, !names.has(n), 'getSkillDirCommands in src/integrations/skills/loadSkillsDir.ts must not read the foreign tool folder')
check('the homes predicate holds on the real catalogue', carriesMercuryOnly(names), [...names].join(', ') + ' — getSkillDirCommands in src/integrations/skills/loadSkillsDir.ts must load Mercury homes only')
const watch = loader.getProjectSkillsWatchPaths('skills', project)
check('the watch list names the Mercury project home only', watch.length === 1 && watch[0] === join(project, '.mercury', 'skills'), watch.join(', ') + ' — getProjectSkillsWatchPaths in src/integrations/skills/loadSkillsDir.ts must return the Mercury project home only')
const walked = await loader.discoverSkillDirsForPaths([join('sub', 'deep', 'file.ts')], project)
check('the mid-session walk discovers the Mercury home only', walksMercuryOnly(walked), walked.join(', ') + ' — discoverSkillDirsForPaths in src/integrations/skills/loadSkillsDir.ts must walk to the Mercury home only')
await loader.addSkillDirectories(walked)
const dynamic = new Set(loader.getDynamicSkills().map(c => c.name))
check('the dynamic map carries the Mercury twin and never the other', dynamic.has('dyn-real') && !dynamic.has('dyn-other'), [...dynamic].join(', ') + ' — addSkillDirectories and getDynamicSkills in src/integrations/skills/loadSkillsDir.ts must seat the Mercury twin only')

console.log("[2] a body expands Mercury's template tokens and leaves a foreign tool's literal")
const real = commands.find(c => c.name === 'project-real')
let rendered = ''
if (real && real.type === 'prompt') {
  const blocks = await real.getPromptForCommand('', undefined as never)
  rendered = blocks.map(b => (b as { text?: string }).text ?? '').join('')
}
const realDir = join(project, '.mercury', 'skills', 'project-real')
const sessionId = String(getSessionId())
check('the skill rendered', rendered.length > 0, 'project-real did not load or its getPromptForCommand returned no text; check getSkillDirCommands in src/integrations/skills/loadSkillsDir.ts')
check(`${MERCURY_DIR_TOKEN} expands to the skill directory`, rendered.includes(`dir mercury=${realDir}`), rendered.slice(0, 300) + ' — check the SKILL_DIR_TOKEN expansion in src/integrations/skills/loadSkillsDir.ts')
check(`${MERCURY_SESSION_TOKEN} expands to the session id`, rendered.includes(`session mercury=${sessionId}`), 'the session id token expansion in src/integrations/skills/loadSkillsDir.ts must substitute the session id')
check('a foreign skill-dir token stays literal', rendered.includes(`dir other=${OTHER_DIR_TOKEN}`), 'src/integrations/skills/loadSkillsDir.ts must expand only the Mercury skill-dir token')
check('a foreign session token stays literal', rendered.includes(`session other=${OTHER_SESSION_TOKEN}`), 'src/integrations/skills/loadSkillsDir.ts must expand only the Mercury session token')
check('the token predicate holds on the real render', expandsMercuryOnly(rendered, realDir, sessionId), 'token expansion in src/integrations/skills/loadSkillsDir.ts must expand the Mercury tokens and leave the foreign ones literal')

console.log('[3] poison controls — each predicate fails on the input it forbids')
check("a catalogue carrying the foreign folder's project skill FAILS the homes predicate", !carriesMercuryOnly(new Set([...names, 'project-other'])))
check("a catalogue carrying the foreign folder's user skill FAILS the homes predicate", !carriesMercuryOnly(new Set([...names, 'user-other'])))
check('a render that expanded the foreign skill-dir token FAILS the token predicate', !expandsMercuryOnly(rendered.replaceAll(OTHER_DIR_TOKEN, realDir), realDir, sessionId))
check('a render that expanded the foreign session token FAILS the token predicate', !expandsMercuryOnly(rendered.replaceAll(OTHER_SESSION_TOKEN, sessionId), realDir, sessionId))
check('a walk that discovered the foreign folder FAILS the walk predicate', !walksMercuryOnly([...walked, join(project, 'sub', OTHER_HOME, 'skills')]))
check(
  'twin control: every absent skill has a same-shaped Mercury twin that loaded',
  names.has('project-real') && names.has('user-real') && dynamic.has('dyn-real'),
)

console.log('[4] nested category folders, globs: frontmatter, and a monorepo skill scoped to its package')
check('a skill one category folder down is found: shipping/land-it', names.has('land-it'), [...names].join(', ') + ' — getSkillDirCommands in src/integrations/skills/loadSkillsDir.ts must find a skill one category folder down')
check('a skill two category folders down is found: debugging/strategies/tdd', names.has('tdd'), [...names].join(', ') + ' — getSkillDirCommands in src/integrations/skills/loadSkillsDir.ts must find a skill two category folders down')
const landIt = commands.find(c => c.name === 'land-it')
check('the nested skill keeps the leaf folder as its name and base directory', landIt !== undefined && (landIt as { skillRoot?: string }).skillRoot === join(project, '.mercury', 'skills', 'shipping', 'land-it'), String((landIt as { skillRoot?: string } | undefined)?.skillRoot) + ' — src/integrations/skills/loadSkillsDir.ts must set skillRoot to the leaf skill folder')
check("a SKILL.md inside a skill's own subfolder is not a second skill", !names.has('not-a-skill'), 'getSkillDirCommands in src/integrations/skills/loadSkillsDir.ts must not treat a SKILL.md inside a skill subfolder as a skill')
check("a nested folder under a foreign tool's home is still never read", !names.has('other-nested'), 'getSkillDirCommands in src/integrations/skills/loadSkillsDir.ts must not read nested folders under the foreign tool home')
check('a globs: skill is withheld from the catalogue until a matching file is touched', !names.has('scoped-globs') && !dynamic.has('scoped-globs'), 'src/integrations/skills/loadSkillsDir.ts must withhold a globs: skill from the catalogue until activateConditionalSkillsForPaths matches')
const unrelated = loader.activateConditionalSkillsForPaths([join('src', 'app', 'main.ts')], project)
check('a file outside the globs does not activate it', !unrelated.includes('scoped-globs'), unrelated.join(', ') + ' — activateConditionalSkillsForPaths in src/integrations/skills/loadSkillsDir.ts must match the globs')
const activated = loader.activateConditionalSkillsForPaths([join('src', 'app', 'Main.tsx')], project)
check('a matching file activates the globs: skill', activated.includes('scoped-globs') && loader.getDynamicSkills().some(c => c.name === 'scoped-globs'), activated.join(', ') + ' — activateConditionalSkillsForPaths in src/integrations/skills/loadSkillsDir.ts must activate a skill whose globs match')
check('the package skill with paths: is withheld, not seated on discovery', !loader.getDynamicSkills().some(c => c.name === 'dyn-cond'), 'addSkillDirectories in src/integrations/skills/loadSkillsDir.ts must withhold a paths: skill until a matching file is touched')
const rootLib = loader.activateConditionalSkillsForPaths([join('lib', 'a.ts')], project)
check("a path under the project root's lib/ does not match the package's lib/**", !rootLib.includes('dyn-cond'), rootLib.join(', ') + ' — activateConditionalSkillsForPaths in src/integrations/skills/loadSkillsDir.ts must anchor paths: filters at the package root')
const packageLib = loader.activateConditionalSkillsForPaths([join(project, 'sub', 'lib', 'a.ts')], project)
check("a path under the package's lib/ activates it (filters anchor at the package root)", packageLib.includes('dyn-cond') && loader.getDynamicSkills().some(c => c.name === 'dyn-cond'), packageLib.join(', ') + ' — activateConditionalSkillsForPaths in src/integrations/skills/loadSkillsDir.ts must anchor paths: filters at the package root')
const touchedFile = join(project, 'sub2', 'lib', 'b.ts')
mkdirSync(join(project, 'sub2', 'lib'), { recursive: true })
writeFileSync(touchedFile, 'export const b = 1\n')
const found = await loader.discoverSkillDirsForPaths([touchedFile], project)
check('the second package is discovered from the touch', found.includes(join(project, 'sub2', '.mercury', 'skills')), found.join(', ') + ' — discoverSkillDirsForPaths in src/integrations/skills/loadSkillsDir.ts must find the second package skill home from a touched file')
await loader.addSkillDirectories(found, { filePaths: [touchedFile], cwd: project })
check('a discovered conditional skill is tested against the triggering file at once', loader.getDynamicSkills().some(c => c.name === 'dyn-cond-touched'), loader.getDynamicSkills().map(c => c.name).join(', ') + ' — addSkillDirectories in src/integrations/skills/loadSkillsDir.ts must test a discovered conditional skill against the touched file at once')

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ SKILL DISCOVERY — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
