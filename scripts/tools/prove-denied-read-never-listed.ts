#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const launch = process.cwd()
const world = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'denied-read-')))
process.on('exit', () => {
  try {
    process.chdir(launch)
    rmSync(world, { recursive: true, force: true })
  } catch {
  }
})
const HOME = join(world, 'home')
const project = join(world, 'project')
mkdirSync(join(HOME, 'tmp'), { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_TMPDIR = join(HOME, 'tmp')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_GREP_RANKED = '1'
process.env.HOME = world
delete process.env.MERCURY_HOME

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const TREE: Record<string, string> = {
  'src/secret/keys.ts': 'export const token = "needle in the denied file"\n',
  'src/secret/deep/more.ts': 'export const token = "needle deeper in the denied folder"\n',
  'src/secret/quiet.ts': 'export const silent = 1\n',
  'src/secrets-public/keys.ts': 'export const token = "needle in a neighbour folder"\n',
  'src/secret.ts': 'export const token = "needle in a neighbour file"\n',
  'src/open.ts': 'export const token = "needle in an open file"\n',
  'README.md': 'the token needle at the root\n',
}
for (const [path, text] of Object.entries(TREE)) {
  mkdirSync(dirname(join(project, path)), { recursive: true })
  writeFileSync(join(project, path), text)
}
process.chdir(project)
const { setOriginalCwd } = await import(`${SRC}/bootstrap/state.ts`)
setOriginalCwd(project)

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const { GrepTool } = await import(`${SRC}/tools/GrepTool/GrepTool.ts`)
const { GlobTool } = await import(`${SRC}/tools/GlobTool/GlobTool.ts`)
const { getEmptyToolPermissionContext } = await import(`${SRC}/Tool.ts`)
const permissions = await import(`${SRC}/utils/permissions/filesystem.ts`)

type Permission = ReturnType<typeof getEmptyToolPermissionContext>
const context = (permission: Permission) => ({ abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: permission, tasks: {}, sessionHooks: new Map() }), setAppState: () => {}, readFileState: new Map(), messages: [], options: { tools: [] } }) as never
const withRules = (kind: 'alwaysDenyRules' | 'alwaysAllowRules' | 'alwaysAskRules', source: string, rules: string[], base: Permission = getEmptyToolPermissionContext()): Permission => ({ ...base, [kind]: { ...(base[kind] as Record<string, string[]>), [source]: rules } })
const deny = (rule: string, source = 'session'): Permission => withRules('alwaysDenyRules', source, [rule])
const directRead = (file: string, permission: Permission): string => permissions.checkReadPermissionForTool({ name: 'Read', getPath: () => file }, { file_path: file }, permission).behavior
const said = (tool: typeof GrepTool | typeof GlobTool, data: unknown): string => tool.mapToolResultToToolResultBlockParam(data as never, 'id').content as string

const TOOLS: Array<[string, (start: string | undefined, permission: Permission) => Promise<string>]> = [
  ['Grep content', async (start, permission) => said(GrepTool, (await GrepTool.call({ pattern: 'needle', output_mode: 'content', ...(start ? { path: start } : {}) } as never, context(permission))).data)],
  ['Grep files', async (start, permission) => said(GrepTool, (await GrepTool.call({ pattern: 'needle', output_mode: 'files_with_matches', ...(start ? { path: start } : {}) } as never, context(permission))).data)],
  ['Grep count', async (start, permission) => said(GrepTool, (await GrepTool.call({ pattern: 'needle', output_mode: 'count', ...(start ? { path: start } : {}) } as never, context(permission))).data)],
  ['Grep ranked', async (start, permission) => said(GrepTool, (await GrepTool.call({ pattern: 'token needle', output_mode: 'ranked', ...(start ? { path: start } : {}) } as never, context(permission))).data)],
  ['Glob', async (start, permission) => said(GlobTool, (await GlobTool.call({ pattern: '**/*.ts', ...(start ? { path: start } : {}) } as never, context(permission))).data)],
]
const STARTS: Array<[string, string | undefined]> = [
  ['the project root', undefined],
  ['the folder above the denied one, by a relative path', 'src'],
  ['the same folder, by an absolute path', join(project, 'src')],
]
const SPELLINGS: Array<[string, string]> = [
  ['relative', 'Read(src/secret/**)'],
  ['from the root', 'Read(/src/secret/**)'],
  ['absolute', `Read(//${project.replace(/^\/+/, '')}/src/secret/**)`],
  ['home', 'Read(~/project/src/secret/**)'],
]
const DENIED = ['secret/keys.ts', 'secret/deep/more.ts']
const NEIGHBOURS = ['secrets-public/keys.ts', 'secret.ts', 'open.ts']
const shows = (answer: string, file: string): boolean => answer.includes(file) || answer.includes(file.replaceAll('/', '\\'))

