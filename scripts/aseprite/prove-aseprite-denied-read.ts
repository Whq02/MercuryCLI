#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const launch = process.cwd()
const world = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'aseprite-denied-')))
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
process.env.HOME = world
delete process.env.MERCURY_HOME
delete process.env.MERCURY_ASEPRITE

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const FILES: Record<string, string> = {
  'secret/hero.aseprite': 'SECRET-LAYERS',
  'secret/colours.gpl': 'SECRET-PALETTE',
  'secret-public/hero.aseprite': 'PUBLIC-LAYERS',
  'secret.aseprite': 'SIBLING-LAYERS',
  'open/hero.aseprite': 'OPEN-LAYERS',
  'open/colours.gpl': 'OPEN-PALETTE',
}
const plant = (): void => {
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(project, path)), { recursive: true })
    writeFileSync(join(project, path), text)
  }
}
plant()
const runs = join(world, 'runs.jsonl')
const shim = join(world, 'aseprite')
writeFileSync(
  shim,
  `#!${process.execPath}
import fs from 'node:fs'
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('Aseprite 9.8.7-fake'); process.exit(0) }
fs.appendFileSync(${JSON.stringify(runs)}, JSON.stringify({ args }) + '\\n')
const sprite = args.find(arg => /\\.(aseprite|ase)$/i.test(arg) && !arg.startsWith('request='))
const seen = sprite && fs.existsSync(sprite) ? fs.readFileSync(sprite, 'utf8').trim() : ''
const request = args.find(arg => arg.startsWith('request='))?.slice(8)
if (request) {
  const data = JSON.parse(fs.readFileSync(request, 'utf8'))
  const palette = data.paletteFile ? fs.readFileSync(data.paletteFile, 'utf8').trim() : undefined
  if (data.save) fs.writeFileSync(data.save, 'DRAWN')
  if (data.render) fs.writeFileSync(data.render, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'))
  fs.writeFileSync(data.report, JSON.stringify({ op: data.op, applied: data.ops?.length, seen, ...(palette !== undefined ? { palette } : {}), ...(data.render ? { render: { width: 1, height: 1, frames: [0] } } : {}) }))
  process.exit(0)
}
console.log(JSON.stringify({ seen }))
`,
)
chmodSync(shim, 0o755)
process.env.MERCURY_ASEPRITE_BIN = shim
process.env.MERCURY_ASEPRITE_NO_DISCOVERY = '1'
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

const { AsepriteTool } = await import(`${SRC}/tools/AsepriteTool/AsepriteTool.ts`)
const { getEmptyToolPermissionContext } = await import(`${SRC}/Tool.ts`)
const { decideToolPermission } = await import(`${SRC}/utils/permissions/decision/engine.ts`)
const permissions = await import(`${SRC}/utils/permissions/filesystem.ts`)

