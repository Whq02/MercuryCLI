#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const launch = process.cwd()
const world = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'reference-read-')))
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
  'src/secret/keys.ts': 'export const token = "CONTENTS-OF-KEYS"\n',
  'src/secret/k%41.ts': 'export const token = "CONTENTS-OF-PERCENT"\n',
  'src/open.ts': 'export const token = "CONTENTS-OF-OPEN"\n',
  'src/.env': 'KEY=CONTENTS-OF-ENV\n',
}
for (const [path, text] of Object.entries(TREE)) {
  mkdirSync(dirname(join(project, path)), { recursive: true })
  writeFileSync(join(project, path), text)
}
mkdirSync(join(world, 'outside'), { recursive: true })
writeFileSync(join(world, 'outside/private.txt'), 'CONTENTS-OF-OUTSIDE\n')
writeFileSync(join(world, 'outside/victim.jsonl'), `${JSON.stringify({ type: 'assistant', uuid: 'a', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'CONTENTS-OF-TRANSCRIPT' }] } })}\n`)
writeFileSync(join(HOME, '.credentials.json'), '{"note":"CONTENTS-OF-CREDENTIALS"}\n', { mode: 0o600 })
const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: project, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
git('init', '-q')
git('add', '-A', '-f', '.')
git('commit', '-q', '-m', 'fixture')
for (const path of ['src/secret/keys.ts', 'src/open.ts']) appendFileSync(join(project, path), 'export const second = 2\n')
git('commit', '-q', '-a', '-m', 'second')
for (const path of ['src/secret/keys.ts', 'src/open.ts']) appendFileSync(join(project, path), 'export const third = 3\n')
writeFileSync(join(HOME, 'victim.json'), JSON.stringify({ schema: 1, spec: { name: 'victim', command: 'true' }, state: 'stopped', note: 'CONTENTS-OF-SERVICERECORD' }))
writeFileSync(join(HOME, 'victim.log'), 'CONTENTS-OF-SERVICELOG\n')
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
const { GitTool } = await import(`${SRC}/tools/GitTool/GitTool.ts`)
const { getEmptyToolPermissionContext } = await import(`${SRC}/Tool.ts`)
const { decideToolPermission } = await import(`${SRC}/utils/permissions/decision/engine.ts`)
const permissions = await import(`${SRC}/utils/permissions/filesystem.ts`)

type Permission = ReturnType<typeof getEmptyToolPermissionContext>
type Answer = { behavior: string; message: string; text: string }
type Door = [string, (path: string) => { tool: unknown; input: Record<string, unknown> } | null]
const context = (permission: Permission) =>
  ({ readFileState: new Map(), userModified: false, updateFileHistoryState: () => {}, dynamicSkillDirTriggers: new Set<string>(), nestedMemoryAttachmentTriggers: new Set<string>(), abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: permission, tasks: {}, sessionHooks: new Map() }), setAppState: () => {}, messages: [], options: { tools: [] } }) as never
