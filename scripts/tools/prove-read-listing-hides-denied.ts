#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const launch = process.cwd()
const world = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'read-listing-')))
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
process.env.MERCURY_BARE = '1'
process.env.HOME = world
delete process.env.MERCURY_HOME
delete process.env.MERCURY_READ_TARGETS

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const TREE: Record<string, string> = {
  'src/secret/keys.ts': 'export const token = "the denied file"\n',
  'src/secret/deep/more.ts': 'export const token = "deeper in the denied folder"\n',
  'src/secret/quiet.ts': 'export const silent = 1\n',
  'src/secrets-public/keys.ts': 'export const token = "a neighbour folder"\n',
  'src/secret.ts': 'export const token = "a neighbour file"\n',
  'src/open.ts': 'export const token = "an open file"\n',
  'src/.env': 'KEY=value\n',
  'README.md': 'the root\n',
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

const { FileReadTool } = await import(`${SRC}/tools/FileReadTool/FileReadTool.ts`)
const { renderDirectoryTarget } = await import(`${SRC}/tools/FileReadTool/readTarget.ts`)
const { getEmptyToolPermissionContext } = await import(`${SRC}/Tool.ts`)
const permissions = await import(`${SRC}/utils/permissions/filesystem.ts`)

type Permission = ReturnType<typeof getEmptyToolPermissionContext>
const context = (permission: Permission) =>
  ({
    readFileState: new Map(),
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: permission, tasks: {}, sessionHooks: new Map() }),
    setAppState: () => {},
    messages: [],
    options: { tools: [] },
  }) as never
const withRules = (kind: 'alwaysDenyRules' | 'alwaysAllowRules' | 'alwaysAskRules', source: string, rules: string[], base: Permission = getEmptyToolPermissionContext()): Permission => ({ ...base, [kind]: { ...(base[kind] as Record<string, string[]>), [source]: rules } })
const deny = (rule: string, source = 'session'): Permission => withRules('alwaysDenyRules', source, [rule])
const directRead = (file: string, permission: Permission): string => permissions.checkReadPermissionForTool({ name: 'Read', getPath: () => file }, { file_path: file }, permission).behavior
const settle = (): void => permissions.getResolvedWorkingDirPaths.clearCache()

let serial = 0
const read = async (folder: string, permission: Permission): Promise<{ text: string; names: string[]; header: string }> => {
  serial++
  const result = await (FileReadTool as { call: Function }).call({ file_path: folder }, context(permission), null, { uuid: `00000000-0000-0000-0000-${String(serial).padStart(12, '0')}`, message: { id: `msg_listing_${serial}` } })
  const text = String(result.data.file.content)
  const lines = text.split('\n')
  return { text, header: lines[0] ?? '', names: lines.slice(1).filter(line => !line.startsWith('… ')).map(line => line.replace(/\/$/, '')) }
}
const refusedByRead = async (folder: string, permission: Permission): Promise<boolean> => (await (FileReadTool as { checkPermissions: Function }).checkPermissions({ file_path: folder }, context(permission))).behavior === 'deny'

const SPELLINGS: Array<[string, string]> = [
  ['relative', 'Read(src/secret/**)'],
  ['from the root', 'Read(/src/secret/**)'],
  ['absolute', `Read(//${project.replace(/^\/+/, '')}/src/secret/**)`],
  ['home', 'Read(~/project/src/secret/**)'],
]
const insensitive = existsSync(join(project, 'SRC', 'OPEN.TS'))
const DOOR = join(world, 'door')
symlinkSync(project, DOOR)
const EIGHT: Array<[string, string]> = [
  ['src', 'src'],
  ['src/', 'src/'],
  ['src//', 'src//'],
  ['<real>/src/', `${project}/src/`],
  ['<link>/src', `${DOOR}/src`],
  ['<link>/src/', `${DOOR}/src/`],
  ['<link>/src//', `${DOOR}/src//`],
  ['<link>/src/.', `${DOOR}/src/.`],
]
const FOLDERS: Array<[string, string]> = [
  ...EIGHT,
  ['with .. in the path', 'src/secret/../../src'],
  ...(insensitive ? [['in another letter case', 'SRC'] as [string, string]] : []),
]
const NEIGHBOURS = ['.env', 'open.ts', 'secret.ts', 'secrets-public']

