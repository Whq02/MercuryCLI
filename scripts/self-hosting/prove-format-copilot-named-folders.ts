#!/usr/bin/env bun
import { symlinkSync } from 'node:fs'
import { join, relative } from 'node:path'
import { checker, contentsOf, count, governs, openWorld } from './instructionWorld.ts'

const world = openWorld('copilot-named')
const { check, section, close } = checker()
const VARIABLE = 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS'
const rule = (header: string, body: string): string => `---\n${header}\n---\n${body}`
const own = (path: string, body: string): string => `Contents of ${path} (user's private global instructions for all projects):\n\n${body}`
const offered = (path: string, description: string): string => `Rule files offered by description (not loaded; Read one when its description fits the work):\n- ${path}: ${description}`

try {
  const shared = world.project({
    'AGENTS.md': 'named-agents-needle\n@notes/style.md\n',
    'notes/style.md': 'named-import-needle\n',
    '.github/instructions/a-always.instructions.md': rule('applyTo: "**"', 'named-always-needle\n'),
    '.github/instructions/b-python.instructions.md': rule('applyTo: "src/**/*.py"', 'named-python-needle\n'),
    '.github/instructions/c-offered.instructions.md': rule('description: How to write a migration', 'named-offered-body-needle\n'),
    '.github/instructions/d-manual.instructions.md': 'named-manual-needle\n',
    '.github/instructions/readme.md': 'not-an-instructions-file-needle\n',
    '.github/copilot-instructions.md': 'named-repository-guide-needle\n',
    'copilot-instructions.md': 'top-level-guide-needle\n',
    'top.instructions.md': rule('applyTo: "**"', 'top-level-rule-needle\n'),
    'GEMINI.md': 'another-tool-needle\n',
  })
  const second = world.project({ 'AGENTS.md': 'second-folder-needle\n' })
  const layout = { 'AGENTS.md': 'project-agents-needle\n', 'src/a.py': '\n', 'src/b.ts': '\n', 'README.md': 'x\n' }
  const project = world.project(layout)
  const NAMED = ['named-agents-needle', 'named-import-needle', 'named-always-needle', 'second-folder-needle']
  const NEVER = ['named-offered-body-needle', 'named-manual-needle', 'not-an-instructions-file-needle', 'named-repository-guide-needle', 'top-level-guide-needle', 'top-level-rule-needle', 'another-tool-needle']
  const env = { [VARIABLE]: `${shared}, ${second},${shared},` }
  const none = (text: string, needles: string[]): boolean => needles.every(needle => !text.includes(needle))
  const present = (text: string, needles: string[]): string => needles.filter(needle => text.includes(needle)).join(', ')

  section('unset or empty, nothing moves')
  const unset = world.drive(project)
  const empty = world.drive(project, { env: { [VARIABLE]: ' , ,' } })
  check('with the variable unset the project loads as it did', unset.first === contentsOf(join(project, 'AGENTS.md'), 'project-agents-needle'), unset.first)
  check('an empty list is the same request', empty.first === unset.first && JSON.stringify(empty.paths) === JSON.stringify(unset.paths), empty.first)

  section('the folders it names: AGENTS.md and the path-specific instructions of each, nothing else')
  const d = world.drive(project, { env, touch: [join(project, 'README.md'), join(project, 'src/b.ts'), join(project, 'src/a.py')] })
  check('every named guide and always rule reaches the first request once', NAMED.every(needle => count(d.first, needle) === 1), NAMED.map(needle => `${needle} ${count(d.first, needle)}`).join(', '))
  check("they compose before the project's own files, in the order the variable lists the folders, a folder named twice once", JSON.stringify(d.paths) === JSON.stringify([join(shared, 'AGENTS.md'), join(shared, 'notes/style.md'), join(shared, '.github/instructions/a-always.instructions.md'), join(shared, '.github/instructions/c-offered.instructions.md'), join(second, 'AGENTS.md'), join(project, 'AGENTS.md')]), d.paths.map(path => relative(world.scratch, path)).join(', '))
  check("a named guide is told as the user's own instructions for all projects", d.first.includes(own(join(shared, 'AGENTS.md'), 'named-agents-needle')), d.first.slice(0, 400))
  const entries = d.entries.filter(entry => entry.path.startsWith(shared) || entry.path.startsWith(second))
  check("each entry is the user's, of the Copilot format", entries.length === 5 && entries.every(entry => entry.type === 'User' && entry.family === 'shared' && entry.convention === 'copilot'), JSON.stringify(entries.map(entry => [entry.type, entry.family, entry.convention, entry.origin])))
  check('a rule offered by its description is one line naming its file', d.first.includes(offered(join(shared, '.github/instructions/c-offered.instructions.md'), 'How to write a migration')), d.first.slice(-400))
  check('nothing else in a named folder is read: no top-level file, no repository guide, no other tool, no manual rule, no offered body', none(d.first, NEVER), present(d.first, NEVER))
  check('a scoped rule is not in the first request', !d.first.includes('named-python-needle'))
  check('files no pattern names attach nothing', d.touched[0]!.attached.length === 0 && d.touched[1]!.attached.length === 0, JSON.stringify(d.touched.slice(0, 2)))
  check('a matching file attaches the scoped rule once, its patterns measured from the working directory', d.touched[2]!.attached.length === 1 && d.touched[2]!.attached[0]!.told.includes(governs(join(shared, '.github/instructions/b-python.instructions.md'), 'src/**/*.py', 'named-python-needle')), JSON.stringify(d.touched[2]))
  check('nothing is reported as a fault', d.diagnostics.filter(diagnostic => diagnostic.kind !== 'duplicate-content').length === 0, JSON.stringify(d.diagnostics))

  section("beside the user's own MERCURY.md")
  const beside = world.drive(project, { env, personal: 'my-own-needle\n' })
  check("the user's own file comes first, then the named folders, then the project", beside.paths.findIndex(path => path.endsWith('MERCURY.md')) === 0 && beside.paths.indexOf(join(shared, 'AGENTS.md')) === 1 && beside.paths.at(-1) === join(project, 'AGENTS.md'), beside.paths.map(path => relative(world.scratch, path)).join(', '))

  section("the switch is the Copilot format's own")
  const decided = world.project({ ...layout, 'MERCURY.md': 'native-needle\n' })
  const underGuide = world.drive(decided, { env, touch: [join(decided, 'src/a.py')] })
  check('under a MERCURY.md no named file loads and none attaches', underGuide.first === contentsOf(join(decided, 'MERCURY.md'), 'native-needle') && underGuide.touched[0]!.attached.length === 0, `${underGuide.first} ${JSON.stringify(underGuide.touched[0])}`)
  const native = world.drive(project, { env, settings: { briefs: { profile: 'native' } }, touch: [join(project, 'src/a.py')] })
  check('under the native profile no named file loads and none attaches', native.first === '' && native.touched[0]!.attached.length === 0, `${native.first} ${JSON.stringify(native.touched[0])}`)
  const untrusted = world.drive(project, { env, untrusted: true })
  check("in a folder never trusted, headless, the named folders load as the user's own files do and the project's do not", NAMED.every(needle => count(untrusted.first, needle) === 1) && !untrusted.first.includes('project-agents-needle'), untrusted.paths.map(path => relative(world.scratch, path)).join(', '))

  section('one file, two inventories')
  const both = world.project({ ...layout, '.github/instructions/a-always.instructions.md': rule('applyTo: "**"', 'project-always-needle\n'), '.github/instructions/scoped.instructions.md': rule('applyTo: "app/src/**"', 'project-scoped-needle\n'), 'app/src/a.py': '\n' })
  const onChain = (folder: string) => world.drive(join(both, 'app'), { trust: both, touch: [join(both, 'app/src/a.py')], env: { [VARIABLE]: `${folder},${join(both, 'app')}` }, screens: true, orient: true })
  const chained = onChain(both)
  check("a named folder that is a folder of the working directory's chain adds nothing: its files load once, as the project's", count(chained.first, 'project-agents-needle') === 1 && count(chained.first, 'project-always-needle') === 1 && chained.entries.every(entry => entry.type === 'Project'), JSON.stringify(chained.entries.map(entry => [relative(both, entry.path), entry.type])))
  const alias = join(world.scratch, 'project-link')
  symlinkSync(both, alias, 'junction')
  const linked = onChain(alias)
  check('a linked spelling of a project-chain folder keeps the same project sources and rows', JSON.stringify(linked.entries) === JSON.stringify(chained.entries) && JSON.stringify(linked.rows) === JSON.stringify(chained.rows), JSON.stringify(linked.entries))
  check('the scoped rule still attaches from its project folder, under either spelling', chained.touched[0]!.attached.length === 1 && JSON.stringify(linked.touched) === JSON.stringify(chained.touched), JSON.stringify(linked.touched))
  check('/orient gives both spellings the same import lines', linked.orient === chained.orient, linked.orient.slice(-600))
  const namedAlias = join(world.scratch, 'named-link')
  symlinkSync(shared, namedAlias, 'junction')
  const aliases = world.drive(project, { env: { [VARIABLE]: `${shared},${namedAlias}` }, touch: [join(project, 'src/a.py')], orient: true })
  check('two names of one personal folder attach its scoped rule once and offer one import per source', aliases.touched[0]!.attached.length === 1 && count(aliases.orient, `@${join(shared, '.github/instructions')}\n`) === 1 && !aliases.orient.includes(namedAlias), JSON.stringify(aliases.touched))
  const twin = world.project({ 'AGENTS.md': 'named-agents-needle\n@notes/style.md\n', 'notes/style.md': 'named-import-needle\n' })
  const twins = world.drive(project, { env: { [VARIABLE]: `${shared},${twin}` } })
  check('the same words in two named folders reach the request once', count(twins.first, 'named-agents-needle') === 1 && twins.diagnostics.some(diagnostic => diagnostic.kind === 'duplicate-content' && diagnostic.path === join(twin, 'AGENTS.md')), JSON.stringify(twins.diagnostics))

  section('how an entry is read')
  const kin = world.project({ 'work/AGENTS.md': 'project-agents-needle\n', 'work/a.py': '\n', 'beside/AGENTS.md': 'relative-entry-needle\n', 'home/kept/AGENTS.md': 'home-entry-needle\n' })
  const read = world.drive(join(kin, 'work'), { trust: kin, home: join(kin, 'home'), env: { [VARIABLE]: '../beside , ~/kept' } })
  check('a relative entry is measured from the working directory and ~/ is the home folder', count(read.first, 'relative-entry-needle') === 1 && count(read.first, 'home-entry-needle') === 1, read.paths.map(path => relative(kin, path)).join(', '))

  section('/memory files names the variable, and /orient keeps what loads')
  const seen = world.drive(project, { env, screens: true, orient: true })
  const at = (file: string): string => join(shared, file)
  check('a loaded file reads by its tool and the name of the variable', seen.rows.some(row => row.startsWith('Copilot · ') && row.includes('AGENTS.md') && row.endsWith(` · named by ${VARIABLE}`)) && seen.rows.some(row => row.includes('c-offered.instructions.md') && row.endsWith(` · offered by its description · named by ${VARIABLE}`)), JSON.stringify(seen.rows))
  check('a scoped rule and a manual one are listed with when they load and the name of the variable', seen.listed.some(row => row.startsWith('Copilot · ') && row.includes('b-python.instructions.md') && row.endsWith(` · loads with src/**/*.py · named by ${VARIABLE}`)) && seen.listed.some(row => row.includes('d-manual.instructions.md') && row.endsWith(` · not loaded: manual, @-mention it · named by ${VARIABLE}`)), JSON.stringify(seen.listed))
  check('/orient carries each as a line of MERCURY.local.md', seen.orient.endsWith(`Files that are personal or stand outside this project load here today — their lines belong in MERCURY.local.md, never in MERCURY.md:\n@${at('AGENTS.md')}\n@${at('.github/instructions')}\n@${join(second, 'AGENTS.md')}\n`), seen.orient.slice(-700))
  const kept = world.project({ ...layout, 'MERCURY.md': 'native-needle\n', 'MERCURY.local.md': `@${at('AGENTS.md')}\n@${at('.github/instructions')}\n` })
  const carried = world.drive(kept, { env, settings: { briefs: {} }, touch: [join(kept, 'src/a.py')] })
  check('written there, the two lines are read as imports of those two files, each waiting on the approval an import from outside the project has always needed', carried.diagnostics.filter(diagnostic => diagnostic.kind === 'external-import-blocked').map(diagnostic => diagnostic.path).sort().join(' ') === [at('.github/instructions'), at('AGENTS.md')].sort().join(' '), JSON.stringify(carried.diagnostics))
} finally {
  world.close()
}
close('format-copilot-named-folders')
