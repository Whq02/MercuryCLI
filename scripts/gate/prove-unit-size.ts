#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'

const ROOT = resolve(import.meta.dir, '..', '..')
const SELF = 'scripts/gate/prove-unit-size.ts'
const TABLE = 'scripts/gate/unit-size.tsv'
const CODE = /\.(?:ts|tsx|mts|cts)$/
const AT_THE_ROOT = new Set(['node_modules', 'dist', '.git'])
const UNIT_CEILING = 300
const FILE_CEILING = 1500
const FLOOR = '151b68f34b2be89255e2320e6effe8ce4ec2fb70'
const LINKS_READ_AT_MOST = 60
const WORKING_TREE = 'the working tree'
const NO_NAME = '-'

type Kind = 'file' | 'table' | 'text' | 'unit'
type Listed = { kind: 'table' | 'text' | 'grows'; what: string }
type Data = ReadonlyMap<string, Listed>

const LISTED: ReadonlyArray<readonly [file: string, name: string, kind: Listed['kind'], what: string]> = [
  ['src/integrations/extensions/bundled/content.generated.ts', 'bundledMetadata', 'grows', 'the bundled extensions as scripts/extensions/gen-bundled.ts writes them'],
  ['src/integrations/vulcan-optable/optable.generated.ts', 'VULCAN_OPS', 'grows', "the Godot bridge's operations as scripts/vulcan/regen-optable.mjs writes them"],
  ['src/screen/tips/tipRegistry.ts', 'GENERAL_TIPS', 'table', 'the tips, one entry a tip'],
  ['src/screen/spinner/spinnerVerbs.ts', 'MERCURY_DESERT_VERBS', 'table', 'the desert thinking verbs, one entry a verb'],
  ['src/platform/substrate/stateLifecycle.ts', 'LIFECYCLE_MANIFEST', 'table', 'the classes of state on disk, one entry a class'],
  ['src/permissions/capability/declarations.ts', 'TOOL_CAPABILITY_DECLARATIONS', 'table', 'what each tool declares it can do, one entry a tool'],
  ['src/tools/engines/eval-kernels/jsRunnerSource.ts', 'JS_RUNNER_SOURCE', 'text', "the eval kernel's JavaScript runner, kept as text"],
  ['src/tools/engines/eval-kernels/pyRunnerSource.ts', 'PY_RUNNER_SOURCE', 'text', "the eval kernel's Python runner, kept as text"],
  ['src/integrations/samples/shell.ts', 'SCRIPT', 'text', "the samples page's browser script, kept as text"],
]
const DATA: Data = new Map(LISTED.map(([file, name, kind, what]) => [`${file}\t${name}`, { kind, what }]))

type Part = { kind: 'unit' | 'data'; name: string; line: number; from: number; to: number; head: number; entries: number | null }
type Measure = { text: string; lines: number; parts: Part[]; imports: Array<[number, number]>; rows?: string[] }
type Row = { file: string; kind: Kind; name: string; count: number }
type Table = Map<string, Row>
type Over = { row: Row; allowed: number | null }
type Stray = { file: string; name: string; line: number; lines: number; why: string }
type State = { id: string; name: string; rows: Table | null; parent: string | null }
type Chain = {
  states: State[]
  read: (id: string, file: string) => string | null
  touched: (from: string, to: string) => string[]
  load?: (id: string, files: string[]) => void
  asTree?: (id: string, file: string) => boolean
}
type Mark = { at: string; row: Row; allowed: number | null; stood: number | null; arrived: number; moved: number }
type Walked = { stood: Table; marks: Map<string, Mark>; read: number; writes: number; base: string | null; since: (row: Row) => { arrived: number; moved: number } | null }

function scriptKind(file: string): ts.ScriptKind {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

function lineCount(text: string): number {
  if (text === '') return 0
  const breaks = text.split('\n').length - 1
  return text.endsWith('\n') ? breaks : breaks + 1
}

function peeled(e: ts.Expression | undefined): ts.Expression | undefined {
  let cur = e
  while (cur !== undefined && (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isNonNullExpression(cur) || ts.isTypeAssertionExpression(cur))) cur = cur.expression
  return cur
}

function holdsFunction(node: ts.Node): boolean {
  let found = false
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n) || ts.isAccessor(n)) found = true
    else ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

function entriesOf(e: ts.Expression | undefined): number | null {
  const cur = peeled(e)
  if (cur === undefined) return null
  if (ts.isObjectLiteralExpression(cur)) return cur.properties.length
  if (ts.isArrayLiteralExpression(cur)) return cur.elements.length
  if (ts.isCallExpression(cur) || ts.isNewExpression(cur)) {
    for (const arg of cur.arguments ?? []) {
      const n = entriesOf(arg)
      if (n !== null) return n
    }
  }
  return null
}

function measure(file: string, text: string): Measure {
  const sf = ts.createSourceFile(join(ROOT, file), text, ts.ScriptTarget.Latest, true, scriptKind(file))
  const lineAt = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line
  const first = (node: ts.Node): number => lineAt(node.getStart(sf))
  const span = (node: ts.Node): number => lineAt(node.end) - first(node) + 1
  const parts: Part[] = []
  const units = new Map<string, number>()
  const imports: Array<[number, number]> = []
  const opens = (code: ts.Node): number => {
    if (ts.isClassLike(code)) return lineAt(Math.max(code.members.pos - 1, code.getStart(sf)))
    return first((ts.isFunctionLike(code) ? (code as ts.FunctionLikeDeclaration).body : undefined) ?? code)
  }
  const unit = (name: string, node: ts.Node, end: ts.Node, code: ts.Node): void => {
    const from = first(node)
    const to = lineAt(end.end)
    const part: Part = { kind: 'unit', name, line: from + 1, from, to, head: Math.min(Math.max(opens(code) - from + 1, 1), to - from + 1), entries: null }
    const twin = units.get(name)
    if (twin === undefined) units.set(name, parts.push(part) - 1)
    else if (to - from > parts[twin]!.to - parts[twin]!.from) parts[twin] = part
  }
  const datum = (name: string, node: ts.Node, init: ts.Expression | undefined): void => {
    if (span(node) > UNIT_CEILING) parts.push({ kind: 'data', name, line: first(node) + 1, from: first(node), to: lineAt(node.end), head: 0, entries: entriesOf(init) })
  }
  const codeOf = (e: ts.Expression | undefined): { code: ts.Node; last: ts.Node; wrapped: boolean } | undefined => {
    const cur = peeled(e)
    if (cur === undefined) return undefined
    if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur) || ts.isClassExpression(cur)) return { code: cur, last: cur, wrapped: false }
    if (!ts.isCallExpression(cur)) return undefined
    let code: ts.Node | undefined
    let last: ts.Node | undefined
    for (const arg of cur.arguments) {
      const inner = peeled(arg)
      const found = inner === undefined ? undefined : ts.isObjectLiteralExpression(inner) || ts.isArrayLiteralExpression(inner) ? (holdsFunction(inner) ? { code: inner, last: inner } : undefined) : codeOf(inner)
      if (found === undefined) continue
      code ??= found.code
      last = found.last
    }
    return code === undefined || last === undefined ? undefined : { code, last, wrapped: true }
  }
  const declared = (name: string, whole: ts.Node, init: ts.Expression | undefined): void => {
    const found = codeOf(init)
    const from = found === undefined ? undefined : found.wrapped ? found.code : whole
    const to = found === undefined ? undefined : found.wrapped ? found.last : whole
    if (found !== undefined && from !== undefined && to !== undefined) unit(name, from, to, found.code)
    if (from === undefined || to === undefined || lineAt(to.end) - first(from) + 1 <= UNIT_CEILING) datum(name, whole, init)
  }
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s)) {
      if (s.body !== undefined) unit(s.name?.text ?? 'default', s, s, s)
    } else if (ts.isClassDeclaration(s)) unit(s.name?.text ?? 'default', s, s, s)
    else if (ts.isVariableStatement(s)) {
      const alone = s.declarationList.declarations.length === 1
      for (const d of s.declarationList.declarations) declared(d.name.getText(sf), alone ? s : d, d.initializer)
    } else if (ts.isExportAssignment(s)) declared('default', s, s.expression)
    else if (ts.isImportDeclaration(s) || (ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined)) imports.push([first(s), lineAt(s.end)])
    else datum(ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isEnumDeclaration(s) || ts.isModuleDeclaration(s) ? s.name.getText(sf) : NO_NAME, s, undefined)
  }
  return { text, lines: lineCount(text), parts, imports }
}