console.log('the control: with no rule every file is in every answer')
{
  const open = getEmptyToolPermissionContext()
  const missing: string[] = []
  for (const [tool, run] of TOOLS) for (const [start, path] of STARTS) for (const file of [...DENIED, ...NEIGHBOURS]) if (!shows(await run(path, open), file)) missing.push(`${tool} from ${start}: ${file}`)
  check('five tools from three starts: the five files are all named', missing.length === 0, missing.join(' | '))
}

console.log('the law: a file whose direct Read is denied appears in no answer; its neighbours stay')
const red: string[] = []
for (const [spelling, rule] of SPELLINGS) {
  const permission = deny(rule)
  check(`${spelling} ${rule.replace(project.replace(/^\/+/, ''), '<project>')}: a direct Read of both files in the folder is denied, of the three neighbours not`, DENIED.every(file => directRead(join(project, 'src', file), permission) === 'deny') && NEIGHBOURS.every(file => directRead(join(project, 'src', file), permission) !== 'deny'))
  for (const [start, path] of STARTS) {
    const cells: string[] = []
    for (const [tool, run] of TOOLS) {
      const answer = await run(path, permission)
      const leaked = DENIED.filter(file => shows(answer, file))
      const lost = NEIGHBOURS.filter(file => !shows(answer, file))
      const ok = leaked.length === 0 && lost.length === 0
      if (!ok) red.push(`${spelling} · ${start} · ${tool}${leaked.length ? ` shows ${leaked.join(', ')}` : ''}${lost.length ? ` loses ${lost.join(', ')}` : ''}`)
      cells.push(`${tool} ${ok ? 'ok' : leaked.length ? 'SHOWS' : 'LOSES'}`)
    }
    check(`${spelling} · searched from ${start}: ${cells.join(' · ')}`, cells.every(cell => cell.endsWith(' ok')), cells.filter(cell => !cell.endsWith(' ok')).join(' · '))
  }
}
console.log(`  (${red.length} of ${SPELLINGS.length * STARTS.length * TOOLS.length} cells red)`)

console.log('the same law from other sources, from a folder above the project, and for a rule on one file')
{
  const others: Array<[string, Permission, string | undefined, string[], string[]]> = [
    ['an absolute rule in the user settings', deny(SPELLINGS[2]![1], 'userSettings'), undefined, DENIED, NEIGHBOURS],
    ['a home rule in the user settings', deny(SPELLINGS[3]![1], 'userSettings'), 'src', DENIED, NEIGHBOURS],
    ['an absolute rule, searched from the folder above the project', deny(SPELLINGS[2]![1]), world, DENIED, NEIGHBOURS],
    ['a relative rule, searched from the folder above the project', deny(SPELLINGS[0]![1]), world, DENIED, NEIGHBOURS],
    ['a rule on one file', deny('Read(src/secret/keys.ts)'), 'src', ['secret/keys.ts'], ['secret/deep/more.ts', ...NEIGHBOURS]],
    ['a rule on a file name at any depth', deny('Read(more.ts)'), 'src', ['secret/deep/more.ts'], ['secret/keys.ts', ...NEIGHBOURS]],
    ['a rule with a wildcard folder', deny('Read(src/*/keys.ts)'), 'src', ['secret/keys.ts', 'secrets-public/keys.ts'], ['secret/deep/more.ts', 'secret.ts', 'open.ts']],
    ['a Glob rule, which a Read obeys too', deny('Glob(src/secret/**)'), 'src', DENIED, NEIGHBOURS],
  ]
  for (const [label, permission, path, hidden, visible] of others) {
    const wrong: string[] = []
    for (const [tool, run] of TOOLS) {
      const answer = await run(path, permission)
      for (const file of hidden) if (shows(answer, file)) wrong.push(`${tool} shows ${file}`)
      for (const file of visible) if (!shows(answer, file)) wrong.push(`${tool} loses ${file}`)
    }
    check(`${label}: hidden from all five, the others named by all five`, wrong.length === 0 && hidden.every(file => directRead(join(project, 'src', file), permission) === 'deny') && visible.every(file => directRead(join(project, 'src', file), permission) !== 'deny'), wrong.join(' | '))
  }
}

