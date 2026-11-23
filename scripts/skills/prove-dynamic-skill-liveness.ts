#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const root = mkdtempSync(join(tmpdir(), 'skill-liveness-'))
const home = join(root, 'home')
const project = join(root, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(join(project, 'packages', 'api', 'src'), { recursive: true })
mkdirSync(join(project, 'packages', 'web', 'src'), { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE
process.chdir(project)
;(await import(join(SRC, 'boot/process-state/processState.ts'))).setSessionTrustAccepted(true)

const skills = await import(join(SRC, 'integrations/skills/loadSkillsDir.ts'))

let failures = 0
let checks = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  checks++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const HORIZON_MS = 60
const seam = skills.setDynamicSkillProbeTtlForProofs as ((ms: number | null) => void) | undefined
t('the probe-horizon proof seam exists', typeof seam === 'function', 'export setDynamicSkillProbeTtlForProofs from src/integrations/skills/loadSkillsDir.ts')
seam?.(HORIZON_MS)

const apiSrc = join(project, 'packages', 'api', 'src', 'x.ts')
const webSrc = join(project, 'packages', 'web', 'src', 'y.ts')
writeFileSync(apiSrc, 'export const x = 1\n')
writeFileSync(webSrc, 'export const y = 1\n')
const apiSkills = join(project, 'packages', 'api', '.mercury', 'skills')
const webSkills = join(project, 'packages', 'web', '.mercury', 'skills')

type Cmd = { name: string; description?: string }
const names = (): string[] => (skills.getDynamicSkills() as Cmd[]).map(c => c.name).sort()
const find = (name: string): Cmd | undefined => (skills.getDynamicSkills() as Cmd[]).find(c => c.name === name)
async function discover(path: string): Promise<string[]> {
  return skills.discoverSkillDirsForPaths([path], project) as Promise<string[]>
}
let stamp = Date.now() / 1000 - 3600
function writeSkill(dir: string, name: string, description: string, body = 'body'): string {
  const skillDir = join(dir, name)
  mkdirSync(skillDir, { recursive: true })
  const file = join(skillDir, 'SKILL.md')
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`)
  stamp += 2
  utimesSync(file, stamp, stamp)
  return file
}

console.log('L1 a touch inside a negatively cached candidate re-probes it at once')
{
  const before = await discover(apiSrc)
  t('the absent candidate discovers nothing', before.length === 0, `${JSON.stringify(before)}; discoverSkillDirsForPaths in src/integrations/skills/loadSkillsDir.ts should return no directory for a path with no skills directory`)
  const file = writeSkill(apiSkills, 'hello', 'first')
  const onWrite = await discover(file)
  t('writing the new SKILL.md discovers its directory', onWrite.includes(apiSkills), `${JSON.stringify(onWrite)}; discoverSkillDirsForPaths in src/integrations/skills/loadSkillsDir.ts should re-probe a negatively cached candidate when a path inside it is touched`)
  if (onWrite.length > 0) await skills.addSkillDirectories(onWrite)
  t('the new skill is in the dynamic map', names().includes('hello'), `${names().join(',')}; addSkillDirectories in src/integrations/skills/loadSkillsDir.ts should load the discovered directory into getDynamicSkills`)
}

console.log('L2 the negative cache expires: a skill created beside touched files appears after the horizon')
{
  const before = await discover(webSrc)
  t('the absent candidate discovers nothing', before.length === 0, `${JSON.stringify(before)}; discoverSkillDirsForPaths in src/integrations/skills/loadSkillsDir.ts should return no directory for a path with no skills directory`)
  writeSkill(webSkills, 'web-skill', 'web')
  const within = await discover(webSrc)
  t('inside the horizon the negative probe stands (no re-stat)', within.length === 0, `${JSON.stringify(within)}; the negative probe cache in src/integrations/skills/loadSkillsDir.ts should hold until the probe horizon (setDynamicSkillProbeTtlForProofs) passes`)
  await sleep(HORIZON_MS + 40)
  const after = await discover(webSrc)
  t('after the horizon the directory is discovered', after.includes(webSkills), `${JSON.stringify(after)}; discoverSkillDirsForPaths in src/integrations/skills/loadSkillsDir.ts should expire the negative probe after the horizon`)
  if (after.length > 0) await skills.addSkillDirectories(after)
  t('the skill is in the dynamic map', names().includes('web-skill'), `${names().join(',')}; addSkillDirectories in src/integrations/skills/loadSkillsDir.ts should load the discovered directory into getDynamicSkills`)
}

console.log('L3 an edited nested skill is re-read after the horizon')
{
  t('precondition: the boot-time description', find('hello')?.description === 'first', `${String(find('hello')?.description)}; addSkillDirectories in src/integrations/skills/loadSkillsDir.ts should have loaded hello with its first frontmatter`)
  writeSkill(apiSkills, 'hello', 'edited', 'new body')
  await sleep(HORIZON_MS + 40)
  const found = await discover(apiSrc)
  t('the loaded directory is not re-announced as new', found.length === 0, `${JSON.stringify(found)}; discoverSkillDirsForPaths in src/integrations/skills/loadSkillsDir.ts should return only directories not yet loaded`)
  t('the description flips to the new frontmatter', find('hello')?.description === 'edited', `${String(find('hello')?.description)}; discoverSkillDirsForPaths in src/integrations/skills/loadSkillsDir.ts should re-read a loaded directory whose SKILL.md changed, after the horizon`)
}

console.log('L4 a deleted nested skill leaves the map on the next touch')
{
  writeSkill(apiSkills, 'doomed', 'doomed')
  await sleep(HORIZON_MS + 40)
  await discover(apiSrc)
  t('precondition: the second skill loaded', names().includes('doomed'), `${names().join(',')}; discoverSkillDirsForPaths in src/integrations/skills/loadSkillsDir.ts should load a skill born in a loaded directory`)
  rmSync(join(apiSkills, 'doomed'), { recursive: true, force: true })
  await sleep(HORIZON_MS + 40)
  await discover(apiSrc)
  t('the deleted skill is gone from the map', !names().includes('doomed'), `${names().join(',')}; discoverSkillDirsForPaths in src/integrations/skills/loadSkillsDir.ts should drop a skill whose directory was deleted on the next touch`)
  t('its sibling stands', names().includes('hello'), `${names().join(',')}; the re-read in src/integrations/skills/loadSkillsDir.ts should keep skills whose SKILL.md still exists`)
}

console.log('L5 the catalogue clear prunes a skill whose SKILL.md is gone, at once')
{
  writeSkill(apiSkills, 'gone-soon', 'gone')
  await sleep(HORIZON_MS + 40)
  await discover(apiSrc)
  t('precondition: loaded', names().includes('gone-soon'), `${names().join(',')}; discoverSkillDirsForPaths in src/integrations/skills/loadSkillsDir.ts should load a skill born in a loaded directory`)
  rmSync(join(apiSkills, 'gone-soon'), { recursive: true, force: true })
  skills.clearSkillCaches()
  t('clearSkillCaches drops it without waiting for a touch', !names().includes('gone-soon'), `${names().join(',')}; clearSkillCaches in src/integrations/skills/loadSkillsDir.ts should prune dynamic skills whose SKILL.md is gone`)
  t('the surviving skills stay (never a wipe)', names().includes('hello') && names().includes('web-skill'), `${names().join(',')}; clearSkillCaches in src/integrations/skills/loadSkillsDir.ts should prune only skills whose SKILL.md is gone, never wipe the map`)
}

console.log('L6 a second skill born in an already-loaded directory appears')
{
  writeSkill(webSkills, 'web-second', 'second')
  await sleep(HORIZON_MS + 40)
  const found = await discover(webSrc)
  t('the loaded directory is re-read in place, not re-announced', found.length === 0, `${JSON.stringify(found)}; discoverSkillDirsForPaths in src/integrations/skills/loadSkillsDir.ts should re-read a loaded directory in place and return only new directories`)
  t('the newborn is in the map', names().includes('web-second'), `${names().join(',')}; discoverSkillDirsForPaths in src/integrations/skills/loadSkillsDir.ts should load a skill born in an already-loaded directory`)
}

console.log('L7 controls')
{
  const same = find('hello')
  await sleep(HORIZON_MS + 40)
  await discover(apiSrc)
  await sleep(HORIZON_MS + 40)
  await discover(apiSrc)
  t('an unchanged loaded directory is not re-read (command identity stands)', find('hello') === same, 'discoverSkillDirsForPaths in src/integrations/skills/loadSkillsDir.ts should not rebuild commands of a directory whose SKILL.md files are unchanged')
  mkdirSync(join(project, 'packages', 'api', 'deep', 'src'), { recursive: true })
  const deepSrc = join(project, 'packages', 'api', 'deep', 'src', 'z.ts')
  writeFileSync(deepSrc, 'z\n')
  writeSkill(join(project, 'packages', 'api', 'deep', '.mercury', 'skills'), 'deep-skill', 'deep')
  const found = await discover(deepSrc)
  t('a new directory below a loaded one is announced alone (deepest first, new only)', found.length === 1 && found[0]?.endsWith(join('deep', '.mercury', 'skills')) === true, `${JSON.stringify(found)}; discoverSkillDirsForPaths in src/integrations/skills/loadSkillsDir.ts should announce only the new directory, deepest first`)
  t('the temp tree is where it should be', existsSync(apiSkills))
}

console.log('L8 category-nested skills hot-reload after boot, through the discovery depth bound')
{
  const detector = await import(join(SRC, 'integrations/skill-watch/skillChangeDetector.ts'))
  const { watch } = await import('chokidar')
  const projectSkills = join(project, '.mercury', 'skills')
  const cases = [
    { dir: projectSkills, name: 'top-level' },
    { dir: join(projectSkills, 'team', 'backend'), name: 'deploy' },
    { dir: join(projectSkills, 'a', 'b', 'c', 'd', 'e', 'f', 'g'), name: 'depth-eight' },
  ]
  for (const { dir, name } of cases) writeSkill(dir, name, 'boot')
  const before = await skills.getSkillDirCommands(project)
  t('all three skills load at boot', cases.every(({ name }) => before.some((cmd: Cmd) => cmd.name === name && cmd.description === 'boot')), 'getSkillDirCommands in src/integrations/skills/loadSkillsDir.ts should load nested category skills up to the discovery depth bound')
  const ready: Promise<void>[] = []
  await detector.resetForTesting({
    debounceMs: 30, stabilityThresholdMs: 50, pollIntervalMs: 20, bunPollIntervalMs: 50,
    watcherFactory: (paths: string[], options: Parameters<typeof watch>[1]) => {
      const watcher = watch(paths, options)
      ready.push(new Promise(resolve => watcher.once('ready', resolve)))
      return watcher
    },
  })
  try {
    await detector.initialize()
    await Promise.all(ready)
    for (const { dir, name } of cases) {
      let unsubscribe = (): void => {}
      let timer: ReturnType<typeof setTimeout>
      const changed = new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), 3000)
        unsubscribe = detector.subscribe(() => resolve(true))
      })
      writeSkill(dir, name, 'edited after boot')
      const fired = await changed
      clearTimeout(timer!)
      unsubscribe()
      const after = await skills.getSkillDirCommands(project)
      t(`${name}: the edit fires without a catalogue clear`, fired, 'the watcher in src/integrations/skill-watch/skillChangeDetector.ts should notify subscribers for an edit this deep under the skills directory')
      t(`${name}: the cached catalogue returns the edited frontmatter`, after.some((cmd: Cmd) => cmd.name === name && cmd.description === 'edited after boot'), 'the cache behind getSkillDirCommands in src/integrations/skills/loadSkillsDir.ts should be cleared when src/integrations/skill-watch/skillChangeDetector.ts fires')
    }
  } finally {
    await detector.dispose()
  }
}

rmSync(root, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
