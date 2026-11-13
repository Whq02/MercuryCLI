#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createFakeBlenderFixture } from './fake-blender.ts'

const launch = process.cwd()
const world = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'blender-denied-')))
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
mkdirSync(join(world, 'addons'), { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_TMPDIR = join(HOME, 'tmp')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.HOME = world
delete process.env.MERCURY_HOME
for (const name of ['MERCURY_BLENDER_BRIDGE_TOKEN', 'BLENDER_USER_SCRIPTS', 'BLENDER_USER_RESOURCES', 'FAKE_BLENDER_C_STDOUT', 'FAKE_BLENDER_C_STDERR', 'FAKE_BLENDER_RENDER_SLEEP_MS']) delete process.env[name]

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const BLENDS: Record<string, { custom_objects: string[]; engine: string }> = {
  'secret/unit.blend': { custom_objects: ['SecretRig'], engine: 'SECRET_ENGINE' },
  'secret-public/unit.blend': { custom_objects: ['PublicRig'], engine: 'CYCLES' },
  'secret.blend': { custom_objects: ['SiblingRig'], engine: 'CYCLES' },
  'open/unit.blend': { custom_objects: ['OpenRig'], engine: 'CYCLES' },
}
for (const [path, meta] of Object.entries(BLENDS)) {
  mkdirSync(dirname(join(project, path)), { recursive: true })
  writeFileSync(join(project, path), JSON.stringify(meta))
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

const deadPort = await new Promise<number>(resolve => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as net.AddressInfo).port
    server.close(() => resolve(port))
  })
})
const fixture = createFakeBlenderFixture(join(world, 'bin'), { version: '5.3.0' })
process.env.MERCURY_BLENDER = '1'
process.env.MERCURY_BLENDER_BIN = fixture.bin
process.env.MERCURY_BLENDER_BRIDGE_PORT = String(deadPort)
process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR = join(world, 'addons')

const { BlenderTool } = await import(`${SRC}/tools/BlenderTool/BlenderTool.ts`)
const { getEmptyToolPermissionContext } = await import(`${SRC}/Tool.ts`)
const { decideToolPermission } = await import(`${SRC}/utils/permissions/decision/engine.ts`)
const permissions = await import(`${SRC}/utils/permissions/filesystem.ts`)
const { resetBlenderBridgeClientForTest } = await import(`${SRC}/services/blender/bridgeClient.ts`)
const { _resetBlenderBridgeContextCacheForTesting } = await import(`${SRC}/utils/blender/bridgeGates.ts`)
resetBlenderBridgeClientForTest()
_resetBlenderBridgeContextCacheForTesting()

type Permission = ReturnType<typeof getEmptyToolPermissionContext>
type Verdict = { behavior: string; message?: string; updatedInput?: unknown }
const context = (permission: Permission) => ({ abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: permission, tasks: {}, sessionHooks: new Map() }), setAppState: () => {}, readFileState: new Map(), messages: [], options: { tools: [] } }) as never
const withRules = (kind: 'alwaysDenyRules' | 'alwaysAllowRules' | 'alwaysAskRules', source: string, rules: string[], base: Permission = getEmptyToolPermissionContext()): Permission => ({ ...base, [kind]: { ...(base[kind] as Record<string, string[]>), [source]: rules } })
const deny = (rule: string, source = 'session'): Permission => withRules('alwaysDenyRules', source, [rule])
const inMode = (mode: string, permission: Permission): Permission => ({ ...permission, mode }) as Permission
const directRead = (file: string, permission: Permission): Verdict => permissions.checkReadPermissionForTool({ name: 'Read', getPath: () => file }, { file_path: file }, permission)
const verdict = async (op: string, args: Record<string, unknown> | undefined, permission: Permission | null): Promise<Verdict> => (await (BlenderTool as { checkPermissions: Function }).checkPermissions({ op, ...(args ? { args } : {}) }, permission === null ? {} : context(permission))) as Verdict
const use = async (op: string, args: Record<string, unknown>, permission: Permission): Promise<{ behavior: string; message: string; answer: string; starts: number }> => {
  fixture.clearInvocations()
  const decision = (await decideToolPermission(BlenderTool, { op, args }, context(permission))).decision as Verdict
  if (decision.behavior !== 'allow') return { behavior: decision.behavior, message: decision.message ?? '', answer: '', starts: fixture.invocations().length }
  const ran = (await (BlenderTool as { call: Function }).call(decision.updatedInput ?? { op, args }, context(permission))) as { data: { result: string } }
  return { behavior: 'allow', message: '', answer: ran.data.result, starts: fixture.invocations().length }
}
const settle = (): void => permissions.getResolvedWorkingDirPaths.clearCache()