console.log('nothing of a denied file reaches a number either')
{
  const permission = deny(SPELLINGS[2]![1])
  const bare = getEmptyToolPermissionContext()
  const count = await TOOLS[2]![1](undefined, permission)
  check('Grep count: the total counts the four files that may be read', /^4 matches across 4 files$/m.test(count), count)
  const ranked = await TOOLS[3]![1](undefined, permission)
  const listedTs = await TOOLS[4]![1](undefined, permission)
  check('Glob: a denied file that holds none of the words searched is not listed either', !shows(listedTs, 'quiet.ts') && shows(await TOOLS[4]![1](undefined, bare), 'secret/quiet.ts'), listedTs)
  rmSync(join(project, 'src/secret'), { recursive: true, force: true })
  const rankedWithout = await TOOLS[3]![1](undefined, bare)
  const countWithout = await TOOLS[2]![1](undefined, bare)
  check('Grep ranked: every number, the files searched among them, is what it is when the denied folder does not exist (one of its files holds none of the words)', ranked === rankedWithout && /among 4 searched\.$/m.test(ranked), `${ranked}\n---\n${rankedWithout}`)
  const rows = (answer: string): string => answer.split('\n').sort().join('\n')
  check('Grep count: the rows and the total are what they are when the denied folder does not exist', rows(count) === rows(countWithout), `${count}\n---\n${countWithout}`)
  for (const file of ['src/secret/keys.ts', 'src/secret/deep/more.ts', 'src/secret/quiet.ts']) {
    mkdirSync(dirname(join(project, file)), { recursive: true })
    writeFileSync(join(project, file), TREE[file]!)
  }
  writeFileSync(join(project, '.gitignore'), 'src/secret/deep/\n')
  mkdirSync(join(project, '.git'), { recursive: true })
  const globbed = await TOOLS[4]![1](undefined, permission)
  check('Glob: a denied file that an ignore rule also hides is not counted among the ignored paths', !globbed.includes('under ignore rules'), globbed)
  rmSync(join(project, '.gitignore'))
  rmSync(join(project, '.git'), { recursive: true, force: true })
}

console.log('letter case, a link into the denied folder, and .. in the path: the search agrees with the direct Read')
{
  const permission = deny(SPELLINGS[0]![1])
  const insensitive = existsSync(join(project, 'SRC', 'OPEN.TS'))
  if (insensitive) {
    const upper = await Promise.all(TOOLS.map(([, run]) => run('SRC', permission)))
    check('a folder named in another letter case (this file system folds case): the denied files are in no answer, as their direct Read is denied', directRead(join(project, 'SRC/secret/keys.ts'), permission) === 'deny' && upper.every(answer => DENIED.every(file => !shows(answer, file) && !shows(answer.toLowerCase(), file))), upper.join('\n---\n'))
    const shouted = deny('Read(SRC/SECRET/**)')
    const answers = await Promise.all(TOOLS.map(([, run]) => run(undefined, shouted)))
    check('a rule written in another letter case: a direct Read is denied and no answer names the files', DENIED.every(file => directRead(join(project, 'src', file), shouted) === 'deny') && answers.every(answer => DENIED.every(file => !shows(answer, file))), answers.join('\n---\n'))
  } else {
    console.log('  [SKIP] this file system keeps letter case apart: a folder named in another case does not exist')
  }
  symlinkSync(join(project, 'src/secret'), join(project, 'src/link'))
  symlinkSync(join(project, 'src/secret/keys.ts'), join(project, 'src/alias.ts'))
  const linked = await Promise.all(TOOLS.map(([, run]) => run(undefined, permission)))
  check('a link to the denied folder and a link to a file in it: a direct Read through either is denied, and no answer follows them', directRead(join(project, 'src/link/keys.ts'), permission) === 'deny' && directRead(join(project, 'src/alias.ts'), permission) === 'deny' && linked.every(answer => !/needle in the denied|needle deeper/.test(answer) && !shows(answer, 'link/keys.ts') && !shows(answer, 'alias.ts')), linked.join('\n---\n'))
  const throughLink = await Promise.all(TOOLS.map(([, run]) => run('src/link', permission).catch((error: unknown) => `refused: ${String(error)}`)))
  check('the link named as the folder to search: nothing of the denied folder is in any answer', throughLink.every(answer => !/needle in the denied|needle deeper/.test(answer) && !shows(answer, 'keys.ts') && !shows(answer, 'more.ts')), throughLink.join('\n---\n'))
  rmSync(join(project, 'src/link'))
  rmSync(join(project, 'src/alias.ts'))
  const dotted = await Promise.all(TOOLS.map(([, run]) => run('src/secret/../../src', permission)))
  check('.. in the path searched: the same answer as the plain path', dotted.every(answer => DENIED.every(file => !shows(answer, file)) && NEIGHBOURS.every(file => shows(answer, file))), dotted.join('\n---\n'))
}

