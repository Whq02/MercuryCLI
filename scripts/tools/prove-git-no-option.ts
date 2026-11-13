#!/usr/bin/env bun
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const launch = process.cwd()
const world = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'git-no-option-')))
process.on('exit', () => {
  try {
    process.chdir(launch)
    rmSync(world, { recursive: true, force: true })
  } catch {
  }
})
const HOME = join(world, 'home')
const project = join(world, 'project')
const scratch = join(world, 'written')
mkdirSync(join(HOME, 'tmp'), { recursive: true })
mkdirSync(join(project, 'src'), { recursive: true })
mkdirSync(scratch, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_TMPDIR = join(HOME, 'tmp')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_BARE = '1'
process.env.HOME = world
delete process.env.MERCURY_HOME
delete process.env.MERCURY_READ_TARGETS

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: project, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
git('init', '-q', '-b', 'main')
writeFileSync(join(project, 'src/f.ts'), 'export const one = 1\n')
git('add', '-A', '.')
git('commit', '-q', '-m', 'one')
git('tag', 'v1')
for (const branch of ['topic', 'feat/x', 'rel-1.2', 'ünï']) git('branch', branch)
writeFileSync(join(project, 'src/f.ts'), 'export const one = 1\nexport const two = 2\n')
git('commit', '-q', '-a', '-m', 'two')
const head = git('rev-parse', 'HEAD').trim()
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

const { GitTool } = await import(`${SRC}/tools/GitTool/GitTool.ts`)
const { InspectTool } = await import(`${SRC}/tools/InspectTool/InspectTool.ts`)
const { FileReadTool } = await import(`${SRC}/tools/FileReadTool/FileReadTool.ts`)
const { getEmptyToolPermissionContext } = await import(`${SRC}/Tool.ts`)
const { decideToolPermission } = await import(`${SRC}/utils/permissions/decision/engine.ts`)
const observe = (await import(`${SRC}/services/gitGraph/observe.ts`)) as { forgetGitVersion?: () => void }

const context = () =>
  ({ readFileState: new Map(), userModified: false, updateFileHistoryState: () => {}, dynamicSkillDirTriggers: new Set<string>(), nestedMemoryAttachmentTriggers: new Set<string>(), abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), tasks: {}, sessionHooks: new Map() }), setAppState: () => {}, messages: [], options: { tools: [] } }) as never
let serial = 0
const run = async (tool: unknown, input: Record<string, unknown>): Promise<string> => {
  serial++
  return (tool as { call: Function }).call(input, context(), null, { uuid: `00000000-0000-0000-0000-${String(serial).padStart(12, '0')}`, message: { id: `msg_git_${serial}` } }).then((ran: { data: unknown }) => JSON.stringify(ran.data), (error: unknown) => `THROWS ${String(error)}`)
}
const used = async (tool: unknown, input: Record<string, unknown>): Promise<{ stage: string; message: string; text: string }> => {
  const valid = await (tool as { validateInput?: Function }).validateInput?.(input, context())
  if (valid && valid.result === false) return { stage: 'validation', message: String(valid.message), text: '' }
  const decision = (await decideToolPermission(tool as never, input, context())).decision as { behavior: string; message?: string; updatedInput?: Record<string, unknown> }
  if (decision.behavior !== 'allow') return { stage: decision.behavior, message: decision.message ?? '', text: '' }
  return { stage: 'ran', message: '', text: await run(tool, decision.updatedInput ?? input) }
}
const written = (): string[] => readdirSync(scratch)
let target = 0
const next = (): string => join(scratch, `w${++target}`)