const SECRET = join(project, 'secret/unit.blend')
const FROM_THE_FILE = /SECRET_ENGINE|SecretRig|secret\/unit\.blend/
const READS = ['scene_info', 'objects_list', 'render_state', 'report_tail']
const CALLS: Array<[string, string, Record<string, unknown>]> = [
  ...READS.map(op => [`${op} blend`, op, { blend: 'secret/unit.blend' }] as [string, string, Record<string, unknown>]),
  ['scene_info path', 'scene_info', { path: 'secret/unit.blend' }],
  ['blend_open path', 'blend_open', { path: 'secret/unit.blend' }],
  ['render_still blend', 'render_still', { blend: 'secret/unit.blend', outputPath: 'renders/out.png' }],
  ['python_run blend', 'python_run', { blend: 'secret/unit.blend', source: 'import bpy\nresult = [o.name for o in bpy.data.scenes[0].objects]' }],
]
const SPELLINGS: Array<[string, string]> = [
  ['relative', 'Read(secret/**)'],
  ['from the root', 'Read(/secret/**)'],
  ['absolute', `Read(//${project.replace(/^\/+/, '')}/secret/**)`],
  ['home', 'Read(~/project/secret/**)'],
]

console.log('the control: with no rule the free reads open the file and answer from it, and the others ask')
{
  const open = getEmptyToolPermissionContext()
  const wrong: string[] = []
  for (const [label, op, args] of CALLS.slice(0, 5)) {
    const used = await use(op, args, open)
    if (used.behavior !== 'allow' || used.starts !== 1 || !FROM_THE_FILE.test(used.answer)) wrong.push(`${label}: ${used.behavior} ${used.answer.slice(0, 80)}`)
  }
  check('four read verbs by blend and one by path: each starts one Blender with no window and answers from the file', wrong.length === 0, wrong.join(' | '))
  const asked: Array<Awaited<ReturnType<typeof use>>> = []
  for (const [, op, args] of CALLS.slice(5)) asked.push(await use(op, args, open))
  check('opening it, rendering it and running Python on it ask first', asked.every(used => used.behavior === 'ask' && used.starts === 0), asked.map(used => used.behavior).join(' '))
}

console.log('the law: a file whose direct Read is denied is not opened by the tool, on any verb, by either argument')
const red: string[] = []
for (const [spelling, rule] of SPELLINGS) {
  const permission = deny(rule)
  const read = directRead(SECRET, permission)
  const cells: string[] = []
  for (const [label, op, args] of CALLS) {
    const used = await use(op, args, permission)
    const ok = used.behavior === 'deny' && used.message === read.message && used.starts === 0
    if (!ok) red.push(`${spelling} · ${label}: ${used.behavior}${FROM_THE_FILE.test(used.answer) ? ', answered from the file' : ''}`)
    cells.push(`${label} ${ok ? 'ok' : used.behavior === 'allow' ? 'OPENS IT' : used.behavior === 'ask' ? 'ASKS' : 'WRONG'}`)
  }
  check(`${spelling} ${rule.replace(project.replace(/^\/+/, ''), '<project>')}: ${cells.join(' · ')}`, cells.every(cell => cell.endsWith(' ok')) && read.behavior === 'deny', red.filter(cell => cell.startsWith(spelling)).join(' | '))
}
console.log(`  (${red.length} of ${SPELLINGS.length * CALLS.length} cells red)`)

console.log('the refusal is the rule\'s own sentence, the one a Read of the file gets')
{
  const permission = deny('Read(secret/**)')
  const refused = await verdict('objects_list', { blend: 'secret/unit.blend' }, permission)
  check('it names the file by its full path and the rule that denies it', String(refused.message).startsWith(`Reading ${SECRET} is denied by the rule Read(secret/**) `) && refused.message === directRead(SECRET, permission).message, String(refused.message))
  const sovereign = inMode('sovereign', permission)
  const still: Array<Awaited<ReturnType<typeof use>>> = []
  for (const [, op, args] of CALLS) still.push(await use(op, args, sovereign))
  check('under the posture that answers every question the rule still refuses all eight, and no Blender starts', still.every(used => used.behavior === 'deny' && used.starts === 0), still.map(used => used.behavior).join(' '))
}