console.log('one decision: what hides a file from a search is what denies its direct Read')
{
  const filter = (permissions as { readDenialFilter?: (permission: Permission, root: string) => (file: string) => boolean }).readDenialFilter
  check('the search tools ask one function whether a direct Read of a file is denied', typeof filter === 'function')
  if (typeof filter === 'function') {
    const files = Object.keys(TREE).map(path => join(project, path))
    const contexts: Array<[string, Permission]> = [
      ['no rule', getEmptyToolPermissionContext()],
      ...SPELLINGS.map(([spelling, rule]) => [spelling, deny(rule)] as [string, Permission]),
      ['one file', deny('Read(src/secret/keys.ts)')],
      ['a name at any depth', deny('Read(keys.ts)')],
      ['an ask rule', withRules('alwaysAskRules', 'session', ['Read(src/secret/**)'])],
      ['an allow rule', withRules('alwaysAllowRules', 'session', ['Read(src/secret/**)'])],
      ['an allow rule beside a deny rule', withRules('alwaysAllowRules', 'session', ['Read(src/**)'], deny('Read(src/secret/**)'))],
      ['tools narrowed to one folder', withRules('alwaysAllowRules', 'toolsNarrowing', ['Read(src/secrets-public/**)'])],
    ]
    const apart: string[] = []
    for (const [label, permission] of contexts) {
      for (const root of [project, join(project, 'src'), world]) {
        const denied = filter(permission, root)
        for (const file of files.filter(file => file.startsWith(root))) if (denied(file) !== (directRead(file, permission) === 'deny')) apart.push(`${label} from ${root.slice(world.length) || '/'}: ${file.slice(project.length + 1)}`)
      }
    }
    check(`${contexts.length} sets of rules, three folders, seven files: it answers as the direct Read does every time`, apart.length === 0, apart.join(' | '))
    const secret = join(HOME, '.credentials.json')
    writeFileSync(secret, '{"note":"needle"}\n', { mode: 0o600 })
    check('Mercury\'s own credential file is denied by it as by a direct Read, with no rule at all', filter(getEmptyToolPermissionContext(), world)(secret) === true && directRead(secret, getEmptyToolPermissionContext()) === 'deny')
    const ask = withRules('alwaysAskRules', 'session', ['Read(src/secret/**)'])
    const asked = await TOOLS[1]![1](undefined, ask)
    check('an ask rule hides nothing from a search, as on the parent', directRead(join(project, 'src/secret/keys.ts'), ask) === 'ask' && shows(asked, 'secret/keys.ts'), asked)
    const narrowed = withRules('alwaysAllowRules', 'toolsNarrowing', ['Read(src/secrets-public/**)'])
    const narrow = await Promise.all(TOOLS.map(([, run]) => run(undefined, narrowed)))
    check('tools narrowed to one folder: a search names that folder\'s file and no other, as a direct Read of the others is denied', narrow.every(answer => shows(answer, 'secrets-public/keys.ts') && !shows(answer, 'secret/keys.ts') && !shows(answer, 'open.ts') && !shows(answer, 'secret.ts')), narrow.join('\n---\n'))
  }
}