type Permission = ReturnType<typeof getEmptyToolPermissionContext>
type Verdict = { behavior: string; message?: string; updatedInput?: unknown }
type Call = Record<string, unknown>
const context = (permission: Permission) => ({ abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: permission, tasks: {}, sessionHooks: new Map() }), setAppState: () => {}, readFileState: new Map(), messages: [], options: { tools: [] } }) as never
const withRules = (kind: 'alwaysDenyRules' | 'alwaysAllowRules' | 'alwaysAskRules', source: string, rules: string[], base: Permission = getEmptyToolPermissionContext()): Permission => ({ ...base, [kind]: { ...(base[kind] as Record<string, string[]>), [source]: rules } })
const deny = (rule: string, source = 'session'): Permission => withRules('alwaysDenyRules', source, [rule])
const inMode = (mode: string, permission: Permission): Permission => ({ ...permission, mode }) as Permission
const directRead = (file: string, permission: Permission): Verdict => permissions.checkReadPermissionForTool({ name: 'Read', getPath: () => file }, { file_path: file }, permission)
const started = (): number => (existsSync(runs) ? readFileSync(runs, 'utf8').split('\n').filter(Boolean).length : 0)
const verdict = async (input: Call, permission: Permission | null): Promise<Verdict> => (permission === null ? await (AsepriteTool as { checkPermissions: Function }).checkPermissions(input) : await (AsepriteTool as { checkPermissions: Function }).checkPermissions(input, context(permission))) as Verdict
const use = async (input: Call, permission: Permission): Promise<{ behavior: string; message: string; answer: string; starts: number }> => {
  writeFileSync(runs, '')
  const decision = (await decideToolPermission(AsepriteTool, input, context(permission))).decision as Verdict
  if (decision.behavior !== 'allow') return { behavior: decision.behavior, message: decision.message ?? '', answer: '', starts: started() }
  const ran = (await (AsepriteTool as { call: Function }).call(decision.updatedInput ?? input, context(permission))) as { data: { result: string } }
  return { behavior: 'allow', message: '', answer: ran.data.result, starts: started() }
}
const settle = (): void => permissions.getResolvedWorkingDirPaths.clearCache()

const SECRET = join(project, 'secret/hero.aseprite')
const PALETTE = join(project, 'secret/colours.gpl')
const stroke = { kind: 'pixel', layer: 'Body', frame: 0, colour: { index: 1 }, x: 0, y: 0 }
const READS: Array<[string, Call, string, string]> = [
  ['info', { op: 'info', file: 'secret/hero.aseprite' }, SECRET, 'SECRET-LAYERS'],
  ['render', { op: 'render', file: 'secret/hero.aseprite' }, SECRET, 'SECRET-LAYERS'],
  ['describe', { op: 'describe', file: 'secret/hero.aseprite' }, SECRET, 'SECRET-LAYERS'],
  ['palette-check', { op: 'palette-check', file: 'secret/hero.aseprite' }, SECRET, 'SECRET-LAYERS'],
  ['palette-check with its palette file', { op: 'palette-check', file: 'open/hero.aseprite', palette: 'secret/colours.gpl' }, PALETTE, 'SECRET-PALETTE'],
]
const ASKS: Array<[string, Call, string, string]> = [
  ['export', { op: 'export', file: 'secret/hero.aseprite', output: 'out/hero.png' }, SECRET, 'SECRET-LAYERS'],
  ['run-script', { op: 'run-script', file: 'secret/hero.aseprite', source: 'print(app.sprite.width)' }, SECRET, 'SECRET-LAYERS'],
  ['draw', { op: 'draw', file: 'secret/hero.aseprite', ops: [stroke] }, SECRET, 'SECRET-LAYERS'],
  ['parts', { op: 'parts', file: 'secret/hero.aseprite', ops: [{ kind: 'hide', part: 'Body' }] }, SECRET, 'SECRET-LAYERS'],
]
const CALLS = [...READS, ...ASKS]
const SPELLINGS: Array<[string, string]> = [
  ['relative', 'Read(secret/**)'],
  ['from the root', 'Read(/secret/**)'],
  ['absolute', `Read(//${project.replace(/^\/+/, '')}/secret/**)`],
  ['home', 'Read(~/project/secret/**)'],
]

console.log('the control: with no rule the free reads hand the file to Aseprite and answer from it, and the others ask')
{
  const open = getEmptyToolPermissionContext()
  const wrong: string[] = []
  for (const [label, input, , content] of READS) {
    const used = await use(input, open)
    if (used.behavior !== 'allow' || used.starts !== 1 || !used.answer.includes(content)) wrong.push(`${label}: ${used.behavior} ${used.answer.slice(0, 80)}`)
  }
  check('info, render, describe, palette-check and a palette file: each runs Aseprite once and answers from the file', wrong.length === 0, wrong.join(' | '))
  const asked: string[] = []
  for (const [, input] of ASKS) asked.push((await use(input, open)).behavior)
  check('export, run-script, draw and parts ask first', asked.every(behavior => behavior === 'ask'), asked.join(' '))
}