console.log('a script named to python_run is a file the tool opens: the same law')
{
  writeFileSync(join(project, 'secret/kit.py'), 'print("SECRET_SCRIPT_RAN")\n')
  writeFileSync(join(project, 'open/kit.py'), 'print("OPEN_SCRIPT_RAN")\n')
  const secretScript = join(project, 'secret/kit.py')
  const wrong: string[] = []
  for (const [spelling, rule] of SPELLINGS) {
    const permission = deny(rule)
    const used = await use('python_run', { script: 'secret/kit.py', argv: ['--unit', 'eques'] }, permission)
    if (!(used.behavior === 'deny' && used.message === directRead(secretScript, permission).message && used.starts === 0)) wrong.push(`${spelling}: ${used.behavior}${used.answer.includes('SECRET_SCRIPT_RAN') ? ', ran it' : ''}`)
  }
  check('a script under the denied folder is refused in the sentence a Read of it gets, under all four spellings, and no Blender starts', wrong.length === 0, wrong.join(' | '))
  const elsewhere = await use('python_run', { script: 'open/kit.py' }, deny('Read(secret/**)'))
  check('a script elsewhere asks first, as every python_run does', elsewhere.behavior === 'ask' && elsewhere.starts === 0, elsewhere.behavior)
  const sovereign = await use('python_run', { script: 'secret/kit.py' }, inMode('sovereign', deny('Read(secret/**)')))
  check('under the posture that answers every question the rule still refuses the script, and no Blender starts', sovereign.behavior === 'deny' && sovereign.starts === 0, `${sovereign.behavior} starts=${sovereign.starts}`)
  const ranOpen = await use('python_run', { script: 'open/kit.py' }, inMode('sovereign', deny('Read(secret/**)')))
  check('and under that posture the script elsewhere runs', ranOpen.behavior === 'allow' && ranOpen.starts === 1 && ranOpen.answer.includes('OPEN_SCRIPT_RAN'), `${ranOpen.behavior} ${ranOpen.answer.slice(0, 120)}`)
}

console.log('the neighbours are opened as before')
{
  const wrong: string[] = []
  for (const [, rule] of SPELLINGS) {
    for (const [file, name] of [['secret-public/unit.blend', 'PublicRig'], ['secret.blend', 'SiblingRig'], ['open/unit.blend', 'OpenRig']] as Array<[string, string]>) {
      const used = await use('objects_list', { blend: file }, deny(rule))
      if (used.behavior !== 'allow' || !used.answer.includes(name)) wrong.push(`${rule} ${file}: ${used.behavior}`)
    }
  }
  check('a folder whose name starts the same, a file beside the folder and a file elsewhere: listed under all four spellings', wrong.length === 0, wrong.join(' | '))
}

console.log('a link, .. and another letter case: the tool agrees with the direct Read')
{
  symlinkSync(SECRET, join(project, 'alias.blend'))
  symlinkSync(join(project, 'secret'), join(project, 'door'))
  settle()
  const permission = deny('Read(secret/**)')
  const spelled = ['alias.blend', 'door/unit.blend', 'open/../secret/unit.blend', ...(existsSync(join(project, 'SECRET', 'UNIT.BLEND')) ? ['SECRET/unit.blend'] : [])]
  const used: Array<Awaited<ReturnType<typeof use>>> = []
  for (const file of spelled) used.push(await use('objects_list', { blend: file }, permission))
  check(`${spelled.join(', ')}: a direct Read of each is denied and none is opened`, used.every(one => one.behavior === 'deny' && one.starts === 0) && spelled.every(file => directRead(join(project, file), permission).behavior === 'deny'), used.map(one => one.behavior).join(' '))
}

