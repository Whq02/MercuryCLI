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

console.log('a picture named to show is a file the tool opens: the same law')
{
  const { encodePng } = await import(`${SRC}/tools/FileReadTool/imageProcessorJs.ts`)
  const picture = encodePng({ width: 2, height: 2, data: new Uint8Array(16).fill(255) })
  writeFileSync(join(project, 'secret/sheet.png'), picture)
  writeFileSync(join(project, 'open/sheet.png'), picture)
  const secretPicture = join(project, 'secret/sheet.png')
  const wrong: string[] = []
  for (const [spelling, rule] of SPELLINGS) {
    const permission = deny(rule)
    for (const show of [['secret/sheet.png'], [{ path: 'secret/sheet.png', scale: 2 }], ['open/sheet.png', 'secret/sheet.png']]) {
      const used = await use('python_run', { script: 'open/kit.py', show }, permission)
      if (!(used.behavior === 'deny' && used.message === directRead(secretPicture, permission).message && used.starts === 0)) wrong.push(`${spelling} ${JSON.stringify(show)}: ${used.behavior}`)
    }
  }
  check('a picture under the denied folder, named alone, with a scale, or second, is refused in the sentence a Read of it gets, under all four spellings, and no Blender starts', wrong.length === 0, wrong.join(' | '))
  const sovereign = inMode('sovereign', deny('Read(secret/**)'))
  const refused = await use('python_run', { script: 'open/kit.py', show: ['secret/sheet.png'] }, sovereign)
  check('under the posture that answers every question the rule still refuses it, and no Blender starts', refused.behavior === 'deny' && refused.starts === 0, `${refused.behavior} starts=${refused.starts}`)
  const shownBy = async (show: unknown[]): Promise<{ behavior: string; starts: number; kinds: string; texts: string[] }> => {
    fixture.clearInvocations()
    const input = { op: 'python_run', args: { script: 'open/kit.py', show } }
    const decision = (await decideToolPermission(BlenderTool, input, context(sovereign))).decision as Verdict
    if (decision.behavior !== 'allow') return { behavior: decision.behavior, starts: fixture.invocations().length, kinds: '', texts: [] }
    const ran = (await (BlenderTool as { call: Function }).call(decision.updatedInput ?? input, context(sovereign))) as { data: unknown }
    const block = (BlenderTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(ran.data, 'toolu_denied') as { content: unknown }
    const parts = (Array.isArray(block.content) ? block.content : []) as Array<{ type: string; text?: string }>
    return { behavior: 'allow', starts: fixture.invocations().length, kinds: parts.map(part => part.type).join(','), texts: parts.flatMap(part => (typeof part.text === 'string' ? [part.text] : [])) }
  }
  const elsewhere = await shownBy(['open/sheet.png'])
  check('and under that posture a picture elsewhere rides the answer of the script that ran', elsewhere.behavior === 'allow' && elsewhere.starts === 1 && elsewhere.kinds === 'text,text,image' && (elsewhere.texts[0] ?? '').includes('OPEN_SCRIPT_RAN'), `${elsewhere.behavior} ${elsewhere.kinds}`)
  const fifth = await shownBy(['open/sheet.png', 'open/sheet.png', 'open/sheet.png', 'open/sheet.png', 'secret/sheet.png'])
  check(
    'a fifth picture is never opened, so the rule on it refuses nothing: the call runs, four ride, and the fifth is listed by the path the call gave',
    fifth.behavior === 'allow' && fifth.starts === 1 && fifth.kinds.split(',').filter(kind => kind === 'image').length === 4 && fifth.texts.at(-1) === 'show: 4 pictures at most ride one answer; not shown: secret/sheet.png',
    `${fifth.behavior} ${fifth.kinds} ${fifth.texts.at(-1) ?? ''}`,
  )
}

console.log('a frame render_still is asked to show is a file the tool opens: the same law; with no show a render only writes there')
{
  const secretFrame = join(project, 'secret/frame.png')
  const wrong: string[] = []
  for (const [spelling, rule] of SPELLINGS) {
    const permission = deny(rule)
    const used = await use('render_still', { blend: 'open/unit.blend', outputPath: 'secret/frame.png', show: true }, permission)
    if (!(used.behavior === 'deny' && used.message === directRead(secretFrame, permission).message && used.starts === 0)) wrong.push(`${spelling}: ${used.behavior}`)
  }
  check('show: true on a frame under the denied folder is refused in the sentence a Read of it gets, under all four spellings, and no Blender starts', wrong.length === 0, wrong.join(' | '))
  const moved: string[] = []
  for (const show of [undefined, false, 'yes']) {
    const args = { blend: 'open/unit.blend', outputPath: 'secret/frame.png', ...(show === undefined ? {} : { show }) }
    const ruled = await verdict('render_still', args, deny('Read(secret/**)'))
    if (ruled.behavior !== 'ask' || JSON.stringify(ruled) !== JSON.stringify(await verdict('render_still', args, null))) moved.push(`${String(show)}: ${ruled.behavior}`)
  }
  check('with no show, show: false, or a show that is not true, the same render asks exactly as it does with no rules at hand', moved.length === 0, moved.join(' | '))
}

console.log('a show path is checked again after the operation, when a new link may name a denied picture')
{
  const permission = inMode('sovereign', deny('Read(secret/**)'))
  const linked = join(project, 'open/after.png')
  const partsOf = (data: unknown): Array<{ type: string; text?: string }> => {
    const block = (BlenderTool as { mapToolResultToToolResultBlockParam: Function }).mapToolResultToToolResultBlockParam(data, 'toolu_after') as { content: unknown }
    return Array.isArray(block.content) ? block.content : []
  }
  const input = { op: 'python_run', args: { source: 'import os\nos.symlink("../secret/sheet.png", "open/after.png")\nprint("SCRIPT_FINISHED")', show: ['open/after.png', 'open/sheet.png'] } }
  const before = (await decideToolPermission(BlenderTool, input, context(permission))).decision as Verdict
  const ran = await (BlenderTool as { call: Function }).call(input, context(permission))
  settle()
  const after = directRead(linked, permission)
  const parts = partsOf(ran.data)
  check('headless: the missing show path allows the call, the script finishes, and a direct Read of its new link is denied', before.behavior === 'allow' && ran.data.result.includes('SCRIPT_FINISHED') && after.behavior === 'deny', JSON.stringify({ before: before.behavior, after: after.behavior }))
  check('headless: the rule\'s own denial replaces that picture, while the script answer and allowed picture beside it survive', parts.map(part => part.type).join(',') === 'text,text,text,image' && parts[0]?.text === ran.data.result && parts[1]?.text === after.message, JSON.stringify(parts.map(part => part.type)))
  rmSync(linked)
  settle()

  const sockets = new Set<net.Socket>()
  const { BLENDER_BRIDGE_PROTOCOL_VERSION } = await import(`${SRC}/services/blender/bridgeProtocol.ts`)
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, newline)) as { id?: number; op: string }
        buffer = buffer.slice(newline + 1)
        if (frame.op === 'hello') socket.write(JSON.stringify({ ok: true, result: { version: BLENDER_BRIDGE_PROTOCOL_VERSION } }) + '\n')
        else {
          if (frame.op === 'python_run') symlinkSync('../secret/sheet.png', linked)
          socket.write(JSON.stringify({ id: frame.id, ok: true, result: 'BRIDGE_FINISHED' }) + '\n')
        }
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  process.env.MERCURY_BLENDER_BRIDGE_PORT = String((server.address() as net.AddressInfo).port)
  process.env.MERCURY_BLENDER_BRIDGE_TOKEN = 'tok'
  resetBlenderBridgeClientForTest()
  try {
    fixture.clearInvocations()
    const accepted = (await decideToolPermission(BlenderTool, input, context(permission))).decision as Verdict
    const reply = await (BlenderTool as { call: Function }).call(input, context(permission))
    settle()
    const read = directRead(linked, permission)
    const shown = partsOf(reply.data)
    check('bridge: the absent path allows the call, the bridge creates the link and answers, and no Blender starts', accepted.behavior === 'allow' && reply.data.result.includes('road: bridge') && reply.data.result.includes('BRIDGE_FINISHED') && fixture.invocations().length === 0 && read.behavior === 'deny', JSON.stringify({ accepted: accepted.behavior, read: read.behavior }))
    check('bridge: the same denial replaces the linked picture, not the answer or the allowed picture', shown.map(part => part.type).join(',') === 'text,text,text,image' && shown[0]?.text === reply.data.result && shown[1]?.text === read.message, JSON.stringify(shown.map(part => part.type)))
  } finally {
    resetBlenderBridgeClientForTest()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    process.env.MERCURY_BLENDER_BRIDGE_PORT = String(deadPort)
    delete process.env.MERCURY_BLENDER_BRIDGE_TOKEN
    rmSync(linked, { force: true })
    settle()
  }

  const render = { op: 'render_still', args: { blend: 'open/unit.blend', outputPath: 'open/after.png', show: true } }
  const accepted = (await decideToolPermission(BlenderTool, render, context(permission))).decision as Verdict
  symlinkSync('../secret/sheet.png', linked)
  process.env.FAKE_BLENDER_RENDER_PNG = '2x2'
  try {
    const reply = await (BlenderTool as { call: Function }).call(render, context(permission))
    settle()
    const read = directRead(linked, permission)
    const shown = partsOf(reply.data)
    check('render: a path replaced after permission still renders and answers, and the final path is denied to Read', accepted.behavior === 'allow' && reply.data.result.includes('"finished": true') && read.behavior === 'deny', JSON.stringify({ accepted: accepted.behavior, read: read.behavior, answer: reply.data.result }))
    check('render: show returns the render answer and the rule\'s denial, never the denied frame', shown.map(part => part.type).join(',') === 'text,text' && shown[0]?.text === reply.data.result && shown[1]?.text === read.message, JSON.stringify(shown.map(part => part.type)))
  } finally {
    delete process.env.FAKE_BLENDER_RENDER_PNG
    rmSync(linked, { force: true })
    settle()
  }
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
