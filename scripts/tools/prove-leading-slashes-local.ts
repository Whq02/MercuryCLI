#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const launch = process.cwd()
const world = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'leading-slashes-')))
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
mkdirSync(join(project, 'secret'), { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_TMPDIR = join(HOME, 'tmp')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_BARE = '1'
process.env.HOME = world
delete process.env.MERCURY_HOME
delete process.env.MERCURY_READ_TARGETS

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
writeFileSync(join(project, 'secret/keys.txt'), 'CONTENTS-OF-KEYS\n')
writeFileSync(join(project, 'open.txt'), 'CONTENTS-OF-OPEN\n')
writeFileSync(join(HOME, '.credentials.json'), '{"note":"CONTENTS-OF-CREDENTIALS"}\n', { mode: 0o600 })
symlinkSync(join(project, 'secret/keys.txt'), join(project, 'link-secret.txt'))
symlinkSync(join(project, 'secret'), join(project, 'door'))
symlinkSync(join(HOME, '.credentials.json'), join(project, 'link-credentials.txt'))
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
const { InspectTool } = await import(`${SRC}/tools/InspectTool/InspectTool.ts`)
const { getEmptyToolPermissionContext } = await import(`${SRC}/Tool.ts`)
const { decideToolPermission } = await import(`${SRC}/utils/permissions/decision/engine.ts`)
const permissions = await import(`${SRC}/utils/permissions/filesystem.ts`)
const paths = (await import(`${SRC}/utils/path.ts`)) as { localPath?: (path: string, platform?: string) => string }

type Permission = ReturnType<typeof getEmptyToolPermissionContext>
type Answer = { behavior: string; text: string }
const context = (permission: Permission) =>
  ({ readFileState: new Map(), userModified: false, updateFileHistoryState: () => {}, dynamicSkillDirTriggers: new Set<string>(), nestedMemoryAttachmentTriggers: new Set<string>(), abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: permission, tasks: {}, sessionHooks: new Map() }), setAppState: () => {}, messages: [], options: { tools: [] } }) as never
const rules = (kind: 'alwaysDenyRules' | 'alwaysAskRules', list: string[], mode: string): Permission => ({ ...getEmptyToolPermissionContext(), mode, [kind]: { session: list } }) as Permission
let serial = 0
const answer = async (tool: unknown, input: Record<string, unknown>, permission: Permission): Promise<Answer> => {
  const door = tool as { validateInput?: Function; call: Function }
  const valid = await door.validateInput?.(input, context(permission))
  if (valid && valid.result === false) return { behavior: 'deny', text: '' }
  const decision = (await decideToolPermission(tool as never, input, context(permission))).decision as { behavior: string; updatedInput?: unknown }
  if (decision.behavior !== 'allow') return { behavior: decision.behavior, text: '' }
  serial++
  const text = await door.call(decision.updatedInput ?? input, context(permission), null, { uuid: `00000000-0000-0000-0000-${String(serial).padStart(12, '0')}`, message: { id: `msg_slashes_${serial}` } }).then((ran: { data: unknown }) => JSON.stringify(ran.data), (error: unknown) => `THROWS ${String(error)}`)
  return { behavior: 'allow', text }
}
const SPELLINGS: Array<[string, (path: string) => string]> = [
  ['two leading slashes', path => `/${path}`],
  ['three leading slashes', path => `//${path}`],
  ['every slash doubled', path => path.replaceAll('/', '//')],
  ['a slash doubled inside', path => path.replace('/project/', '/project//')],
]
const TARGETS: Array<[string, string]> = [
  ['the denied file', join(project, 'secret/keys.txt')],
  ['a link to the denied file', join(project, 'link-secret.txt')],
  ['a file through a link to the denied folder', join(project, 'door/keys.txt')],
  ['a link to Mercury\'s own credential file', join(project, 'link-credentials.txt')],
  ['an open file', join(project, 'open.txt')],
]
const RULES: Array<[string, string]> = [
  ['relative', 'Read(secret/**)'],
  ['from the root', 'Read(/secret/**)'],
  ['absolute', `Read(//${project.replace(/^\/+/, '')}/secret/**)`],
]
const DOORS: Array<[string, (path: string) => { tool: unknown; input: Record<string, unknown> }]> = [
  ['Read by the path', path => ({ tool: FileReadTool, input: { file_path: path } })],
  ['Read by the reference', path => ({ tool: FileReadTool, input: { file_path: `mercury://file/${path}` } })],
  ['Inspect', path => ({ tool: InspectTool, input: { ref: `mercury://file/${path}` } })],
]
const MODES = ['default', 'implement', 'sovereign']
const CONTENTS = /CONTENTS-OF-(KEYS|CREDENTIALS)/