console.log('one decision: the tool refuses a file exactly when a direct Read of it is denied')
{
  const contexts: Array<[string, Permission]> = [
    ['no rule', getEmptyToolPermissionContext()],
    ...SPELLINGS.map(([spelling, rule]) => [spelling, deny(rule)] as [string, Permission]),
    ['one file', deny('Read(secret/unit.blend)')],
    ['a name at any depth', deny('Read(unit.blend)')],
    ['a wildcard folder', deny('Read(*/unit.blend)')],
    ['a rule in the user settings', deny(SPELLINGS[2]![1], 'userSettings')],
    ['a Glob rule, which a Read obeys too', deny('Glob(secret/**)')],
    ['an ask rule', withRules('alwaysAskRules', 'session', ['Read(secret/**)'])],
    ['an allow rule beside a deny rule', withRules('alwaysAllowRules', 'session', ['Read(**)'], deny('Read(secret/**)'))],
    ['tools narrowed to one folder', withRules('alwaysAllowRules', 'toolsNarrowing', ['Read(open/**)'])],
  ]
  const files = [...Object.keys(BLENDS), 'alias.blend', 'door/unit.blend', 'nowhere/missing.blend']
  const apart: string[] = []
  for (const [label, permission] of contexts) {
    for (const file of files) {
      for (const [op, args] of [['scene_info', { blend: file }], ['scene_info', { path: file }], ['blend_open', { path: file }]] as Array<[string, Record<string, unknown>]>) {
        const refused = (await verdict(op, args, permission)).behavior === 'deny'
        if (refused !== (directRead(join(project, file), permission).behavior === 'deny')) apart.push(`${label} · ${op} ${Object.keys(args)[0]} ${file}`)
      }
    }
  }
  check(`${contexts.length} sets of rules, ${files.length} files, three ways of naming each: it answers deny exactly when the direct Read does`, apart.length === 0, apart.join(' | '))
  rmSync(join(project, 'alias.blend'))
  rmSync(join(project, 'door'))
  settle()
}

console.log('every other answer is the one the tool gave before')
{
  const inputs: Array<[string, Record<string, unknown> | undefined]> = [
    ...READS.map(op => [op, { blend: 'open/unit.blend' }] as [string, Record<string, unknown>]),
    ...READS.map(op => [op, undefined] as [string, undefined]),
    ['blend_open', { path: 'open/unit.blend' }],
    ['render_still', { blend: 'open/unit.blend', outputPath: 'renders/out.png' }],
    ['python_run', { source: 'result = 1' }],
    ['python_run', { blend: 'open/unit.blend', source: 'result = 1' }],
    ['blender_status', undefined],
    ['blender_bridge_install', undefined],
    ['blender_bridge_uninstall', undefined],
    ['no_such_verb', { blend: 'secret/unit.blend' }],
    ['scene_info', { blend: 'secret/unit.blend' }],
    ['blend_open', { path: 'secret/unit.blend' }],
  ]
  const contexts: Array<[string, Permission]> = [
    ['no rule', getEmptyToolPermissionContext()],
    ['a deny rule on another folder', deny('Read(elsewhere/**)')],
    ['an ask rule on the file', withRules('alwaysAskRules', 'session', ['Read(secret/**)'])],
    ['an allow rule on the file', withRules('alwaysAllowRules', 'session', ['Read(secret/**)'])],
    ['an edit deny rule on the file', deny('Edit(secret/**)')],
  ]
  const moved: string[] = []
  for (const [label, permission] of contexts) {
    for (const [op, args] of inputs) {
      const before = JSON.stringify(await verdict(op, args, null))
      if (JSON.stringify(await verdict(op, args, permission)) !== before) moved.push(`${label} · ${op} ${JSON.stringify(args ?? {})}`)
    }
  }
  check(`${contexts.length} sets of rules that deny no Read of the file, ${inputs.length} calls: the answer is byte for byte the one given with no rules at hand`, moved.length === 0, moved.join(' | '))
  const asked = withRules('alwaysAskRules', 'session', ['Read(secret/**)'])
  const read = await use('objects_list', { blend: 'secret/unit.blend' }, asked)
  check('where a Read would only ask, the free read still answers with no question, as before', directRead(SECRET, asked).behavior === 'ask' && read.behavior === 'allow' && read.answer.includes('SecretRig'), `${read.behavior} ${read.answer.slice(0, 80)}`)
  const bare = await Promise.all([verdict('scene_info', { blend: 'secret/unit.blend' }, null), (BlenderTool as { checkPermissions: Function }).checkPermissions({ op: 'scene_info', args: { blend: 'secret/unit.blend' } })])
  check('a caller that hands the tool no session decides as before: a read is allowed', bare.every(one => (one as Verdict).behavior === 'allow'), JSON.stringify(bare))
}

rmSync(world, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-blender-denied-read: ${failures} of ${checks} FAILED`)
  process.exit(1)
}
console.log(`\nprove-blender-denied-read: all ${checks} green`)