const sizeOf = (part: Part): number => part.to - part.from + 1
const unitOf = (m: Measure | null, name: string): Part | undefined => m?.parts.find(p => p.kind === 'unit' && p.name === name)
const listedAs = (file: string, part: Part, data: Data): Listed | undefined => (part.kind === 'data' ? data.get(`${file}\t${part.name}`) : undefined)

function linesOf(m: Measure): string[] {
  if (m.rows === undefined) {
    const lines = m.text.split('\n')
    if (lines.at(-1) === '') lines.pop()
    m.rows = lines.map(line => line.trim())
  }
  return m.rows
}

const stretch = (m: Measure, from: number, to: number): string[] => (from > to ? [] : linesOf(m).slice(from, to + 1))

function own(file: string, m: Measure, data: Data): string[] {
  const aside = m.parts.filter(p => listedAs(file, p, data)?.kind === 'grows')
  return aside.length === 0 ? linesOf(m) : linesOf(m).filter((_, i) => !aside.some(p => i >= p.from && i <= p.to))
}

const countOf = (file: string, m: Measure, data: Data): number => m.lines - m.parts.reduce((n, p) => n + (listedAs(file, p, data)?.kind === 'grows' ? sizeOf(p) : 0), 0)

function dataCount(row: Row, m: Measure | null, data: Data): number | undefined {
  const part = m?.parts.find(p => p.name === row.name && listedAs(row.file, p, data)?.kind === row.kind)
  return part === undefined ? undefined : row.kind === 'table' ? (part.entries ?? undefined) : sizeOf(part)
}

const keyOf = (row: Pick<Row, 'file' | 'kind' | 'name'>): string => `${row.file}\t${row.kind}\t${row.name}`
const inOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function rowsOf(held: Iterable<[string, Measure]>, data: Data): Table {
  const rows: Table = new Map()
  const add = (row: Row): void => void rows.set(keyOf(row), row)
  for (const [file, m] of held) {
    const count = countOf(file, m, data)
    if (count > FILE_CEILING) add({ file, kind: 'file', name: NO_NAME, count })
    for (const part of m.parts) {
      const listed = listedAs(file, part, data)
      if (part.kind === 'unit' && sizeOf(part) > UNIT_CEILING) add({ file, kind: 'unit', name: part.name, count: sizeOf(part) })
      else if (listed?.kind === 'table' && part.entries !== null) add({ file, kind: 'table', name: part.name, count: part.entries })
      else if (listed?.kind === 'text') add({ file, kind: 'text', name: part.name, count: sizeOf(part) })
    }
  }
  return rows
}

function straysOf(held: Iterable<[string, Measure]>, data: Data): Stray[] {
  const out: Stray[] = []
  for (const [file, m] of held) {
    for (const part of m.parts) {
      if (part.kind !== 'data') continue
      const listed = listedAs(file, part, data)
      if (listed === undefined) out.push({ file, name: part.name, line: part.line, lines: sizeOf(part), why: 'is neither a unit nor on the list of data' })
      else if (listed.kind === 'table' && part.entries === null) out.push({ file, name: part.name, line: part.line, lines: sizeOf(part), why: 'is listed as a table and is no list or object whose entries can be counted' })
    }
  }
  return out.sort((a, b) => inOrder(a.file, b.file) || a.line - b.line)
}

const staleOf = (held: ReadonlyMap<string, Measure>, data: Data): string[] => [...data.keys()].filter(key => !held.get(key.split('\t')[0]!)?.parts.some(p => p.kind === 'data' && p.name === key.split('\t')[1])).sort()

const render = (rows: Table): string =>
  [...rows.entries()]
    .sort(([a], [b]) => inOrder(a, b))
    .map(([, row]) => `${row.file}\t${row.kind}\t${row.name}\t${row.count}\n`)
    .join('')

function tableOf(text: string): Table | null {
  const table: Table = new Map()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const m = /^(src\/[^\t]+)\t(file|table|text|unit)\t([^\t]+)\t([1-9][0-9]*)$/.exec(line)
    if (!m || /^[0-9]+$/.test(m[3]!)) return null
    const row: Row = { file: m[1]!, kind: m[2] as Kind, name: m[3]!, count: Number(m[4]) }
    if (table.has(keyOf(row)) || (row.kind === 'file') !== (row.name === NO_NAME)) return null
    if ((row.kind === 'unit' && row.count <= UNIT_CEILING) || (row.kind === 'file' && row.count <= FILE_CEILING)) return null
    table.set(keyOf(row), row)
  }
  return table
}

function judge(fresh: Table, table: Table): Over[] {
  const over: Over[] = []
  for (const [key, row] of fresh) {
    const allowed = table.get(key)?.count ?? null
    if (allowed === null || row.count > allowed) over.push({ row, allowed })
  }
  return over.sort((a, b) => inOrder(keyOf(a.row), keyOf(b.row)))
}

const bag = (lines: readonly string[]): Map<string, number> => {
  const out = new Map<string, number>()
  for (const line of lines) out.set(line, (out.get(line) ?? 0) + 1)
  return out
}

const less = (a: Map<string, number>, b: Map<string, number>): Map<string, number> => {
  const out = new Map<string, number>()
  for (const [line, n] of a) if (n > (b.get(line) ?? 0)) out.set(line, n - (b.get(line) ?? 0))
  return out
}

const size = (lines: Map<string, number>): number => [...lines.values()].reduce((n, c) => n + c, 0)

function drawn(pool: Map<string, number>, wanted: Map<string, number>, spend: boolean): number {
  let got = 0
  for (const [line, n] of wanted) {
    const have = Math.min(n, pool.get(line) ?? 0)
    got += have
    if (spend && have > 0) pool.set(line, (pool.get(line) ?? 0) - have)
  }
  return got
}

