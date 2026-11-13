#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const launch = process.cwd()
const world = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'rule-braces-')))
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
process.env.MERCURY_GREP_RANKED = '1'
process.env.HOME = world
delete process.env.MERCURY_HOME
delete process.env.MERCURY_READ_TARGETS

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const TREE: Record<string, string> = {
  'src/secret/keys.ts': 'export const token = "needle in the first folder"\n',
  'src/vault/keys.ts': 'export const token = "needle in the second folder"\n',
  'src/{x,y}/keys.ts': 'export const token = "needle in a folder named with braces"\n',
  'src/secret.ts': 'export const token = "needle in a neighbour file"\n',
  'src/open.ts': 'export const token = "needle in an open file"\n',
}
for (const [path, text] of Object.entries(TREE)) {
  mkdirSync(dirname(join(project, path)), { recursive: true })
  writeFileSync(join(project, path), text)
}
for (const folder of ['a', 'b', 'c']) {
  mkdirSync(join(world, 'outside', folder), { recursive: true })
  writeFileSync(join(world, 'outside', folder, 'x.txt'), 'outside\n')
}
const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: project, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
git('init', '-q')
git('add', '-A', '.')
git('commit', '-q', '-m', 'fixture')
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
const { GrepTool } = await import(`${SRC}/tools/GrepTool/GrepTool.ts`)
const { GlobTool } = await import(`${SRC}/tools/GlobTool/GlobTool.ts`)
const { getEmptyToolPermissionContext } = await import(`${SRC}/Tool.ts`)
const { decideToolPermission } = await import(`${SRC}/utils/permissions/decision/engine.ts`)
const permissions = await import(`${SRC}/utils/permissions/filesystem.ts`)
const braces = (await import(`${SRC}/utils/permissions/ruleBraces.ts`).catch(() => ({}))) as { expandRuleBraces?: (pattern: string, wide?: boolean) => string[]; RULE_BRACE_BOUND?: number }
const { validatePermissionRule } = await import(`${SRC}/utils/settings/permissionValidation.ts`)
const { filterInvalidPermissionRules } = await import(`${SRC}/utils/settings/validation.ts`)

type Permission = ReturnType<typeof getEmptyToolPermissionContext>
type Kind = 'alwaysDenyRules' | 'alwaysAllowRules' | 'alwaysAskRules'
const context = (permission: Permission) =>
  ({ readFileState: new Map(), userModified: false, updateFileHistoryState: () => {}, dynamicSkillDirTriggers: new Set<string>(), nestedMemoryAttachmentTriggers: new Set<string>(), abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: permission, tasks: {}, sessionHooks: new Map() }), setAppState: () => {}, messages: [], options: { tools: [] } }) as never
const withRules = (kind: Kind, rules: string[]): Permission => ({ ...getEmptyToolPermissionContext(), [kind]: { session: rules } }) as Permission
const reads = (file: string, permission: Permission): { behavior: string; message?: string } => permissions.checkReadPermissionForTool({ name: 'Read', getPath: () => file }, { file_path: file }, permission)
const writes = (file: string, permission: Permission): string => permissions.checkWritePermissionForTool({ name: 'Edit', getPath: () => file }, { file_path: file }, permission).behavior
const here = project.replace(/^\/+/, '')
const FIRST = join(project, 'src/secret/keys.ts')
const SECOND = join(project, 'src/vault/keys.ts')
const OPEN = join(project, 'src/open.ts')
const outside = (folder: string): string => join(world, 'outside', folder, 'x.txt')

