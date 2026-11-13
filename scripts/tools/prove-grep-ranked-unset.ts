#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SRC = process.env.PROVE_SRC ?? join(ROOT, 'src')
const FIXTURE = join(import.meta.dir, 'fixtures', 'grep-definition-base.json')
const CORPUS = join(ROOT, 'scripts', 'tool-economy', 'fixtures', 'definition-corpus.json')
const SWITCH = 'MERCURY_GREP_RANKED'
const emit = process.argv.includes('--emit')
const record = process.argv.includes('--record')

type Roads = { roads: Record<string, { model: string; definition: string }>; mcp: string }

async function read(): Promise<Roads> {
  delete process.env.NODE_ENV
  for (const name of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_MODEL']) delete process.env[name]
  const { enableConfigs } = await import(`${SRC}/utils/config/globalConfig.ts`)
  enableConfigs()
  const { setIsInteractive } = await import(`${SRC}/bootstrap/state.ts`)
  setIsInteractive(false)
  const { getAllBaseTools } = await import(`${SRC}/tools.ts`)
  const { getEmptyToolPermissionContext } = await import(`${SRC}/Tool.ts`)
  const { toolToAPISchema } = await import(`${SRC}/utils/api.ts`)
  const { PROVIDER_ID_SPACES, declaredRouteOf } = await import(`${SRC}/services/providers/routeLaw.ts`)
  const { zodToJsonSchema } = await import(`${SRC}/utils/zodToJsonSchema.ts`)
  const { GrepTool } = await import(`${SRC}/tools/GrepTool/GrepTool.ts`)
  const tools = getAllBaseTools()
  const permission = getEmptyToolPermissionContext()
  const models: Array<[string, string]> = [['anthropic', 'claude-fable-5-2']]
  for (const space of PROVIDER_ID_SPACES as Array<{ route: string; qualifiedPrefix?: string; barePrefixes?: string[]; innerGrammar?: string }>) {
    models.push([space.route, space.qualifiedPrefix !== undefined ? `${space.qualifiedPrefix}${space.innerGrammar === 'segments-2' ? 'vendor/model-x' : 'model-x'}` : `${space.barePrefixes![0]}x1`])
  }
  const roads: Roads['roads'] = {}
  for (const [route, model] of models) {
    if (declaredRouteOf(model) !== route) throw new Error(`${model} is not a model of the ${route} road`)
    roads[route] = { model, definition: JSON.stringify(await toolToAPISchema(GrepTool, { getToolPermissionContext: async () => permission, tools, agents: [], model })) }
  }
  const description = await GrepTool.prompt({ getToolPermissionContext: async () => permission, tools, agents: [] })
  const mcp = JSON.stringify({ name: GrepTool.name, description, inputSchema: zodToJsonSchema(GrepTool.inputSchema), outputSchema: zodToJsonSchema(GrepTool.outputSchema, 'output') })
  return { roads, mcp }
}

if (emit) {
  console.log(JSON.stringify(await read()))
  process.exit(0)
}

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'grep-ranked-unset-home-')))
process.on('exit', () => {
  try {
    rmSync(HOME, { recursive: true, force: true })
  } catch {
  }
})
const childHome = (name: string): string => {
  const home = join(HOME, name)
  mkdirSync(join(home, 'tmp'), { recursive: true })
  return home
}
process.env.MERCURY_CONFIG_DIR = childHome('own')
process.env.MERCURY_TMPDIR = join(process.env.MERCURY_CONFIG_DIR, 'tmp')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env[SWITCH]