function walk(chain: Chain, tree: ReadonlyMap<string, Measure>, data: Data): Walked | null {
  const cache = new Map<string, Measure | null>()
  const at = (id: string, file: string): Measure | null => {
    if (chain.asTree?.(id, file)) return tree.get(file) ?? null
    const key = `${id}\u0000${file}`
    if (!cache.has(key)) {
      const text = chain.read(id, file)
      cache.set(key, text === null ? null : measure(file, text))
    }
    return cache.get(key) ?? null
  }
  const measured = (id: string, files: Iterable<string>): Table => {
    const list = [...new Set(files)]
    chain.load?.(id, list)
    return rowsOf(
      list.flatMap((file): Array<[string, Measure]> => {
        const m = at(id, file)
        return m === null ? [] : [[file, m]]
      }),
      data,
    )
  }
  const bodyOf = (m: Measure | null, name: string): Map<string, number> => {
    const part = unitOf(m, name)
    return bag(m === null || part === undefined ? [] : stretch(m, part.from, part.to))
  }
  const pools = (prev: string, id: string, before: Table): { unit: Map<string, number>; file: Map<string, number> } => {
    const touched = new Set(chain.touched(prev, id))
    const lawful = [...before.values()].filter(row => touched.has(row.file))
    const files = [...new Set(lawful.map(row => row.file))]
    chain.load?.(prev, files)
    chain.load?.(id, files)
    const pool = { unit: new Map<string, number>(), file: new Map<string, number>() }
    const pour = (into: Map<string, number>, lines: Map<string, number>): void => {
      for (const [line, n] of lines) into.set(line, (into.get(line) ?? 0) + n)
    }
    for (const row of lawful) {
      const was = at(prev, row.file)
      const now = at(id, row.file)
      if (was === null) continue
      if (row.kind === 'unit') pour(pool.unit, less(bodyOf(was, row.name), bodyOf(now, row.name)))
      else if (row.kind === 'file') pour(pool.file, less(bag(own(row.file, was, data)), bag(now === null ? [] : own(row.file, now, data))))
    }
    return pool
  }
  const arrivedIn = (row: Row, was: Measure | null, now: Measure): Map<string, number> | null => {
    if (row.kind === 'unit') {
      const part = unitOf(now, row.name)
      return part === undefined ? null : less(bag(stretch(now, part.from + part.head, part.to - 1)), bodyOf(was, row.name))
    }
    if (row.kind !== 'file') return null
    const imports = bag(now.imports.flatMap(([from, to]) => stretch(now, from, to)))
    return less(less(bag(own(row.file, now, data)), bag(was === null ? [] : own(row.file, was, data))), imports)
  }
  const heldAt = (id: string, row: Row): number => {
    chain.load?.(id, [row.file])
    const m = at(id, row.file)
    const part = unitOf(m, row.name)
    return (m === null ? undefined : row.kind === 'file' ? countOf(row.file, m, data) : row.kind === 'unit' ? (part === undefined ? undefined : sizeOf(part)) : dataCount(row, m, data)) ?? 0
  }
  let leftOut: Table = new Map()
  const settle = (prev: string, state: State, allowed: Table, marks: Map<string, Mark>): number => {
    const rows = state.rows!
    const before = new Map(allowed)
    const back = leftOut
    leftOut = new Map([...before].filter(([key, was]) => (rows.get(key)?.count ?? 0) < was.count))
    const born: Row[] = []
    for (const [key, row] of rows) {
      const was = before.get(key)
      const kept = back.get(key)?.count
      const most = was === undefined ? 0 : kept === undefined || row.count <= was.count ? was.count : Math.max(was.count, Math.min(kept, heldAt(prev, row)))
      if (was === undefined) born.push(row)
      else if (row.count <= most) {
        allowed.set(key, row)
        marks.delete(key)
      } else marks.set(key, { ...(marks.get(key) ?? { at: state.name, allowed: most, stood: null, arrived: 0, moved: 0 }), row })
    }
    for (const key of before.keys()) if (!rows.has(key)) allowed.delete(key)
    for (const key of [...marks.keys()]) if (!rows.has(key)) marks.delete(key)
    if (born.length === 0) return 0
    const pool = pools(prev, state.id, before)
    chain.load?.(prev, born.map(row => row.file))
    chain.load?.(state.id, born.map(row => row.file))
    for (const row of born.sort((a, b) => inOrder(keyOf(a), keyOf(b)))) {
      const key = keyOf(row)
      const was = at(prev, row.file)
      const now = at(state.id, row.file)
      const refuse = (stood: number | null, arrived: number, moved: number, most: number | null = null): void => void marks.set(key, { ...(marks.get(key) ?? { at: state.name, allowed: most, stood, arrived, moved }), row })
      const accept = (count: number): void => {
        allowed.set(key, { ...row, count: Math.min(row.count, count) })
        marks.delete(key)
      }
      const kept = back.get(key)?.count
      if (row.kind === 'table' || row.kind === 'text') {
        const base = dataCount(row, was, data)
        const most = kept === undefined || base === undefined ? (kept ?? base) : Math.min(kept, base)
        if (most !== undefined && row.count > most) refuse(null, 0, 0, most)
        else accept(dataCount(row, now, data) ?? row.count)
        continue
      }
      const part = unitOf(now, row.name)
      const holds = now === null ? null : row.kind === 'file' ? countOf(row.file, now, data) : part === undefined ? null : sizeOf(part)
      const old = unitOf(was, row.name)
      const stood = was === null ? 0 : row.kind === 'file' ? countOf(row.file, was, data) : old === undefined ? 0 : sizeOf(old)
      const arrived = now === null ? null : arrivedIn(row, was, now)
      if (holds === null || arrived === null) refuse(null, row.count, 0)
      else if (stood > (row.kind === 'file' ? FILE_CEILING : UNIT_CEILING)) {
        if (kept !== undefined && row.count <= Math.min(kept, stood)) accept(holds)
        else refuse(kept === undefined ? stood : null, 0, 0, kept === undefined ? null : Math.min(kept, stood))
      } else {
        const moved = drawn(row.kind === 'file' ? pool.file : pool.unit, arrived, true)
        if (moved >= size(arrived)) accept(holds)
        else refuse(null, size(arrived), moved)
      }
    }
    return 1
  }
  const first = chain.states.findIndex(state => state.rows !== null)
  if (first < 0) return null
  const head = chain.states[first]!
  const base = first === 0 ? head.id : head.parent
  if (base === null) return null
  const allowed: Table = new Map(first === 0 ? head.rows! : [])
  const rest = chain.states.slice(first === 0 ? 1 : first).filter(state => state.rows !== null)
  const next = rest[0]
  if (next !== undefined) {
    const lacking = (): string[] => [...next.rows!.values()].filter(row => !allowed.has(keyOf(row))).map(row => row.file)
    const take = (rows: Table): void => {
      for (const [key, row] of rows) if (!allowed.has(key)) allowed.set(key, row)
    }
    if (first !== 0) take(measured(base, rest.flatMap(state => [...state.rows!.values()].map(row => row.file))))
    else if (lacking().length > 0) take(measured(base, lacking()))
    if (first !== 0 && lacking().length > 0) take(measured(base, chain.touched(base, next.id)))
  }
  const marks = new Map<string, Mark>()
  let prev = base
  let last = base
  let stood: Table = new Map(allowed)
  let read = 0
  for (const state of rest) {
    stood = new Map(allowed)
    last = prev
    read += settle(prev, state, allowed, marks)
    prev = state.id
  }
  const tip = rest.at(-1)?.id ?? base
  let pool: ReturnType<typeof pools> | null = null
  const since = (row: Row): { arrived: number; moved: number } | null => {
    if (row.kind !== 'unit' && row.kind !== 'file') return null
    chain.load?.(last, [row.file])
    const now = at(tip, row.file)
    const arrived = now === null ? null : arrivedIn(row, at(last, row.file), now)
    if (arrived === null) return null
    pool ??= pools(last, tip, stood)
    return { arrived: size(arrived), moved: drawn(row.kind === 'file' ? pool.file : pool.unit, arrived, false) }
  }
  return { stood, marks, read, writes: rest.length - 1, base: first === 0 ? null : base, since }
}

const worth = (kind: Kind): string => (kind === 'table' ? 'entries' : 'lines')
const called = (row: Row): string => (row.kind === 'file' ? row.file : `${row.file} ${row.name}`)
const holder = (kind: Kind): string => (kind === 'file' ? 'file' : 'unit')
const DO = (row: Row): string => (row.kind === 'file' ? 'move part of the file into a file of its own' : row.kind === 'unit' ? `move part of ${row.name} into a function or file of its own` : `move part of ${row.name} into a ${row.kind} of its own`)
const LAW = `A unit is a function, a class, a variable whose initialiser is a function, or the argument of a call that wraps code (buildTool({ … }), memo(…)), at the top level of a file. Every unit over ${UNIT_CEILING} lines and every file over ${FILE_CEILING} has a row, and no row rises, by new lines or by moved ones. A row is new only for lines that left a unit that has a row (a file that has one, for a file's row), matched line for line: the head and the last line of the new unit and the import lines of the new file are not counted. bun ${SELF} --write lowers a row, writes one that is new so and drops one that is gone; it raises none`
const some = <T>(found: T[], line: (one: T) => string): string =>
  found
    .slice(0, 40)
    .map(one => `\n      ${line(one)}`)
    .join('') + (found.length > 40 ? `\n      … and ${found.length - 40} more` : '')
const arrivals = (row: Row, arrived: number, moved: number): string =>
  arrived > 0 && moved >= arrived ? `all ${arrived} lines that arrived in it left a ${holder(row.kind)} that has a row, and a row does not rise by moved lines either` : `of the ${arrived} lines that arrived in it, ${moved} left a ${holder(row.kind)} that has a row and the rest is new`
const LOST = `; a row that one write of the table left out comes back at the next write alone, so if a write lost this one by mistake, name that commit as FLOOR in ${SELF}`
const spoken = (id: string): string => (id === 'HEAD' ? 'the last commit' : id.endsWith('^') ? `the commit before ${id.slice(0, 10)}` : `commit ${id.slice(0, 10)}`)

const told = (over: Over[], walked: Walked | null): string =>
  `${over.length} above — ${LAW}:` +
  some(over, ({ row, allowed }) => {
    const is = row.kind === 'file' ? `${row.file}: the file is ${row.count} lines` : `${row.file}: ${row.name} ${row.kind === 'unit' ? 'is' : 'holds'} ${row.count} ${worth(row.kind)}`
    if (allowed === null && (row.kind === 'table' || row.kind === 'text')) return `${is} and has no row — bun ${SELF} --write writes the row of what stands on the list of data`
    const counted = walked?.since(row) ?? null
    if (counted !== null && counted.arrived === 0) return `${is} and ${allowed === null ? 'has no row' : `its row allows ${allowed}`}; no line arrived in it since the last write of the table, which is out of step with its tree — bun ${SELF} --write mends a row that the last write alone left out or set too low`
    if (allowed === null && counted !== null && counted.moved >= counted.arrived) return `${is} and has no row; all ${counted.arrived} lines that arrived in it left a ${holder(row.kind)} that has a row — bun ${SELF} --write writes its row`
    return `${is} and ${allowed === null ? `has no row, so it may hold at most ${row.kind === 'file' ? FILE_CEILING : UNIT_CEILING}` : `its row allows ${allowed}`}${counted === null ? '' : `; ${arrivals(row, counted.arrived, counted.moved)}`} — ${DO(row)}`
  })