console.log('the law: a file whose direct Read is denied is not handed to Aseprite, on any operation')
const red: string[] = []
for (const [spelling, rule] of SPELLINGS) {
  plant()
  const permission = deny(rule)
  const cells: string[] = []
  for (const [label, input, target, content] of CALLS) {
    const used = await use(input, permission)
    const read = directRead(target, permission)
    const ok = used.behavior === 'deny' && read.behavior === 'deny' && used.message === read.message && used.starts === 0
    if (!ok) red.push(`${spelling} · ${label}: ${used.behavior}${used.answer.includes(content) ? ', answered from the file' : ''}`)
    cells.push(`${label} ${ok ? 'ok' : used.behavior === 'allow' ? 'OPENS IT' : used.behavior === 'ask' ? 'ASKS' : 'WRONG'}`)
  }
  check(`${spelling} ${rule.replace(project.replace(/^\/+/, ''), '<project>')}: ${cells.join(' · ')}`, cells.every(cell => cell.endsWith(' ok')), red.filter(cell => cell.startsWith(spelling)).join(' | '))
}
console.log(`  (${red.length} of ${SPELLINGS.length * CALLS.length} cells red)`)

console.log('the refusal is the rule\'s own sentence, the one a Read of the file gets')
{
  plant()
  const permission = deny('Read(secret/**)')
  const refused = await verdict({ op: 'info', file: 'secret/hero.aseprite' }, permission)
  check('it names the file by its full path and the rule that denies it', String(refused.message).startsWith(`Reading ${SECRET} is denied by the rule Read(secret/**) `) && refused.message === directRead(SECRET, permission).message, String(refused.message))
  const sovereign = inMode('sovereign', permission)
  const still: Array<Awaited<ReturnType<typeof use>>> = []
  for (const [, input] of CALLS) still.push(await use(input, sovereign))
  check('under the posture that answers every question the rule still refuses all nine, and Aseprite never runs', still.every(used => used.behavior === 'deny' && used.starts === 0) && readFileSync(SECRET, 'utf8') === 'SECRET-LAYERS', still.map(used => used.behavior).join(' '))
}

console.log('the neighbours are read as before')
{
  plant()
  const wrong: string[] = []
  for (const [, rule] of SPELLINGS) {
    for (const [file, content] of [['secret-public/hero.aseprite', 'PUBLIC-LAYERS'], ['secret.aseprite', 'SIBLING-LAYERS'], ['open/hero.aseprite', 'OPEN-LAYERS']] as Array<[string, string]>) {
      const used = await use({ op: 'info', file }, deny(rule))
      if (used.behavior !== 'allow' || !used.answer.includes(content)) wrong.push(`${rule} ${file}: ${used.behavior}`)
    }
    const palette = await use({ op: 'palette-check', file: 'open/hero.aseprite', palette: 'open/colours.gpl' }, deny(rule))
    if (palette.behavior !== 'allow' || !palette.answer.includes('OPEN-PALETTE')) wrong.push(`${rule} open/colours.gpl: ${palette.behavior}`)
  }
  check('a folder whose name starts the same, a file beside the folder, a file elsewhere and an open palette: answered under all four spellings', wrong.length === 0, wrong.join(' | '))
}

console.log('a link, .. and another letter case: the tool agrees with the direct Read')
{
  symlinkSync(SECRET, join(project, 'alias.aseprite'))
  symlinkSync(join(project, 'secret'), join(project, 'door'))
  settle()
  const permission = deny('Read(secret/**)')
  const spelled = ['alias.aseprite', 'door/hero.aseprite', 'open/../secret/hero.aseprite', ...(existsSync(join(project, 'SECRET', 'HERO.ASEPRITE')) ? ['SECRET/hero.aseprite'] : [])]
  const used: Array<Awaited<ReturnType<typeof use>>> = []
  for (const file of spelled) used.push(await use({ op: 'info', file }, permission))
  check(`${spelled.join(', ')}: a direct Read of each is denied and none is handed over`, used.every(one => one.behavior === 'deny' && one.starts === 0) && spelled.every(file => directRead(join(project, file), permission).behavior === 'deny'), used.map(one => one.behavior).join(' '))
}