const withRules = (kind: 'alwaysDenyRules' | 'alwaysAskRules', rules: string[], mode: string): Permission => ({ ...getEmptyToolPermissionContext(), mode, [kind]: { session: rules } }) as Permission
let serial = 0
const answer = async (tool: unknown, input: Record<string, unknown>, permission: Permission): Promise<Answer> => {
  const door = tool as { validateInput?: Function; call: Function }
  const valid = await door.validateInput?.(input, context(permission))
  if (valid && valid.result === false) return { behavior: 'deny', message: String(valid.message), text: '' }
  const decision = (await decideToolPermission(tool as never, input, context(permission))).decision as { behavior: string; message?: string; updatedInput?: unknown }
  if (decision.behavior !== 'allow') return { behavior: decision.behavior, message: decision.message ?? '', text: '' }
  serial++
  const text = await door.call(decision.updatedInput ?? input, context(permission), null, { uuid: `00000000-0000-0000-0000-${String(serial).padStart(12, '0')}`, message: { id: `msg_reference_${serial}` } }).then((ran: { data: unknown }) => JSON.stringify(ran.data), (error: unknown) => `THROWS ${String(error)}`)
  return { behavior: 'allow', message: '', text }
}
const inside = (path: string): string | null => (path.startsWith(`${project}/`) ? path.slice(project.length + 1) : null)
const read = (file_path: string) => ({ tool: FileReadTool, input: { file_path } })
const inspect = (ref: string) => ({ tool: InspectTool, input: { ref } })
const DOORS: Door[] = [
  ['Read, the absolute reference', path => read(`mercury://file/${path}`)],
  ['Read, the relative reference', path => (inside(path) === null ? null : read(`mercury://file/${inside(path)}`))],
  ['Read, the encoded reference', path => read(`mercury://file/${encodeURIComponent(path)}`)],
  ['Read, the reference with a line range', path => read(`mercury://file/${path}?lines=1-3`)],
  ['Read, the reference through ..', path => (inside(path) === null ? null : read(`mercury://file/${project}/src/../${inside(path)}`))],
  ['Read, git at HEAD', path => (inside(path) === null ? null : read(`mercury://git/at/HEAD/${inside(path)}`))],
  ['Read, git file', path => (inside(path) === null ? null : read(`mercury://git/file/${inside(path)}`))],
  ['Inspect, the absolute reference', path => inspect(`mercury://file/${path}`)],
  ['Inspect, the relative reference', path => (inside(path) === null ? null : inspect(`mercury://file/${inside(path)}`))],
  ['Inspect, the encoded reference', path => inspect(`mercury://file/${encodeURIComponent(path)}`)],
  ['Inspect, git at HEAD', path => (inside(path) === null ? null : inspect(`mercury://git/at/HEAD/${inside(path)}`))],
  ['Inspect, git file', path => (inside(path) === null ? null : inspect(`mercury://git/file/${inside(path)}`))],
  ['the Git tool, fileAtRef', path => (inside(path) === null ? null : { tool: GitTool, input: { op: 'fileAtRef', ref: 'HEAD', path: inside(path) } })],
]
const KEYS = join(project, 'src/secret/keys.ts')
const TARGETS: Array<[string, string, (mode: string) => Permission]> = [
  ['a deny rule, relative', KEYS, mode => withRules('alwaysDenyRules', ['Read(src/secret/**)'], mode)],
  ['a deny rule, from the root', KEYS, mode => withRules('alwaysDenyRules', ['Read(/src/secret/**)'], mode)],
  ['a deny rule, absolute', KEYS, mode => withRules('alwaysDenyRules', [`Read(//${project.replace(/^\/+/, '')}/src/secret/**)`], mode)],
  ['a deny rule on a file whose name holds a percent sequence', join(project, 'src/secret/k%41.ts'), mode => withRules('alwaysDenyRules', ['Read(src/secret/k%41.ts)'], mode)],
  ['a file outside the starting folder', join(world, 'outside/private.txt'), mode => withRules('alwaysDenyRules', [], mode)],
  ['an ask rule', KEYS, mode => withRules('alwaysAskRules', ['Read(src/secret/**)'], mode)],
  ['a .env file', join(project, 'src/.env'), mode => withRules('alwaysDenyRules', [], mode)],
  ['Mercury\'s own credential file', join(HOME, '.credentials.json'), mode => withRules('alwaysDenyRules', [], mode)],
  ['a denied folder', join(project, 'src/secret'), mode => withRules('alwaysDenyRules', ['Read(src/secret/**)'], mode)],
  ['an open file, no rule', join(project, 'src/open.ts'), mode => withRules('alwaysDenyRules', [], mode)],
]
const MODES = ['default', 'implement', 'sovereign']
const CONTENTS = /CONTENTS-OF-[A-Z]+/

console.log('the law: a path a direct Read denies or would ask about gets the same answer through every door')
const red: string[] = []
let cells = 0
for (const [label, path, rules] of TARGETS) {
  const rows: string[] = []
  const plain: string[] = []
  for (const mode of MODES) {
    const byPath = await answer(FileReadTool, { file_path: path }, rules(mode))
    plain.push(`${mode} ${byPath.behavior}`)
    for (const [door, through] of DOORS) {
      const call = through(path)
      if (call === null || (door.includes('git') && (label.startsWith('a denied folder') || label.includes('credential')))) continue
      cells++
      const got = await answer(call.tool, call.input, rules(mode))
      const leaked = byPath.behavior !== 'allow' && CONTENTS.test(got.text)
      if (got.behavior === byPath.behavior && !leaked) continue
      red.push(`${label} · ${mode} · ${door}`)
      rows.push(`${mode} ${door}: ${got.behavior}${leaked ? `, with ${CONTENTS.exec(got.text)![0]}` : ''}`)
    }
  }
  check(`${label} (Read by its path: ${plain.join(', ')}): every door answers as the path does`, rows.length === 0, rows.join(' | '))
}
console.log(`  (${red.length} of ${cells} cells red)`)

