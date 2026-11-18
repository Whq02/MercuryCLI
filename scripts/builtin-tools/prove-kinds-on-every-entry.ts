#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readImports, staticPairs } from '../lib/importCycle.ts'

const ROOT = join(import.meta.dir, '..', '..')
const LAUNCHER = 'src/entrypoints/cli.tsx'
const RESOLVER = 'src/services/resources/registry.ts'
const TABLE = 'src/services/resources/kinds.ts'
const FOLDER = 'src/services/resources/adapters/'
const TOOL_LIST = 'src/tools.ts'
const OWNER = 'src/services/run/resolveOwner.ts'
const NO_KIND = 'zz-no-such-kind'
const NO_RECORD = 'zz-no-such-record'
const POOL = 6
const DOORS = ['resolveResource', 'resourceAdapterKinds', 'listResourceKind', 'getResourceAdapter'] as const
type Door = (typeof DOORS)[number]
const ALSO: Array<[string, string]> = [
  ['src/cli/run.ts', 'the headless runner'],
  ['src/entrypoints/mcp.ts', 'the MCP server'],
  ['src/services/crewBoard/implementation.ts', 'the crew board bundle'],
  ['src/entrypoints/shellParentGuard.ts', 'the shell parent guard bundle'],
  ['src/entrypoints/tensorfoldAdapter.ts', 'the TensorFold adapter bundle'],
  ['src/services/privateChannel/verifyArtifactStandalone.ts', 'the artifact verifier bundle'],
]

interface Answer {
  state: string
  note: string
}
interface Asked {
  first: Door
  answers: Record<string, Answer>
  control: Answer
  listed: string[]
  exported: Array<{ file: string; kind: string }>
}

if (process.argv[2] === '--child') {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const out = process.argv[3]!
  const first = process.argv[4] as Door
  const kinds = JSON.parse(process.argv[5]!) as string[] | null
  const scan = JSON.parse(process.argv[6]!) as string[]
  const load = process.argv.slice(7)
  for (const file of load) await import(join(ROOT, file))
  const registry = (await import(join(ROOT, RESOLVER))) as typeof import('../../src/services/resources/registry.ts')
  const { processMainOwner } = (await import(join(ROOT, OWNER))) as typeof import('../../src/services/run/resolveOwner.ts')
  const context = { owner: processMainOwner(), cwd: process.cwd() }
  const ask = async (kind: string): Promise<Answer> => {
    const answer = await registry.resolveResource(`mercury://${kind}/${NO_RECORD}`, context)
    return { state: answer.state, note: 'note' in answer && typeof answer.note === 'string' ? answer.note : '' }
  }
  const probe = kinds?.[0] ?? NO_KIND
  if (first === 'resourceAdapterKinds') registry.resourceAdapterKinds()
  else if (first === 'listResourceKind') await registry.listResourceKind(probe, context)
  else if (first === 'getResourceAdapter') registry.getResourceAdapter(probe)
  const answers: Record<string, Answer> = {}
  for (const kind of kinds ?? []) answers[kind] = await ask(kind)
  const control = await ask(NO_KIND)
  const listed = registry.resourceAdapterKinds().map(row => row.kind)
  const exported: Array<{ file: string; kind: string }> = []
  for (const file of scan) {
    const held = (await import(join(ROOT, file))) as Record<string, unknown>
    for (const value of Object.values(held)) {
      const shape = value as { kind?: unknown; resolve?: unknown } | null
      if (typeof shape === 'object' && shape !== null && typeof shape.kind === 'string' && typeof shape.resolve === 'function') exported.push({ file, kind: shape.kind })
    }
  }
  const asked: Asked = { first, answers, control, listed, exported }
  writeFileSync(out, JSON.stringify(asked))
  process.exit(0)
}

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail: string[] = []): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
  if (!cond) for (const line of detail) console.log(`         ${line}`)
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))

console.log('============================================================')
console.log(' A resource kind is known wherever the resolver can be asked')
console.log('============================================================')

const { files, known, edges } = readImports(ROOT)
const next = new Map<string, string[]>()
for (const [from, to] of staticPairs(edges)) next.set(from, [...(next.get(from) ?? []), to])
const reach = (entry: string): Set<string> => {
  const seen = new Set([entry])
  const queue = [entry]
  while (queue.length > 0) for (const to of next.get(queue.shift()!) ?? []) if (!seen.has(to)) queue.push((seen.add(to), to))
  return seen
}
const direct = (entry: string): string[] => [...new Set(edges.filter(edge => edge.from === entry && edge.kind === 'static' && edge.to !== entry).map(edge => edge.to))]
const loadedBy = (file: string): string => {
  const importers = edges.filter(edge => edge.to === file && edge.kind === 'static' && edge.from !== file)
  return importers.length === 0 ? `nothing imports ${file}` : `${file} is loaded by ${importers.map(edge => `${edge.from}:${edge.line}`).join(', ')}`
}

const scratch = mkdtempSync(join(tmpdir(), 'kinds-entries-'))
let serial = 0
async function run(first: Door, kinds: string[] | null, scan: string[], load: string[]): Promise<{ asked: Asked | null; why: string }> {
  const root = join(scratch, String(serial++))
  const home = join(root, 'home')
  const cwd = join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const out = join(root, 'asked.json')
  const child = spawn(process.execPath, [import.meta.path, '--child', out, first, JSON.stringify(kinds), JSON.stringify(scan), ...load], { cwd, env: { ...process.env, MERCURY_CONFIG_DIR: home }, stdio: ['ignore', 'pipe', 'pipe'] })
  let said = ''
  child.stdout.on('data', chunk => (said += String(chunk)))
  child.stderr.on('data', chunk => (said += String(chunk)))
  const deadline = setTimeout(() => child.kill('SIGKILL'), 240_000)
  const code = await new Promise<number | null>(resolve => child.on('close', resolve))
  clearTimeout(deadline)
  try {
    return { asked: JSON.parse(readFileSync(out, 'utf8')) as Asked, why: '' }
  } catch {
    return { asked: null, why: `the process wrote no answer (exit ${code}): ${said.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}` }
  }
}
async function pooled<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let at = 0
  await Promise.all(Array.from({ length: Math.min(POOL, items.length) }, async () => {
    while (at < items.length) {
      const mine = at++
      results[mine] = await work(items[mine]!)
    }
  }))
  return results
}

