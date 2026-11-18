#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const launch = process.cwd()
const world = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'git-hardening-kept-')))
process.on('exit', () => {
  try {
    process.chdir(launch)
    rmSync(world, { recursive: true, force: true })
  } catch {
  }
})
const HOME = join(world, 'home')
const project = join(world, 'project')
const ran = join(world, 'ran')
const programs = join(world, 'programs')
for (const folder of [join(HOME, 'tmp'), project, ran, programs]) mkdirSync(folder, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_TMPDIR = join(HOME, 'tmp')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_BARE = '1'
process.env.HOME = world
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_READ_TARGETS

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const installed = Bun.which('git') ?? 'git'
const plain = (folder: string, ...args: string[]): string => execFileSync(installed, ['-C', folder, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const quiet = (folder: string, ...args: string[]): string => plain(folder, '-c', 'core.fsmonitor=false', '-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', '-c', 'commit.gpgsign=false', ...args)
const program = (name: string, tail = ''): string => {
  const path = join(programs, name)
  writeFileSync(path, `#!/bin/sh\n: > "${join(ran, name)}"\n${tail}`, { mode: 0o755 })
  return path
}
const marks = (): string[] => readdirSync(ran).sort()
const forget = (): void => {
  for (const name of readdirSync(ran)) rmSync(join(ran, name))
}

quiet(project, 'init', '-q', '-b', 'main')
writeFileSync(join(project, 'a.txt'), 'one\n')
writeFileSync(join(project, 'b.conv'), 'one\n')
writeFileSync(join(project, '.gitattributes'), '*.conv diff=conv\n')
quiet(project, 'add', '--', 'a.txt', 'b.conv', '.gitattributes')
quiet(project, 'commit', '-q', '-m', 'one')
writeFileSync(join(project, 'a.txt'), 'two\n')
writeFileSync(join(project, 'b.conv'), 'two\n')
quiet(project, 'commit', '-q', '-a', '-m', 'two')
writeFileSync(join(project, 'a.txt'), 'three\n')
writeFileSync(join(project, 'b.conv'), 'three\n')
quiet(project, 'config', 'core.fsmonitor', program('monitor'))
quiet(project, 'config', 'diff.external', program('differ'))
quiet(project, 'config', 'diff.conv.textconv', program('converter', 'cat "$1"\n'))

const inner = join(project, 'vendor', 'inner')
mkdirSync(join(project, 'vendor'))
plain(world, 'init', '-q', '--bare', '-b', 'main', inner)
rmSync(join(inner, 'hooks'), { recursive: true, force: true })
quiet(inner, 'config', 'core.bare', 'false')
quiet(inner, 'config', 'core.worktree', '.')
writeFileSync(join(inner, 'data.txt'), 'one\n')
quiet(world, '--git-dir', inner, '--work-tree', inner, 'add', '--', 'data.txt')
quiet(world, '--git-dir', inner, '--work-tree', inner, 'commit', '-q', '-m', 'inner')
writeFileSync(join(inner, 'data.txt'), 'two\n')
quiet(inner, 'config', 'core.fsmonitor', program('monitor-inner'))

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

const { gitArgs } = (await import(`${SRC}/utils/git/spawnArgs.ts`)) as { gitArgs: (args: string[], cwd?: string) => string[] }
const { gitDiff } = (await import(`${SRC}/services/gitGraph/observe.ts`)) as { gitDiff: (root: string, options: { scope: string; ref?: string; paths?: string[] }) => unknown }
const { GitTool } = await import(`${SRC}/tools/GitTool/GitTool.ts`)
const { InspectTool } = await import(`${SRC}/tools/InspectTool/InspectTool.ts`)
const { FileReadTool } = await import(`${SRC}/tools/FileReadTool/FileReadTool.ts`)
const { getEmptyToolPermissionContext } = await import(`${SRC}/Tool.ts`)
const { decideToolPermission } = await import(`${SRC}/utils/permissions/decision/engine.ts`)

const context = () =>
  ({ readFileState: new Map(), userModified: false, updateFileHistoryState: () => {}, dynamicSkillDirTriggers: new Set<string>(), nestedMemoryAttachmentTriggers: new Set<string>(), abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), tasks: {}, sessionHooks: new Map() }), setAppState: () => {}, messages: [], options: { tools: [] } }) as never
let serial = 0
const used = async (tool: unknown, input: Record<string, unknown>): Promise<{ stage: string; text: string }> => {
  const door = tool as { validateInput?: Function; call: Function }
  const valid = await door.validateInput?.(input, context())
  if (valid && valid.result === false) return { stage: `refused: ${String(valid.message)}`, text: '' }
  const decision = (await decideToolPermission(tool as never, input, context())).decision as { behavior: string; updatedInput?: Record<string, unknown> }
  if (decision.behavior !== 'allow') return { stage: decision.behavior, text: '' }
  serial++
  const text = await door.call(decision.updatedInput ?? input, context(), null, { uuid: `00000000-0000-0000-0000-${String(serial).padStart(12, '0')}`, message: { id: `msg_hardening_${serial}` } }).then((result: { data: unknown }) => JSON.stringify(result.data), (error: unknown) => `THROWS ${String(error)}`)
  return { stage: 'ran', text }
}

