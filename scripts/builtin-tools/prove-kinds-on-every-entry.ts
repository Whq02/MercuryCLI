#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readImports, staticPairs } from '../lib/importCycle.ts'

const ROOT = join(import.meta.dir, '..', '..')
const SELF = 'scripts/builtin-tools/prove-kinds-on-every-entry.ts'
const LAUNCHER = 'src/entrypoints/cli.tsx'
const RESOLVER = 'src/services/resources/registry.ts'
const TABLE = 'src/services/resources/kinds.ts'
const FOLDER = 'src/services/resources/adapters/'
const TOOL_LIST = 'src/tools.ts'
const OWNER = 'src/services/run/resolveOwner.ts'
const NO_KIND = 'zz-no-such-kind'
const NO_RECORD = 'zz-no-such-record'
const POOL = 6
const HELD_TURNS = 12
const DOORS = ['resolveResource', 'resourceAdapterKinds', 'listResourceKind'] as const
type Door = (typeof DOORS)[number]
const ALSO: Array<[string, string]> = [
  ['src/cli/run.ts', 'the headless runner'],
  ['src/entrypoints/mcp.ts', 'the MCP server'],
  ['src/services/crewBoard/implementation.ts', 'the crew board bundle'],
  ['src/entrypoints/shellParentGuard.ts', 'the shell parent guard bundle'],
  ['src/entrypoints/tensorfoldAdapter.ts', 'the TensorFold adapter bundle'],
  ['src/services/privateChannel/verifyArtifactStandalone.ts', 'the artifact verifier bundle'],
]
const ROWS: Array<[string, string, string]> = [
  ['resource-plane-fast', 'src/utils/health/sections/coding-loop-fast.ts', 'codingLoopFastChecks'],
  ['primitive-resources', 'src/utils/health/sections/architecture-fast.ts', 'architectureFastChecks'],
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
interface Held {
  reached: number
  stood: boolean
  settled: string
  listed: Array<string[] | string>
  resolved: Array<Answer | string>
  children: string[]
  rows: Array<{ id: string; found: boolean; said: { status: string; evidence: string } | string }>
  control: Answer | string
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
  if (first === 'resourceAdapterKinds') await registry.resourceAdapterKinds()
  else if (first === 'listResourceKind') await registry.listResourceKind(probe, context)
  const answers: Record<string, Answer> = {}
  for (const kind of kinds ?? []) answers[kind] = await ask(kind)
  const control = await ask(NO_KIND)
  const listed = (await registry.resourceAdapterKinds()).map(row => row.kind)
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

if (process.argv[2] === '--held') {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const out = process.argv[3]!
  const kinds = JSON.parse(process.argv[4]!) as string[]
  const { plugin } = await import('bun')
  const gate = { open: (): void => {}, reached: 0, settled: '' }
  const letGo = new Promise<void>(resolve => (gate.open = resolve))
  plugin({
    name: 'the table held',
    setup(build) {
      build.onLoad({ filter: new RegExp(`/${TABLE.split('.').join('\\.')}$`) }, async args => {
        gate.reached++
        await letGo
        plugin.clearAll()
        return { exports: { ...((await import(`${args.path}?let-go`)) as Record<string, unknown>) }, loader: 'object' }
      })
    },
  })
  const threw = (error: unknown): string => `threw: ${error instanceof Error ? error.message : String(error)}`.split(ROOT).join('')
  const registry = (await import(join(ROOT, RESOLVER))) as typeof import('../../src/services/resources/registry.ts')
  const { processMainOwner } = (await import(join(ROOT, OWNER))) as typeof import('../../src/services/run/resolveOwner.ts')
  const context = { owner: processMainOwner(), cwd: process.cwd() }
  type Row = { id: string; run: (args: { signal: AbortSignal }) => unknown }
  const specs: Array<{ id: string; run: Row['run'] | undefined }> = []
  for (const [id, file, maker] of ROWS) {
    const made = ((await import(join(ROOT, file))) as Record<string, (() => Row[]) | undefined>)[maker]?.() ?? []
    specs.push({ id, run: made.find(row => row.id === id)?.run })
  }
  const flight = import(join(ROOT, TOOL_LIST)).then(() => (gate.settled = 'loaded'), error => (gate.settled = threw(error)))
  const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
  for (let waited = 0; waited < 5000 && gate.reached === 0 && gate.settled === ''; waited++) await turn()
  const ask = (kind: string): Promise<Answer | string> =>
    (async (): Promise<Answer> => {
      const answer = await registry.resolveResource(`mercury://${kind}/${NO_RECORD}`, context)
      return { state: answer.state, note: 'note' in answer && typeof answer.note === 'string' ? answer.note : '' }
    })().catch(threw)
  const rows = specs.map(spec => ({
    id: spec.id,
    found: spec.run !== undefined,
    said: (async (): Promise<{ status: string; evidence: string }> => {
      const result = (await spec.run!({ signal: new AbortController().signal })) as { status: string; evidence: string }
      return { status: result.status, evidence: result.evidence }
    })().catch(threw),
  }))
  const listed: Array<Promise<string[] | string>> = []
  const resolved: Array<Promise<Answer | string>> = []
  const children: Array<Promise<string>> = []
  for (let at = 0; at < HELD_TURNS; at++) {
    const kind = kinds[at % kinds.length]!
    listed.push((async (): Promise<string[]> => (await registry.resourceAdapterKinds()).map(row => row.kind))().catch(threw))
    resolved.push(ask(kind))
    children.push((async (): Promise<string> => (await registry.listResourceKind(kind, context)).state)().catch(threw))
    await turn()
  }
  const stood = gate.reached > 0 && gate.settled === ''
  gate.open()
  await flight
  const held: Held = {
    reached: gate.reached,
    stood,
    settled: gate.settled,
    listed: await Promise.all(listed),
    resolved: await Promise.all(resolved),
    children: await Promise.all(children),
    rows: await Promise.all(rows.map(async row => ({ id: row.id, found: row.found, said: await row.said }))),
    control: await ask(NO_KIND),
  }
  writeFileSync(out, JSON.stringify(held))
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
async function spawned<T>(mode: string, words: string[]): Promise<{ result: T | null; why: string }> {
  const root = join(scratch, String(serial++))
  const home = join(root, 'home')
  const cwd = join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const out = join(root, 'asked.json')
  const child = spawn(process.execPath, [import.meta.path, mode, out, ...words], { cwd, env: { ...process.env, MERCURY_CONFIG_DIR: home }, stdio: ['ignore', 'pipe', 'pipe'] })
  let said = ''
  child.stdout.on('data', chunk => (said += String(chunk)))
  child.stderr.on('data', chunk => (said += String(chunk)))
  const deadline = setTimeout(() => child.kill('SIGKILL'), 240_000)
  const code = await new Promise<number | null>(resolve => child.on('close', resolve))
  clearTimeout(deadline)
  try {
    return { result: JSON.parse(readFileSync(out, 'utf8')) as T, why: '' }
  } catch {
    return { result: null, why: `the process wrote no answer (exit ${code}): ${said.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}` }
  }
}
async function run(first: Door, kinds: string[] | null, scan: string[], load: string[]): Promise<{ asked: Asked | null; why: string }> {
  const { result, why } = await spawned<Asked>('--child', [first, JSON.stringify(kinds), JSON.stringify(scan), ...load])
  return { asked: result, why }
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
  check(`every entry names a file under src/: ${entries.length} entries`, nameless.length === 0, nameless.map(entry => `${entry.file} (${entry.words}) names no file: correct its row in ALSO of ${SELF}`))
}
const unknownTo = (control: Answer, answer: Answer | undefined, kind: string): boolean => {
  const head = control.note.split(NO_KIND)[0]!
  return answer === undefined || (answer.state === control.state && head !== '' && answer.note.startsWith(head + kind))
}
const unknownIn = (asked: Asked): string[] => kinds.filter(kind => unknownTo(asked.control, asked.answers[kind], kind) || !asked.listed.includes(kind))
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

section(`(4) an import in flight — ${TABLE} held as a module still being fetched inside an import() of ${TOOL_LIST}, and every door of the resolver asked at each of ${HELD_TURNS} turns of the loop before the module is let go (bun cannot require() a module in that state; from the bundle there is no such state)`)
{
  const awaited = await spawned<Held>('--held', [JSON.stringify(kinds)])
  const held = awaited.result
  check(
    `the import of ${TOOL_LIST} asked for ${TABLE} and was still in flight after the ${HELD_TURNS} turns`,
    held !== null && held.stood,
    [held === null ? awaited.why : `the module was asked for ${held.reached} time(s) and the import ${held.settled === '' ? 'did not settle' : `had settled (${held.settled})`}: this section held nothing — it stands on ${TOOL_LIST} importing ${TABLE} and on the plugin in the --held arm of ${SELF}, which keeps that module's fetch open`],
  )
  if (held !== null) {
    const short = held.listed.flatMap((entry, at) => (typeof entry === 'string' ? [`turn ${at + 1}: ${entry}`] : kinds.every(kind => entry.includes(kind)) ? [] : [`turn ${at + 1}: ${entry.length} kinds listed, not ${kinds.length}`]))
    const doorway = `every door of ${RESOLVER} awaits adapters(), which awaits import() of ${TABLE}: an import() waits for a module that is still being fetched, and a require() of it throws under bun`
    check(`resourceAdapterKinds asked at each turn: every ask lists the ${kinds.length} kinds`, held.listed.length === HELD_TURNS && short.length === 0, [...short, doorway])
    const control = held.control
    const lost = held.resolved.flatMap((answer, at) => {
      const kind = kinds[at % kinds.length]!
      return typeof answer === 'string' ? [`turn ${at + 1}, mercury://${kind}: ${answer}`] : typeof control !== 'string' && unknownTo(control, answer, kind) ? [`turn ${at + 1}: mercury://${kind} is a kind the resolver does not know`] : []
    })
    check(`resolveResource asked at each turn: it answers, and knows the kind`, held.resolved.length === HELD_TURNS && typeof control !== 'string' && lost.length === 0, [
      ...lost,
      ...(typeof control === 'string' ? [`after the import settled, mercury://${NO_KIND}: ${control}`] : []),
      doorway,
    ])
    const mute = held.children.flatMap((state, at) => (state.startsWith('threw: ') ? [`turn ${at + 1}, ${kinds[at % kinds.length]}: ${state}`] : []))
    check(`listResourceKind asked at each turn: it answers`, held.children.length === HELD_TURNS && mute.length === 0, [...mute, doorway])
    for (const [id, file] of ROWS) {
      const row = held.rows.find(entry => entry.id === id)
      const said = row?.said
      check(
        `the health row '${id}', run while the import was in flight, prints the ${kinds.length} kinds`,
        row !== undefined && row.found && typeof said === 'object' && said.status === 'ok' && said.evidence.includes(String(kinds.length)),
        [row === undefined || !row.found ? `${file} makes no row '${id}': correct its line in ROWS of ${SELF}` : typeof said === 'string' ? `the row ${said} — in ${file}, the row reads the kinds with await resourceAdapterKinds() of ${RESOLVER} and by no other road` : `the row printed ${said?.status}: ${said?.evidence}`],
      )
    }
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log('')
console.log(failures === 0 ? `prove-kinds-on-every-entry: ALL HOLD — ${checks} checks` : `prove-kinds-on-every-entry: ${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