console.log('the grammar: the shell\'s alternatives and no wider')
{
  const expand = braces.expandRuleBraces
  check('a rule\'s pattern is expanded by one function', typeof expand === 'function')
  const cases: Array<[string, string, string[]]> = [
    ['a list in one pair', 'src/{secret,vault}/**', ['src/secret/**', 'src/vault/**']],
    ['a pair inside a pair', 'src/{a,{b,c}}/x', ['src/a/x', 'src/b/x', 'src/c/x']],
    ['two pairs', '{a,b}/{c,d}', ['a/c', 'a/d', 'b/c', 'b/d']],
    ['an empty alternative', 'x{,y}', ['x', 'xy']],
    ['a pair with no comma stays as written', 'src/{a}/x', ['src/{a}/x']],
    ['a pair with no comma around a list', 'src/{a{b,c}}', ['src/{ab}', 'src/{ac}']],
    ['a brace never closed stays as written', 'src/{a,b', ['src/{a,b']],
    ['a brace never opened stays as written', 'src/a,b}', ['src/a,b}']],
    ['an escaped pair stays as written', 'src/\\{a,b\\}', ['src/\\{a,b\\}']],
    ['a brace inside a class stays as written', 'src/[{]a,b[}]', ['src/[{]a,b[}]']],
    ['a range is not a list', 'f{1..3}', ['f{1..3}']],
    ['no brace: the pattern itself', 'src/secret/**', ['src/secret/**']],
  ]
  const wrong = typeof expand === 'function' ? cases.filter(([, pattern, expected]) => JSON.stringify(expand(pattern)) !== JSON.stringify(expected)).map(([label, pattern]) => `${label}: ${JSON.stringify(expand(pattern))}`) : ['no function']
  check(`${cases.length} patterns: each becomes exactly its alternatives`, wrong.length === 0, wrong.join(' | '))
  const eight = Array.from({ length: 8 }, (_, index) => `{a${index},b${index}}`).join('/')
  const nine = `${eight}/{a8,b8}`
  check('the bound: 256 alternatives are taken; a pattern that would make more stays as written for an allow rule', typeof expand === 'function' && expand(eight).length === 256 && braces.RULE_BRACE_BOUND === 256 && JSON.stringify(expand(nine)) === JSON.stringify([nine]), typeof expand === 'function' ? `${expand(eight).length} ${expand(nine).length}` : '')
  check('past the bound a deny or ask rule is read with each pair as a star, and a pair that holds a slash as a star over all that follows', typeof expand === 'function' && JSON.stringify(expand(nine, true)) === JSON.stringify([Array.from({ length: 9 }, () => '*').join('/')]) && JSON.stringify(expand(`src/{a/b,c}/${nine}`, true)) === JSON.stringify(['src/*']), typeof expand === 'function' ? JSON.stringify(expand(nine, true)) : '')
}

console.log('every kind of rule that takes a path: its alternatives are all in force')
{
  const kinds: Array<[string, boolean, string]> = [
    ['a Read deny rule denies a Read of both folders and of no other', reads(FIRST, withRules('alwaysDenyRules', ['Read(src/{secret,vault}/**)'])).behavior === 'deny' && reads(SECOND, withRules('alwaysDenyRules', ['Read(src/{secret,vault}/**)'])).behavior === 'deny' && reads(OPEN, withRules('alwaysDenyRules', ['Read(src/{secret,vault}/**)'])).behavior === 'allow', ''],
    ['a Read ask rule asks about both', reads(FIRST, withRules('alwaysAskRules', ['Read(src/{secret,vault}/**)'])).behavior === 'ask' && reads(SECOND, withRules('alwaysAskRules', ['Read(src/{secret,vault}/**)'])).behavior === 'ask' && reads(OPEN, withRules('alwaysAskRules', ['Read(src/{secret,vault}/**)'])).behavior === 'allow', ''],
    ['a Read allow rule allows both of two folders outside the starting folder, and still asks about a third', reads(outside('a'), withRules('alwaysAllowRules', [`Read(//${world.replace(/^\/+/, '')}/outside/{a,b}/**)`])).behavior === 'allow' && reads(outside('b'), withRules('alwaysAllowRules', [`Read(//${world.replace(/^\/+/, '')}/outside/{a,b}/**)`])).behavior === 'allow' && reads(outside('c'), withRules('alwaysAllowRules', [`Read(//${world.replace(/^\/+/, '')}/outside/{a,b}/**)`])).behavior === 'ask', ''],
    ['an Edit deny rule denies a write to both', writes(FIRST, withRules('alwaysDenyRules', ['Edit(src/{secret,vault}/**)'])) === 'deny' && writes(SECOND, withRules('alwaysDenyRules', ['Edit(src/{secret,vault}/**)'])) === 'deny' && writes(OPEN, withRules('alwaysDenyRules', ['Edit(src/{secret,vault}/**)'])) !== 'deny', ''],
    ['a Write deny rule the same', writes(FIRST, withRules('alwaysDenyRules', ['Write(src/{secret,vault}/**)'])) === 'deny' && writes(SECOND, withRules('alwaysDenyRules', ['Write(src/{secret,vault}/**)'])) === 'deny', ''],
    ['an Edit allow rule allows a write to both of two folders outside, and not to a third', writes(outside('a'), withRules('alwaysAllowRules', [`Edit(//${world.replace(/^\/+/, '')}/outside/{a,b}/**)`])) === 'allow' && writes(outside('b'), withRules('alwaysAllowRules', [`Edit(//${world.replace(/^\/+/, '')}/outside/{a,b}/**)`])) === 'allow' && writes(outside('c'), withRules('alwaysAllowRules', [`Edit(//${world.replace(/^\/+/, '')}/outside/{a,b}/**)`])) !== 'allow', ''],
  ]
  for (const [label, ok] of kinds) check(label, ok)
  const refused = reads(FIRST, withRules('alwaysDenyRules', ['Read(src/{secret,vault}/**)']))
  check('the refusal names the rule as it was written', refused.message === `Reading ${FIRST} is denied by the rule Read(src/{secret,vault}/**) from this session.`, String(refused.message))
  const literal = withRules('alwaysDenyRules', ['Read(src/\\{x,y\\}/**)'])
  check('an escaped pair denies the folder whose name holds the braces, and neither alternative', reads(join(project, 'src/{x,y}/keys.ts'), literal).behavior === 'deny' && reads(FIRST, literal).behavior === 'allow')
}