if (record) {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
  const base = process.env.PROVE_SRC === undefined ? git('rev-parse', 'HEAD') : (process.env.PROVE_BASE ?? '')
  if (base === '') throw new Error('a recording from PROVE_SRC names its commit in PROVE_BASE')
  if (process.env.PROVE_SRC === undefined && git('diff', '--name-only', 'HEAD', '--', 'src') !== '') throw new Error('record from a committed product tree')
  const now = await read()
  writeFileSync(FIXTURE, `${JSON.stringify({ base, ...now }, null, 2)}\n`)
  console.log(`RECORDED Grep's definition on ${Object.keys(now.roads).length} roads and the MCP listing at ${base}`)
  rmSync(HOME, { recursive: true, force: true })
  process.exit(0)
}

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const stored = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Roads & { base: string }
const corpusGrep = JSON.stringify((JSON.parse(readFileSync(CORPUS, 'utf8')) as { definitions: Array<{ name: string }> }).definitions.find(definition => definition.name === 'Grep'))
const child = (name: string, script: string, args: string[], value: string | undefined): { status: number | null; out: string; err: string } => {
  const home = childHome(name)
  const env: Record<string, string | undefined> = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_TMPDIR: join(home, 'tmp') }
  if (value === undefined) delete env[SWITCH]
  else env[SWITCH] = value
  const ran = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 })
  return { status: ran.status, out: ran.stdout ?? '', err: ran.stderr ?? '' }
}
const emitted = (name: string, value: string | undefined): Roads => {
  const ran = child(name, import.meta.path, ['--emit'], value)
  if (ran.status !== 0) throw new Error(`the emitting child failed (${String(ran.status)}): ${ran.err.slice(-600)}`)
  return JSON.parse(ran.out.trim().split('\n').at(-1)!) as Roads
}
const routes = Object.keys(stored.roads)
const same = (a: Roads, b: Roads): string[] => [...routes.filter(route => a.roads[route]?.definition !== b.roads[route]?.definition), ...(a.mcp === b.mcp ? [] : ['the MCP listing'])]

console.log(`unset: Grep's definition is the recorded one, byte for byte, on every road (recorded at ${stored.base.slice(0, 10)})`)
const unset = await read()
{
  check('the recording covers twenty-four roads, the local one among them, and the MCP listing', routes.length === 24 && routes.includes('local') && routes.includes('anthropic') && stored.mcp.length > 0, routes.join(' '))
  check('every road of the product is in it', JSON.stringify(Object.keys(unset.roads)) === JSON.stringify(routes), Object.keys(unset.roads).join(' '))
  const moved = same(unset, stored)
  check('with the switch unset every road and the MCP listing send the recorded bytes', moved.length === 0, moved.join(', '))
  const offCorpus = routes.filter(route => route !== 'local' && stored.roads[route]!.definition !== corpusGrep)
  check('on twenty-three roads those bytes are also the 62-definition corpus\'s own Grep entry, recorded apart from this proof', offCorpus.length === 0 && routes.length - 1 === 23, offCorpus.join(', '))
  check('the local road sends its short form, which the recording holds', stored.roads.local!.definition !== corpusGrep && unset.roads.local!.definition === stored.roads.local!.definition && stored.roads.local!.definition.length < corpusGrep.length)
  check('nothing of the mode is in any of them', !JSON.stringify(unset).includes('ranked'))
}

console.log('unset in every spelling but 1: the same bytes, in a process of its own')
for (const [label, value] of [['absent', undefined], ['0', '0'], ['empty', ''], ['true', 'true'], ['yes', 'yes'], ['on', 'on'], ['1 with a space', ' 1'], ['2', '2']] as Array<[string, string | undefined]>) {
  const moved = same(emitted(`off-${label.replace(/\W+/g, '-')}`, value), stored)
  check(`${SWITCH} ${label}: every road and the MCP listing send the recorded bytes`, moved.length === 0, moved.join(', '))
}