const SETTING = 'core.fsmonitor=false'
const OWN = ['--no-pager', '-c', 'core.quotepath=false', '-c', SETTING, '-c', 'core.pager=cat']
const settled = (argv: string[]): boolean => OWN.every((word, at) => argv[at] === word)
const times = (argv: string[], word: string): number => argv.filter(candidate => candidate === word).length

console.log('the scene has teeth: git with none of the spawn layer\'s settings runs the programs the repository\'s config names')
{
  forget()
  plain(project, 'diff')
  const bare = marks()
  forget()
  plain(project, 'diff', '--no-ext-diff')
  const converted = marks()
  forget()
  plain(inner, 'diff')
  const within = marks()
  check('a plain diff runs the monitor and the external differ, without the differ the converter, and inside the carried repository its own monitor', bare.includes('monitor') && bare.includes('differ') && converted.includes('converter') && within.includes('monitor-inner'), `${bare.join(' ')} | ${converted.join(' ')} | ${within.join(' ')}`)
  forget()
}

console.log('the spawn layer: its own settings stay whatever a path, a revision or a folder is named')
{
  const KEPT: Array<[string, string[]]> = [
    ['a path named as the setting', ['diff', '--no-color', '--unified=3', '--', SETTING]],
    ['the same beside an honest path', ['diff', '--no-color', '--unified=3', '--', 'a.txt', SETTING]],
    ['a staged diff with that path', ['diff', '--no-color', '--unified=3', '--cached', '--', SETTING]],
    ['a revision named as the setting', ['show', '--no-color', '--format=', '--end-of-options', SETTING]],
    ['a revision named so with no marker before it', ['merge-base', SETTING, 'HEAD']],
    ['a folder named so after -C', ['-C', SETTING, 'status', '--porcelain']],
    ['a path named so after another global\'s value', ['-c', 'core.quotepath=off', 'ls-tree', '-l', 'HEAD', SETTING]],
  ]
  const lost = KEPT.filter(([, args]) => !settled(gitArgs(args))).map(([label]) => label)
  check(`${KEPT.length} argument lists that only name the setting: each still begins with the layer's own four settings`, lost.length === 0, lost.join(' | '))
  const FLAGGED: Array<[string, string[]]> = [
    ['paths named as the two flags', ['diff', '--no-color', '--', '--no-ext-diff', '--no-textconv']],
    ['the same beside an honest path', ['diff', '--no-color', '--', 'a.txt', '--no-ext-diff', '--no-textconv']],
    ['a revision named as a flag after the marker', ['show', '--format=', '--end-of-options', '--no-textconv']],
    ['a log with a path named as a flag', ['log', '-1', '--', '--no-ext-diff']],
  ]
  const bare = FLAGGED.filter(([, args]) => {
    const argv = gitArgs(args)
    const cut = argv.findIndex(word => word === '--' || word === '--end-of-options')
    return !(argv.slice(0, cut).includes('--no-ext-diff') && argv.slice(0, cut).includes('--no-textconv'))
  }).map(([label]) => label)
  check(`${FLAGGED.length} argument lists whose path or revision is named as a diff flag: both flags still stand among the command's options`, bare.length === 0, bare.join(' | '))
  const once = gitArgs(['-c', SETTING, 'status'])
  const flagged = gitArgs(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--', 'a.txt'])
  const HONEST = [['status', '--porcelain'], ['diff'], ['diff', '--cached', '--', 'a.txt'], ['show', '--format=', 'HEAD'], ['log', '-1'], ['rev-parse', 'HEAD']]
  const twice = HONEST.filter(args => JSON.stringify(gitArgs(gitArgs(args))) !== JSON.stringify(gitArgs(args))).map(args => args.join(' '))
  check('a caller that already set them is given nothing twice: the setting as a global\'s value, the flags among the options, and a list the layer already assembled', times(once, SETTING) === 1 && times(flagged, '--no-ext-diff') === 1 && times(flagged, '--no-textconv') === 1 && twice.length === 0, `${once.join(' ')} | ${flagged.join(' ')} | ${twice.join(' ; ')}`)
}

console.log('through the doors: a path or a reference named as the setting runs no program of the repository\'s config')
{
  const CALLS: Array<[string, unknown, Record<string, unknown>]> = [
    ['Git diff, paths [the setting]', GitTool, { op: 'diff', paths: [SETTING] }],
    ['Git diff, paths [a.txt, the setting]', GitTool, { op: 'diff', paths: ['a.txt', SETTING] }],
    ['Git diff staged, paths [the setting]', GitTool, { op: 'diff', scope: 'staged', paths: [SETTING] }],
    ['Inspect mercury://git/file/<the setting>', InspectTool, { ref: `mercury://git/file/${SETTING}` }],
    ['Read mercury://git/file/<the setting>', FileReadTool, { file_path: `mercury://git/file/${SETTING}` }],
    ['Git diff in the carried repository, paths [the setting]', GitTool, { op: 'diff', cwd: inner, paths: [SETTING] }],
    ['Git diff in the carried repository by a relative folder, paths [data.txt, the setting]', GitTool, { op: 'diff', cwd: 'vendor/inner', paths: ['data.txt', SETTING] }],
  ]
  const wrong: string[] = []
  for (const [label, tool, input] of CALLS) {
    forget()
    const got = await used(tool, input)
    if (marks().length > 0) wrong.push(`${label}: ${got.stage}, RAN ${marks().join(' ')}`)
  }
  check(`${CALLS.length} calls, each allowed with no question: no program runs`, wrong.length === 0, wrong.join(' | '))
  writeFileSync(join(inner, 'line.sh'), `: > "${join(ran, 'shell-line')}"\n`)
  quiet(inner, 'config', 'core.fsmonitor', 'sh ./line.sh')
  forget()
  const line = await used(GitTool, { op: 'diff', cwd: inner, paths: ['data.txt', SETTING] })
  check('nor does a line for the shell that a carried repository names, relative to its own folder', marks().length === 0 && line.stage === 'ran', `${line.stage} ${marks().join(' ')}`)
  forget()
  gitDiff(project, { scope: 'worktree', paths: ['a.txt', 'b.conv', '--no-ext-diff', '--no-textconv'] })
  check('under the tool, a diff whose paths are named as the two flags runs neither the differ nor the converter', marks().length === 0, marks().join(' '))
}

console.log('nothing an honest call does moves')
{
  const HONEST: Array<[string, unknown, Record<string, unknown>, RegExp]> = [
    ['status', GitTool, { op: 'status' }, /a\.txt/],
    ['diff', GitTool, { op: 'diff' }, /worktree: 2 file\(s\), 2 hunk\(s\).*a\.txt \+1 -1.*b\.conv \+1 -1/],
    ['diff of one path', GitTool, { op: 'diff', paths: ['a.txt'] }, /worktree: 1 file\(s\), 1 hunk\(s\).*a\.txt \+1 -1/],
    ['diff of what is staged', GitTool, { op: 'diff', scope: 'staged' }, /staged/],
    ['diff of a commit', GitTool, { op: 'diff', scope: 'commit', ref: 'HEAD' }, /commit HEAD: 2 file\(s\), 2 hunk\(s\)/],
    ['show', GitTool, { op: 'show', sha: 'HEAD' }, /two/],
    ['compare', GitTool, { op: 'compare', refA: 'HEAD~1', refB: 'HEAD' }, /a\.txt/],
    ['status in the carried repository', GitTool, { op: 'status', cwd: inner }, /data\.txt/],
    ['diff in the carried repository', GitTool, { op: 'diff', cwd: inner }, /worktree: 1 file\(s\), 1 hunk\(s\).*data\.txt \+1 -1/],
    ['the diff by reference', InspectTool, { ref: 'mercury://git/diff' }, /2 file\(s\) · 2 hunk\(s\)/],
    ['a file by reference', InspectTool, { ref: 'mercury://git/file/a.txt' }, /a\.txt/],
  ]
  const wrong: string[] = []
  for (const [label, tool, input, expected] of HONEST) {
    forget()
    const got = await used(tool, input)
    if (got.stage !== 'ran' || !expected.test(got.text) || marks().length > 0) wrong.push(`${label}: ${got.stage} ${marks().join(' ')} ${got.text.slice(0, 400)}`)
  }
  check(`${HONEST.length} honest calls: each runs, answers, and runs no program`, wrong.length === 0, wrong.join(' | '))
  const LISTS: Array<[string[], string[]]> = [
    [['status', '--porcelain'], [...OWN, 'status', '--porcelain']],
    [['diff'], [...OWN, 'diff', '--no-ext-diff', '--no-textconv']],
    [['diff', '--cached', '--', 'a.txt'], [...OWN, 'diff', '--no-ext-diff', '--no-textconv', '--cached', '--', 'a.txt']],
    [['show', '--format=', 'HEAD'], [...OWN, 'show', '--no-ext-diff', '--no-textconv', '--format=', 'HEAD']],
    [['log', '-1'], [...OWN, 'log', '--no-ext-diff', '--no-textconv', '-1']],
    [['rev-parse', 'HEAD'], [...OWN, 'rev-parse', 'HEAD']],
    [['diff', '--no-textconv', '--stat'], [...OWN, 'diff', '--no-ext-diff', '--no-textconv', '--stat']],
  ]
  const moved = LISTS.filter(([args, expected]) => JSON.stringify(gitArgs(args)) !== JSON.stringify(expected)).map(([args]) => `${args.join(' ')} → ${gitArgs(args).join(' ')}`)
  check(`${LISTS.length} honest argument lists are assembled word for word as before`, moved.length === 0, moved.join(' | '))
}

rmSync(world, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-git-hardening-kept: ${failures} of ${checks} FAILED`)
  process.exit(1)
}
console.log(`\nprove-git-hardening-kept: all ${checks} green`)