console.log('one decision: the tool refuses a file exactly when a direct Read of it is denied')
{
  const contexts: Array<[string, Permission]> = [
    ['no rule', getEmptyToolPermissionContext()],
    ...SPELLINGS.map(([spelling, rule]) => [spelling, deny(rule)] as [string, Permission]),
    ['one file', deny('Read(secret/hero.aseprite)')],
    ['a name at any depth', deny('Read(hero.aseprite)')],
    ['a wildcard folder', deny('Read(*/hero.aseprite)')],
    ['a rule in the user settings', deny(SPELLINGS[2]![1], 'userSettings')],
    ['a Glob rule, which a Read obeys too', deny('Glob(secret/**)')],
    ['an ask rule', withRules('alwaysAskRules', 'session', ['Read(secret/**)'])],
    ['an allow rule beside a deny rule', withRules('alwaysAllowRules', 'session', ['Read(**)'], deny('Read(secret/**)'))],
    ['tools narrowed to one folder', withRules('alwaysAllowRules', 'toolsNarrowing', ['Read(open/**)'])],
  ]
  const sprites = ['secret/hero.aseprite', 'secret-public/hero.aseprite', 'secret.aseprite', 'open/hero.aseprite', 'alias.aseprite', 'door/hero.aseprite', 'nowhere/missing.aseprite']
  const apart: string[] = []
  for (const [label, permission] of contexts) {
    for (const file of sprites) {
      for (const input of [{ op: 'info', file }, { op: 'describe', file }, { op: 'export', file, output: 'out/x.png' }, { op: 'run-script', file, source: 'print(1)' }] as Call[]) {
        const refused = (await verdict(input, permission)).behavior === 'deny'
        if (refused !== (directRead(join(project, file), permission).behavior === 'deny')) apart.push(`${label} · ${String(input.op)} ${file}`)
      }
    }
  }
  check(`${contexts.length} sets of rules, ${sprites.length} files, four operations on each: it answers deny exactly when the direct Read does`, apart.length === 0, apart.join(' | '))
  rmSync(join(project, 'alias.aseprite'))
  rmSync(join(project, 'door'))
  settle()
}

console.log('status: a sprite file whose direct Read is denied is not named or counted')
{
  plant()
  const said = async (permission: Permission | null): Promise<string> => ((await (AsepriteTool as { call: Function }).call({ op: 'status' }, permission === null ? {} : context(permission))) as { data: { result: string } }).data.result.split('\n').at(-1)!
  const open = await said(getEmptyToolPermissionContext())
  check('the control: with no rule status counts four sprite files and names the denied folder\'s among them', open.startsWith('4 sprite file(s) in the working tree: ') && open.includes('secret/hero.aseprite'), open)
  const wrong: string[] = []
  for (const [spelling, rule] of SPELLINGS) {
    const line = await said(deny(rule))
    if (line !== '3 sprite file(s) in the working tree: open/hero.aseprite, secret-public/hero.aseprite, secret.aseprite') wrong.push(`${spelling}: ${line}`)
  }
  check('under each of the four spellings: three counted, the three neighbours named, the denied one not', wrong.length === 0, wrong.join(' | '))
  const asked = await said(withRules('alwaysAskRules', 'session', ['Read(secret/**)']))
  check('a file a Read would only ask about is named as before', asked === open, asked)
  const narrowed = await said(withRules('alwaysAllowRules', 'toolsNarrowing', ['Read(open/**)']))
  check('tools narrowed to one folder: only that folder\'s sprite is named, as a direct Read of the others is denied', narrowed === '1 sprite file(s) in the working tree: open/hero.aseprite', narrowed)
  check('a caller that hands the tool no session gets the listing it got', (await said(null)) === open, await said(null))
}

