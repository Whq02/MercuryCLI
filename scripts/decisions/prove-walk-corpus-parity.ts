#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const FIXTURE = join(import.meta.dir, 'walk-corpus.json')
const SELF = 'scripts/decisions/prove-walk-corpus-parity.ts'
const RECORD = process.argv.includes('--record')
const SHOWN = 12
const PLAIN = -1
const OWN = '\\u0001'
const JOINED = / ?(?:&&|\|\||\||;) ?/
const REMEMBERED: readonly string[] = ['command', 'redirected_statement', 'pipeline', 'list', 'declaration_command']
const ALWAYS_KINDS: readonly string[] = ['', 'ERROR', 'PARSE_ABORT', 'command', 'program']
const STARTED: ReadonlyArray<readonly [unknown, unknown]> = [['git', ['commit', '-m', 'a b']], ['ls', []], ['', ['a']], [undefined, []], ['ls', 'a'], ['printf', ['%s', 3, "it's", '']], [7, ['a']]]
const LONGER_THAN_THE_PARSER_READS = `echo ${'x'.repeat(10_001)}`

const ast = await import('../../src/platform/shell/bash/ast.ts')
const parser = await import('../../src/platform/shell/bash/parser.ts')

type Tree = { type: string; text: string; startIndex: number; endIndex: number; children: Tree[] }
type Verdict = Awaited<ReturnType<typeof ast.parseForSecurity>>
type Row = [command: string, reading: number, inner?: Array<[text: string, reading: number]>]
type Crafted = [label: string, tree: unknown, reading: number]
type Peeled = [argv: string[], peeled: unknown]
type Fixture = { kinds: Record<string, number>; aborted: unknown; started: unknown; readings: unknown[]; crafted: Crafted[]; peeled: Peeled[]; rows: Row[] }
type Read = { reading: string | null; inner: Array<[string, string]>; prepared: boolean; found: boolean; kind: string; nodeType: string | undefined; peeled: Array<[string, string]> }

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

const abortedPlainly = JSON.stringify(ast.parseForSecurityFromAst('true', parser.PARSE_ABORTED))
const startedNow = JSON.stringify(STARTED.map(([command, args]) => ast.startedCommandText(command, args) ?? null))

function folded(text: string, command: string): string {
  const own = JSON.stringify(command).slice(1, -1)
  return own.length < 6 ? text : text.replaceAll(own, OWN)
}

function plainReading(command: string): string {
  const parts = command.split(JOINED)
  return JSON.stringify([{ kind: 'simple', commands: parts.map(text => ({ argv: text.split(' '), envVars: [], redirects: [], text })) }, { ok: true }, parts])
}

function settled(command: string, verdict: Verdict): string | null {
  const semantics = verdict.kind === 'simple' ? ast.checkSemantics(verdict.commands) : null
  const quoted = verdict.kind === 'simple' ? verdict.commands.map(one => ast.shellCommandText(one.argv)) : null
  const aborted = JSON.stringify(ast.parseForSecurityFromAst(command, parser.PARSE_ABORTED))
  const reading = aborted === abortedPlainly ? JSON.stringify([verdict, semantics, quoted]) : `${JSON.stringify([verdict, semantics, quoted]).slice(0, -1)},${aborted}]`
  return reading === plainReading(command) ? null : folded(reading, command)
}

function rememberedNodes(root: Tree): Tree[] {
  const found: Tree[] = []
  const visit = (node: Tree, top: boolean): void => {
    if (!top && REMEMBERED.includes(node.type)) found.push(node)
    for (const child of node.children) visit(child, false)
  }
  visit(root, true)
  return found
}

