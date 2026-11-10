import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

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
  if (existsSync(dir)) visit(dir)
  return out.sort()
}
const whole = (dir: string): boolean => Object.entries(FILES).every(([rel, text]) => existsSync(join(dir, rel)) && readFileSync(join(dir, rel), 'utf8') === text)
const mode = (path: string): number => (statSync(path, { throwIfNoEntry: false })?.mode ?? 0) & 0o777
const gone = (path: string): void => rmSync(path, { force: true })
const linkAt = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true
const plant = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }

try {
  const { registerBundledSkill, getBundledSkills, getBundledSkillExtractDir } = await import('../../src/skills/bundledSkills.ts')
  const { getBundledSkillsRoot } = await import('../../src/utils/permissions/filesystem.ts')
  registerBundledSkill({ name: 'kept-fixture', description: 'a fixture skill with reference files', files: FILES, getPromptForCommand: async args => [{ type: 'text', text: `# Kept fixture\n\n${args}` }] })
  registerBundledSkill({ name: 'kept-lazy', description: 'a fixture skill whose files come from a provider', files: () => FILES, getPromptForCommand: async () => [{ type: 'text', text: '# Lazy fixture' }] })
  registerBundledSkill({ name: 'kept-planted', description: 'a fixture skill whose folder holds a file before its first use', files: { 'references/notes.md': NOTES }, getPromptForCommand: async () => [{ type: 'text', text: '# Planted fixture' }] })
  const skill = (name: string) => getBundledSkills().find(command => command.name === name) as unknown as { getPromptForCommand: (args: string, context: never) => Promise<Array<{ text?: string }>> }
  const prompt = async (name: string, args = ''): Promise<string> => (await skill(name).getPromptForCommand(args, {} as never)).map(block => block.text ?? '').join('')
  const dir = getBundledSkillExtractDir('kept-fixture')
  const line = `Base directory for this skill: ${dir} `

  section('§1 the first use writes the reference files and names their folder')
  const first = await prompt('kept-fixture', 'one')
  check('the prompt opens on the base-directory line', first.startsWith(line), first.slice(0, 120))
  check('the three reference files stand under it, byte for byte', whole(dir) && walk(dir).join(' ') === Object.keys(FILES).sort().join(' '), walk(dir).join(' '))
  if (process.platform !== 'win32') check('the helper with a shebang is owner-executable and the pages owner-only', mode(join(dir, 'scripts/probe.mjs')) === 0o700 && mode(join(dir, 'references/notes.md')) === 0o600)

  section("§2 the system's temp cleaner takes the files and leaves the folders: the next use writes them again")
  for (const rel of Object.keys(FILES)) gone(join(dir, rel))
  check('the scene: every file is gone, every folder stands', walk(dir).length === 0 && existsSync(join(dir, 'references/deep')) && existsSync(join(dir, 'scripts')))
  const second = await prompt('kept-fixture', 'two')
  check('the prompt still opens on the base-directory line', second.startsWith(line), second.slice(0, 120))
  check('every file the line promises stands under it again, byte for byte', whole(dir), walk(dir).join(' ') || 'the folder holds no file')
  if (process.platform !== 'win32') check('the helper is owner-executable again', existsSync(join(dir, 'scripts/probe.mjs')) && mode(join(dir, 'scripts/probe.mjs')) === 0o700 && mode(join(dir, 'references/notes.md')) === 0o600)

  section('§3 the emptied folders are taken too, up to the process folder: the next use makes them again')
  rmSync(getBundledSkillsRoot(), { recursive: true, force: true })
  check('the scene: the process folder is gone', !existsSync(getBundledSkillsRoot()))
  const third = await prompt('kept-fixture', 'three')
  check('the prompt opens on the same base-directory line and its files stand', third.startsWith(line) && whole(dir), walk(dir).join(' ') || 'the folder holds no file')

  section('§4 one file gone among three: that file is written again, the others are not touched')
  const keptIdentity = (rel: string): string => { const info = lstatSync(join(dir, rel), { throwIfNoEntry: false }); return info ? `${info.ino}:${info.mtimeMs}` : 'absent' }
  const before = { notes: keptIdentity('references/notes.md'), probe: keptIdentity('scripts/probe.mjs') }
  gone(join(dir, 'references/deep/page.md'))
  await prompt('kept-fixture', 'four')
  check('the missing page is back', existsSync(join(dir, 'references/deep/page.md')) && readFileSync(join(dir, 'references/deep/page.md'), 'utf8') === DEEP)
  check('the two files that stood keep their inode and their write time', before.notes !== 'absent' && keptIdentity('references/notes.md') === before.notes && keptIdentity('scripts/probe.mjs') === before.probe)

  section('§5 a file that stands is never overwritten or unlinked, whatever it holds')
  const notes = join(dir, 'references/notes.md')
  gone(notes)
  plant(notes, 'an operator edited this page\n')
  await prompt('kept-fixture', 'five')
  check("an edited page keeps the operator's bytes", readFileSync(notes, 'utf8') === 'an operator edited this page\n')
  if (process.platform !== 'win32') {
    const outside = join(scratch, 'outside.md')
    writeFileSync(outside, 'outside the skill folder\n')
    gone(notes)
    symlinkSync(outside, notes)
    const linked = await prompt('kept-fixture', 'six')
    check('a link standing at a reference path is left as it is and its target is not written', linkAt(notes) && readFileSync(outside, 'utf8') === 'outside the skill folder\n' && linked.startsWith(line))
    const dangling = join(dir, 'references/deep/page.md')
    gone(dangling)
    mkdirSync(join(dangling, '..'), { recursive: true })
    symlinkSync(join(scratch, 'not-there.md'), dangling)
    await prompt('kept-fixture', 'seven')
    check('a link to nowhere at a reference path is not followed into a new file', linkAt(dangling) && !existsSync(join(scratch, 'not-there.md')))
  }

  section('§6 two uses in one tick after the files went: both answer, the files are written once')
  rmSync(dir, { recursive: true, force: true })
  const [left, right] = await Promise.all([prompt('kept-fixture', 'left'), prompt('kept-fixture', 'right')])
  check('both prompts open on the base-directory line', left.startsWith(line) && right.startsWith(line))
  check('the files stand whole', whole(dir), walk(dir).join(' '))

  section('§7 a skill whose files come from a provider is kept the same way')
  const lazyDir = getBundledSkillExtractDir('kept-lazy')
  await prompt('kept-lazy')
  for (const rel of Object.keys(FILES)) gone(join(lazyDir, rel))
  const lazy = await prompt('kept-lazy')
  check('its files are written again and its prompt names the folder', whole(lazyDir) && lazy.startsWith(`Base directory for this skill: ${lazyDir} `), walk(lazyDir).join(' ') || 'the folder holds no file')

  section('§8 the first use still refuses a folder that already holds one of its files')
  const plantedDir = getBundledSkillExtractDir('kept-planted')
  plant(join(plantedDir, 'references/notes.md'), 'planted before the first use\n')
  const planted = await prompt('kept-planted')
  check('no base-directory line is given and the planted file keeps its bytes', !planted.startsWith('Base directory for this skill:') && planted.startsWith('# Planted fixture') && readFileSync(join(plantedDir, 'references/notes.md'), 'utf8') === 'planted before the first use\n')
  gone(join(plantedDir, 'references/notes.md'))
  const plantedAgain = await prompt('kept-planted')
  check('a first use that failed stays failed for the process: nothing is written later', !plantedAgain.startsWith('Base directory for this skill:') && !existsSync(join(plantedDir, 'references/notes.md')))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`\n${failures ? 'FAIL' : 'PASS'} bundled-skill-references-kept: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