const toldMarks = (marks: Mark[], fresh: Table): string =>
  `${marks.length} row${marks.length === 1 ? '' : 's'} — ${LAW}:` +
  some(marks, mark => {
    const holds = fresh.get(keyOf(mark.row))?.count ?? 0
    if (mark.allowed !== null) return `${called(mark.row)}: its row says ${mark.row.count} ${worth(mark.row.kind)} and may say ${mark.allowed} at most: raised by hand in ${mark.at}; the tree holds ${holds} — ${holds > mark.allowed ? `${DO(mark.row)}, then ` : ''}bun ${SELF} --write puts the row at what the tree holds`
    return `${called(mark.row)}: its row of ${mark.row.count} ${worth(mark.row.kind)} is new in ${mark.at}${mark.stood === null ? `; ${arrivals(mark.row, mark.arrived, mark.moved)}` : `, where it stood at ${mark.stood} with no row`} — ${DO(mark.row)}${mark.stood === null ? '' : LOST}`
  })

const toldRefused = (marks: Mark[]): string =>
  `${marks.length} row${marks.length === 1 ? '' : 's'} — ${LAW}:` +
  some(marks, mark => {
    if (mark.allowed !== null) return `${called(mark.row)}: its row says ${mark.allowed} ${worth(mark.row.kind)} and the tree holds ${mark.row.count}: --write lowers a row and never raises one${mark.at === WORKING_TREE ? '' : ` (the table has stood above its row since ${mark.at}, by hand)`} — ${DO(mark.row)}`
    return `${called(mark.row)}: it holds ${mark.row.count} ${worth(mark.row.kind)} and has no row${mark.stood === null ? `; ${arrivals(mark.row, mark.arrived, mark.moved)}` : `, and it stood at ${mark.stood} with none before`} — ${DO(mark.row)}${mark.stood === null ? '' : LOST}`
  })

const toldStrays = (strays: Stray[]): string =>
  `${strays.length} statement${strays.length === 1 ? '' : 's'} — a statement over ${UNIT_CEILING} lines at the top level of a file is a unit, or it is data that stands on the list LISTED in ${SELF} with one phrase for what it is:` +
  some(strays, stray => `${stray.file}:${stray.line} ${stray.name === NO_NAME ? 'the statement' : stray.name} is ${stray.lines} lines and ${stray.why} — cut it into statements of ${UNIT_CEILING} lines or fewer, or list it there with what it is and how it is counted (table: in entries; text: in lines; grows: not held)`)

function sourceFiles(root: string): string[] {
  const out: string[] = []
  const walkDir = (rel: string): void => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      if (rel === 'src' && AT_THE_ROOT.has(name)) continue
      const path = `${rel}/${name}`
      if (statSync(join(root, path)).isDirectory()) walkDir(path)
      else if (CODE.test(name)) out.push(path)
    }
  }
  walkDir('src')
  return out
}