console.log('through every door: the rule hides and denies both folders, and the neighbours stay')
const red: string[] = []
let cells = 0
{
  let serial = 0
  const said = (tool: { mapToolResultToToolResultBlockParam: Function }, data: unknown): string => String(tool.mapToolResultToToolResultBlockParam(data as never, 'id').content)
  const decided = async (tool: unknown, input: Record<string, unknown>, permission: Permission): Promise<string> => {
    const door = tool as { validateInput?: Function }
    const valid = await door.validateInput?.(input, context(permission))
    if (valid && valid.result === false) return 'deny'
    return ((await decideToolPermission(tool as never, input, context(permission))).decision as { behavior: string }).behavior
  }
  const searches: Array<[string, (permission: Permission) => Promise<string>]> = [
    ['Grep content', async permission => said(GrepTool, (await GrepTool.call({ pattern: 'needle', output_mode: 'content' } as never, context(permission))).data)],
    ['Grep files', async permission => said(GrepTool, (await GrepTool.call({ pattern: 'needle', output_mode: 'files_with_matches', path: 'src' } as never, context(permission))).data)],
    ['Grep count', async permission => said(GrepTool, (await GrepTool.call({ pattern: 'needle', output_mode: 'count' } as never, context(permission))).data)],
    ['Grep ranked', async permission => said(GrepTool, (await GrepTool.call({ pattern: 'token needle', output_mode: 'ranked' } as never, context(permission))).data)],
    ['Glob', async permission => said(GlobTool, (await GlobTool.call({ pattern: '**/*.ts', path: 'src' } as never, context(permission))).data)],
    ['Read of the folder above', async permission => {
      serial++
      const listing = String((await (FileReadTool as { call: Function }).call({ file_path: 'src' }, context(permission), null, { uuid: `00000000-0000-0000-0000-${String(serial).padStart(12, '0')}`, message: { id: `msg_braces_${serial}` } })).data.file.content)
      return listing.split('\n').map(line => (line.endsWith('/') ? `${line}keys.ts` : line)).join('\n')
    }],
  ]
  const judged: Array<[string, (file: string) => { tool: unknown; input: Record<string, unknown> }]> = [
    ['Read by its path', file => ({ tool: FileReadTool, input: { file_path: file } })],
    ['Read by its reference', file => ({ tool: FileReadTool, input: { file_path: `mercury://file/${file}` } })],
    ['Inspect', file => ({ tool: InspectTool, input: { ref: `mercury://file/${file}` } })],
    ['Read by its git reference', file => ({ tool: FileReadTool, input: { file_path: `mercury://git/at/HEAD/${file.slice(project.length + 1)}` } })],
    ['the Git tool', file => ({ tool: GitTool, input: { op: 'fileAtRef', ref: 'HEAD', path: file.slice(project.length + 1) } })],
  ]
  const SPELLINGS: Array<[string, string]> = [
    ['relative', 'Read(src/{secret,vault}/**)'],
    ['from the root', 'Read(/src/{secret,vault}/**)'],
    ['absolute', `Read(//${here}/src/{secret,vault}/**)`],
    ['home', 'Read(~/project/src/{secret,vault}/**)'],
  ]
  for (const [spelling, rule] of SPELLINGS) {
    const permission = withRules('alwaysDenyRules', [rule])
    const rows: string[] = []
    for (const [door, run] of searches) {
      cells++
      const answer = await run(permission).catch((error: unknown) => `the search failed: ${String(error)}`)
      const ok = !answer.includes('secret/keys.ts') && !answer.includes('vault/keys.ts') && answer.includes('open.ts') && answer.includes('secret.ts')
      if (!ok) {
        red.push(`${spelling} · ${door}`)
        rows.push(`${door} ${answer.startsWith('the search failed') ? 'FAILS' : answer.includes('secret/keys.ts') || answer.includes('vault/keys.ts') ? 'SHOWS' : 'LOSES'}`)
      }
    }
    for (const [door, through] of judged) {
      cells++
      const [first, second, open] = [await decided(through(FIRST).tool, through(FIRST).input, permission), await decided(through(SECOND).tool, through(SECOND).input, permission), await decided(through(OPEN).tool, through(OPEN).input, permission)]
      if (first === 'deny' && second === 'deny' && open === 'allow') continue
      red.push(`${spelling} · ${door}`)
      rows.push(`${door} ${first} ${second} ${open}`)
    }
    check(`${spelling} ${rule.replace(here, '<project>')}: six searches and listings hide both folders, five doors refuse both files, and the open file is found and read`, rows.length === 0, rows.join(' · '))
  }
}
console.log(`  (${red.length} of ${cells} cells red)`)