section(`(1) the kinds — what the resolver lists in a process that has loaded the tool list and every file of ${FOLDER}`)
const folder = files.filter(file => file.startsWith(FOLDER))
const fullest = await run('resolveResource', null, folder, [TOOL_LIST])
check('the fullest process answered', fullest.asked !== null, [fullest.why])
const kinds = [...(fullest.asked?.listed ?? [])].sort()
const fileOf = (kind: string): string => `${FOLDER}${kind}.ts`
{
  const homeless = kinds.filter(kind => !known.has(fileOf(kind)))
  check(`each of the ${kinds.length} kinds has the file of its name under ${FOLDER}: ${kinds.join(' ')}`, kinds.length > 0 && homeless.length === 0, homeless.map(kind => `the kind '${kind}' has no file ${fileOf(kind)}: name the adapter's file after its kind`))
  const unlisted = (fullest.asked?.exported ?? []).filter(entry => !kinds.includes(entry.kind))
  check(`every adapter a file of the folder exports is a kind the resolver lists (${fullest.asked?.exported.length ?? 0} exported)`, unlisted.length === 0, unlisted.map(entry => `${entry.file} exports the adapter of '${entry.kind}' and the resolver does not list it: add it to the list resourceKinds() returns in ${TABLE}`))
}

const roots = [...new Set(edges.filter(edge => edge.from === LAUNCHER && edge.kind === 'lazy').map(edge => edge.to))]
const lines = (file: string): string => edges.filter(edge => edge.from === LAUNCHER && edge.kind === 'lazy' && edge.to === file).map(edge => edge.line).join(', ')
const entries: Array<{ file: string; words: string }> = [
  { file: LAUNCHER, words: 'the launcher' },
  ...roots.map(file => ({ file, words: `${LAUNCHER}:${lines(file)}` })),
  ...ALSO.filter(([file]) => file !== LAUNCHER && !roots.includes(file)).map(([file, words]) => ({ file, words })),
]

section(`(2) the entries — ${LAUNCHER}, the ${roots.length} files it loads by import(), and ${ALSO.length} programs the build ships beside them: each in a fresh process that loads what the entry imports and starts nothing`)
{
  const nameless = entries.filter(entry => !known.has(entry.file))
  check(`every entry names a file under src/: ${entries.length} entries`, nameless.length === 0, nameless.map(entry => `${entry.file} (${entry.words}) names no file: correct its row in ALSO of scripts/builtin-tools/prove-kinds-on-every-entry.ts`))
}
const unknownIn = (asked: Asked): string[] => {
  const head = asked.control.note.split(NO_KIND)[0]!
  return kinds.filter(kind => {
    const answer = asked.answers[kind]
    return answer === undefined || (answer.state === asked.control.state && head !== '' && answer.note.startsWith(head + kind)) || !asked.listed.includes(kind)
  })
}
const remedy = (kind: string): string => `${loadedBy(fileOf(kind))}: put the adapter of '${kind}' in the list resourceKinds() returns in ${TABLE}, which the resolver reads when it is first asked, and take its registration out of the module that held it`
const listed = entries.filter(entry => known.has(entry.file))
const answered = await pooled(listed, entry => run('resolveResource', kinds, [], direct(entry.file)))
listed.forEach((entry, at) => {
  const { asked, why } = answered[at]!
  const own = reach(entry.file)
  const where = `${entry.file} (${entry.words}; its imports reach ${own.size} file(s), ${own.has(RESOLVER) ? 'the resolver among them' : 'the resolver loaded after them'}${own.has(TOOL_LIST) ? ', and the tool list' : ''})`
  if (asked === null) return check(`${where}: the resolver knows every kind`, false, [why])
  const unknown = unknownIn(asked)
  check(`${where}: the resolver knows each of the ${kinds.length} kinds`, kinds.length > 0 && unknown.length === 0, unknown.map(kind => `in a process that has loaded what ${entry.file} imports, mercury://${kind} is a kind the resolver does not know — ${remedy(kind)}`))
})

section(`(3) the doors — ${RESOLVER} loaded by itself, each of its ${DOORS.length} doors asked first in a fresh process`)
const alone = await pooled([...DOORS], door => run(door, kinds, [], []))
DOORS.forEach((door, at) => {
  const { asked, why } = alone[at]!
  if (asked === null) return check(`${door} asked first: the resolver knows every kind`, false, [why])
  const unknown = unknownIn(asked)
  check(`${door} asked first: the resolver knows each of the ${kinds.length} kinds`, kinds.length > 0 && unknown.length === 0, unknown.map(kind => `with ${RESOLVER} loaded by itself and ${door} asked first, mercury://${kind} is a kind the resolver does not know — ${remedy(kind)}`))
})

rmSync(scratch, { recursive: true, force: true })
console.log('')
console.log(failures === 0 ? `prove-kinds-on-every-entry: ALL HOLD — ${checks} checks` : `prove-kinds-on-every-entry: ${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