console.log('the refusal names the rule, and the doors still open what may be read')
{
  const denied = withRules('alwaysDenyRules', ['Read(src/secret/**)'], 'default')
  const byPath = await answer(FileReadTool, { file_path: KEYS }, denied)
  const byRef = await answer(FileReadTool, { file_path: `mercury://file/${KEYS}` }, denied)
  const byGit = await answer(InspectTool, { ref: 'mercury://git/at/HEAD/src/secret/keys.ts' }, denied)
  check('by its path, by its reference and by its git reference the refusal is the rule\'s own sentence', [byPath, byRef, byGit].every(one => one.behavior === 'deny' && one.message === `Reading ${KEYS} is denied by the rule Read(src/secret/**) from this session.`), [byPath, byRef, byGit].map(one => one.message).join(' | '))
  const open = withRules('alwaysDenyRules', ['Read(src/secret/**)'], 'default')
  const got = await Promise.all([read(`mercury://file/${join(project, 'src/open.ts')}`), read('mercury://file/src/open.ts'), read('mercury://git/at/HEAD/src/open.ts'), inspect(`mercury://file/${join(project, 'src/open.ts')}`), inspect('mercury://git/at/HEAD/src/open.ts')].map(call => answer(call.tool, call.input, open)))
  check('an open file beside the denied folder is read through five doors', got.every(one => one.behavior === 'allow' && one.text.includes('CONTENTS-OF-OPEN')), got.map(one => `${one.behavior} ${one.text.slice(0, 60)}`).join(' | '))
  const tree = await Promise.all([inspect('mercury://git/tree/HEAD/src/secret'), read('mercury://git/tree/HEAD/src/secret'), inspect('mercury://git/conflict/src/secret/keys.ts'), read('mercury://git/conflict/src/secret/keys.ts')].map(call => answer(call.tool, call.input, denied)))
  check('the denied folder\'s tree and a conflict named by the denied path are refused as the path is', tree.every(one => one.behavior === 'deny'), tree.map(one => one.behavior).join(' '))
  const records = await Promise.all([inspect('mercury://seat'), read('mercury://seat'), inspect('mercury://git/status'), read('mercury://git/status'), inspect('mercury://git/tree/HEAD'), read('mercury://run/current')].map(call => answer(call.tool, call.input, denied)))
  check('a reference that names no path, Mercury\'s own records, is allowed as before', records.every(one => one.behavior === 'allow'), records.map(one => one.behavior).join(' '))
}