console.log('the control: with no rule a folder\'s listing names every entry')
{
  const open = await read('src', getEmptyToolPermissionContext())
  check('Read of the folder above names its five entries, the folder that will be denied among them', open.header === '(target: directory · owner: Read · entries: 5 shown of 5)' && JSON.stringify(open.names) === JSON.stringify(['.env', 'open.ts', 'secret.ts', 'secret', 'secrets-public']), open.text)
}

console.log('the law: an entry whose direct Read is denied is not named; its neighbours stay')
const red: string[] = []
for (const [spelling, rule] of SPELLINGS) {
  const permission = deny(rule)
  const shown = rule.replace(project.replace(/^\/+/, ''), '<project>')
  const cells: string[] = []
  for (const [how, folder] of FOLDERS) {
    const listing = await read(folder, permission)
    const ok = !listing.names.includes('secret') && NEIGHBOURS.every(name => listing.names.includes(name)) && listing.header.endsWith('entries: 4 shown of 4)')
    if (!ok) red.push(`${spelling} · ${how}`)
    cells.push(`${how} ${ok ? 'ok' : listing.names.includes('secret') ? 'NAMES IT' : 'WRONG'}`)
  }
  check(`${spelling} ${shown}: a direct Read of the folder is denied, and Read of the folder above (${cells.join(' · ')}) names four entries and counts four`, cells.every(cell => cell.endsWith(' ok')) && directRead(join(project, 'src/secret'), permission) === 'deny' && (await refusedByRead('src/secret', permission)), cells.filter(cell => !cell.endsWith(' ok')).join(' · '))
}
console.log(`  (${red.length} of ${SPELLINGS.length * FOLDERS.length} cells red)`)

console.log('the same folder spelled eight ways: Grep and Glob, which a search root reaches the one decision through, leave the denied files out too')
{
  const { GrepTool } = await import(`${SRC}/tools/GrepTool/GrepTool.ts`)
  const { GlobTool } = await import(`${SRC}/tools/GlobTool/GlobTool.ts`)
  const wrong: string[] = []
  for (const [, rule] of SPELLINGS) {
    for (const [how, folder] of EIGHT) {
      const grep = String(GrepTool.mapToolResultToToolResultBlockParam((await GrepTool.call({ pattern: 'token', output_mode: 'files_with_matches', path: folder } as never, context(deny(rule)))).data as never, 'id').content)
      const glob = String(GlobTool.mapToolResultToToolResultBlockParam((await GlobTool.call({ pattern: '**/*.ts', path: folder } as never, context(deny(rule)))).data as never, 'id').content)
      for (const [tool, said] of [['Grep', grep], ['Glob', glob]] as Array<[string, string]>) if (said.includes('secret/keys.ts') || !said.includes('open.ts')) wrong.push(`${rule.replace(project.replace(/^\/+/, ''), '<project>')} · ${how} · ${tool}`)
    }
  }
  check(`${SPELLINGS.length * EIGHT.length * 2} searches: none names a file of the denied folder, each names the open one`, wrong.length === 0, wrong.join(' | '))
}