console.log('validation never removes protection: a deny or ask rule the matcher can read stays in force, an allow rule in doubt allows nothing')
{
  const { settingsFaultLine } = await import(`${SRC}/utils/settings/validation.ts`)
  const wide = Array.from({ length: 9 }, (_, index) => `{a${index},b${index}}`).join('/')
  const nine = `Read(src/${wide})`
  const set = ['Read(src/secret/**)', 'Read(src/sec*ret/keys.ts)', nine, 'Read(unclosed', 'read(src/x)']
  type Fault = { message: string; severity?: string; kept?: true; path: string }
  const loaded = (key: 'deny' | 'ask' | 'allow'): { rules: string[]; faults: Fault[] } => {
    const data = { guardrails: { [key]: [...set] } }
    const faults = filterInvalidPermissionRules(data, 'settings.json') as Fault[]
    return { rules: (data.guardrails as Record<string, string[]>)[key]!, faults }
  }
  const [denied, asked, allowed] = [loaded('deny'), loaded('ask'), loaded('allow')]
  const inForce = JSON.stringify(['Read(src/secret/**)', 'Read(src/sec*ret/keys.ts)', nine])
  check('deny: the plain rule, the one with a star inside a name and the one past the bound stay in force; the two nothing can read are skipped', JSON.stringify(denied.rules) === inForce, JSON.stringify(denied.rules))
  check('ask: the same three stay in force', JSON.stringify(asked.rules) === inForce, JSON.stringify(asked.rules))
  check('allow: only the plain rule is in force, as before', JSON.stringify(allowed.rules) === JSON.stringify(['Read(src/secret/**)']), JSON.stringify(allowed.rules))
  const said = (faults: Fault[]): string => faults.map(fault => `${fault.severity}${fault.kept ? '+kept' : ''}`).join(' ')
  check('deny and ask: two warnings for the rules kept and two errors for the rules skipped; allow: four warnings', said(denied.faults) === 'warning+kept warning+kept error error' && said(asked.faults) === said(denied.faults) && said(allowed.faults) === 'warning warning warning warning', `${said(denied.faults)} | ${said(allowed.faults)}`)
  check('a kept rule\'s line is the validator\'s own advice, and says the rule stays in force', settingsFaultLine({ file: 'settings.json', ...denied.faults[0]! }) === 'settings: settings.json · guardrails.deny · Permission rule "Read(src/sec*ret/keys.ts)": The wildcard placement in "src/sec*ret/keys.ts" may be wrong. Wildcards belong at path boundaries — the rule stays in force; the rest of the file applies', settingsFaultLine({ file: 'settings.json', ...denied.faults[0]! }))
  check('a rule past the bound says how it is read', denied.faults[1]!.message === `Permission rule "${nine}": The braces in "src/${wide}" expand to more than 256 patterns: read as src/${Array.from({ length: 9 }, () => '*').join('/')}`, denied.faults[1]!.message)
  check('a rule nothing can read is skipped in the sentence it had, as an error that says it is not in force', denied.faults[2]!.message.startsWith('Skipped invalid permission rule "Read(unclosed": Rule "Read(unclosed" has mismatched parentheses') && settingsFaultLine({ file: 'settings.json', ...denied.faults[2]! }).endsWith(' — this rule is not in force until it is corrected; the rest of the file applies'), settingsFaultLine({ file: 'settings.json', ...denied.faults[2]! }))
  check('an allow rule in doubt is skipped in the words it had', allowed.faults[0]!.message === 'Skipped invalid permission rule "Read(src/sec*ret/keys.ts)": The wildcard placement in "src/sec*ret/keys.ts" may be wrong. Wildcards belong at path boundaries' && allowed.faults[1]!.message.startsWith(`Skipped invalid permission rule "${nine}": The braces in `) && settingsFaultLine({ file: 'settings.json', ...allowed.faults[0]! }).endsWith(' — this value is skipped; the rest of the file applies'), allowed.faults.map(fault => fault.message.slice(0, 90)).join(' | '))
  const inSession = withRules('alwaysDenyRules', denied.rules)
  mkdirSync(join(project, 'src/a0/a1/a2/a3/a4/a5/a6/a7'), { recursive: true })
  writeFileSync(join(project, 'src/a0/a1/a2/a3/a4/a5/a6/a7/a8'), 'x')
  check('with the deny rules that stayed in force: the file under the star inside a name is refused, and so is a path the rule past the bound was written for', reads(FIRST, withRules('alwaysDenyRules', ['Read(src/sec*ret/keys.ts)'])).behavior === 'deny' && reads(join(project, 'src/a0/a1/a2/a3/a4/a5/a6/a7/a8'), withRules('alwaysDenyRules', [nine])).behavior === 'deny' && reads(OPEN, inSession).behavior === 'allow', `${reads(FIRST, withRules('alwaysDenyRules', ['Read(src/sec*ret/keys.ts)'])).behavior} ${reads(join(project, 'src/a0/a1/a2/a3/a4/a5/a6/a7/a8'), withRules('alwaysDenyRules', [nine])).behavior}`)
  check('an allow rule past the bound allows nothing it did not allow before', reads(outside('a'), withRules('alwaysAllowRules', [`Read(//${world.replace(/^\/+/, '')}/outside/${wide})`])).behavior === 'ask')
  const verdict = validatePermissionRule(nine) as { valid: boolean; error?: string }
  check('the validator says of a rule past the bound why it is in doubt', verdict.valid === false && String(verdict.error).includes('expand to more than 256 patterns'), JSON.stringify(verdict))
  const judgedAsBefore = [validatePermissionRule('Read(src/**)'), validatePermissionRule('Read(src/sec*ret)'), validatePermissionRule('Read(*.ts)'), validatePermissionRule('Bash(git *)')] as Array<{ valid: boolean }>
  check('a rule with no brace is judged by the validator as it was', JSON.stringify(judgedAsBefore.map(one => one.valid)) === '[true,false,true,true]', JSON.stringify(judgedAsBefore))
  const alternatives = [validatePermissionRule('Read(src/{*.ts,*.md})'), validatePermissionRule('Read(src/{a*b,c})')] as Array<{ valid: boolean }>
  check('a wildcard is judged in each alternative: one that begins a name in its alternative is accepted, one inside a name is refused as before', alternatives[0]!.valid === true && alternatives[1]!.valid === false, JSON.stringify(alternatives))
}

rmSync(world, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-rule-braces: ${failures} of ${checks} FAILED`)
  process.exit(1)
}
console.log(`\nprove-rule-braces: all ${checks} green`)