console.log('the law: a path that begins with more than one slash is the local path, and is judged as it')
const red: string[] = []
let cells = 0
for (const [target, path] of TARGETS) {
  const rows: string[] = []
  for (const [, rule] of RULES) {
    for (const mode of MODES) {
      const permission = rules('alwaysDenyRules', [rule], mode)
      const plain = await answer(FileReadTool, { file_path: path }, permission)
      for (const [spelling, spell] of SPELLINGS) {
        for (const [door, through] of DOORS) {
          cells++
          const call = through(spell(path))
          const got = await answer(call.tool, call.input, permission)
          const leaked = plain.behavior !== 'allow' && CONTENTS.test(got.text)
          if (got.behavior === plain.behavior && !leaked) continue
          red.push(`${target} · ${rule} · ${mode} · ${spelling} · ${door}`)
          if (rows.length < 4) rows.push(`${mode} ${spelling} ${door}: ${got.behavior} where one slash gives ${plain.behavior}${leaked ? `, with ${CONTENTS.exec(got.text)![0]}` : ''}`)
        }
      }
    }
  }
  check(`${target}: under three rule spellings and three postures, four spellings through three doors answer as the path with one slash does`, rows.length === 0, rows.join(' | '))
}
console.log(`  (${red.length} of ${cells} cells red)`)

console.log('the resolver the judge and the credential floor share takes such a path through its links')
{
  const forms = permissions.getResolvedWorkingDirPaths(`/${join(project, 'link-secret.txt')}`) as string[]
  check('two leading slashes before a link: the forms judged hold the file the link leads to', forms.includes(join(project, 'secret/keys.txt')), forms.join(' | '))
  const writes = permissions.checkWritePermissionForTool({ name: 'Edit', getPath: () => `/${join(project, 'link-secret.txt')}` }, {}, { ...getEmptyToolPermissionContext(), alwaysDenyRules: { session: ['Edit(secret/**)'] } }) as { behavior: string }
  check('a write through the same spelling to a file an Edit rule denies is denied', writes.behavior === 'deny', writes.behavior)
}

console.log('where two slashes do begin a network path: a spelling of a local drive is that drive\'s path (read from the rule, not run on that system)')
{
  const local = paths.localPath
  const cases: Array<[string, string]> = [
    ['\\\\?\\C:\\Users\\me\\secret\\k.txt', 'C:\\Users\\me\\secret\\k.txt'],
    ['\\\\.\\C:\\Users\\me\\secret\\k.txt', 'C:\\Users\\me\\secret\\k.txt'],
    ['//?/C:/Users/me/secret/k.txt', 'C:\\Users\\me\\secret\\k.txt'],
    ['\\\\localhost\\C$\\Users\\me\\secret\\k.txt', 'C:\\Users\\me\\secret\\k.txt'],
    ['\\\\127.0.0.1\\c$\\Users\\me\\secret\\k.txt', 'C:\\Users\\me\\secret\\k.txt'],
    ['\\\\server\\share\\secret\\k.txt', '\\\\server\\share\\secret\\k.txt'],
    ['\\\\?\\UNC\\server\\share\\k.txt', '\\\\?\\UNC\\server\\share\\k.txt'],
    ['C:\\Users\\me\\k.txt', 'C:\\Users\\me\\k.txt'],
  ]
  const wrong = typeof local === 'function' ? cases.filter(([given, expected]) => local(given, 'windows') !== expected).map(([given]) => `${given} → ${local(given, 'windows')}`) : ['no function']
  check('five spellings of a local drive become the drive\'s path; a true network path, its long form and a plain drive path stay', wrong.length === 0, wrong.join(' | '))
  check('on this system a network spelling is left alone and leading slashes are folded to one', typeof local === 'function' && local('//a/b', 'macos') === '/a/b' && local('///a//b', 'macos') === '/a//b' && local('/a/b', 'macos') === '/a/b' && local('a//b', 'macos') === 'a//b')
}

rmSync(world, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-leading-slashes-local: ${failures} of ${checks} FAILED`)
  process.exit(1)
}
console.log(`\nprove-leading-slashes-local: all ${checks} green`)