console.log('a rule on one file, on a name, on a wildcard folder, on a folder only')
{
  const one = deny('Read(src/secret/keys.ts)')
  const above = await read('src', one)
  const inside = await read('src/secret', one)
  check('a rule on one file: the folder is named, and inside it the file is not, the other two are, and two are counted', above.names.includes('secret') && JSON.stringify(inside.names) === JSON.stringify(['deep', 'quiet.ts']) && inside.header.endsWith('entries: 2 shown of 2)'), `${above.text}\n---\n${inside.text}`)
  const name = await read('src/secret/deep', deny('Read(more.ts)'))
  check('a rule on a file name at any depth: a folder that holds only that file lists nothing and counts nothing', name.names.length === 0 && name.header.endsWith('entries: 0 shown of 0)'), name.text)
  const wild = deny('Read(src/*/keys.ts)')
  const [first, second] = [await read('src/secret', wild), await read('src/secrets-public', wild)]
  check('a rule with a wildcard folder: the file is named in neither folder it matches', JSON.stringify(first.names) === JSON.stringify(['deep', 'quiet.ts']) && second.names.length === 0, `${first.text}\n---\n${second.text}`)
  const folderOnly = deny('Read(/src/secret/)')
  const [over, within] = [await read('src', folderOnly), await read('src/secret', folderOnly)]
  check('a rule that names a folder only: Read of the folder above names what a direct Read does not refuse, and everything inside is left out', over.names.includes('secret') === (directRead(join(project, 'src/secret'), folderOnly) !== 'deny') && within.names.length === 0, `${over.text}\n---\n${within.text}`)
}

console.log('what a Read would only ask about is named as before: a name is not its contents')
{
  const bare = await read('src', getEmptyToolPermissionContext())
  const ask = withRules('alwaysAskRules', 'session', ['Read(src/secret/**)'])
  const asked = await read('src', ask)
  check('an ask rule: the listing is byte for byte the one with no rule, and a direct Read of the folder asks', asked.text === bare.text && directRead(join(project, 'src/secret'), ask) === 'ask', asked.text)
  check('a .env file is named, and a direct Read of it asks', bare.names.includes('.env') && directRead(join(project, 'src/.env'), getEmptyToolPermissionContext()) === 'ask', bare.text)
  const envDenied = await read('src', deny('Read(src/.env)'))
  check('a .env file that a rule denies is not named', !envDenied.names.includes('.env') && envDenied.names.includes('open.ts'), envDenied.text)
  const allowed = await read('src', withRules('alwaysAllowRules', 'session', ['Read(src/secret/**)']))
  check('an allow rule changes nothing in the listing', allowed.text === bare.text, allowed.text)
  const both = await read('src', withRules('alwaysAllowRules', 'session', ['Read(src/**)'], deny('Read(src/secret/**)')))
  check('an allow rule beside a deny rule leaves the deny standing', !both.names.includes('secret') && NEIGHBOURS.every(name => both.names.includes(name)), both.text)
}

console.log('links: an entry that leads into a denied folder is not named either')
{
  symlinkSync(join(project, 'src/secret/keys.ts'), join(project, 'src/alias.ts'))
  symlinkSync(join(project, 'src/secret'), join(project, 'src/link'))
  symlinkSync(join(project, 'src/open.ts'), join(project, 'src/secret/via'))
  symlinkSync(join(project, 'src/secret/via'), join(project, 'src/hop'))
  symlinkSync(join(project, 'src/open.ts'), join(project, 'src/fine.ts'))
  symlinkSync(join(project, 'src/nowhere'), join(project, 'src/gone'))
  settle()
  const permission = deny('Read(src/secret/**)')
  const linked = await read('src', permission)
  check('a link to a denied file, a link to the denied folder, and a link that passes through it to an open file: a direct Read of each is denied and none is named', ['alias.ts', 'link', 'hop'].every(name => directRead(join(project, 'src', name), permission) === 'deny' && !linked.names.includes(name)), linked.text)
  check('a link to an open file and a link to nothing stay named', linked.names.includes('fine.ts') && linked.names.includes('gone') && directRead(join(project, 'src/fine.ts'), permission) !== 'deny', linked.text)
  const throughDoor = await read(join(world, 'door', 'src'), permission)
  check('the folder reached through a link to the project: the same entries are left out', JSON.stringify(throughDoor.names) === JSON.stringify(linked.names), throughDoor.text)
}