console.log('every other answer is the one the tool gave before')
{
  const inputs: Call[] = [
    { op: 'status' },
    { op: 'info', file: 'open/hero.aseprite' },
    { op: 'info' },
    { op: 'render', file: 'open/hero.aseprite' },
    { op: 'describe', file: 'open/hero.aseprite' },
    { op: 'palette-check', file: 'open/hero.aseprite', palette: 'open/colours.gpl' },
    { op: 'palette-check', file: 'open/hero.aseprite', palette: ['#ff0000'] },
    { op: 'export', file: 'open/hero.aseprite', output: 'out/hero.png' },
    { op: 'create', output: 'new.aseprite', width: 8, height: 8 },
    { op: 'run-script', source: 'print(1)' },
    { op: 'run-script', file: 'open/hero.aseprite', source: 'print(1)' },
    { op: 'draw', file: 'open/hero.aseprite', ops: [stroke] },
    { op: 'draw', file: 'open/hero.aseprite' },
    { op: 'info', file: 'secret/hero.aseprite' },
    { op: 'describe', file: 'secret/hero.aseprite' },
    { op: 'export', file: 'secret/hero.aseprite', output: 'out/hero.png' },
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
    for (const input of inputs) {
      const before = JSON.stringify(await verdict(input, null))
      if (JSON.stringify(await verdict(input, permission)) !== before) moved.push(`${label} · ${JSON.stringify(input)}`)
    }
  }
  check(`${contexts.length} sets of rules that deny no Read of the file, ${inputs.length} calls: the answer is byte for byte the one given with no rules at hand`, moved.length === 0, moved.join(' | '))
  const malformed = { op: 'draw', file: 'secret/hero.aseprite' }
  const [bare, ruled] = [await verdict(malformed, null), await verdict(malformed, deny('Read(secret/**)'))]
  check('a call the tool already refused for its shape is refused in the same words, whatever file it names', bare.behavior === 'deny' && JSON.stringify(ruled) === JSON.stringify(bare), JSON.stringify(ruled))
  const untouched = deny('Read(secret/**)')
  const [status, create] = [await verdict({ op: 'status' }, untouched), await verdict({ op: 'create', output: 'secret/new.aseprite', width: 8, height: 8 }, untouched)]
  check('status, which opens no file, is allowed, and create, which reads none, asks as before', status.behavior === 'allow' && create.behavior === 'ask' && JSON.stringify(create) === JSON.stringify(await verdict({ op: 'create', output: 'secret/new.aseprite', width: 8, height: 8 }, null)), `${status.behavior} ${create.behavior}`)
  plant()
  const asked = withRules('alwaysAskRules', 'session', ['Read(secret/**)'])
  const read = await use({ op: 'info', file: 'secret/hero.aseprite' }, asked)
  check('where a Read would only ask, the free read still answers with no question, as before', directRead(SECRET, asked).behavior === 'ask' && read.behavior === 'allow' && read.answer.includes('SECRET-LAYERS'), `${read.behavior} ${read.answer.slice(0, 80)}`)
  const none = await Promise.all([verdict({ op: 'info', file: 'secret/hero.aseprite' }, null), (AsepriteTool as { checkPermissions: Function }).checkPermissions({ op: 'info', file: 'secret/hero.aseprite' }, {})])
  check('a caller that hands the tool no session decides as before: a read is allowed', none.every(one => (one as Verdict).behavior === 'allow'), JSON.stringify(none))
}

rmSync(world, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-aseprite-denied-read: ${failures} of ${checks} FAILED`)
  process.exit(1)
}
console.log(`\nprove-aseprite-denied-read: all ${checks} green`)