console.log('set to 1: Grep gains the mode and one sentence, and nothing else')
{
  const set = emitted('on', '1')
  const SENTENCE = ' With output_mode "ranked", pattern is plain words that describe a behaviour, and the answer is the few files and line ranges that hold those words most densely.'
  const CLAUSE = '; "ranked" reads pattern as plain words, not a regex, and returns the files and line ranges that hold them most densely — the mode for finding where a behaviour is implemented before its names are known.'
  type Definition = { description: string; input_schema: { properties: { output_mode: { description: string; enum: string[] } } } }
  const wrong: string[] = []
  for (const route of routes) {
    const before = JSON.parse(stored.roads[route]!.definition) as Definition
    const after = JSON.parse(set.roads[route]!.definition) as Definition
    const expected = structuredClone(before)
    expected.input_schema.properties.output_mode.enum = [...before.input_schema.properties.output_mode.enum, 'ranked']
    if (route !== 'local') {
      expected.description = before.description + SENTENCE
      expected.input_schema.properties.output_mode.description = before.input_schema.properties.output_mode.description.replace(/\.$/, '') + CLAUSE
    }
    if (JSON.stringify(after) !== JSON.stringify(expected)) wrong.push(route)
  }
  check('on twenty-three roads: the description plus one sentence, the enum plus "ranked", output_mode\'s text plus one clause, every other byte the same', wrong.filter(route => route !== 'local').length === 0, wrong.join(', '))
  check('on the local road: the enum plus "ranked" and no other byte (its short form names no mode)', !wrong.includes('local') && !set.roads.local!.definition.includes('plain words'), set.roads.local!.definition.slice(0, 200))
  const listed = JSON.parse(stored.mcp) as { description: string; inputSchema: Definition['input_schema']; outputSchema: { properties: Record<string, unknown> } }
  const expectedListing = structuredClone(listed)
  expectedListing.description = listed.description + SENTENCE
  expectedListing.inputSchema.properties.output_mode.enum = [...listed.inputSchema.properties.output_mode.enum, 'ranked']
  expectedListing.inputSchema.properties.output_mode.description = listed.inputSchema.properties.output_mode.description.replace(/\.$/, '') + CLAUSE
  expectedListing.outputSchema.properties = { ...listed.outputSchema.properties, ranked: { type: 'string' } }
  check('in the MCP listing: the same three, and the output schema gains the field that carries the answer', set.mcp === JSON.stringify(expectedListing), set.mcp.slice(-300))
}

console.log('the standing corpus of 62 definitions: green unset, and with the switch set Grep is the only definition that moves')
{
  const corpusProof = join(ROOT, 'scripts', 'tool-economy', 'prove-definition-corpus-parity.ts')
  const off = child('corpus-off', corpusProof, [], undefined)
  check('unset: the corpus proof passes, 62 definitions identical', off.status === 0 && off.out.includes('PASS CORPUS 62 definitions identical'), `${String(off.status)} ${off.out.slice(-200)} ${off.err.slice(-300)}`)
  const on = child('corpus-on', corpusProof, [], '1')
  const moved = /^AssertionError: a definition moved since the recording at [0-9a-f]+ — re-record with --record and list the diff: ([^\n]*)$/m.exec(`${on.out}\n${on.err}`)
  check('set: it fails naming Grep and no other tool, so the other 61 definitions are unchanged', on.status !== 0 && moved !== null && moved[1]!.trim() === 'Grep', `${String(on.status)} ${moved?.[1] ?? on.err.slice(-300)}`)
}

console.log('the switch is a registered opt-in, read once')
{
  const { FLAG_REGISTRY } = await import(`${SRC}/substrate/flagRegistry.ts`)
  const row = (FLAG_REGISTRY as Array<{ env: string; kind: string; tier?: string; evidence?: string; summary: string; off: string; consumer: string }>).find(flag => flag.env === SWITCH)
  check('its row: opt-in, behavioral, this proof as its evidence, its reader named', row?.kind === 'opt-in' && row.tier === 'behavioral' && row.evidence === 'scripts/tools/prove-grep-ranked-unset.ts' && row.consumer === 'src/tools/GrepTool/prompt.ts' && existsSync(join(ROOT, row.consumer)), JSON.stringify(row))
  check('the row says where it must stand', row !== undefined && row.summary.includes('must stand in the environment Mercury starts in') && row.summary.includes('a settings env value arrives too late'), row?.summary)
  const { GrepTool } = await import(`${SRC}/tools/GrepTool/GrepTool.ts`)
  const { getDescription } = await import(`${SRC}/tools/GrepTool/prompt.ts`)
  process.env[SWITCH] = '1'
  check('set after the tools have loaded it changes nothing: the description and the schema still agree', !getDescription().includes('ranked') && !GrepTool.inputSchema.safeParse({ pattern: 'x', output_mode: 'ranked' }).success && (await GrepTool.prompt({ tools: [] } as never)) === getDescription())
  delete process.env[SWITCH]
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-grep-ranked-unset: ${failures} of ${checks} FAILED`)
  process.exit(1)
}
console.log(`\nprove-grep-ranked-unset: all ${checks} green`)