function git(root: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function blobs(root: string, names: string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (names.length === 0) return out
  const held = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: names.map(name => `${name}\n`).join(''), maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'] })
  let at = 0
  for (const name of names) {
    const end = held.indexOf(10, at)
    if (end < 0) throw new Error(`git cat-file --batch stopped before ${name}`)
    const head = held.toString('utf8', at, end).split(' ')
    at = end + 1
    if (head.length !== 3 || head[1] !== 'blob') continue
    const bytes = Number(head[2])
    out.set(name, held.toString('utf8', at, at + bytes))
    at += bytes + 1
  }
  return out
}

function gitChain(root: string, files: string[], texts: ReadonlyMap<string, string>, rows: Table): Chain | string {
  const floor = (git(root, 'rev-parse', '--verify', '--quiet', `${FLOOR}^{commit}`) ?? '').trim()
  if (floor === '') return `the floor ${FLOOR.slice(0, 10)} named in ${SELF} is no commit of this clone`
  if ((git(root, 'merge-base', floor, 'HEAD') ?? '').trim() !== floor) return `HEAD does not descend from the floor ${FLOOR.slice(0, 10)} named in ${SELF}`
  const writes = (git(root, 'rev-list', '--first-parent', '--reverse', `${floor}..HEAD`, '--', TABLE) ?? '').split('\n').filter(Boolean)
  const tables = blobs(root, [floor, ...writes].map(commit => `${commit}:${TABLE}`))
  const states: State[] = [floor, ...writes].map((commit, i) => ({ id: commit, name: `commit ${commit.slice(0, 10)}`, rows: tables.has(`${commit}:${TABLE}`) ? tableOf(tables.get(`${commit}:${TABLE}`)!) : null, parent: i === 0 ? null : `${commit}^` }))
  states.push({ id: WORKING_TREE, name: WORKING_TREE, rows, parent: 'HEAD' })
  const held = new Map<string, Map<string, string | null>>()
  const differs = new Map<string, Set<string>>()
  let indexed: Set<string> | null = null
  const touched = (from: string, to: string): Set<string> => {
    const key = `${from}\u0000${to}`
    if (!differs.has(key)) {
      const differ = (git(root, 'diff', '--name-only', '--no-renames', ...(to === WORKING_TREE ? [from] : [from, to]), '--', 'src') ?? '').split('\n').filter(file => CODE.test(file))
      indexed ??= new Set((git(root, 'ls-files', '--', 'src') ?? '').split('\n'))
      differs.set(key, new Set(to === WORKING_TREE ? [...differ, ...files.filter(file => !indexed!.has(file))] : differ))
    }
    return differs.get(key)!
  }
  const asTree = (id: string, file: string): boolean => id === WORKING_TREE || !touched(id, WORKING_TREE).has(file)
  const load = (id: string, wanted: string[]): void => {
    if (id === WORKING_TREE) return
    const mine = held.get(id) ?? new Map<string, string | null>()
    held.set(id, mine)
    const missing = [...new Set(wanted)].filter(file => !mine.has(file) && !asTree(id, file))
    const got = blobs(root, missing.map(file => `${id}:${file}`))
    for (const file of missing) mine.set(file, got.get(`${id}:${file}`) ?? null)
  }
  return {
    states,
    read: (id, file) => {
      if (asTree(id, file)) return texts.get(file) ?? null
      load(id, [file])
      return held.get(id)!.get(file) ?? null
    },
    touched: (from, to) => [...touched(from, to)].sort(),
    load,
    asTree,
  }
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

function plantedEstate(): void {
  type Files = Record<string, string>
  type Step = { name: string; files: Files; rows: Table | null }
  const NONE: Data = new Map()
  const body = (n: number, word = 'step'): string[] => Array.from({ length: n }, (_, i) => `  ${word}(${i})`)
  const fn = (name: string, lines: number, word?: string): string[] => [`export function ${name}(): void {`, ...body(lines - 2, word), '}']
  const text = (lines: string[]): string => lines.join('\n') + '\n'
  const held = (files: Files): Map<string, Measure> => new Map(Object.entries(files).map(([file, source]) => [file, measure(file, source)]))
  const rowed = (files: Files, data: Data = NONE): Table => rowsOf(held(files), data)
  const chainOf = (steps: Step[]): Chain => ({
    states: steps.map((step, i) => ({ id: String(i), name: step.name, rows: step.rows, parent: i === 0 ? null : String(i - 1) })),
    read: (id, file) => steps[Number(id)]!.files[file] ?? null,
    touched: (from, to) => [...new Set([...Object.keys(steps[Number(from)]!.files), ...Object.keys(steps[Number(to)]!.files)])].filter(file => steps[Number(from)]!.files[file] !== steps[Number(to)]!.files[file]).sort(),
  })
  const walked = (steps: Step[], data: Data = NONE): Walked => walk(chainOf(steps), new Map(), data)!
  const said = (found: Walked): string => [...found.marks.values()].map(mark => `${called(mark.row)} ${mark.row.count} ${mark.allowed ?? (mark.stood === null ? 'new' : `stood ${mark.stood}`)} ${mark.arrived}/${mark.moved} in ${mark.at}`).join(' · ')
  const floor = (files: Files, data: Data = NONE): Step => ({ name: 'the floor', files, rows: rowed(files, data) })
  const written = (from: Files, to: Files, data: Data = NONE): string => said(walked([floor(from, data), { name: WORKING_TREE, files: to, rows: rowed(to, data) }], data))
  const stands = (files: Files, rows: Table, data: Data = NONE): string => judge(rowed(files, data), rows).map(o => `${called(o.row)} ${o.row.count} ${o.allowed ?? 'no row'}`).join(' · ')
  const P = 'src/planted'

  const kinds = text([
    "import { step } from './step.ts'",
    ...fn('declared', 5),
    'export class Held<',
    '  T,',
    '> {',
    '  run(): void {',
    '    step(1)',
    '  }',
    '}',
    'export const arrow = (): void => {',
    ...body(8),
    '}',
    'export const cast = ((): void => {',
    ...body(10),
    '}) as () => void',
    'export const table = {',
    ...Array.from({ length: 40 }, (_, i) => `  row${i}: ${i},`),
    '}',
    'export const wrapped = memo(',
    '  function Inner(',
    '    props: Props,',
    '  ): void {',
    ...body(30),
    '  },',
    ')',
    'export const tool = buildTool({',
    '  name: "tool",',
    '  async call(): Promise<void> {',
    ...body(20),
    '  },',
    '} satisfies ToolDef)',
    'export const twice = memo(forwardRef((props: Props): void => {',
    ...body(6),
    '}))',
    'export const both = memoize(',
    '  (a: number): number => {',
    ...body(4),
    '  },',
    '  (a: number): string => {',
    ...body(3),
    '  },',
    ')',
    'export const recipes = withCaching([{ id: 1 }, ...[2, 3].map(id => ({ id }))])',
    'export const frozen = Object.freeze({ a: 1, b: 2 })',
    'type Shape = {',
    ...Array.from({ length: 50 }, (_, i) => `  field${i}: number`),
    '}',
    'export default function (): void {',
    ...body(1),
    '}',
  ])
  const seen = measure(`${P}/kinds.ts`, kinds)
  const sizes = seen.parts.map(part => `${part.name} ${sizeOf(part)}/${part.head}`).join(' ')
  check(
    'a unit is a function, a class, a variable whose initialiser is a function (an arrow, a function expression, either one in parentheses or under a cast) or the argument of a call that wraps code (a function, an object or a list that holds one, a wrap inside a wrap), at the top level of a file; it is named by the function, the class or the variable and measured from its first line to its last, the wrapped one by the argument alone, and by the first such argument to the last where a call takes several; its head ends on the line that opens its body; a table, a type and a call that wraps data alone are no units; every unit of a file is taken, and the file with its lines',
    sizes === 'declared 5/1 Held 7/3 arrow 10/1 cast 12/1 wrapped 34/3 tool 25/1 twice 8/1 both 11/1 recipes 1/1 default 3/1' && seen.lines === lineCount(kinds) && measure(`${P}/empty.ts`, 'export const table = { a: 1 }\n').parts.length === 0 && measure(`${P}/empty.ts`, '').lines === 0 && measure(`${P}/one.ts`, 'export const a = 1').lines === 1,
    sizes,
  )

  const wide = text(fn('wide', UNIT_CEILING + 1))
  const narrow = text(fn('narrow', UNIT_CEILING))
  const long = text(Array.from({ length: FILE_CEILING + 1 }, (_, i) => `export const c${i} = ${i}`))
  const level = text(Array.from({ length: FILE_CEILING }, (_, i) => `export const c${i} = ${i}`))
  const two = text([...fn('one', UNIT_CEILING + 40), ...fn('other', UNIT_CEILING + 5), ...fn('third', 20)])
  const firstRows = render(rowed({ [`${P}/wide.ts`]: wide, [`${P}/narrow.ts`]: narrow, [`${P}/long.ts`]: long, [`${P}/level.ts`]: level, [`${P}/two.ts`]: two }))
  check(
    `the table holds a row for every unit over ${UNIT_CEILING} lines, the second of a file as the first, and one for every file over ${FILE_CEILING} lines, in the order of the files, and reads back as written; a unit or a file at its ceiling has none`,
    firstRows === `${P}/long.ts\tfile\t-\t${FILE_CEILING + 1}\n${P}/two.ts\tunit\tone\t${UNIT_CEILING + 40}\n${P}/two.ts\tunit\tother\t${UNIT_CEILING + 5}\n${P}/wide.ts\tunit\twide\t${UNIT_CEILING + 1}\n` && render(tableOf(firstRows) ?? new Map()) === firstRows,
    firstRows.replaceAll('\n', ' · '),
  )
  check(
    'a table does not read with a file outside src, a row twice, a unit at or under its ceiling, a file at or under its own, a kind that is none of the four, a file row with a name, a number that is no count, or the rows of the first shape (a file, its longest unit and two numbers)',
    [`scripts/a.ts\tunit\tf\t400\n`, `src/a.ts\tunit\tf\t400\nsrc/a.ts\tunit\tf\t400\n`, `src/a.ts\tunit\tf\t${UNIT_CEILING}\n`, `src/a.ts\tfile\t-\t${FILE_CEILING}\n`, `src/a.ts\tclass\tf\t400\n`, `src/a.ts\tfile\tf\t1600\n`, `src/a.ts\tunit\tf\tmany\n`, `src/a.ts\tf\t400\t500\n`, `src/a.ts\ttext\t400\t500\n`].every(lines => tableOf(lines) === null) && tableOf('')?.size === 0,
  )

  const big = fn('runBig', 400)
  const BIG = `${P}/big.ts`
  const SMALL = `${P}/small.ts`
  const MOVED = `${P}/moved.ts`
  const estate: Files = { [BIG]: text(["import { step } from './step.ts'", ...big, ...fn('helper', 20, 'help')]), [SMALL]: text(fn('small', 40)) }
  const table = rowed(estate)
  check('on its own table the planted estate stands', stands(estate, table) === '' && render(table) === `${BIG}\tunit\trunBig\t400\n` && written(estate, estate) === '')

  const newUnit = { ...estate, [SMALL]: text(fn('small', UNIT_CEILING + 1)) }
  const first = judge(rowed(newUnit), table)
  check(
    `canary 1: a new function of ${UNIT_CEILING + 1} lines in a file with no row is named with the file, the unit, its lines and what to do, and the table is not written for it`,
    first.length === 1 && told(first, null).includes(`${SMALL}: small is ${UNIT_CEILING + 1} lines and has no row, so it may hold at most ${UNIT_CEILING} — move part of small into a function or file of its own`) && written(estate, newUnit) === `${SMALL} small ${UNIT_CEILING + 1} new 261/0 in ${WORKING_TREE}`,
    `${told(first, null)} | ${written(estate, newUnit)}`,
  )
  const grownBig = { ...estate, [BIG]: text(["import { step } from './step.ts'", ...fn('runBig', 410), ...fn('helper', 20, 'help')]) }
  const second = judge(rowed(grownBig), table)
  const sinceTheFloor = walked([floor(estate), { name: WORKING_TREE, files: grownBig, rows: table }])
  check(
    'canary 2: ten lines added to a unit that has a row are named against the row, with how many arrived and how many of them moved in, and the table is not written for them',
    second.length === 1 && told(second, sinceTheFloor).includes(`${BIG}: runBig is 410 lines and its row allows 400; of the 10 lines that arrived in it, 0 left a unit that has a row and the rest is new — move part of runBig into a function or file of its own`) && said(sinceTheFloor) === '' && written(estate, grownBig) === `${BIG} runBig 410 400 0/0 in ${WORKING_TREE}`,
    `${told(second, sinceTheFloor)} | ${written(estate, grownBig)}`,
  )
  const lifted = new Map(table)
  lifted.set(keyOf({ file: BIG, kind: 'unit', name: 'runBig' }), { file: BIG, kind: 'unit', name: 'runBig', count: 410 })
  const third = walked([floor(estate), { name: WORKING_TREE, files: estate, rows: lifted }])
  const fallen = { ...estate, [BIG]: text(["import { step } from './step.ts'", ...fn('runBig', 350), ...fn('helper', 20, 'help')]) }
  check(
    'canary 3: a row raised by hand is named with what it says, the most it may say and where it was raised; a row left above its unit by a fall is not',
    said(third) === `${BIG} runBig 410 400 0/0 in ${WORKING_TREE}` && toldMarks([...third.marks.values()], table).includes(`${BIG} runBig: its row says 410 lines and may say 400 at most: raised by hand in ${WORKING_TREE}; the tree holds 400 — bun ${SELF} --write puts the row at what the tree holds`) && said(walked([floor(estate), { name: WORKING_TREE, files: fallen, rows: table }])) === '' && stands(fallen, table) === '',
    `${said(third)} | ${toldMarks([...third.marks.values()], table)}`,
  )
  const moved: Files = { [BIG]: text(["import { step } from './step.ts'", "import { runBig } from './moved.ts'", ...fn('helper', 20, 'help')]), [SMALL]: estate[SMALL]!, [MOVED]: text(["import { step } from './step.ts'", ...big]) }
  const movedRows = rowed(moved)
  check(
    'canary 4: a unit moved whole to a new file is let through when the table is written, though the new file adds its imports and the old one the import of what left: the new row is written and the old one is dropped',
    written(estate, moved) === '' && stands(moved, movedRows) === '' && stands(moved, table) === `${MOVED} runBig 400 no row` && render(movedRows) === `${MOVED}\tunit\trunBig\t400\n`,
    `${written(estate, moved)} | ${render(movedRows).replaceAll('\n', ' · ')}`,
  )
  const grownAfter = { ...moved, [MOVED]: text(["import { step } from './step.ts'", ...fn('runBig', 410)]) }
  const fifth = judge(rowed(grownAfter), movedRows)
  check(
    'canary 5: the new file then grown is named against its row, and the table is not written for it: nothing left a unit that has a row',
    fifth.length === 1 && told(fifth, walked([floor(moved), { name: WORKING_TREE, files: grownAfter, rows: movedRows }])).includes(`${MOVED}: runBig is 410 lines and its row allows 400; of the 10 lines that arrived in it, 0 left a unit that has a row and the rest is new`) && written(moved, grownAfter) === `${MOVED} runBig 410 400 0/0 in ${WORKING_TREE}`,
    `${told(fifth, null)} | ${written(moved, grownAfter)}`,
  )

  const wrapper = { ...estate, [BIG]: text(["import { step } from './step.ts'", ...fn('helper', 20, 'help')]), [MOVED]: text(['export function wrapper(): void {', '  begin()', ...big.slice(1, -1), '  end()', '}']) }
  const paidByDeletion = { [BIG]: text(fn('helper', 20, 'help')), [SMALL]: text(fn('small', 440, 'fresh')) }
  const nearly = { ...estate, [SMALL]: text([...fn('small', UNIT_CEILING - 10), ...fn('aide', 30, 'aid')]) }
  const fromItsFile = { ...estate, [SMALL]: text(['export function small(): void {', ...body(UNIT_CEILING - 12), ...body(28, 'aid'), '}']) }
  const fromNoRow = { ...estate, [SMALL]: text(fn('aide', 30, 'aid')), [MOVED]: text(fn('small', UNIT_CEILING + 20)) }
  check(
    'a row is new only by lines that left a unit that has a row: lines written new around moved text, lines that only replace a deletion, lines drawn in from a unit of the same file that has no row and a unit that left a file where it had no row are each refused',
    written(estate, wrapper) === `${MOVED} wrapper 402 new 400/398 in ${WORKING_TREE}` && written(estate, paidByDeletion) === `${SMALL} small 440 new 438/0 in ${WORKING_TREE}` && written(nearly, fromItsFile) === `${SMALL} small 318 new 28/0 in ${WORKING_TREE}` && written(nearly, fromNoRow) === `${MOVED} small 320 new 318/0 in ${WORKING_TREE}`,
    `${written(estate, wrapper)} | ${written(estate, paidByDeletion)} | ${written(nearly, fromItsFile)} | ${written(nearly, fromNoRow)}`,
  )

  const WIDE = `${P}/wide.ts`
  const whole = fn('runWide', 700)
  const tail = ['export function runTail(): void {', ...whole.slice(350, -1), '}']
  const one: Files = { [WIDE]: text(whole) }
  const split: Files = { [WIDE]: text([...whole.slice(0, 350), '}', ...tail]) }
  const tailGrown: Files = { [WIDE]: text([...whole.slice(0, 350), '}', ...tail.slice(0, -1), ...body(30, 'fresh'), '}']) }
  const beside = { ...estate, [BIG]: estate[BIG]! + text(fn('second', 340, 'fresh')) }
  check(
    'every unit is held, not the longest of its file alone: a new unit of 340 new lines beside a longer one that has a row is refused; a unit split in two inside its file is written, each half with a row, the head and the last line of the new half not counted; and the shorter half then grown by new lines is named against its own row and not written',
    stands(beside, table) === `${BIG} second 340 no row` && written(estate, beside) === `${BIG} second 340 new 338/0 in ${WORKING_TREE}` && written(one, split) === '' && render(rowed(split)) === `${WIDE}\tunit\trunTail\t351\n${WIDE}\tunit\trunWide\t351\n` && stands(tailGrown, rowed(split)) === `${WIDE} runTail 381 351` && written(split, tailGrown) === `${WIDE} runTail 381 351 0/0 in ${WORKING_TREE}`,
    `${stands(beside, table)} | ${written(estate, beside)} | ${written(one, split)} | ${render(rowed(split)).replaceAll('\n', ' · ')} | ${stands(tailGrown, rowed(split))} | ${written(split, tailGrown)}`,
  )

  const A = `${P}/a.ts`
  const B = `${P}/b.ts`
  const pair: Files = { [A]: text(fn('runA', 400, 'a')), [B]: text(fn('runB', 400, 'b')) }
  const drawnIn: Files = { [A]: text(fn('runA', 390, 'a')), [B]: text(['export function runB(): void {', ...body(398, 'b'), ...body(398, 'a').slice(388), '}']) }
  const tall = Array.from({ length: FILE_CEILING + 100 }, (_, i) => `export const c${i} = ${i}`)
  const others = Array.from({ length: FILE_CEILING + 50 }, (_, i) => `export const d${i} = ${i}`)
  const TALL = `${P}/tall.ts`
  const OTHER = `${P}/other.ts`
  const HALF = `${P}/half.ts`
  const tallEstate: Files = { [TALL]: text(tall), [OTHER]: text(others) }
  const tallMoved: Files = { [TALL]: text(tall.slice(0, FILE_CEILING + 40)), [OTHER]: text([...others, ...tall.slice(FILE_CEILING + 40)]) }
  const tallGrown: Files = { ...tallEstate, [OTHER]: text([...others, ...Array.from({ length: 10 }, (_, i) => `export const e${i} = ${i}`)]) }
  const half = tall.slice(0, FILE_CEILING + 10)
  const tallSplit: Files = { ...tallEstate, [TALL]: text(tall.slice(FILE_CEILING + 10)), [HALF]: text(["import { step } from './step.ts'", ...half]) }
  const tallSplitAndGrown: Files = { ...tallSplit, [HALF]: text(["import { step } from './step.ts'", ...half, 'export const fresh = step']) }
  check(
    `no row rises, by new lines or by moved ones: lines that leave one unit with a row for another are refused in the one that grew, and so are lines that leave one file over ${FILE_CEILING} lines for another; a file's row is new only by lines that left a file that has a row, the import lines of the new file not counted and a line that is no import counted`,
    written(pair, drawnIn) === `${B} runB 410 400 0/0 in ${WORKING_TREE}` && told(judge(rowed(drawnIn), rowed(pair)), walked([floor(pair), { name: WORKING_TREE, files: drawnIn, rows: rowed(pair) }])).includes(`${B}: runB is 410 lines and its row allows 400; all 10 lines that arrived in it left a unit that has a row, and a row does not rise by moved lines either — move part of runB into a function or file of its own`) && written(tallEstate, tallMoved) === `${OTHER} ${FILE_CEILING + 110} ${FILE_CEILING + 50} 0/0 in ${WORKING_TREE}` && written(tallEstate, tallGrown) === `${OTHER} ${FILE_CEILING + 60} ${FILE_CEILING + 50} 0/0 in ${WORKING_TREE}` && written(tallEstate, tallSplit) === '' && render(rowed(tallSplit)) === `${HALF}\tfile\t-\t${FILE_CEILING + 11}\n${OTHER}\tfile\t-\t${FILE_CEILING + 50}\n` && written(tallEstate, tallSplitAndGrown) === `${HALF} ${FILE_CEILING + 12} new ${FILE_CEILING + 11}/${FILE_CEILING + 10} in ${WORKING_TREE}`,
    `${written(pair, drawnIn)} | ${written(tallEstate, tallMoved)} | ${written(tallEstate, tallGrown)} | ${written(tallEstate, tallSplit)} | ${written(tallEstate, tallSplitAndGrown)}`,
  )

  const TOOL = `${P}/tool.ts`
  const toolOf = (lines: number, word?: string): string => text(["import { buildTool } from './build.ts'", 'export const Tool = buildTool({', "  name: 'Tool',", '  async call(): Promise<void> {', ...body(lines - 5, word), '  },', '})'])
  const wrappedEstate: Files = { [TOOL]: toolOf(320) }
  const wrappedGrown: Files = { [TOOL]: toolOf(330) }
  const wrappedMoved: Files = { [TOOL]: text(["export { Tool } from './moved.ts'"]), [MOVED]: toolOf(320) }
  check(
    'the argument of a wrapping call is held as any unit: it has a row under the name of the variable, ten new lines in it are named against that row and not written, and moved whole to a new file it is written',
    render(rowed(wrappedEstate)) === `${TOOL}\tunit\tTool\t320\n` && stands(wrappedGrown, rowed(wrappedEstate)) === `${TOOL} Tool 330 320` && written(wrappedEstate, wrappedGrown) === `${TOOL} Tool 330 320 0/0 in ${WORKING_TREE}` && written(wrappedEstate, wrappedMoved) === '' && render(rowed(wrappedMoved)) === `${MOVED}\tunit\tTool\t320\n`,
    `${render(rowed(wrappedEstate)).replaceAll('\n', ' · ')} | ${stands(wrappedGrown, rowed(wrappedEstate))} | ${written(wrappedEstate, wrappedGrown)} | ${written(wrappedEstate, wrappedMoved)}`,
  )

  const ROWS = `${P}/rows.ts`
  const SOURCE = `${P}/source.ts`
  const PAGES = `${P}/pages.ts`
  const rowsOfTable = (entries: number, longer = 0): string => text(['export const ROWS = {', ...Array.from({ length: entries }, (_, i) => (i < longer ? [`  row${i}:`, `    ${i},`] : [`  row${i}: ${i},`])).flat(), '}'])
  const sourceOf = (lines: number): string => text(['export const SOURCE = `', ...Array.from({ length: lines }, (_, i) => `print(${i})`), '`'])
  const pagesOf = (lines: number): string => text(['export const PAGES = `', ...Array.from({ length: lines }, (_, i) => `- line ${i}`), '`', 'export const LATEST = 1'])
  const list: Data = new Map([
    [`${ROWS}\tROWS`, { kind: 'table', what: 'a planted table' }],
    [`${SOURCE}\tSOURCE`, { kind: 'text', what: 'a planted text' }],
    [`${PAGES}\tPAGES`, { kind: 'grows', what: 'a planted text that may grow' }],
  ])
  const dataEstate: Files = { [ROWS]: rowsOfTable(320), [SOURCE]: sourceOf(320), [PAGES]: pagesOf(FILE_CEILING + 200) }
  const strays = straysOf(held(dataEstate), NONE)
  const oneMore = { ...dataEstate, [ROWS]: rowsOfTable(321) }
  const longerEntry = { ...dataEstate, [ROWS]: rowsOfTable(320, 9) }
  const longerText = { ...dataEstate, [SOURCE]: sourceOf(321) }
  const morePages = { ...dataEstate, [PAGES]: pagesOf(FILE_CEILING + 900) }
  check(
    `data is declared: a statement over ${UNIT_CEILING} lines that is no unit and stands on no list is named with what to do; on the list a table is held by its entries and a text by its lines, and one more of either is named against its row and not written, while an entry may grow longer; what the list lets grow has no row and its lines are not the file's; a listing whose statement is gone is named`,
    strays.length === 3 && toldStrays(strays).includes(`${ROWS}:1 ROWS is 322 lines and is neither a unit nor on the list of data — cut it into statements of ${UNIT_CEILING} lines or fewer, or list it there`) && straysOf(held(dataEstate), list).length === 0 && render(rowed(dataEstate, list)) === `${ROWS}\ttable\tROWS\t320\n${SOURCE}\ttext\tSOURCE\t322\n` && stands(oneMore, rowed(dataEstate, list), list) === `${ROWS} ROWS 321 320` && written(dataEstate, oneMore, list) === `${ROWS} ROWS 321 320 0/0 in ${WORKING_TREE}` && stands(longerEntry, rowed(dataEstate, list), list) === '' && written(dataEstate, longerEntry, list) === '' && written(dataEstate, longerText, list) === `${SOURCE} SOURCE 323 322 0/0 in ${WORKING_TREE}` && stands(morePages, rowed(dataEstate, list), list) === '' && written(dataEstate, morePages, list) === '' && staleOf(held({ ...dataEstate, [ROWS]: rowsOfTable(20) }), list).join() === `${ROWS}\tROWS` && staleOf(held(dataEstate), list).length === 0,
    `${strays.length} | ${toldStrays(strays)} | ${render(rowed(dataEstate, list)).replaceAll('\n', ' · ')} | ${stands(oneMore, rowed(dataEstate, list), list)} | ${written(dataEstate, oneMore, list)} | ${written(dataEstate, longerEntry, list)} | ${written(dataEstate, longerText, list)} | ${written(dataEstate, morePages, list)} | ${staleOf(held({ ...dataEstate, [ROWS]: rowsOfTable(20) }), list).join()}`,
  )

  const raisedAt: Step = { name: 'commit A', files: grownBig, rows: lifted }
  const oneLater: Step = { name: 'commit B', files: grownBig, rows: lifted }
  const cutBack: Step = { name: 'commit C', files: fallen, rows: rowed(fallen) }
  const atItsCommit = walked([floor(estate), raisedAt, { name: WORKING_TREE, files: grownBig, rows: lifted }])
  const later = walked([floor(estate), raisedAt, oneLater, { name: WORKING_TREE, files: grownBig, rows: lifted }])
  const afterTheCut = walked([floor(estate), raisedAt, oneLater, cutBack, { name: WORKING_TREE, files: fallen, rows: rowed(fallen) }])
  const byHand = new Map([...table, ...rowed(newUnit)])
  const bornByHand = walked([floor(estate), { name: 'commit A', files: newUnit, rows: byHand }, { name: 'commit B', files: newUnit, rows: byHand }, { name: WORKING_TREE, files: newUnit, rows: byHand }])
  const writeLater = walked([floor(estate), raisedAt, oneLater, { name: WORKING_TREE, files: grownBig, rows: rowed(grownBig) }])
  check(
    'every write of the table since the floor is read against the one before: ten new lines with their row raised by hand to match are named at the commit that raised it, one commit later and at every write after, with that commit, and the table is not written over them; a unit new by hand is named the same way; once the unit is cut back under the row it had, nothing is named',
    said(atItsCommit) === `${BIG} runBig 410 400 0/0 in commit A` && said(later) === said(atItsCommit) && toldMarks([...later.marks.values()], rowed(grownBig)).includes(`${BIG} runBig: its row says 410 lines and may say 400 at most: raised by hand in commit A; the tree holds 410 — move part of runBig into a function or file of its own, then bun ${SELF} --write puts the row at what the tree holds`) && toldRefused([...writeLater.marks.values()]).includes(`${BIG} runBig: its row says 400 lines and the tree holds 410: --write lowers a row and never raises one (the table has stood above its row since commit A, by hand)`) && said(afterTheCut) === '' && said(bornByHand) === `${SMALL} small ${UNIT_CEILING + 1} new 261/0 in commit A`,
    `${said(atItsCommit)} | ${said(later)} | ${toldRefused([...writeLater.marks.values()])} | ${said(afterTheCut)} | ${said(bornByHand)}`,
  )
  const noTable: Step = { name: 'the floor', files: estate, rows: null }
  const firstTable = walked([noTable, { name: 'commit A', files: estate, rows: table }, { name: WORKING_TREE, files: estate, rows: table }])
  const firstTableRaised = walked([noTable, { name: 'commit A', files: grownBig, rows: lifted }, { name: WORKING_TREE, files: grownBig, rows: lifted }])
  const unread = walked([floor(estate), { name: 'commit A', files: estate, rows: null }, { name: WORKING_TREE, files: grownBig, rows: lifted }])
  check(
    'where the floor holds no table that reads, the first one after it is held to what the commit before it measures, so that it raises nothing either; a write that does not read is passed over and the next is read against the last that did',
    said(firstTable) === '' && firstTable.base === '0' && said(firstTableRaised) === `${BIG} runBig 410 400 0/0 in commit A` && said(unread) === `${BIG} runBig 410 400 0/0 in ${WORKING_TREE}` && unread.base === null,
    `${said(firstTable)} | ${said(firstTableRaised)} | ${said(unread)}`,
  )
  const without: Step = { name: 'commit A', files: estate, rows: new Map() }
  const back = walked([floor(estate), without, { name: WORKING_TREE, files: estate, rows: table }])
  const backHigher = walked([floor(estate), without, { name: WORKING_TREE, files: grownBig, rows: lifted }])
  const tooLate = walked([floor(estate), without, { name: 'commit B', files: estate, rows: new Map() }, { name: WORKING_TREE, files: estate, rows: table }])
  const tooLow: Step = { name: 'commit A', files: estate, rows: rowed(fallen) }
  const up = walked([floor(estate), tooLow, { name: WORKING_TREE, files: estate, rows: table }])
  const upHigher = walked([floor(estate), tooLow, { name: WORKING_TREE, files: grownBig, rows: lifted }])
  const afterACut = walked([floor(estate), { name: 'commit A', files: fallen, rows: rowed(fallen) }, { name: WORKING_TREE, files: estate, rows: table }])
  const firstLeftOut = walked([noTable, without, { name: WORKING_TREE, files: estate, rows: table }])
  check(
    'a write of the table that is out of step with its tree is mended by the next write alone: a row it left out while the unit stood, or set below what the unit held, comes back at the number it had and not above it, and so it is when that write is the first table after a floor that holds none; left out by two writes it reads as a unit that stood with no row, and a row lowered by a true cut does not come back',
    said(back) === '' && said(backHigher) === `${BIG} runBig 410 400 0/0 in ${WORKING_TREE}` && said(tooLate) === `${BIG} runBig 400 stood 400 0/0 in ${WORKING_TREE}` && said(up) === '' && said(upHigher) === `${BIG} runBig 410 400 0/0 in ${WORKING_TREE}` && said(afterACut) === `${BIG} runBig 400 350 0/0 in ${WORKING_TREE}` && said(firstLeftOut) === '',
    `${said(back)} | ${said(backHigher)} | ${said(tooLate)} | ${said(up)} | ${said(upHigher)} | ${said(afterACut)} | ${said(firstLeftOut)}`,
  )
}

section('§0 the reader on a planted estate: what a unit is, the table, the five canaries, and the laws of a row')
plantedEstate()

section(`§1 the estate: every unit and the lines of each TypeScript file under src, against ${TABLE}`)
const files = sourceFiles(ROOT)
const texts = new Map(files.map(file => [file, readFileSync(join(ROOT, file), 'utf8')]))
const held = new Map(files.map(file => [file, measure(file, texts.get(file)!)]))
const fresh = rowsOf(held, DATA)
const text = existsSync(join(ROOT, TABLE)) ? readFileSync(join(ROOT, TABLE), 'utf8') : null
const table = text === null ? null : tableOf(text)
const of = (kind: Kind, rows: Table = fresh): Row[] => [...rows.values()].filter(row => row.kind === kind)
const linesIn = (kind: Kind, rows: Table = fresh): number => of(kind, rows).reduce((n, row) => n + row.count, 0)
const grows = [...held].flatMap(([file, m]) => m.parts.filter(part => listedAs(file, part, DATA)?.kind === 'grows').map(part => sizeOf(part)))
console.log(
  `  ${files.length} TypeScript files under src · ${of('unit').length} units over ${UNIT_CEILING} lines in ${new Set(of('unit').map(row => row.file)).size} files, ${of('unit').filter(row => row.count > 1000).length} of them over 1000, ${linesIn('unit')} lines in all · ${of('file').length} files over ${FILE_CEILING} lines, ${linesIn('file')} lines in all · on the list of data: ${of('table').length} tables held by their entries, ${of('text').length} texts held by their lines, ${grows.length} that may grow (${grows.reduce((n, c) => n + c, 0)} lines today)`,
)
check(`the TypeScript under src is read (${files.length} files)`, files.length > 3000, `${files.length} files read, more than 3000 wanted`)
const strays = straysOf(held, DATA)
check(`every statement over ${UNIT_CEILING} lines at the top level of a file is a unit or stands on the list of data (${LISTED.length} listed)`, strays.length === 0, toldStrays(strays))
const stale = staleOf(held, DATA)
check(`every statement on the list of data stands in its file and is over ${UNIT_CEILING} lines`, stale.length === 0, `${stale.length} listed and gone — take each off LISTED in ${SELF}:` + some(stale, key => key.replace('\t', ' ')))
if (process.argv.includes('--list')) {
  for (const row of [...fresh.values()].sort((a, b) => b.count - a.count)) console.log(`${row.count}\t${row.kind}\t${row.name}\t${row.file}`)
} else if (process.argv.includes('--write')) {
  const chain = gitChain(ROOT, files, texts, fresh)
  if (failures > 0) console.log('  nothing written: the reader failed on its own estate, or a statement is neither a unit nor listed')
  else if (typeof chain === 'string') {
    const raised = [...fresh.values()].filter(row => (table?.get(keyOf(row))?.count ?? row.count) < row.count).map((row): Mark => ({ at: WORKING_TREE, row, allowed: table!.get(keyOf(row))!.count, stood: null, arrived: 0, moved: 0 }))
    check(`--write raises no row of the table as it stands (${chain}: no write of the table is read from git)`, raised.length === 0, `nothing written — ${toldRefused(raised)}`)
    if (raised.length === 0) {
      writeFileSync(join(ROOT, TABLE), render(fresh))
      console.log(`  wrote ${TABLE}: ${fresh.size} rows (${chain}: a row that is new was written as the tree holds it)`)
    }
  } else {
    const walked = walk(chain, held, DATA)!
    const refused = [...walked.marks.values()]
    check(`--write lowers a row, writes one that is new by lines that moved and drops one that is gone; it raises none (the floor ${FLOOR.slice(0, 10)}; ${walked.writes} write${walked.writes === 1 ? '' : 's'} of the table since)`, refused.length === 0, `nothing written — ${toldRefused(refused)}`)
    if (refused.length === 0) {
      const lowered = [...fresh].filter(([key, row]) => (walked.stood.get(key)?.count ?? 0) > row.count).length
      const born = [...fresh.keys()].filter(key => !walked.stood.has(key)).length
      const dropped = [...walked.stood.keys()].filter(key => !fresh.has(key)).length
      writeFileSync(join(ROOT, TABLE), render(fresh))
      console.log(`  wrote ${TABLE}: ${fresh.size} rows; ${lowered} lowered, ${born} new, ${dropped} dropped; the unit rows hold ${linesIn('unit')} lines in all where they held ${linesIn('unit', walked.stood)}, the file rows ${linesIn('file')} where they held ${linesIn('file', walked.stood)}${walked.base === null ? '' : ` (the floor holds no table of this shape: the first one is held to what ${spoken(walked.base)} measures)`}`)
    }
  }
} else if (table === null) {
  check(`${TABLE} reads as rows of a file, a kind (file, unit, table, text), a name and a count`, false, text === null ? `no table: put the table of the last commit back (git checkout -- ${TABLE}); a tree that never held one writes the first with bun ${SELF} --write` : `a row is not a file under src, one of the four kinds, a name and a count over its ceiling, or a row stands twice, or the table is of the first shape or holds the marks of a merge; bun ${SELF} --write writes it again from the tree, and reads the rows it may not raise from git and not from this file`)
} else {
  const started = Date.now()
  const chain = gitChain(ROOT, files, texts, table)
  const walked = typeof chain === 'string' ? null : walk(chain, held, DATA)
  const over = judge(fresh, table)
  check(`nothing is above its row: no unit, no file, no listed table or text; and what has no row is at or under its ceiling, ${UNIT_CEILING} lines a unit and ${FILE_CEILING} a file (${fresh.size} need a row, ${table.size} rows)`, over.length === 0, told(over, walked))
  if (walked === null) console.log(`  the writes of the table are not read: ${chain}; the rows are held to the table as it stands`)
  else {
    const marks = [...walked.marks.values()]
    check(
      `no row was raised and none is new but by lines that moved, in any write of the table since the floor, each read against the one before (the floor ${FLOOR.slice(0, 10)}; ${walked.writes} write${walked.writes === 1 ? '' : 's'} since and the tree as it stands${walked.base === null ? '' : `; the floor holds no table of this shape, so the first one is held to what ${spoken(walked.base)} measures`})`,
      marks.length === 0,
      toldMarks(marks, fresh),
    )
    check(`the writes read against their sources stay few (${walked.read} of ${walked.writes + 1}, ${LINKS_READ_AT_MOST} at most; ${Date.now() - started} ms over git)`, walked.read <= LINKS_READ_AT_MOST, `name a later commit as FLOOR in ${SELF}, one whose table the gate judged green: the writes before it are then not read, and what its table says is taken as written`)
  }
  const slack = [...table].filter(([key, row]) => (fresh.get(key)?.count ?? 0) < row.count).length
  if (slack > 0) console.log(`  rows above what the tree holds: ${slack} (bun ${SELF} --write lowers them, and drops the row of what is gone or under its ceiling)`)
}
console.log(failures === 0 ? '\nprove-unit-size: green' : `\nprove-unit-size: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