const FIELDS: Array<[string, string, (value: string) => Record<string, unknown>]> = [
  ['show', 'sha', value => ({ op: 'show', sha: value })],
  ['diff of a commit', 'ref', value => ({ op: 'diff', scope: 'commit', ref: value })],
  ['diff of a range', 'ref', value => ({ op: 'diff', scope: 'range', ref: `${value}..HEAD` })],
  ['compare', 'refA', value => ({ op: 'compare', refA: value, refB: 'HEAD' })],
  ['compare', 'refB', value => ({ op: 'compare', refA: 'HEAD', refB: value })],
  ['mergebase', 'refA', value => ({ op: 'mergebase', refA: value, refB: 'HEAD' })],
  ['mergebase', 'refB', value => ({ op: 'mergebase', refA: 'HEAD', refB: value })],
  ['fileAtRef', 'ref', value => ({ op: 'fileAtRef', ref: value, path: 'src/f.ts' })],
  ['fileAtRef', 'path', value => ({ op: 'fileAtRef', ref: 'HEAD', path: value })],
  ['tree', 'ref', value => ({ op: 'tree', ref: value })],
  ['tree', 'path', value => ({ op: 'tree', ref: 'HEAD', path: value })],
  ['diff', 'paths', value => ({ op: 'diff', paths: [value] })],
  ['stage', 'files', value => ({ op: 'stage', files: [value] })],
  ['restore', 'files', value => ({ op: 'restore', files: [value] })],
  ['resolve', 'path', value => ({ op: 'resolve', path: value, take: 'ours' })],
]
const OPTIONS = (file: string): string[] => [`--output=${file}`, `  --output=${file}`, '--no-index', '--ext-diff', '--textconv', `-O${file}`, '-p']

const optionRevisions = async (): Promise<string[]> => {
  const wrong: string[] = []
  for (const [op, field, input] of FIELDS.slice(0, 11)) {
    const file = next()
    const text = await run(GitTool, input(`--output=${file}`))
    if (existsSync(file)) wrong.push(`${op} ${field} WROTE a file`)
    else if (/"outcome":"no-change"/.test(text) && !/needs|failed|no commit|does not|cannot|no merge base/.test(text)) wrong.push(`${op} ${field}: ${text.slice(0, 90)}`)
  }
  return wrong
}
const optionReferences = async (): Promise<string[]> => {
  const wrong: string[] = []
  const forms: Array<[string, (file: string) => string]> = [
    ['commit', file => `mercury://git/commit/--output=${file}`],
    ['at', file => `mercury://git/at/--output=${file}/src/f.ts`],
    ['tree', file => `mercury://git/tree/--output=${file}`],
    ['compare', file => `mercury://git/compare/--output=${file}...HEAD`],
    ['compare head', file => `mercury://git/compare/HEAD...--output=${file}`],
  ]
  for (const [form, ref] of forms) {
    for (const [door, tool, input] of [['Inspect', InspectTool, (text: string) => ({ ref: text })], ['Read', FileReadTool, (text: string) => ({ file_path: text })]] as Array<[string, unknown, (text: string) => Record<string, unknown>]>) {
      const file = next()
      await used(tool, input(ref(file)))
      if (existsSync(file)) wrong.push(`${door} git/${form} WROTE a file`)
    }
  }
  return wrong
}
const HONEST: Array<[string, Record<string, unknown>, RegExp]> = [
  ['a full sha', { op: 'show', sha: head }, /two/],
  ['a short sha', { op: 'show', sha: head.slice(0, 8) }, /two/],
  ['HEAD~1', { op: 'show', sha: 'HEAD~1' }, /one/],
  ['a tag', { op: 'show', sha: 'v1' }, /one/],
  ['a branch', { op: 'show', sha: 'topic' }, /one/],
  ['a branch with a slash', { op: 'fileAtRef', ref: 'feat/x', path: 'src/f.ts' }, /export const one/],
  ['a branch with a dot and a hyphen inside', { op: 'tree', ref: 'rel-1.2' }, /src/],
  ['a branch with letters outside ASCII', { op: 'show', sha: 'ünï' }, /one/],
  ['a range', { op: 'diff', scope: 'range', ref: 'HEAD~1..HEAD' }, /src\/f\.ts/],
  ['a commit\'s diff', { op: 'diff', scope: 'commit', ref: 'HEAD' }, /src\/f\.ts/],
  ['compare', { op: 'compare', refA: 'topic', refB: 'main' }, /1 ahead/],
  ['mergebase', { op: 'mergebase', refA: 'topic', refB: 'main' }, /[0-9a-f]{12}/],
  ['a path limit', { op: 'diff', scope: 'range', ref: 'HEAD~1..HEAD', paths: ['src/f.ts'] }, /src\/f\.ts/],
  ['the upstream spelling, which names none here', { op: 'show', sha: '@{upstream}' }, /no commit/],
]
const honestCalls = async (): Promise<string[]> => {
  const wrong: string[] = []
  for (const [label, input, expected] of HONEST) {
    const got = await used(GitTool, input)
    if (got.stage !== 'ran' || !expected.test(got.text)) wrong.push(`${label}: ${got.stage} ${got.message} ${got.text.slice(0, 110)}`)
  }
  return wrong
}
const HONEST_REFERENCES = [`mercury://git/commit/${head}`, 'mercury://git/at/feat/x/src/f.ts', 'mercury://git/tree/v1', 'mercury://git/compare/topic...main']
const honestReferences = async (): Promise<string[]> => {
  const wrong: string[] = []
  for (const ref of HONEST_REFERENCES) {
    const got = await used(InspectTool, { ref })
    if (got.stage !== 'ran' || !/"state":"ok"/.test(got.text)) wrong.push(`${ref.slice(14)}: ${got.stage} ${got.text.slice(0, 70)}`)
  }
  return wrong
}