async function read(command: string): Promise<Read> {
  const root = await parser.parseCommandRaw(command)
  const verdict = await ast.parseForSecurity(command)
  const held = root !== null && root !== parser.PARSE_ABORTED
  const prepared = !held || JSON.stringify(ast.preparedSecurityParse(command)) === JSON.stringify(verdict)
  const found = verdict.kind !== 'simple' || verdict.commands.every(one => ast.preparedSecurityParse(one.text).kind !== 'parse-unavailable')
  const inner: Array<[string, string]> = []
  if (held) {
    const seen = new Set<string>()
    for (const node of rememberedNodes(root as Tree)) {
      if (seen.has(node.text) || node.text === command) continue
      seen.add(node.text)
      const alone = JSON.stringify(ast.parseForSecurityFromAst(node.text, node as never))
      const asCommand = JSON.stringify(await ast.parseForSecurity(node.text))
      if (alone !== asCommand) inner.push([node.text, folded(alone, node.text)])
    }
  }
  const peeled: Array<[string, string]> = verdict.kind !== 'simple' ? [] : verdict.commands.flatMap(one => {
    const given = JSON.stringify(one.argv)
    const left = JSON.stringify(ast.peelWrappers(one.argv))
    return left === given ? [] : [[given, left] as [string, string]]
  })
  return { reading: settled(command, verdict), inner, prepared, found, kind: verdict.kind, nodeType: verdict.kind === 'too-complex' ? verdict.nodeType : undefined, peeled }
}

async function innerTexts(command: string): Promise<string[]> {
  const root = await parser.parseCommandRaw(command)
  return root === null || root === parser.PARSE_ABORTED ? [] : rememberedNodes(root as Tree).map(node => node.text)
}

function craftedReading(tree: unknown): string {
  return JSON.stringify(ast.parseForSecurityFromAst((tree as Tree).text, tree as never))
}

function kindTable(nodeTypes: Iterable<string>): Record<string, number> {
  const table: Record<string, number> = { undefined: ast.nodeTypeId(undefined) }
  for (const name of [...new Set([...ALWAYS_KINDS, ...nodeTypes])].sort()) table[name] = ast.nodeTypeId(name)
  return table
}

function listOf(path: string): unknown[] {
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!Array.isArray(value)) throw new Error(`${path} is not a JSON array`)
  return value
}

console.log('============================================================')
console.log(' the walk — corpus parity (what every command reads as)')
console.log('============================================================')

const fixture: Fixture = existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture) : { kinds: {}, aborted: null, started: null, readings: [], crafted: [], peeled: [], rows: [] }
const recorded = fixture.readings.map(reading => JSON.stringify(reading))