console.log('one decision: an entry is named exactly when its direct Read is not denied')
{
  const contexts: Array<[string, Permission]> = [
    ['no rule', getEmptyToolPermissionContext()],
    ...SPELLINGS.map(([spelling, rule]) => [spelling, deny(rule)] as [string, Permission]),
    ['one file', deny('Read(src/secret/keys.ts)')],
    ['a name at any depth', deny('Read(keys.ts)')],
    ['a wildcard folder', deny('Read(src/*/keys.ts)')],
    ['a folder only', deny('Read(/src/secret/)')],
    ['a Glob rule, which a Read obeys too', deny('Glob(src/secret/**)')],
    ['a rule in the user settings', deny(SPELLINGS[2]![1], 'userSettings')],
    ['an ask rule', withRules('alwaysAskRules', 'session', ['Read(src/secret/**)'])],
    ['an allow rule beside a deny rule', withRules('alwaysAllowRules', 'session', ['Read(src/**)'], deny('Read(src/secret/**)'))],
    ['tools narrowed to one folder', withRules('alwaysAllowRules', 'toolsNarrowing', ['Read(src/secrets-public/**)'])],
    ['tools narrowed to the source folder, with a deny rule inside', withRules('alwaysAllowRules', 'toolsNarrowing', ['Read(src/**)'], deny('Read(src/secret/**)'))],
  ]
  const folders = [project, join(project, 'src'), join(project, 'src/secret'), join(project, 'src/secret/deep'), join(project, 'src/secrets-public'), join(world, 'door', 'src')]
  const apart: string[] = []
  let entries = 0
  for (const [label, permission] of contexts) {
    for (const folder of folders) {
      const listing = await read(folder, permission)
      for (const name of readdirSync(folder)) {
        entries++
        if (listing.names.includes(name) !== (directRead(join(folder, name), permission) !== 'deny')) apart.push(`${label} · ${folder.slice(world.length + 1)}/${name}`)
      }
    }
  }
  check(`${contexts.length} sets of rules, ${folders.length} folders, links among their entries (${entries} entries read): the listing agrees with the direct Read every time`, apart.length === 0, apart.join(' | '))
  for (const name of ['alias.ts', 'link', 'hop', 'fine.ts', 'gone', 'secret/via']) rmSync(join(project, 'src', name))
  settle()
}

console.log('the same folders by reference: Inspect of mercury://file/<folder>, and Read of it, name what the direct Read does not refuse')
{
  const { InspectTool } = await import(`${SRC}/tools/InspectTool/InspectTool.ts`)
  const children = (text: string): string[] => text.split('\n').filter(line => line.includes(' — ') && line.trimStart().startsWith('mercury://file/')).map(line => line.slice(line.indexOf(' — ') + 3).replace(/\/? \((?:file|directory)\)$/, ''))
  const byInspect = async (folder: string, permission: Permission): Promise<{ names: string[]; text: string }> => {
    const text = String(((await (InspectTool as { call: Function }).call({ ref: `mercury://file/${folder}` }, context(permission))) as { data: { result: string } }).data.result)
    return { names: children(text), text }
  }
  const byRead = async (folder: string, permission: Permission): Promise<string[]> => {
    serial++
    const result = await (FileReadTool as { call: Function }).call({ file_path: `mercury://file/${folder}` }, context(permission), null, { uuid: `00000000-0000-0000-0000-${String(serial).padStart(12, '0')}`, message: { id: `msg_listing_${serial}` } })
    return children(String(result.data.file.content))
  }
  const src = join(project, 'src')
  const bare = await byInspect(src, getEmptyToolPermissionContext())
  check('the control: with no rule Inspect names the five entries', JSON.stringify([...bare.names].sort()) === JSON.stringify(['.env', 'open.ts', 'secret', 'secret.ts', 'secrets-public']) && bare.text.includes('directory · 5 entries'), bare.text)
  const contexts: Array<[string, Permission]> = [
    ['no rule', getEmptyToolPermissionContext()],
    ...SPELLINGS.map(([spelling, rule]) => [spelling, deny(rule)] as [string, Permission]),
    ['one file', deny('Read(src/secret/keys.ts)')],
    ['a name at any depth', deny('Read(keys.ts)')],
    ['a rule in the user settings', deny(SPELLINGS[2]![1], 'userSettings')],
    ['an ask rule', withRules('alwaysAskRules', 'session', ['Read(src/secret/**)'])],
    ['an allow rule beside a deny rule', withRules('alwaysAllowRules', 'session', ['Read(src/**)'], deny('Read(src/secret/**)'))],
    ['tools narrowed to the source folder, with a deny rule inside', withRules('alwaysAllowRules', 'toolsNarrowing', ['Read(src/**)'], deny('Read(src/secret/**)'))],
  ]
  symlinkSync(join(project, 'src/secret/keys.ts'), join(project, 'src/alias.ts'))
  settle()
  const apart: string[] = []
  let entries = 0
  for (const [label, permission] of contexts) {
    for (const folder of [src, join(project, 'src/secret'), join(project, 'src/secrets-public'), `${DOOR}/src/`]) {
      const [inspected, read] = [await byInspect(folder, permission), await byRead(folder, permission)]
      for (const name of readdirSync(folder)) {
        entries++
        const readable = directRead(join(folder, name), permission) !== 'deny'
        if (inspected.names.includes(name) !== readable || read.includes(name) !== readable) apart.push(`${label} · ${folder.slice(world.length + 1)}${name}`)
      }
    }
  }
  check(`${contexts.length} sets of rules, four folders, a link among their entries (${entries} entries read): both doors name an entry exactly when its direct Read is not denied`, apart.length === 0, apart.join(' | '))
  const counted = await byInspect(src, deny('Read(src/secret/**)'))
  check('the count is of what is named', counted.text.includes('directory · 4 entries') && !counted.names.includes('secret') && !counted.names.includes('alias.ts'), counted.text)
  rmSync(join(project, 'src/alias.ts'))
  settle()
}