console.log('the Git tool\'s input: a field that would reach git and begins with a dash is refused, and names itself')
{
  const wrong: string[] = []
  let asked = 0
  for (const [op, field, input] of FIELDS) {
    for (const option of OPTIONS(next())) {
      asked++
      const got = await used(GitTool, input(option))
      if (got.stage !== 'validation' || got.message !== `${field} may not begin with a dash`) wrong.push(`${op} ${field} ${option.slice(0, 12)}: ${got.stage} ${got.message.slice(0, 50)}`)
    }
  }
  check(`${FIELDS.length} fields, seven options each (${asked} calls): each is refused before any question, in one sentence that names the field`, wrong.length === 0, wrong.slice(0, 6).join(' | '))
  check('and no file was written by any of them', written().length === 0, written().join(' '))
}

console.log('under the tool: a revision that reads as an option never reaches git as one')
{
  const before = written().length
  const wrong = await optionRevisions()
  check('the same eleven revisions and paths handed to the tool\'s call with no validation: no file appears, and each is answered as a revision that is not there', wrong.length === 0 && written().length === before, wrong.join(' | '))
}

console.log('by reference: a git reference whose revision reads as an option writes nothing, through Inspect and through Read')
{
  const before = written().length
  const wrong = await optionReferences()
  check('five forms through two doors: no file appears', wrong.length === 0 && written().length === before, wrong.join(' | '))
}

console.log('nothing an honest revision does moves')
{
  const wrong = await honestCalls()
  check(`${HONEST.length} honest calls: each runs and answers as it did`, wrong.length === 0, wrong.join(' | '))
  const refs = await honestReferences()
  check('and four honest git references resolve', refs.length === 0, refs.join(' | '))
}

