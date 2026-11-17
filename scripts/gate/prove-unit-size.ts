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
const NO_UNIT = '-'

type Unit = { name: string; lines: number }
type Measure = { unit: string; unitLines: number; lines: number; unitText: string; aside: number }
type Row = { unit: string; unitLines: number; lines: number }
type Table = Map<string, Row>
type Side = (file: string) => string | null
type Since = { from: string; was: Table; touched: string[]; before: Side }
type Over = { file: string; held: Row; row: Row | null }
type Unpaid = { file: string; held: Row; stood: Row; unitRise: number; unitMoved: number; lineRise: number; lineMoved: number }

function scriptKind(file: string): ts.ScriptKind {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

function lineCount(text: string): number {
  if (text === '') return 0
  const breaks = text.split('\n').length - 1
  return text.endsWith('\n') ? breaks : breaks + 1
}

function isFunction(e: ts.Expression | undefined): boolean {
  let cur = e
  while (cur !== undefined && (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isNonNullExpression(cur) || ts.isTypeAssertionExpression(cur))) cur = cur.expression
  return cur !== undefined && (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur))
}

function measure(file: string, text: string): Measure {
  const sf = ts.createSourceFile(join(ROOT, file), text, ts.ScriptTarget.Latest, true, scriptKind(file))
  const span = (node: ts.Node): { lines: number; text: string } => {
    const start = node.getStart(sf)
    return { lines: sf.getLineAndCharacterOfPosition(node.end).line - sf.getLineAndCharacterOfPosition(start).line + 1, text: text.slice(start, node.end) }
  }
  let longest: (Unit & { text: string }) | null = null
  let aside = 0
  const take = (name: string, node: ts.Node): void => {
    const at = span(node)
    if (longest === null || at.lines > longest.lines) longest = { name, lines: at.lines, text: at.text }
  }
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) take(s.name?.text ?? 'default', s)
    else if (ts.isVariableStatement(s) && s.declarationList.declarations.some(d => isFunction(d.initializer))) {
      const alone = s.declarationList.declarations.length === 1
      for (const d of s.declarationList.declarations) if (isFunction(d.initializer)) take(d.name.getText(sf), alone ? s : d)
    } else if (span(s).lines > UNIT_CEILING) aside++
  }
  const found = longest as (Unit & { text: string }) | null
  return { unit: found?.name ?? NO_UNIT, unitLines: found?.lines ?? 0, lines: lineCount(text), unitText: found?.text ?? '', aside }
}

const needsRow = (m: Row): boolean => m.unitLines > UNIT_CEILING || m.lines > FILE_CEILING

function sourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      if (rel === 'src' && AT_THE_ROOT.has(name)) continue
      const path = `${rel}/${name}`
      if (statSync(join(root, path)).isDirectory()) walk(path)
      else if (CODE.test(name)) out.push(path)
    }
  }
  walk('src')
  return out
}

const inOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const render = (rows: Table): string =>
  [...rows]
    .sort(([a], [b]) => inOrder(a, b))
    .map(([file, row]) => `${file}\t${row.unit}\t${row.unitLines}\t${row.lines}\n`)
    .join('')

function tableOf(text: string): Table | null {
  const table: Table = new Map()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const m = /^(src\/[^\t]+)\t([^\t]+)\t(0|[1-9][0-9]*)\t([1-9][0-9]*)$/.exec(line)
    if (!m || table.has(m[1]!)) return null
    const row = { unit: m[2]!, unitLines: Number(m[3]), lines: Number(m[4]) }
    if (!needsRow(row)) return null
    table.set(m[1]!, row)
  }
  return table
}

function rowsOf(held: Map<string, Measure>): Table {
  const rows: Table = new Map()
  for (const [file, m] of held) if (needsRow(m)) rows.set(file, { unit: m.unit, unitLines: m.unitLines, lines: m.lines })
  return rows
}