console.log('the numbers: a denied entry is counted nowhere, the cap included')
{
  mkdirSync(join(project, 'big'))
  for (let index = 0; index < 203; index++) writeFileSync(join(project, 'big', `f${String(index).padStart(3, '0')}.txt`), 'x')
  for (let index = 0; index < 4; index++) writeFileSync(join(project, 'big', `a-hidden-${index}.txt`), 'x')
  const bare = await read('big', getEmptyToolPermissionContext())
  check('the control: 207 entries, 200 shown, 7 named as omitted', bare.header.endsWith('entries: 200 shown of 207)') && bare.text.includes('… 7 more entries omitted') && bare.names.includes('a-hidden-0.txt'), bare.header)
  const hidden = await read('big', deny('Read(big/a-hidden-*)'))
  check('four of them denied: 203 counted, 200 shown, 3 omitted, and none of the four named', hidden.header.endsWith('entries: 200 shown of 203)') && hidden.text.includes('… 3 more entries omitted') && !hidden.text.includes('a-hidden-') && hidden.names.includes('f199.txt'), `${hidden.header}\n${hidden.text.split('\n').at(-1)}`)
  rmSync(join(project, 'big'), { recursive: true, force: true })
}

console.log('what stays as it was')
{
  const secret = join(HOME, '.credentials.json')
  writeFileSync(secret, '{"note":"fixture"}\n', { mode: 0o600 })
  writeFileSync(join(HOME, 'notes.json'), '{}\n')
  const home = await read(HOME, getEmptyToolPermissionContext())
  check('Mercury\'s own credential file is not named, with no rule at all, and its neighbour is', !home.names.includes('.credentials.json') && home.names.includes('notes.json'), home.text)
  const plain = renderDirectoryTarget(join(project, 'src'))
  const bare = await read('src', getEmptyToolPermissionContext())
  check('the listing asked for with no decision is the listing under no rule, byte for byte', plain.content === bare.text, plain.content)
  process.env.MERCURY_READ_TARGETS = '0'
  const off = await read('src', deny('Read(src/secret/**)')).then(() => 'listed', (error: unknown) => String(error))
  delete process.env.MERCURY_READ_TARGETS
  check('with folder targets switched off a folder is still refused as before', off !== 'listed', off)
}

rmSync(world, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-read-listing-hides-denied: ${failures} of ${checks} FAILED`)
  process.exit(1)
}
console.log(`\nprove-read-listing-hides-denied: all ${checks} green`)