if (RECORD) {
  const given = process.argv.slice(process.argv.indexOf('--record') + 1)
  const craftedAt = given.indexOf('--crafted')
  const added = (craftedAt === -1 ? given : given.slice(0, craftedAt)).flatMap(listOf).map(entry => (typeof entry === 'string' ? entry : (entry as { command: string }).command))
  const trees = new Map<string, unknown>(fixture.crafted.map(([label, tree]) => [label, tree]))
  for (const entry of craftedAt === -1 ? [] : given.slice(craftedAt + 1).flatMap(listOf)) trees.set((entry as { label: string }).label, (entry as { tree: unknown }).tree)
  const corpus = new Set<string>([...fixture.rows.map(row => row[0]), ...added])
  for (const command of [...corpus]) for (const text of await innerTexts(command)) corpus.add(text)
  const readings: string[] = []
  const index = new Map<string, number>()
  const intern = (text: string): number => {
    const known = index.get(text)
    if (known !== undefined) return known
    readings.push(text)
    index.set(text, readings.length - 1)
    return readings.length - 1
  }
  const rows: Row[] = []
  const nodeTypes = new Set<string>()
  const peeled = new Map<string, string>()
  for (const command of [...corpus].sort()) {
    const now = await read(command)
    if (now.nodeType !== undefined) nodeTypes.add(now.nodeType)
    for (const [given, left] of now.peeled) peeled.set(given, left)
    const reading = now.reading === null ? PLAIN : intern(now.reading)
    rows.push(now.inner.length === 0 ? [command, reading] : [command, reading, now.inner.map(([text, alone]) => [text, intern(alone)])])
  }
  const crafted: Crafted[] = [...trees.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([label, tree]) => [label, tree, intern(craftedReading(tree))])
  for (const text of readings) {
    const nodeType = /^\{"kind":"too-complex","reason":"[^"]*","nodeType":"([^"]*)"\}$/.exec(text)?.[1]
    if (nodeType !== undefined) nodeTypes.add(nodeType)
  }
  const head = JSON.stringify({ kinds: kindTable(nodeTypes), aborted: JSON.parse(abortedPlainly) as unknown, started: JSON.parse(startedNow) as unknown }).slice(1, -1)
  writeFileSync(FIXTURE, `{${head},\n"readings":[\n${readings.join(',\n')}\n],\n"crafted":[\n${crafted.map(row => JSON.stringify(row)).join(',\n')}\n],\n"peeled":[\n${[...peeled.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([given, left]) => `[${given},${left}]`).join(',\n')}\n],\n"rows":[\n${rows.map(row => JSON.stringify(row)).join(',\n')}\n]}\n`)
  console.log(`\n  [RECORDED] ${rows.length} commands and ${crafted.length} hand-built trees with ${readings.length} distinct readings, ${peeled.size} commands that peelWrappers changes → ${FIXTURE}`)
} else {
  section(`(1) the corpus — ${fixture.rows.length} commands, ${fixture.readings.length} distinct readings`)
  check('the recorded corpus exists beside the proof', fixture.rows.length > 0, `${FIXTURE} is absent or holds no rows; restore scripts/decisions/walk-corpus.json or record it with bun ${SELF} --record`)
  const moved: string[] = []
  const kinds = new Map<string, number>()
  const nodeTypes = new Set<string>()
  let unprepared = 0
  let lost = 0
  let plain = 0
  const peeled = new Map<string, string>()
  for (const [command, reading, inner = []] of fixture.rows) {
    const now = await read(command)
    for (const [given, left] of now.peeled) peeled.set(given, left)
    kinds.set(now.kind, (kinds.get(now.kind) ?? 0) + 1)
    if (now.nodeType !== undefined) nodeTypes.add(now.nodeType)
    if (!now.prepared) unprepared++
    if (!now.found) lost++
    if (now.reading === null) plain++
    const want = reading === PLAIN ? null : (recorded[reading] ?? '')
    if (now.reading !== want) moved.push(`${JSON.stringify(command)} — the reading\n      recorded: ${want ?? 'the plain reading: each command its words as written'}\n      now:      ${now.reading ?? 'the plain reading: each command its words as written'}`)
    const wantInner = JSON.stringify(inner.map(([text, at]) => [text, recorded[at] ?? '']))
    if (JSON.stringify(now.inner) !== wantInner) moved.push(`${JSON.stringify(command)} — a part of it walked alone, where that differs from the part read as a command\n      recorded: ${wantInner}\n      now:      ${JSON.stringify(now.inner)}`)
  }
  for (const [kind, count] of [...kinds.entries()].sort()) console.log(`    verdict ${kind}: ${count}`)
  console.log(`    plain readings: ${plain}`)
  check(
    `every command reads as recorded: the verdict, the semantic check, the quoted words and the reading of a parse that did not finish, for each of the ${fixture.rows.length} commands, byte for byte`,
    moved.length === 0,
    `${moved.length} moved. If the walk was meant to change, record again with \`bun ${SELF} --record\` and read the diff of scripts/decisions/walk-corpus.json; if it was not, the change to src/platform/shell/bash/ast.ts or its parts altered what a command reads as`,
  )
  for (const line of moved.slice(0, SHOWN)) console.log(`    ${line}`)
  if (moved.length > SHOWN) console.log(`    … ${moved.length - SHOWN} more`)
  check('the tree a parse leaves prepared reads as the command itself does', unprepared === 0, `${unprepared} commands read differently through preparedSecurityParse; make preparedSecurityParse in src/platform/shell/bash/ast.ts return what parseForSecurity returns for a command the parser held`)
  check('every command of a simple reading is found again by its own text', lost === 0, `${lost} commands hold a part that preparedSecurityParse does not find; make preparedSecurityParse in src/platform/shell/bash/ast.ts find the text of each command of a simple reading`)
  check('nodeTypeId gives the recorded id for every recorded kind', JSON.stringify(kindTable(Object.keys(fixture.kinds).filter(name => name !== 'undefined'))) === JSON.stringify(fixture.kinds), JSON.stringify(kindTable(Object.keys(fixture.kinds).filter(name => name !== 'undefined'))) + ' — nodeTypeId in src/permissions/rules/decision/command-analysis/exactParse.ts no longer gives the ids recorded under kinds in scripts/decisions/walk-corpus.json; keep the old ids, or record again with bun ' + SELF + ' --record if they were meant to change')
  check('every refusal kind the corpus meets has a recorded id', [...nodeTypes].every(name => name in fixture.kinds), [...nodeTypes].filter(name => !(name in fixture.kinds)).join(' ') + ' — a refusal kind the corpus meets has no recorded id; record again with bun ' + SELF + ' --record')
  check('the corpus reaches both verdict kinds', (kinds.get('simple') ?? 0) > 0 && (kinds.get('too-complex') ?? 0) > 0, [...kinds.keys()].join(',') + ' — the corpus must hold both simple and too-complex commands; check parseForSecurity in src/platform/shell/bash/ast.ts and the rows of scripts/decisions/walk-corpus.json')

  section(`(2) trees no parse builds — ${fixture.crafted.length} built by hand, walked as given`)
  const bent = fixture.crafted.flatMap(([label, tree, reading]) => (craftedReading(tree) === (recorded[reading] ?? '') ? [] : [`${label}\n      recorded: ${recorded[reading] ?? ''}\n      now:      ${craftedReading(tree)}`]))
  check(`each hand-built tree reads as recorded (${fixture.crafted.length} trees)`, bent.length === 0, `${bent.length} moved; record again with \`bun ${SELF} --record\` if the walk was meant to change`)
  for (const line of bent.slice(0, SHOWN)) console.log(`    ${line}`)

  section(`(3) the wrappers — ${fixture.peeled.length} commands of the corpus that peelWrappers changes`)
  const wanted = new Map<string, string>(fixture.peeled.map(([given, left]) => [JSON.stringify(given), JSON.stringify(left)]))
  const unpeeled = [...new Set([...wanted.keys(), ...peeled.keys()])].sort().flatMap(given => (wanted.get(given) === peeled.get(given) ? [] : [`${given}\n      recorded: ${wanted.get(given) ?? 'the words as given'}\n      now:      ${peeled.get(given) ?? 'the words as given'}`]))
  check(`peelWrappers leaves every simple command of the corpus as recorded: its words as given, or the ${fixture.peeled.length} recorded answers`, unpeeled.length === 0, `${unpeeled.length} moved; record again with \`bun ${SELF} --record\` if the wrappers were meant to change, else the change to src/platform/shell/bash/ast/wrappers.ts altered what a wrapper leaves`)
  for (const line of unpeeled.slice(0, SHOWN)) console.log(`    ${line}`)

  section('(4) the door beside the walk')
  check('a parse that did not finish reads as recorded', abortedPlainly === JSON.stringify(fixture.aborted), abortedPlainly + ' — fix parseForSecurityFromAst in src/permissions/rules/decision/command-analysis/exactParse.ts for a parse that did not finish, or record again with bun ' + SELF + ' --record if that was meant to change')
  check(`startedCommandText spells the ${STARTED.length} recorded starts as recorded`, startedNow === JSON.stringify(fixture.started), startedNow + ' — fix startedCommandText in src/platform/shell/bash/ast.ts, or record again with bun ' + SELF + ' --record if the spelling was meant to change')
  check('a command longer than the parser reads has no reading, and no command at all reads as none', (await ast.parseForSecurity(LONGER_THAN_THE_PARSER_READS)).kind === 'parse-unavailable' && JSON.stringify(await ast.parseForSecurity('')) === '{"kind":"simple","commands":[]}', 'fix parseForSecurity in src/platform/shell/bash/ast.ts: a command longer than the parser reads must give parse-unavailable, and an empty command must give simple with no commands')
  check('a text no parse has met is not found prepared', ast.preparedSecurityParse('no parse has met this text').kind === 'parse-unavailable', 'fix preparedSecurityParse in src/platform/shell/bash/ast.ts to give parse-unavailable for a text no parse has met')
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(RECORD ? ' CORPUS RECORDED' : ` WALK CORPUS PARITY GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ${failures} WALK CORPUS PARITY FAILURE(S)`)
process.exit(1)