console.log('the Git tool: a path it prints, lists or resolves is judged as that path, and its other answers are what they were')
{
  const denied = withRules('alwaysDenyRules', ['Read(src/secret/**)'], 'default')
  const gitAnswer = (input: Record<string, unknown>, permission: Permission): Promise<Answer> => answer(GitTool, input, permission)
  const file = await gitAnswer({ op: 'fileAtRef', ref: 'HEAD', path: 'src/secret/keys.ts' }, denied)
  check('fileAtRef of a denied file is refused in the rule\'s sentence and prints nothing', file.behavior === 'deny' && file.message === `Reading ${KEYS} is denied by the rule Read(src/secret/**) from this session.`, `${file.behavior} ${file.message} ${file.text.slice(0, 80)}`)
  const trees = [await gitAnswer({ op: 'tree', ref: 'HEAD', path: 'src/secret' }, denied), await gitAnswer({ op: 'tree', ref: 'HEAD', path: 'src' }, denied), await gitAnswer({ op: 'tree', ref: 'HEAD' }, denied)]
  check('tree of the denied folder is refused; of the folder above it and of the top it lists as before', trees[0]!.behavior === 'deny' && trees[1]!.behavior === 'allow' && trees[1]!.text.includes('open.ts') && trees[2]!.behavior === 'allow', trees.map(one => one.behavior).join(' '))
  const sovereign = withRules('alwaysDenyRules', ['Read(src/secret/**)'], 'sovereign')
  const resolved = [await gitAnswer({ op: 'resolve', path: 'src/secret/keys.ts', take: 'ours' }, denied), await gitAnswer({ op: 'resolve', path: 'src/secret/keys.ts', take: 'ours' }, sovereign), await gitAnswer({ op: 'resolve', path: 'src/open.ts', take: 'ours' }, denied)]
  check('resolve of a denied path is refused, under the posture that answers every question too; of an open path it asks in its own words as before', resolved[0]!.behavior === 'deny' && resolved[1]!.behavior === 'deny' && resolved[2]!.behavior === 'ask' && resolved[2]!.message === 'Git resolve conflict src/open.ts', resolved.map(one => `${one.behavior} ${one.message.slice(0, 60)}`).join(' | '))
  const asked = withRules('alwaysAskRules', ['Read(src/secret/**)'], 'default')
  const [askedFile, askedResolve, env] = [await gitAnswer({ op: 'fileAtRef', ref: 'HEAD', path: 'src/secret/keys.ts' }, asked), await gitAnswer({ op: 'resolve', path: 'src/secret/keys.ts', take: 'ours' }, asked), await gitAnswer({ op: 'fileAtRef', ref: 'HEAD', path: 'src/.env' }, withRules('alwaysDenyRules', [], 'default'))]
  check('a path a Read would ask about: fileAtRef asks as the Read does (an ask rule, a .env); resolve keeps its own question', askedFile.behavior === 'ask' && env.behavior === 'ask' && env.message.includes('.env') && askedResolve.behavior === 'ask' && askedResolve.message === 'Git resolve conflict src/secret/keys.ts', `${askedFile.behavior} · ${env.behavior} ${env.message.slice(0, 50)} · ${askedResolve.message}`)
  const open = [await gitAnswer({ op: 'fileAtRef', ref: 'HEAD', path: 'src/open.ts' }, denied), await gitAnswer({ op: 'status' }, denied), await gitAnswer({ op: 'diff' }, denied), await gitAnswer({ op: 'worktree' }, denied)]
  check('an open file is printed, and status, diff and worktree answer as before', open.every(one => one.behavior === 'allow') && open[0]!.text.includes('CONTENTS-OF-OPEN'), open.map(one => one.behavior).join(' '))
  const naming: Array<[string, Record<string, unknown>]> = [
    ['status', { op: 'status' }],
    ['diff', { op: 'diff' }],
    ['show', { op: 'show', sha: 'HEAD' }],
    ['compare', { op: 'compare', refA: 'HEAD~1', refB: 'HEAD' }],
    ['tree of the folder above', { op: 'tree', ref: 'HEAD', path: 'src' }],
  ]
  const wrong: string[] = []
  for (const [label, input] of naming) {
    const [bare, ruled] = [await gitAnswer(input, withRules('alwaysDenyRules', [], 'default')), await gitAnswer(input, denied)]
    const line = label.startsWith('tree') ? '1 entry withheld: a permission rule denies reading it' : '1 file withheld: a permission rule denies reading it'
    if (!(bare.text.includes('secret') && !bare.text.includes('withheld') && ruled.behavior === 'allow' && !ruled.text.includes('secret') && ruled.text.includes('open.ts') && ruled.text.includes(line))) wrong.push(`${label}: ${ruled.text.slice(0, 200)}`)
  }
  check('status, diff, show, compare and the tree of the folder above name the open file, leave the denied one out, and say in one line that one is withheld', wrong.length === 0, wrong.join(' | '))
  const treeRef = [await answer(InspectTool, { ref: 'mercury://git/tree/HEAD/src' }, denied), await answer(FileReadTool, { file_path: 'mercury://git/tree/HEAD/src' }, denied)]
  check('the tree reference of the folder above, through Inspect and through Read: the same', treeRef.every(one => one.behavior === 'allow' && !one.text.includes('secret') && one.text.includes('open.ts') && one.text.includes('1 entry withheld')), treeRef.map(one => one.text.slice(0, 160)).join(' | '))
}