function judge(held: Map<string, Measure>, table: Table): Over[] {
  const over: Over[] = []
  for (const [file, m] of held) {
    const row = table.get(file) ?? null
    if (m.unitLines > (row?.unitLines ?? UNIT_CEILING) || m.lines > (row?.lines ?? FILE_CEILING)) over.push({ file, held: { unit: m.unit, unitLines: m.unitLines, lines: m.lines }, row })
  }
  return over.sort((a, b) => inOrder(a.file, b.file))
}

const bag = (text: string | null): Map<string, number> => {
  const out = new Map<string, number>()
  if (text === null) return out
  for (const line of text.split('\n')) out.set(line.trim(), (out.get(line.trim()) ?? 0) + 1)
  return out
}

const less = (a: Map<string, number>, b: Map<string, number>): Map<string, number> => {
  const out = new Map<string, number>()
  for (const [line, n] of a) if (n > (b.get(line) ?? 0)) out.set(line, n - (b.get(line) ?? 0))
  return out
}

function drawn(pool: Map<string, number>, wanted: Map<string, number>, spend: boolean): number {
  let got = 0
  for (const [line, n] of wanted) {
    const have = Math.min(n, pool.get(line) ?? 0)
    got += have
    if (spend && have > 0) pool.set(line, (pool.get(line) ?? 0) - have)
  }
  return got
}

function unpaid(was: Table, touched: string[], before: Side, after: Side): Unpaid[] {
  const out: Unpaid[] = []
  const left = new Map<string, Map<string, number>>()
  for (const file of touched) if (was.has(file)) left.set(file, less(bag(before(file)), bag(after(file))))
  for (const file of [...touched].sort()) {
    const now = after(file)
    if (now === null) continue
    const held = measure(file, now)
    if (!needsRow(held)) continue
    const stoodText = before(file)
    const stood = stoodText === null ? { unit: NO_UNIT, unitLines: 0, lines: 0 } : measure(file, stoodText)
    const unitRise = held.unitLines > UNIT_CEILING ? Math.max(0, held.unitLines - stood.unitLines) : 0
    const lineRise = held.lines > FILE_CEILING ? Math.max(0, held.lines - stood.lines) : 0
    if (unitRise === 0 && lineRise === 0) continue
    const pool = new Map<string, number>()
    for (const [other, lines] of left) if (other !== file) for (const [line, n] of lines) pool.set(line, (pool.get(line) ?? 0) + n)
    const arrived = less(bag(now), bag(stoodText))
    const unitMoved = drawn(pool, less(bag(held.unitText), bag(stoodText)), false)
    const lineMoved = drawn(pool, arrived, false)
    for (const [other, lines] of left) if (other !== file) drawn(lines, arrived, true)
    if (unitRise > unitMoved || lineRise > lineMoved) out.push({ file, held: { unit: held.unit, unitLines: held.unitLines, lines: held.lines }, stood: { unit: stood.unit, unitLines: stood.unitLines, lines: stood.lines }, unitRise, unitMoved, lineRise, lineMoved })
  }
  return out
}

function handRaised(was: Table, table: Table, held: Map<string, Measure>): string[] {
  const out: string[] = []
  for (const [file, row] of table) {
    const before = was.get(file)
    const now = held.get(file)
    if (row.unitLines > Math.max(before?.unitLines ?? 0, now?.unitLines ?? 0)) out.push(`${file} ${row.unit}: its row says ${row.unitLines} lines for the unit, the last written table says ${before?.unitLines ?? 0} and the file holds ${now?.unitLines ?? 0}`)
    if (row.lines > Math.max(before?.lines ?? 0, now?.lines ?? 0)) out.push(`${file}: its row says ${row.lines} lines for the file, the last written table says ${before?.lines ?? 0} and the file holds ${now?.lines ?? 0}`)
  }
  return out
}