console.log('the globs: ripgrep is kept out of a denied folder wherever the search starts')
{
  type Normalise = (patterns: Map<string | null, string[]>, start: string) => string[]
  const normalise = (permissions as { normalizePatternsToPath: Normalise }).normalizePatternsToPath
  const globs = (root: string | null, pattern: string, start: string): string => JSON.stringify(normalise(new Map([[root, [pattern]]]), start).sort())
  const cases: Array<[string, string | null, string, string, string[]]> = [
    ['a rule from the root, searched from the root', project, '/src/secret/**', project, ['/src/secret', '/src/secret/**']],
    ['searched from the folder above the denied one', project, '/src/secret/**', join(project, 'src'), ['/secret', '/secret/**']],
    ['searched from the denied folder itself', project, '/src/secret/**', join(project, 'src/secret'), ['/**']],
    ['searched from inside the denied folder', project, '/src/secret/**', join(project, 'src/secret/deep'), ['/**']],
    ['searched from a sibling folder', project, '/src/secret/**', join(project, 'docs'), []],
    ['searched from above the rule\'s root', project, '/src/secret/**', world, ['/project/src/secret', '/project/src/secret/**']],
    ['searched from a folder that is no kin of the root', project, '/src/secret/**', HOME, []],
    ['an absolute rule, searched from the project', '/', `/${project.replace(/^\/+/, '')}/src/secret/**`, project, ['/src/secret', '/src/secret/**']],
    ['an absolute rule, searched from the folder above the denied one', '/', `/${project.replace(/^\/+/, '')}/src/secret/**`, join(project, 'src'), ['/secret', '/secret/**']],
    ['a home rule, searched from the folder above the denied one', world, '/project/src/secret/**', join(project, 'src'), ['/secret', '/secret/**']],
    ['one file', project, '/src/secret/keys.ts', join(project, 'src'), ['/secret/keys.ts', '/secret/keys.ts/**']],
    ['a wildcard folder, searched from below it', project, '/src/*/keys.ts', join(project, 'src/secret'), ['/keys.ts', '/keys.ts/**']],
    ['a wildcard folder that the path searched does not match', project, '/src/s*/keys.ts', join(project, 'src/docs'), []],
    ['any depth, searched from a folder the rule may or may not have passed', project, '/**/secret/keys.ts', join(project, 'src/secret'), ['/**/secret/keys.ts', '/**/secret/keys.ts/**', '/secret/keys.ts', '/secret/keys.ts/**', '/keys.ts', '/keys.ts/**']],
    ['a rule that names a folder only', project, '/build/', project, ['/build/**']],
    ['letter case is folded, as the direct Read folds it', project, '/SRC/Secret/**', join(project, 'src'), ['/Secret', '/Secret/**']],
    ['a bare name under its root stays that root\'s own child', HOME, '.credentials.json', world, ['/home/.credentials.json', '/home/.credentials.json/**']],
    ['a bare name is not carried into a folder below its root', HOME, '*-auth.json', join(HOME, 'tmp'), []],
    ['a folder whose name holds a glob character is escaped', join(project, 'a[1]'), '/x/**', project, ['/a\\[1\\]/x', '/a\\[1\\]/x/**']],
  ]
  const wrong = cases.filter(([, root, pattern, start, expected]) => globs(root, pattern, start) !== JSON.stringify([...expected].sort())).map(([label, root, pattern, start]) => `${label}: ${globs(root, pattern, start)}`)
  check(`${cases.length} rules and starts: each gives exactly the globs that name the denied paths below the start, and none where the rule cannot reach`, wrong.length === 0, wrong.join(' | '))
  check('a rule with no leading slash is still given as written, and is also anchored at the working folder', globs(null, 'src/secret/**', join(project, 'src')) === JSON.stringify(['/secret', '/secret/**', 'src/secret/**']), globs(null, 'src/secret/**', join(project, 'src')))
  check('a bare name with no root is given as written: any depth, as before', globs(null, 'more.ts', join(project, 'src')) === JSON.stringify(['more.ts']), globs(null, 'more.ts', join(project, 'src')))
  const platform = await import(`${SRC}/utils/platform.ts`)
  const cache = (platform.getPlatform as unknown as { cache: Map<unknown, unknown> }).cache
  const had = cache.has(undefined)
  const real = cache.get(undefined)
  cache.set(undefined, 'windows')
  try {
    const drive = permissions.rootForPattern('C:/Users/me/proj/src/secret/**', 'userSettings', 'windows') as { root: string; relative: string }
    const fromProject = JSON.stringify(normalise(new Map([[drive.root, [drive.relative]]]), 'C:\\Users\\me\\proj').sort())
    const fromFolder = JSON.stringify(normalise(new Map([[drive.root, [drive.relative]]]), 'c:\\users\\ME\\proj\\src').sort())
    const elsewhere = JSON.stringify(normalise(new Map([[drive.root, [drive.relative]]]), 'D:\\other'))
    check('a rule with a drive letter (the Windows seam, primed): searched from the project, from a folder below it in another letter case, and from another drive', fromProject === '["/src/secret","/src/secret/**"]' && fromFolder === '["/secret","/secret/**"]' && elsewhere === '[]', `${fromProject} ${fromFolder} ${elsewhere}`)
  } finally {
    if (had) cache.set(undefined, real)
    else cache.delete(undefined)
  }
}

process.chdir(launch)
rmSync(world, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-denied-read-never-listed: ${failures} of ${checks} FAILED`)
  process.exit(1)
}
console.log(`\nprove-denied-read-never-listed: all ${checks} green`)