console.log('whichever git is installed: the marker that ends the options goes only where that git reads it, and the refusal does not rest on it')
{
  const STAND_IN = `#!/bin/sh
here=$(dirname "$0")
real=$(cat "$here/real")
version=$(cat "$here/version" 2>/dev/null)
[ -z "$version" ] && exec "$real" "$@"
command=""
marker=0
skip=""
for word in "$@"; do
  if [ -n "$skip" ]; then skip=""; continue; fi
  if [ -z "$command" ]; then
    case "$word" in
      --version) echo "git version $version"; exit 0 ;;
      -c|-C) skip=1 ;;
      -*) ;;
      *) command="$word" ;;
    esac
    continue
  fi
  [ "$word" = "--" ] && break
  [ "$word" = "--end-of-options" ] && marker=1
done
major=\${version%%.*}
rest=\${version#*.}
minor=\${rest%%.*}
least=24
[ "$command" = "rev-parse" ] && least=30
if [ "$marker" = 1 ] && { [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt "$least" ]; }; }; then
  printf '%s\\trefused\\n' "$command" >> "$here/log"
  echo "fatal: unrecognized argument: --end-of-options" >&2
  exit 129
fi
printf '%s\\t%s\\n' "$command" "$marker" >> "$here/log"
exec "$real" "$@"
`
  const real = Bun.which('git') ?? 'git'
  const numbers = (version: string): [number, number] => [Number(version.split('.')[0]), Number(version.split('.')[1])]
  const reads = (version: string, least: number): boolean => numbers(version)[0] > 2 || (numbers(version)[0] === 2 && numbers(version)[1] >= least)
  const installed = /\d+\.\d+(?:\.\d+)?/.exec(execFileSync(real, ['--version'], { encoding: 'utf8' }))?.[0] ?? '0.0'
  const standIn = join(world, 'stand-in')
  mkdirSync(standIn)
  writeFileSync(join(standIn, 'real'), real)
  writeFileSync(join(standIn, 'git'), STAND_IN, { mode: 0o755 })
  const path = process.env.PATH ?? ''
  process.env.PATH = `${standIn}${delimiter}${path}`
  const WALKERS = ['show', 'diff', 'merge-base', 'ls-tree', 'rev-list', 'log']
  const versions = [...new Set(['2.17.1', '2.25.1', installed])].filter(version => numbers(version)[0] < numbers(installed)[0] || (numbers(version)[0] === numbers(installed)[0] && numbers(version)[1] <= numbers(installed)[1]))
  console.log(`  (the installed git is ${installed}; a stand-in named git answers --version as told, refuses the marker where that version does not read it, and otherwise runs the installed one)`)
  for (const version of versions) {
    writeFileSync(join(standIn, 'version'), version)
    writeFileSync(join(standIn, 'log'), '')
    observe.forgetGitVersion?.()
    const before = written().length
    const moved = [...(await honestCalls()), ...(await honestReferences())]
    check(`git ${version}: the ${HONEST.length} honest calls and the four honest references answer as they do on the installed git`, moved.length === 0, moved.slice(0, 5).join(' | '))
    const wrote = [...(await optionRevisions()), ...(await optionReferences())]
    check(`git ${version}: the option revisions write no file, through the tool's call with no validation and through the two doors`, wrote.length === 0 && written().length === before, wrote.join(' | '))
    const spawns = readFileSync(join(standIn, 'log'), 'utf8').split('\n').filter(Boolean).map(line => line.split('\t') as [string, string])
    const marked = spawns.filter(([, marker]) => marker === '1').map(([command]) => command)
    const refused = spawns.filter(([, marker]) => marker === 'refused').map(([command]) => command)
    const walkers = marked.filter(command => WALKERS.includes(command)).length
    const parses = marked.filter(command => command === 'rev-parse').length
    const others = marked.filter(command => !WALKERS.includes(command) && command !== 'rev-parse')
    const table = spawns.length > 0 && refused.length === 0 && others.length === 0 && (reads(version, 24) ? walkers > 0 : walkers === 0) && (reads(version, 30) ? parses > 0 : parses === 0)
    const where = reads(version, 30) ? 'show, diff, log, merge-base, the walkers and rev-parse' : reads(version, 24) ? 'show, diff, log, merge-base and the walkers, and not rev-parse' : 'no spawn'
    check(`git ${version}: the marker rides ${where}, and no spawn is handed a marker its git does not read`, table, `${spawns.length} spawns through the stand-in · marked: ${walkers} walkers, ${parses} rev-parse, others ${others.join(' ') || 'none'} · refused: ${[...new Set(refused)].join(' ') || 'none'}`)
  }
  process.env.PATH = path
  observe.forgetGitVersion?.()
}

rmSync(world, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-git-no-option: ${failures} of ${checks} FAILED`)
  process.exit(1)
}
console.log(`\nprove-git-no-option: all ${checks} green`)