const DO = (unit: string): string => (unit === NO_UNIT ? 'move part of the file into a file of its own' : `move part of ${unit} into a function or file of its own`)
const MOVE = `A unit is a function, a class or a variable whose initialiser is a function, at the top level of a file. Text that moves whole between files takes its lines along, and bun ${SELF} --write in the same change writes the rows: a new or higher row is written only for lines that left the file of another row`

const told = (over: Over[]): string =>
  `${over.length} file${over.length === 1 ? '' : 's'} above — ${MOVE}:` +
  over
    .slice(0, 40)
    .map(o => `\n      ${o.file}: ${o.held.unit} is ${o.held.unitLines} lines and the file is ${o.held.lines} lines; ${o.row === null ? `it has no row, so a unit holds at most ${UNIT_CEILING} lines and a file at most ${FILE_CEILING}` : `its row allows ${o.row.unitLines} (${o.row.unit}) and ${o.row.lines}`} — ${DO(o.held.unit)}`)
    .join('') +
  (over.length > 40 ? `\n      … and ${over.length - 40} more files` : '')

const toldUnpaid = (found: Unpaid[]): string =>
  `${found.length} file${found.length === 1 ? '' : 's'} — ${MOVE}:` +
  found
    .slice(0, 40)
    .map(u => `\n      ${u.file}: ${u.held.unit} is ${u.held.unitLines} lines and the file is ${u.held.lines} lines; at the last written table they stood at ${u.stood.unitLines} and ${u.stood.lines}; of the ${Math.max(u.unitRise, u.lineRise)} lines that arrived, ${Math.max(u.unitRise > 0 ? u.unitMoved : 0, u.lineRise > 0 ? u.lineMoved : 0)} left the file of another row and the rest is new — ${DO(u.held.unit)}`)
    .join('') +
  (found.length > 40 ? `\n      … and ${found.length - 40} more` : '')