console.log('one judge: Read and Inspect answer alike on every reference')
{
  const refs = (path: string): string[] => [`mercury://file/${path}`, `mercury://file/${encodeURIComponent(path)}`, `mercury://file/${path}?lines=1-2`, ...(inside(path) === null ? [] : [`mercury://file/${inside(path)}`, `mercury://git/at/HEAD/${inside(path)}`, `mercury://git/file/${inside(path)}`, `mercury://git/tree/HEAD/${dirname(inside(path)!)}`])]
  const apart: string[] = []
  let asked = 0
  for (const [label, path, rules] of TARGETS) {
    for (const mode of MODES) {
      for (const ref of refs(path)) {
        asked++
        const [byRead, byInspect] = [await answer(FileReadTool, { file_path: ref }, rules(mode)), await answer(InspectTool, { ref }, rules(mode))]
        if (byRead.behavior !== byInspect.behavior) apart.push(`${label} · ${mode} · ${ref.replace(world, '')}: Read ${byRead.behavior}, Inspect ${byInspect.behavior}`)
      }
    }
  }
  check(`${asked} references over the ten targets and three modes: the two tools give the same answer`, apart.length === 0, apart.join(' | '))
}

console.log('an id is a name, never a path')
{
  const open = withRules('alwaysDenyRules', [], 'default')
  const up = '../'.repeat(40)
  const far = (target: string): string => `${up}${target.replace(/^\/+/, '')}`
  const reaching = [`mercury://agent/x/${far(join(world, 'outside/victim'))}`, `mercury://agent/..`]
  const got: Answer[] = []
  for (const ref of reaching) for (const call of [inspect(ref), read(ref)]) got.push(await answer(call.tool, call.input, open))
  check('an agent id that holds .. or a separator answers "no such record" through both tools, and nothing from elsewhere is read', got.every(one => !CONTENTS.test(one.text) && (one.behavior !== 'allow' || /absent|ABSENT/.test(one.text))), got.map(one => `${one.behavior} ${CONTENTS.exec(one.text)?.[0] ?? ''}`).join(' | '))
  const service = [await answer(InspectTool, { ref: 'mercury://service/../../victim?child=logs' }, open), await answer(InspectTool, { ref: 'mercury://service/../../victim' }, open), await answer(InspectTool, { ref: 'mercury://service/no-such-service' }, open)]
  check('a service name that holds .. answers "no service" as an unknown name does, and reads no record or log elsewhere', service.every(one => !CONTENTS.test(one.text) && /no service|disabled/.test(one.text)), service.map(one => one.text.slice(0, 140)).join(' | '))
  const plainIds = await Promise.all([inspect('mercury://agent/a0123456789abcdef')].map(call => answer(call.tool, call.input, open)))
  check('an id of the shape the product mints is looked up as before', plainIds.every(one => one.behavior === 'allow' && /no crewmate|needs a live session/.test(one.text)), plainIds.map(one => one.text.slice(0, 120)).join(' | '))
}

console.log('with folder and reference targets switched off, Read is what it was')
{
  process.env.MERCURY_READ_TARGETS = '0'
  const denied = withRules('alwaysDenyRules', ['Read(src/secret/**)'], 'default')
  const input = { file_path: `mercury://file/${KEYS}` }
  const verdict = (await (FileReadTool as { checkPermissions: Function }).checkPermissions(input, context(denied))) as { behavior: string }
  const old = permissions.checkReadPermissionForTool(FileReadTool, input, denied) as { behavior: string }
  const ran = await answer(FileReadTool, input, denied)
  delete process.env.MERCURY_READ_TARGETS
  check('the reference is taken for a file name, judged as one, and no file of that name is found', JSON.stringify(verdict) === JSON.stringify(old) && !CONTENTS.test(ran.text) && (ran.behavior !== 'allow' || ran.text.includes('There is no file at that path')), `${verdict.behavior} ${ran.behavior} ${ran.text.slice(0, 100)}`)
}

rmSync(world, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-reference-read-one-judge: ${failures} of ${checks} FAILED`)
  process.exit(1)
}
console.log(`\nprove-reference-read-one-judge: all ${checks} green`)
