import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'skill-references-kept-')))
process.env.MERCURY_TMPDIR = join(scratch, 'tmp')
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
}
const section = (title: string): void => console.log(`\n${title}`)

const NOTES = '# Notes\n\nThe reference a skill names under its base directory.\n'
const DEEP = 'a page two folders down\n'
const PROBE = '#!/usr/bin/env node\nconsole.log("probe ok")\n'
const FILES: Record<string, string> = { 'references/notes.md': NOTES, 'references/deep/page.md': DEEP, 'scripts/probe.mjs': PROBE }
const walk = (dir: string): string[] => {
  const out: string[] = []
  const visit = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) visit(path)
      else out.push(relative(dir, path).split('\\').join('/'))
    }
  }
  if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) visit(dir)
  return out.sort()
}
const whole = (dir: string): boolean => Object.entries(FILES).every(([rel, text]) => lstatSync(join(dir, rel), { throwIfNoEntry: false })?.isFile() === true && readFileSync(join(dir, rel), 'utf8') === text)
const ownFolders = (dir: string): boolean => [dir, join(dir, 'references'), join(dir, 'references/deep'), join(dir, 'scripts')].every(path => lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true)
const mode = (path: string): number => (statSync(path, { throwIfNoEntry: false })?.mode ?? 0) & 0o777
const gone = (path: string): void => rmSync(path, { force: true })
const linkAt = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true
const linkFolder = (target: string, path: string): void => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
const dropLink = (path: string): void => { try { unlinkSync(path) } catch { rmdirSync(path) } }
const plant = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
const named = (prompt: string): string | undefined => /^Base directory for this skill: (.+?) \(read or grep/.exec(prompt)?.[1]
const foreignFolder = (name: string, files: Record<string, string> = { 'foreign.txt': 'foreign sentinel\n' }): string => {
  const dir = join(scratch, name)
  for (const [rel, text] of Object.entries(files)) plant(join(dir, rel), text)
  return dir
}
const untouched = (dir: string, files: Record<string, string> = { 'foreign.txt': 'foreign sentinel\n' }): boolean => walk(dir).join(' ') === Object.keys(files).sort().join(' ') && Object.entries(files).every(([rel, text]) => readFileSync(join(dir, rel), 'utf8') === text) && readdirSync(dir).length === new Set(Object.keys(files).map(rel => rel.split('/')[0])).size

try {
  const { registerBundledSkill, getBundledSkills, getBundledSkillExtractDir } = await import('../../src/skills/bundledSkills.ts')
  const { getBundledSkillsRoot } = await import('../../src/utils/permissions/filesystem.ts')
  const root = getBundledSkillsRoot()
  const fixtures = ['kept-fixture', 'kept-one-gone', 'kept-edited', 'kept-file-link', 'kept-tick', 'kept-empty-planted', 'kept-link-planted', 'kept-inner-link', 'kept-inner-twin', 'kept-inner-file', 'kept-skill-link', 'kept-obstacle', 'kept-above']
  for (const name of fixtures) registerBundledSkill({ name, description: 'a fixture skill with reference files', files: FILES, getPromptForCommand: async args => [{ type: 'text', text: `# ${name}\n\n${args}` }] })
  registerBundledSkill({ name: 'kept-lazy', description: 'a fixture skill whose files come from a provider', files: () => FILES, getPromptForCommand: async () => [{ type: 'text', text: '# kept-lazy' }] })
  registerBundledSkill({ name: 'kept-planted', description: 'a fixture skill whose folder holds a file before its first use', files: { 'references/notes.md': NOTES }, getPromptForCommand: async () => [{ type: 'text', text: '# kept-planted' }] })
  const skill = (name: string) => getBundledSkills().find(command => command.name === name) as unknown as { getPromptForCommand: (args: string, context: never) => Promise<Array<{ text?: string }>> }
  const prompt = async (name: string, args = ''): Promise<string> => (await skill(name).getPromptForCommand(args, {} as never)).map(block => block.text ?? '').join('')
  const firstUse = async (name: string): Promise<string> => { const dir = named(await prompt(name)); if (dir === undefined || !whole(dir)) throw new Error(`the first use of ${name} extracted nothing`); return dir }
  const underRoot = (dir: string | undefined): boolean => dir !== undefined && dirname(dir) === root

  section('§1 the first use writes the reference files and names their folder')
  const before = getBundledSkillExtractDir('kept-fixture')
  check('nothing stands before the first use', !existsSync(before) && before === join(root, 'kept-fixture'))
  const first = await prompt('kept-fixture', 'one')
  const dir = named(first)!
  check('the prompt opens on the base-directory line naming the skill folder under the process folder', dir === before && first.includes('\n\n# kept-fixture\n\none'), first.slice(0, 160))
  check('the three reference files stand under it, byte for byte', whole(dir) && walk(dir).join(' ') === Object.keys(FILES).sort().join(' '), walk(dir).join(' '))
  if (process.platform !== 'win32') check('the helper with a shebang is owner-executable, the pages owner-only, the folders owner-only', mode(join(dir, 'scripts/probe.mjs')) === 0o700 && mode(join(dir, 'references/notes.md')) === 0o600 && mode(dir) === 0o700 && mode(join(dir, 'references/deep')) === 0o700)
  const again = await prompt('kept-fixture', 'again')
  check('a use over a whole folder names the same folder and adds none', named(again) === dir && readdirSync(root).filter(name => name.startsWith('kept-fixture')).length === 1)

  section("§2 the system's temp cleaner takes the files and leaves the folders: the next use extracts into a folder of its own")
  for (const rel of Object.keys(FILES)) gone(join(dir, rel))
  check('the scene: every file is gone, every folder stands', walk(dir).length === 0 && ownFolders(dir))
  const second = await prompt('kept-fixture', 'two')
  const fresh = named(second)
  check('the prompt opens on a base-directory line naming another folder under the process folder', underRoot(fresh) && fresh !== dir, second.slice(0, 200))
  check('every file the line promises stands under that folder, byte for byte, in folders of its own', fresh !== undefined && whole(fresh) && ownFolders(fresh), fresh === undefined ? 'no folder named' : walk(fresh).join(' ') || 'the folder holds no file')
  if (process.platform !== 'win32') check('the helper is owner-executable there', fresh !== undefined && mode(join(fresh, 'scripts/probe.mjs')) === 0o700 && mode(join(fresh, 'references/notes.md')) === 0o600 && mode(fresh) === 0o700)
  check('the emptied folder is left as it was: nothing written into it', walk(dir).length === 0 && ownFolders(dir))
  check('the module answers the folder the prompt named', fresh !== undefined && getBundledSkillExtractDir('kept-fixture') === fresh)

  section('§3 the emptied folders are taken too, up to the process folder: the next use makes it again')
  rmSync(root, { recursive: true, force: true })
  check('the scene: the process folder is gone', !existsSync(root))
  const third = named(await prompt('kept-fixture', 'three'))
  check('the prompt names a folder under the process folder and its files stand', underRoot(third) && whole(third!) && lstatSync(root).isDirectory(), third === undefined ? 'no folder named' : walk(third).join(' '))

  section('§4 one file gone among three: the damaged folder is not touched, a whole one is named')
  const oneGone = await firstUse('kept-one-gone')
  const identity = (path: string): string => { const info = lstatSync(path, { throwIfNoEntry: false }); return info ? `${info.ino}:${info.mtimeMs}` : 'absent' }
  const stood = { notes: identity(join(oneGone, 'references/notes.md')), probe: identity(join(oneGone, 'scripts/probe.mjs')) }
  gone(join(oneGone, 'references/deep/page.md'))
  const mended = named(await prompt('kept-one-gone'))
  check('the prompt names another folder that holds all three', underRoot(mended) && mended !== oneGone && whole(mended!), mended === undefined ? 'no folder named' : walk(mended).join(' '))
  check('in the damaged folder the two files that stood keep their inode and their write time and the third stays gone', stood.notes !== 'absent' && identity(join(oneGone, 'references/notes.md')) === stood.notes && identity(join(oneGone, 'scripts/probe.mjs')) === stood.probe && !existsSync(join(oneGone, 'references/deep/page.md')))

  section('§5 a regular file that stands is never overwritten, whatever it holds')
  const edited = await firstUse('kept-edited')
  gone(join(edited, 'references/notes.md'))
  plant(join(edited, 'references/notes.md'), 'an operator edited this page\n')
  const afterEdit = named(await prompt('kept-edited'))
  check("the folder is whole: the prompt names it again and the edited page keeps the operator's bytes", afterEdit === edited && readFileSync(join(edited, 'references/notes.md'), 'utf8') === 'an operator edited this page\n' && readdirSync(root).filter(name => name.startsWith('kept-edited')).length === 1)

  if (process.platform === 'win32') console.log('\n§6 SKIP on win32: a link to a file needs a privilege an ordinary account lacks; the folder links of §10 to §12 are junctions there')
  else {
    section('§6 a link standing at a reference path: it is not read as the file, not followed, not unlinked')
    const linked = await firstUse('kept-file-link')
    const target = foreignFolder('foreign-file-link')
    gone(join(linked, 'references/notes.md'))
    symlinkSync(join(target, 'foreign.txt'), join(linked, 'references/notes.md'))
    gone(join(linked, 'references/deep/page.md'))
    symlinkSync(join(target, 'not-there.md'), join(linked, 'references/deep/page.md'))
    const afterLink = named(await prompt('kept-file-link'))
    check('the prompt names another folder, whole, with files of its own', underRoot(afterLink) && afterLink !== linked && whole(afterLink!))
    check('both links stand, the file behind one keeps its bytes, the other still points at nothing', linkAt(join(linked, 'references/notes.md')) && linkAt(join(linked, 'references/deep/page.md')) && untouched(target))
  }

  section('§7 two uses in one tick after the files went: both name one new folder')
  const tick = await firstUse('kept-tick')
  rmSync(tick, { recursive: true, force: true })
  const [left, right] = await Promise.all([prompt('kept-tick', 'left'), prompt('kept-tick', 'right')])
  check('both prompts name the same folder and its files stand', named(left) !== undefined && named(left) === named(right) && whole(named(left)!))
  check('one folder was made for the two', readdirSync(root).filter(name => name.startsWith('kept-tick')).length === 1, readdirSync(root).filter(name => name.startsWith('kept-tick')).join(' '))

  section('§8 a skill whose files come from a provider is kept the same way')
  const lazyDir = await firstUse('kept-lazy')
  for (const rel of Object.keys(FILES)) gone(join(lazyDir, rel))
  const lazy = named(await prompt('kept-lazy'))
  check('its files stand under the folder its prompt names', underRoot(lazy) && whole(lazy!), lazy === undefined ? 'no folder named' : walk(lazy).join(' ') || 'the folder holds no file')

  section('§9 the first use refuses a folder it did not make; the refusal costs that use only')
  plant(join(root, 'kept-planted/references/notes.md'), 'planted before the first use\n')
  const planted = await prompt('kept-planted')
  check('no base-directory line is given and the planted file keeps its bytes', named(planted) === undefined && planted.startsWith('# kept-planted') && readFileSync(join(root, 'kept-planted/references/notes.md'), 'utf8') === 'planted before the first use\n')
  const plantedNext = named(await prompt('kept-planted'))
  check('the next use extracts into a folder of its own and still leaves the planted one alone', underRoot(plantedNext) && plantedNext !== join(root, 'kept-planted') && readFileSync(join(plantedNext!, 'references/notes.md'), 'utf8') === NOTES && readFileSync(join(root, 'kept-planted/references/notes.md'), 'utf8') === 'planted before the first use\n' && readdirSync(join(root, 'kept-planted/references')).length === 1)

  mkdirSync(join(root, 'kept-empty-planted'))
  const emptyPlanted = await prompt('kept-empty-planted')
  check('an empty folder standing where the skill folder would be made is not written into', named(emptyPlanted) === undefined && readdirSync(join(root, 'kept-empty-planted')).length === 0)
  const linkPlantedForeign = foreignFolder('foreign-planted-link')
  linkFolder(linkPlantedForeign, join(root, 'kept-link-planted'))
  const linkPlanted = await prompt('kept-link-planted')
  check('a link standing where the skill folder would be made is not followed: the foreign folder is untouched', named(linkPlanted) === undefined && untouched(linkPlantedForeign) && linkAt(join(root, 'kept-link-planted')))
  const linkPlantedNext = named(await prompt('kept-link-planted'))
  check('…and the next use extracts into a folder of its own', underRoot(linkPlantedNext) && whole(linkPlantedNext!) && untouched(linkPlantedForeign))

  {
    section('§10 a folder of the skill replaced by a link out of it: nothing is written behind the link')
    const inner = await firstUse('kept-inner-link')
    const innerForeign = foreignFolder('foreign-inner')
    rmSync(join(inner, 'references'), { recursive: true })
    linkFolder(innerForeign, join(inner, 'references'))
    const afterInner = named(await prompt('kept-inner-link'))
    check('an inner folder replaced by a link: the foreign folder keeps its one file and its bytes, the link stands', untouched(innerForeign) && linkAt(join(inner, 'references')))
    check('…and the prompt names another folder, whole, whose folders are its own', underRoot(afterInner) && afterInner !== inner && whole(afterInner!) && ownFolders(afterInner!))

    const twin = await firstUse('kept-inner-twin')
    const twinFiles = { 'notes.md': 'a foreign page with the reference name\n', 'deep/page.md': 'a foreign page two folders down\n' }
    const twinForeign = foreignFolder('foreign-twin', twinFiles)
    rmSync(join(twin, 'references'), { recursive: true })
    linkFolder(twinForeign, join(twin, 'references'))
    const afterTwin = named(await prompt('kept-inner-twin'))
    check('a link to a folder that holds files under the reference names is not taken for the skill folder', underRoot(afterTwin) && afterTwin !== twin && whole(afterTwin!) && untouched(twinForeign, twinFiles))

    const innerFile = await firstUse('kept-inner-file')
    rmSync(join(innerFile, 'references'), { recursive: true })
    writeFileSync(join(innerFile, 'references'), 'a file where the folder stood\n')
    const afterInnerFile = named(await prompt('kept-inner-file'))
    check('a file standing where an inner folder stood keeps its bytes and another folder is named', underRoot(afterInnerFile) && afterInnerFile !== innerFile && whole(afterInnerFile!) && readFileSync(join(innerFile, 'references'), 'utf8') === 'a file where the folder stood\n')

    const skillLinked = await firstUse('kept-skill-link')
    const skillForeign = foreignFolder('foreign-skill')
    rmSync(skillLinked, { recursive: true })
    linkFolder(skillForeign, skillLinked)
    const afterSkill = named(await prompt('kept-skill-link'))
    check("the skill's own folder replaced by a link: the foreign folder is untouched, the link stands, another folder is named", untouched(skillForeign) && linkAt(skillLinked) && underRoot(afterSkill) && afterSkill !== skillLinked && whole(afterSkill!))

    section('§11 a use that cannot make its folder gets no base-directory line; the next use tries again')
    const obstacle = await firstUse('kept-obstacle')
    for (const rel of Object.keys(FILES)) gone(join(obstacle, rel))
    const rootForeign = foreignFolder('foreign-root')
    const aside = `${root}.aside`
    renameSync(root, aside)
    linkFolder(rootForeign, root)
    const refused = await prompt('kept-obstacle')
    check('the process folder replaced by a link: no base-directory line, the foreign folder untouched, the link stands', named(refused) === undefined && refused.startsWith('# kept-obstacle') && untouched(rootForeign) && linkAt(root))
    const refusedAgain = await prompt('kept-obstacle')
    check('while the link stands every use is refused the same way', named(refusedAgain) === undefined && untouched(rootForeign))
    dropLink(root)
    renameSync(aside, root)
    const recovered = named(await prompt('kept-obstacle'))
    check('once the process folder is its own again the next use extracts and names its folder', underRoot(recovered) && recovered !== obstacle && whole(recovered!), recovered === undefined ? 'no folder named' : walk(recovered).join(' '))

    section('§12 a link above the process folder: nothing is made or written behind it')
    const above = await firstUse('kept-above')
    for (const rel of Object.keys(FILES)) gone(join(above, rel))
    const shelf = dirname(root)
    const shelfAside = `${shelf}.aside`
    const bareShelf = foreignFolder('foreign-shelf-bare')
    renameSync(shelf, shelfAside)
    linkFolder(bareShelf, shelf)
    const bareRefused = await prompt('kept-above')
    check('the shelf replaced by a link to a folder that holds no process folder: no base-directory line, and no folder is made there', named(bareRefused) === undefined && readdirSync(bareShelf).join(' ') === 'foreign.txt' && untouched(bareShelf))
    dropLink(shelf)
    const twinShelf = foreignFolder('foreign-shelf-twin')
    mkdirSync(join(twinShelf, root.slice(shelf.length + 1)))
    linkFolder(twinShelf, shelf)
    const twinRefused = await prompt('kept-above')
    check('…and to a folder that holds a folder under the process folder name: no base-directory line, nothing written into it', named(twinRefused) === undefined && readdirSync(twinShelf).sort().join(' ') === `${root.slice(shelf.length + 1)} foreign.txt` && readdirSync(join(twinShelf, root.slice(shelf.length + 1))).length === 0)
    dropLink(shelf)
    renameSync(shelfAside, shelf)
    const temp = dirname(shelf)
    const tempAside = `${temp}.aside`
    const farForeign = foreignFolder('foreign-temp')
    mkdirSync(join(farForeign, shelf.slice(temp.length + 1)))
    renameSync(temp, tempAside)
    linkFolder(farForeign, temp)
    const farRefused = await prompt('kept-above')
    check('the temp folder two levels up replaced by a link to a folder that holds a shelf of its own: no base-directory line, no folder made on that shelf', named(farRefused) === undefined && readdirSync(join(farForeign, shelf.slice(temp.length + 1))).length === 0 && readdirSync(farForeign).length === 2)
    dropLink(temp)
    renameSync(tempAside, temp)
    const aboveRecovered = named(await prompt('kept-above'))
    check('with the shelf its own again the next use extracts and names its folder', underRoot(aboveRecovered) && whole(aboveRecovered!))

    section('§13 the shelf and the temp folder taken whole: the next use makes them again, level by level')
    rmSync(shelf, { recursive: true, force: true })
    const shelfRemade = named(await prompt('kept-above'))
    check('the shelf gone: the next use names a whole folder under the process folder', !existsSync(shelfAside) && underRoot(shelfRemade) && whole(shelfRemade!) && lstatSync(shelf).isDirectory())
    rmSync(dirname(shelf), { recursive: true, force: true })
    const tempRemade = named(await prompt('kept-above'))
    check('the temp folder gone: the next use names a whole folder under the process folder', underRoot(tempRemade) && whole(tempRemade!) && lstatSync(dirname(shelf)).isDirectory())
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`\n${failures ? 'FAIL' : 'PASS'} bundled-skill-references-kept: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