function git(root: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function blobs(root: string, commit: string, files: string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (files.length === 0) return out
  const held = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: files.map(file => `${commit}:${file}\n`).join(''), maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'] })
  let at = 0
  for (const file of files) {
    const end = held.indexOf(10, at)
    if (end < 0) throw new Error(`git cat-file --batch stopped before ${commit}:${file}`)
    const head = held.toString('utf8', at, end).split(' ')
    at = end + 1
    if (head.length !== 3 || head[1] !== 'blob') continue
    const size = Number(head[2])
    out.set(file, held.toString('utf8', at, at + size))
    at += size + 1
  }
  return out
}

function sinceLastWrite(root: string, files: string[]): Since | null {
  const dirty = git(root, 'status', '--porcelain', '--', 'src', TABLE, SELF)
  if (dirty === null) return null
  const lastWrite = (start: string): string => (git(root, 'log', '-1', '--first-parent', '--format=%H', start, '--', TABLE) ?? '').trim()
  let from = lastWrite(dirty.trim() === '' ? 'HEAD^' : 'HEAD')
  let written = from === '' ? null : git(root, 'show', `${from}:${TABLE}`)
  while (from !== '' && written === null) {
    from = lastWrite(`${from}^`)
    written = from === '' ? null : git(root, 'show', `${from}:${TABLE}`)
  }
  if (from === '' || written === null) return null
  const stood = new Set((git(root, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'src') ?? '').split('\n'))
  const differ = (git(root, 'diff', '--name-only', '--no-renames', from, '--', 'src') ?? '').split('\n').filter(file => CODE.test(file))
  const touched = [...new Set([...differ, ...files.filter(file => !stood.has(file))])].sort()
  let held: Map<string, string> | null = null
  return { from, was: tableOf(written) ?? new Map(), touched, before: file => (held ??= blobs(root, from, touched)).get(file) ?? null }
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

function plantedEstate(): void {
  const body = (n: number, word = 'step'): string[] => Array.from({ length: n }, (_, i) => `  ${word}(${i})`)
  const fn = (name: string, lines: number, word?: string): string[] => [`export function ${name}(): void {`, ...body(lines - 2, word), '}']
  const text = (lines: string[]): string => lines.join('\n') + '\n'
  const kinds = text([
    "import { step } from './step.ts'",
    ...fn('declared', 5),
    'export class Held {',
    '  run(): void {',
    '    step(1)',
    '    step(2)',
    '    step(3)',
    '  }',
    '}',
    'export const arrow = (): void => {',
    ...body(8),
    '}',
    'const spelled = function (): void {',
    ...body(3),
    '}',
    'export const cast = ((): void => {',
    ...body(10),
    '}) as () => void',
    'export const table = {',
    ...Array.from({ length: 40 }, (_, i) => `  row${i}: ${i},`),
    '}',
    'export const wrapped = memo(() => {',
    ...body(30),
    '})',
    'type Shape = {',
    ...Array.from({ length: 50 }, (_, i) => `  field${i}: number`),
    '}',
    'export default function (): void {',
    ...body(1),
    '}',
  ])
  const seen = measure('src/planted/kinds.ts', kinds)
  check(
    'a unit is a function, a class or a variable whose initialiser is a function (an arrow, a function expression, either one in parentheses or under a cast), at the top level of a file; a table, a call that wraps a function and a type are not units; the longest unit is taken with its lines from its first line to its last, and the file with its own',
    seen.unit === 'cast' && seen.unitLines === 12 && seen.lines === lineCount(kinds) && measure('src/planted/empty.ts', 'export const table = { a: 1 }\n').unit === NO_UNIT && measure('src/planted/empty.ts', '').lines === 0 && measure('src/planted/one.ts', 'export const a = 1').lines === 1,
    `${seen.unit} ${seen.unitLines} of ${seen.lines}`,
  )
  const wide = text(fn('wide', UNIT_CEILING + 1))
  const narrow = text(fn('narrow', UNIT_CEILING))
  const long = text(Array.from({ length: FILE_CEILING + 1 }, (_, i) => `export const c${i} = ${i}`))
  const held = (files: Record<string, string>): Map<string, Measure> => new Map(Object.entries(files).map(([file, body]) => [file, measure(file, body)]))
  const rowed = rowsOf(held({ 'src/planted/wide.ts': wide, 'src/planted/narrow.ts': narrow, 'src/planted/long.ts': long }))
  const written = render(rowed)
  check(
    `the table holds one row for each file whose longest unit is over ${UNIT_CEILING} lines or which is over ${FILE_CEILING} lines, in the order of the files, and reads back as written; a file at a ceiling has no row`,
    written === `src/planted/long.ts\t${NO_UNIT}\t0\t${FILE_CEILING + 1}\nsrc/planted/wide.ts\twide\t${UNIT_CEILING + 1}\t${UNIT_CEILING + 1}\n` && render(tableOf(written) ?? new Map()) === written,
    written.replaceAll('\n', ' · '),
  )
  check('a table with a file outside src, a row twice, a row under both ceilings or a number that is not a count does not read', tableOf('scripts/a.ts\tf\t400\t400\n') === null && tableOf('src/a.ts\tf\t400\t400\nsrc/a.ts\tf\t400\t400\n') === null && tableOf('src/a.ts\tf\t300\t1500\n') === null && tableOf('src/a.ts\tf\tmany\t400\n') === null)
  const big = fn('runBig', 400)
  const estate = { 'src/planted/big.ts': text(["import { step } from './step.ts'", ...big, ...fn('helper', 20, 'help')]), 'src/planted/small.ts': text(fn('small', 40)) }
  const table = rowsOf(held(estate))
  const stands = (files: Record<string, string>, rows: Table): string => judge(held(files), rows).map(o => `${o.file} ${o.held.unit} ${o.held.unitLines} ${o.held.lines}`).join(' · ')
  check('on its own table the planted estate stands', stands(estate, table) === '' && table.size === 1)
  const newUnit = { ...estate, 'src/planted/small.ts': text(fn('small', UNIT_CEILING + 1)) }
  const first = judge(held(newUnit), table)
  check(
    `canary 1: a new function of ${UNIT_CEILING + 1} lines in a file with no row is named with the file, the unit, both numbers and what to do`,
    first.length === 1 && told(first).includes(`src/planted/small.ts: small is ${UNIT_CEILING + 1} lines and the file is ${UNIT_CEILING + 1} lines; it has no row`) && told(first).includes('move part of small into a function or file of its own'),
    told(first),
  )
  const grownBig = { ...estate, 'src/planted/big.ts': text(["import { step } from './step.ts'", ...fn('runBig', 410), ...fn('helper', 20, 'help')]) }
  const second = judge(held(grownBig), table)
  check('canary 2: ten lines added to a unit that has a row are named against the row', second.length === 1 && told(second).includes('src/planted/big.ts: runBig is 410 lines and the file is 431 lines; its row allows 400 (runBig) and 421'), told(second))
  const lifted = new Map(table)
  lifted.set('src/planted/big.ts', { unit: 'runBig', unitLines: 410, lines: 431 })
  const third = handRaised(table, lifted, held(estate))
  check('canary 3: a row raised by hand is named: it stands above the last written table and above what its file holds; a row left above its file by a fall is not', third.length === 2 && third[0] === 'src/planted/big.ts runBig: its row says 410 lines for the unit, the last written table says 400 and the file holds 400' && handRaised(table, table, held({ ...estate, 'src/planted/big.ts': text(fn('runBig', 350)) })).length === 0, third.join(' · '))
  const side = (files: Record<string, string>): Side => file => files[file] ?? null
  const changed = (a: Record<string, string>, b: Record<string, string>): string[] => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(file => a[file] !== b[file]).sort()
  const owed = (a: Record<string, string>, b: Record<string, string>): Unpaid[] => unpaid(rowsOf(held(a)), changed(a, b), side(a), side(b))
  const said = (found: Unpaid[]): string => found.map(u => `${u.file} ${u.held.unit} +${u.unitRise}/${u.unitMoved} +${u.lineRise}/${u.lineMoved}`).join(' · ')
  const moved = { 'src/planted/big.ts': text(["import { step } from './step.ts'", "import { runBig } from './moved.ts'", ...fn('helper', 20, 'help')]), 'src/planted/small.ts': estate['src/planted/small.ts']!, 'src/planted/moved.ts': text(["import { step } from './step.ts'", ...big]) }
  const movedRows = rowsOf(held(moved))
  check(
    'canary 4: a unit moved whole to a new file is let through when the table is written, though the new file adds its imports and the old one the import of what left: the new row is written and the old one is dropped',
    said(owed(estate, moved)) === '' && stands(moved, movedRows) === '' && render(movedRows) === 'src/planted/moved.ts\trunBig\t400\t401\n' && handRaised(table, movedRows, held(moved)).length === 0,
    `${said(owed(estate, moved))} | ${render(movedRows).replaceAll('\n', ' · ')}`,
  )
  const grownAfter = { ...moved, 'src/planted/moved.ts': text(["import { step } from './step.ts'", ...fn('runBig', 410)]) }
  const fifth = judge(held(grownAfter), movedRows)
  check(
    'canary 5: the new file then grown is named against its row, and the table is not written for it: nothing left the file of another row',
    fifth.length === 1 && told(fifth).includes('src/planted/moved.ts: runBig is 410 lines') && said(owed(moved, grownAfter)) === 'src/planted/moved.ts runBig +10/0 +0/0' && toldUnpaid(owed(moved, grownAfter)).includes('of the 10 lines that arrived, 0 left the file of another row and the rest is new'),
    `${told(fifth)} | ${said(owed(moved, grownAfter))}`,
  )
  const wrapper = { ...estate, 'src/planted/big.ts': text(["import { step } from './step.ts'", ...fn('helper', 20, 'help')]), 'src/planted/moved.ts': text(['export function wrapper(): void {', '  begin()', ...big.slice(1, -1), '  end()', '}']) }
  const paidByDeletion = { 'src/planted/big.ts': text(fn('helper', 20, 'help')), 'src/planted/small.ts': text(fn('small', 440, 'fresh')) }
  const withinTheFile = { ...estate, 'src/planted/big.ts': text(["import { step } from './step.ts'", ...fn('runBig', 420, 'help')]) }
  const fromNoRow = { 'src/planted/big.ts': estate['src/planted/big.ts']!, 'src/planted/small.ts': text(fn('small', 10)), 'src/planted/moved.ts': text(fn('small', UNIT_CEILING + 20)) }
  check(
    'a row rises only by lines that left the file of another row: lines written new around moved text, lines that only replace a deletion, lines of the same file drawn into its unit and lines that left a file with no row are each refused',
    said(owed(estate, wrapper)) === 'src/planted/moved.ts wrapper +402/399 +0/399' && said(owed(estate, paidByDeletion)) === 'src/planted/small.ts small +400/0 +0/0' && said(owed(estate, withinTheFile)) === 'src/planted/big.ts runBig +20/0 +0/0' && said(owed({ ...estate, 'src/planted/small.ts': text(fn('small', UNIT_CEILING - 10)) }, fromNoRow)) === 'src/planted/moved.ts small +320/0 +0/0',
    `${said(owed(estate, wrapper))} | ${said(owed(estate, paidByDeletion))} | ${said(owed(estate, withinTheFile))} | ${said(owed({ ...estate, 'src/planted/small.ts': text(fn('small', UNIT_CEILING - 10)) }, fromNoRow))}`,
  )
  const tall = Array.from({ length: FILE_CEILING + 100 }, (_, i) => `export const c${i} = ${i}`)
  const tallEstate = { 'src/planted/tall.ts': text(tall), 'src/planted/other.ts': text(Array.from({ length: FILE_CEILING + 50 }, (_, i) => `export const d${i} = ${i}`)) }
  const tallMoved = { 'src/planted/tall.ts': text(tall.slice(0, FILE_CEILING + 40)), 'src/planted/other.ts': text([...Array.from({ length: FILE_CEILING + 50 }, (_, i) => `export const d${i} = ${i}`), ...tall.slice(FILE_CEILING + 40)]) }
  const tallGrown = { ...tallEstate, 'src/planted/other.ts': text(Array.from({ length: FILE_CEILING + 60 }, (_, i) => `export const d${i} = ${i}`)) }
  check('the lines of a file over the ceiling rise the same way: by lines that left the file of another row, and not by new ones', said(owed(tallEstate, tallMoved)) === '' && said(owed(tallEstate, tallGrown)) === 'src/planted/other.ts - +0/0 +10/0', `${said(owed(tallEstate, tallMoved))} | ${said(owed(tallEstate, tallGrown))}`)
}

section('§0 the reader on a planted estate: what a unit is, the table, and the five canaries')
plantedEstate()

section(`§1 the estate: the longest unit and the lines of each TypeScript file under src, against ${TABLE}`)
const files = sourceFiles(ROOT)
const texts = new Map(files.map(file => [file, readFileSync(join(ROOT, file), 'utf8')]))
const held = new Map(files.map(file => [file, measure(file, texts.get(file)!)]))
const rows = rowsOf(held)
const text = existsSync(join(ROOT, TABLE)) ? readFileSync(join(ROOT, TABLE), 'utf8') : null
const table = text === null ? null : tableOf(text)
const overUnit = (n: number): number => [...held.values()].filter(m => m.unitLines > n).length
const overFile = [...held.values()].filter(m => m.lines > FILE_CEILING).length
const aside = [...held.values()].reduce((n, m) => n + m.aside, 0)
console.log(`  ${files.length} TypeScript files under src · ${rows.size} hold a unit over ${UNIT_CEILING} lines or are over ${FILE_CEILING} lines · longest unit over ${UNIT_CEILING} lines in ${overUnit(UNIT_CEILING)} files, over 1000 in ${overUnit(1000)} · ${overFile} files over ${FILE_CEILING} lines`)
check(`the TypeScript under src is read (${files.length} files)`, files.length > 3000, `${files.length} files read, more than 3000 wanted`)
if (process.argv.includes('--list')) {
  for (const [file, row] of [...rows].sort(([, a], [, b]) => b.unitLines - a.unitLines)) console.log(`${row.unitLines}\t${row.lines}\t${row.unit}\t${file}`)
} else if (process.argv.includes('--write')) {
  const since = sinceLastWrite(ROOT, files)
  const owed = since === null ? [] : unpaid(since.was, since.touched, since.before, file => texts.get(file) ?? null)
  if (failures > 0) console.log('  nothing written: the reader failed on its own estate')
  else if (owed.length > 0) check(`a row is new or higher only by lines that left the file of another row (the last written table: ${since!.from.slice(0, 10)})`, false, `nothing written — ${toldUnpaid(owed)}`)
  else {
    writeFileSync(join(ROOT, TABLE), render(rows))
    console.log(`  wrote ${TABLE}: ${rows.size} rows${since === null ? ' (no commit holds a table: the first one)' : ` (the last written table: ${since.from.slice(0, 10)}; ${since.touched.length} files differ from it)`}`)
  }
} else if (table === null) {
  check(`${TABLE} reads as rows of a file, its longest unit, the unit's lines and the file's lines`, false, text === null ? `no table: put the table of the last commit back (git checkout -- ${TABLE}); a tree that never held one writes the first with bun ${SELF} --write` : `a row is not a file under src, a unit, and two counts of which one is over its ceiling, or a file stands twice; bun ${SELF} --write writes the table again`)
} else {
  const over = judge(held, table)
  check(`no unit and no file is longer than its row allows, and a file with no row holds no unit over ${UNIT_CEILING} lines and is no longer than ${FILE_CEILING} (${rows.size} files need a row, ${table.size} rows)`, over.length === 0, told(over))
  const since = sinceLastWrite(ROOT, files)
  if (since === null) console.log('  no commit to read the last written table from: the rows are held to the table as it stands')
  else {
    const owed = unpaid(since.was, since.touched, since.before, file => texts.get(file) ?? null)
    check(`no row is new or higher than at the last written table but by lines that left the file of another row (${since.from.slice(0, 10)}; ${since.touched.length} files differ from it)`, owed.length === 0, toldUnpaid(owed))
    const lifted = handRaised(since.was, table, held)
    check('no row stands above both the last written table and what its file holds: a row is written by --write and never by hand', lifted.length === 0, `${lifted.length} number${lifted.length === 1 ? '' : 's'} — bun ${SELF} --write puts each row at what its file holds:` + lifted.slice(0, 40).map(row => `\n      ${row}`).join(''))
  }
  const slack = [...table].filter(([file, row]) => (held.get(file)?.unitLines ?? 0) < row.unitLines || (held.get(file)?.lines ?? 0) < row.lines).length
  console.log(`  out of reach, counted here and held by no row: a statement at the top level of a file that is over ${UNIT_CEILING} lines and is no unit, which is a table, a type or a call that wraps a function (${aside} today)`)
  if (slack > 0) console.log(`  rows above what their file holds: ${slack} (bun ${SELF} --write lowers them, and drops a row that is under both ceilings)`)
}
console.log(failures === 0 ? '\nprove-unit-size: green' : `\nprove-unit-size: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
