#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { GENERATORS, NAMED_TOOLS, STEPS, estateOf, factsOf, srcOf, toolsOf, type Estate, type Facts, type Hit } from '../lib/sourceTextReads.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const SELF = 'scripts/gate/prove-source-text-reads.ts'
const TABLE = 'scripts/gate/source-text-reads.tsv'
const INSTEAD = 'import the module and call it, look the value up, or run the built product and read what it prints'

type Row = { pins: number; searches: number; digest: string }
type Table = Map<string, Row>
type Over = { script: string; why: string; lines: Hit[] }
type Verdict = { over: Over[]; pins: number; searches: number; allowed: number; slack: number }

const digestOf = (files: Iterable<string>): string =>
  createHash('sha256')
    .update([...files].sort().join('\n'))
    .digest('hex')
    .slice(0, 12)

function doorOf(file: string): string | null {
  const folder = file.slice(0, file.lastIndexOf('/'))
  for (const ext of ['.ts', '.tsx']) if (existsSync(join(ROOT, folder + ext))) return folder + ext
  return null
}

function rowOf(f: Facts): Row {
  const opened = new Set(f.pins.keys())
  const counted = [...opened].filter(file => {
    const door = doorOf(file)
    return door === null || !opened.has(door)
  })
  return { pins: counted.length, searches: f.searches.length, digest: digestOf(counted) }
}

function rowsOf(facts: Map<string, Facts>): Table {
  const rows: Table = new Map()
  for (const [script, f] of facts) if (f.pins.size > 0) rows.set(script, rowOf(f))
  return rows
}

const render = (rows: Table): string =>
  [...rows]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([script, row]) => `${script}\t${row.pins}\t${row.searches}\t${row.digest}\n`)
    .join('')

function tableOf(text: string): Table | null {
  const table: Table = new Map()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const m = /^(scripts\/[^\t]+)\t([1-9][0-9]*)\t([0-9]+)\t([0-9a-f]{12})$/.exec(line)
    if (!m || table.has(m[1]!)) return null
    table.set(m[1]!, { pins: Number(m[2]), searches: Number(m[3]), digest: m[4]! })
  }
  return table
}

function olderTableOf(text: string): Table {
  const table: Table = new Map()
  for (const line of text.split('\n')) {
    const m = /^(scripts\/[^\t]+)\t([0-9]+)(?:\t([0-9]+)\t([0-9a-f]{12}))?$/.exec(line)
    if (m) table.set(m[1]!, { pins: Number(m[2]), searches: m[3] === undefined ? -1 : Number(m[3]), digest: m[4] ?? '' })
  }
  return table
}

const pinLines = (f: Facts): Hit[] => [...f.pins].map(([file, line]) => ({ file, line }))

function judge(facts: Map<string, Facts>, table: Table): Verdict {
  const over: Over[] = []
  let pins = 0
  let searches = 0
  for (const [script, f] of facts) {
    if (f.pins.size === 0) continue
    const now = rowOf(f)
    pins += now.pins
    searches += now.searches
    const row = table.get(script)
    if (!row) over.push({ script, why: 'has no row', lines: pinLines(f) })
    else if (now.pins > row.pins) over.push({ script, why: `its row allows ${row.pins} file${row.pins === 1 ? '' : 's'}`, lines: pinLines(f) })
    else if (now.searches > row.searches) over.push({ script, why: `its row allows ${row.searches} search${row.searches === 1 ? '' : 'es'}`, lines: f.searches })
    else if (now.pins === row.pins && now.digest !== row.digest) over.push({ script, why: 'its row holds the same number of other files, so one was swapped for another', lines: pinLines(f) })
  }
  let allowed = 0
  let slack = 0
  for (const [script, row] of table) {
    allowed += row.pins
    const f = facts.get(script)
    if (!f || f.pins.size < row.pins || f.searches.length < row.searches) slack++
  }
  return { over, pins, searches, allowed, slack }
}

function refused(facts: Map<string, Facts>, table: Table, movedFrom: Map<string, string>): Over[] {
  const out: Over[] = []
  for (const [script, f] of facts) {
    if (f.pins.size === 0) continue
    const now = rowOf(f)
    const from = table.has(script) ? script : movedFrom.get(script)
    const row = from === undefined ? undefined : table.get(from)
    if (!row) out.push({ script, why: 'is new: a row is added only when it moves with its file, by git mv and then --write', lines: pinLines(f) })
    else if (now.pins > row.pins) out.push({ script, why: `opens more files than the ${row.pins} of ${from === script ? 'its row' : `the row of ${from}`}`, lines: pinLines(f) })
    else if (now.searches > row.searches) out.push({ script, why: `searches more often than the ${row.searches} of ${from === script ? 'its row' : `the row of ${from}`}`, lines: f.searches })
  }
  return out
}

function movedIn(root: string): Map<string, string> {
  const moved = new Map<string, string>()
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    const since = git('log', '-1', '--format=%H', '--', TABLE).trim() || 'HEAD'
    for (const line of git('diff', '--cached', '-M', '--name-status', since, '--', 'scripts').split('\n')) {
      const [status, from, to] = line.split('\t')
      if (status?.startsWith('R') && from && to) moved.set(to, from)
    }
  } catch {
    return moved
  }
  return moved
}

function risen(base: Table, tip: Table, movedFrom: Map<string, string>): { lines: string[]; higher: number } {
  const lines: string[] = []
  let higher = 0
  for (const [script, row] of [...tip].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const from = base.has(script) ? script : movedFrom.get(script)
    const was = from === undefined ? undefined : base.get(from)
    const moved = from !== undefined && from !== script ? ` (moved from ${from})` : ''
    const after = `${row.pins} files, ${row.searches} searches`
    if (!was) lines.push(`NEW   ${after}\t${script}`)
    else if (row.pins > was.pins || (was.searches >= 0 && row.searches > was.searches)) lines.push(`ROSE  ${was.pins} files${was.searches >= 0 ? `, ${was.searches} searches` : ''} -> ${after}\t${script}${moved}`)
    else if (was.digest !== '' && row.pins === was.pins && row.digest !== was.digest) lines.push(`SWAP  ${row.pins} files, other files than before\t${script}${moved}`)
    if (!was || row.pins > was.pins || (was.searches >= 0 && row.searches > was.searches)) higher++
  }
  return { lines, higher }
}

const told = (over: Over[], facts: Map<string, Facts>): string =>
  over
    .slice(0, 25)
    .map(o => {
      const f = facts.get(o.script)
      const head = `\n      ${o.script} opens ${f?.pins.size ?? 0} src file${f?.pins.size === 1 ? '' : 's'} as text and searches ${f?.searches.length ?? 0} time${f?.searches.length === 1 ? '' : 's'} in what it read: ${o.why}:`
      return head + o.lines.slice(0, 80).map(h => `\n        ${o.script}:${h.line} ${h.file}`).join('') + (o.lines.length > 80 ? `\n        … and ${o.lines.length - 80} more lines` : '')
    })
    .join('') + (over.length > 25 ? `\n      … and ${over.length - 25} more scripts` : '')

let failures = 0
let onPlanted = false
const plantedHint = 'to fix, change how factsOf, srcOf or toolsOf read a script in scripts/lib/sourceTextReads.ts, or the table functions judge, refused, risen, tableOf and render in this file, until the planted estate reads as the check says'
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  const shown = !cond && onPlanted ? (detail ? `${detail} (${plantedHint})` : plantedHint) : detail
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && shown ? ` — ${shown}` : ''}`)
}
const section = (t: string): void => {
  onPlanted = t.startsWith('§0')
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

function plantedEstate(): void {
  const ONE = 'src/planted/one.ts'
  const TWO = 'src/planted/two.tsx'
  const THREE = 'src/planted/deep/three.ts'
  const JSON_ROWS = 'src/planted/rows.json'
  const LONE = 'src/lone.ts'
  const planted: Array<{ file: string; lines: string[]; events: Array<[number, string]>; searches: number; namesOnly: string[] }> = [
    {
      file: 'scripts/lib/door.ts',
      lines: ["import { readFileSync } from 'node:fs'", "import { join, resolve } from 'node:path'", "const ROOT = resolve(import.meta.dir, '..', '..')", "export const text = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')", 'export function loneText(): string {', "  return readFileSync(join(ROOT, 'src/lone.ts'), 'utf8')", '}'],
      events: [[6, LONE]],
      searches: 0,
      namesOnly: [],
    },
    {
      file: 'scripts/a/prove-pins.ts',
      lines: [
        "import { execFileSync, execSync } from 'node:child_process'",
        "import { readFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        "import { loneText, text } from '../lib/door.ts'",
        "import raw from '../../src/planted/rows.json' with { type: 'text' }",
        "const ROOT = join(import.meta.dir, '..', '..')",
        "const whole = readFileSync(join(ROOT, 'src/planted/one.ts'), 'utf8')",
        "const segments = readFileSync(join(ROOT, 'src', 'planted', 'two.tsx'), 'utf8')",
        "const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')",
        "const deep = (name: string): string => readFileSync(join(ROOT, 'src', 'planted', 'deep', name), 'utf8')",
        "const three = deep('three.ts')",
        "const dotted = read('src/planted/../lone.ts')",
        "const listed = ['src/planted/one.ts', 'src/planted/two.tsx'].map(rel => read(rel))",
        "const table = { one: 'src/planted/one.ts' }",
        'for (const rel of Object.values(table)) console.log(read(rel).length)',
        "const through = text('src/planted/deep/three.ts')",
        'const door = loneText()',
        "const shown = execFileSync('git', ['show', 'HEAD:src/planted/two.tsx'], { encoding: 'utf8' })",
        "const command = execSync('grep -c export src/planted/two.tsx src/lone.ts')",
        "const late = await import('../../src/planted/one.ts')",
        'const body = String(late.one)',
        'const has = (hay: string, needle: string): boolean => hay.includes(needle)',
        "console.log(whole.includes('a') && /b/.test(segments), three.split('\\n').length, has(dotted, 'c'), has(door, 'd'), body.indexOf('e'), listed.join('').match(/f/), through.startsWith('g'), raw.endsWith('h'))",
        'console.log(shown, command)',
      ],
      events: [[5, JSON_ROWS], [7, ONE], [8, TWO], [11, THREE], [12, LONE], [13, ONE], [13, TWO], [15, ONE], [16, THREE], [17, LONE], [18, TWO], [19, LONE], [19, TWO], [23, LONE], [23, THREE], [23, ONE], [23, JSON_ROWS], [23, TWO]],
      searches: 9,
      namesOnly: [],
    },
    {
      file: 'scripts/a/prove-names.ts',
      lines: [
        "import { spawnSync } from 'node:child_process'",
        "import { existsSync, writeFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        "const ROOT = join(import.meta.dir, '..', '..')",
        "const LISTED = ['src/planted/one.ts', 'src/planted/two.tsx']",
        "const label = { 'src/planted/deep/three.ts': 'a label' }",
        String.raw`const pattern = /src\/planted\/rows\.json$/`,
        "const there = existsSync(join(ROOT, 'src/lone.ts'))",
        "writeFileSync(join(scratch, 'src', 'planted', 'one.ts'), 'export {}')",
        "const ran = spawnSync(process.execPath, [join(ROOT, 'src/planted/two.tsx')])",
        "console.log('the row type lives in src/planted/deep/three.ts.', LISTED.includes(process.argv[2] ?? ''), label, pattern, there, ran)",
      ],
      events: [],
      searches: 0,
      namesOnly: [ONE, TWO, THREE, JSON_ROWS, LONE],
    },
    {
      file: 'scripts/a/prove-imports.ts',
      lines: [
        "import { one } from '../../src/planted/one.ts'",
        "import '../../src/lone.ts'",
        "import type { Two } from '../../src/planted/two.tsx'",
        "import rows from '../../src/planted/rows.json' with { type: 'json' }",
        "export { three } from '../../src/planted/deep/three.ts'",
        "export * from '../../src/lone.ts'",
        "import legacy = require('../../src/planted/one.ts')",
        "const late = await import('../../src/planted/one.ts')",
        "const joined = await import(join(ROOT, 'src', 'planted', 'deep', 'three.ts'))",
        "const href = await import(pathToFileURL(join(SRC, 'lone.ts')).href)",
        "const old = require('../../src/planted/one.ts')",
        "type Three = import('../../src/planted/deep/three.ts').Three",
        "type Lone = typeof import('../../src/lone.ts')",
        "mock.module('../../src/planted/one.ts', () => ({ one: 2 }))",
        "const load = (rel: string): Promise<unknown> => import(join(ROOT, 'src', rel))",
        "const loaded = await load('planted/one.ts')",
        'async function stub(rel: string, over: object): Promise<void> {',
        '  const target = join(ROOT, rel)',
        '  const actual = await import(target)',
        '  mock.module(target, () => ({ ...actual, ...over }))',
        '}',
        "await stub('src/planted/two.tsx', {})",
        "const child = `import { one } from '${ROOT}/src/planted/one.ts'\\nconsole.log(one)`",
        "const inline = ['bun', '-e', \"const m = await import('./src/lone.ts'); console.log(m)\"]",
        "const quoted = `const m = await import(${JSON.stringify(join(ROOT, 'src/planted/one.ts'))})`",
        'const onTemplate = await import(`${SRC}/planted/one.ts`)',
        '// a comment may name src/planted/one.ts',
        'export const out = [one, rows, legacy, late.one.length, joined, href, old, loaded, child, inline, quoted, onTemplate]',
      ],
      events: [],
      searches: 0,
      namesOnly: [],
    },
    {
      file: 'scripts/a/prove-closed.ts',
      lines: [
        "import { readFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        "const ROOT = join(import.meta.dir, '..', '..')",
        "const load = async (rel: string): Promise<{ mod: unknown; text: string }> => ({ mod: await import(join(ROOT, rel)), text: readFileSync(join(ROOT, rel), 'utf8') })",
        "const { text } = await load('src/planted/one.ts')",
        "const picked = await import(readFileSync(join(ROOT, 'src/lone.ts'), 'utf8').includes('x') ? 'node:path' : 'node:os')",
        "const { join: j } = await import('node:path')",
        "const aliased = readFileSync(j(ROOT, 'src/planted/two.tsx'), 'utf8')",
        "console.log(text.includes('y'), picked, aliased)",
      ],
      events: [[5, ONE], [6, LONE], [8, TWO], [9, ONE]],
      searches: 2,
      namesOnly: [],
    },
    {
      file: 'scripts/a/run-all.sh',
      lines: ['#!/usr/bin/env bash', '# gate-watch: src/planted/one.ts src/lone.ts', 'set -u', 'grep -c export src/planted/one.ts', 'test -s "$ROOT/src/planted/deep/three.ts"', "bun -e \"import { one } from './src/planted/one.ts'; console.log(one)\"", 'cat "${SRC_DIR}/planted/two.tsx"', 'cd "$ROOT/src" && cat lone.ts', 'grep -c import src/planted/one.ts'],
      events: [[4, ONE], [5, THREE], [7, TWO], [9, ONE]],
      searches: 4,
      namesOnly: [],
    },
    { file: 'scripts/a/reader.py', lines: ['# src/planted/one.ts in a comment', "text = open('src/planted/two.tsx').read()", "rows = open(os.path.join(ROOT, 'src', 'planted', 'rows.json')).read()"], events: [[2, TWO], [3, JSON_ROWS]], searches: 2, namesOnly: [] },
    { file: 'scripts/a/hook', lines: ['#!/bin/sh', 'grep -q export src/lone.ts'], events: [[2, LONE]], searches: 1, namesOnly: [] },
    { file: 'scripts/a/list.txt', lines: ['# paths a reader opens', 'src/lone.ts', 'planted/deep/three.ts'], events: [], searches: 0, namesOnly: [] },
    { file: 'scripts/a/notes.md', lines: ['src/planted/one.ts is where the rows live'], events: [], searches: 0, namesOnly: [] },
    { file: 'scripts/a/packed.bin', lines: ['\0src/planted/one.ts'], events: [], searches: 0, namesOnly: [] },
    {
      file: 'scripts/a/out-of-reach.ts',
      lines: [
        'const name = process.argv[2]',
        "const built = readFileSync(join(ROOT, 'src/planted', name + '.ts'), 'utf8')",
        "const walked = readdirSync(join(ROOT, 'src', 'planted')).map(f => readFileSync(join(ROOT, 'src', 'planted', f), 'utf8'))",
        "const globbed = new Bun.Glob('src/planted/*.ts')",
        "const handed = readFileSync(process.argv[3] ?? '', 'utf8')",
        "const other = readFileSync(join(scratch, 'proj', 'src', 'lone.ts'), 'utf8')",
        "const child = execFileSync(process.execPath, ['-e', \"import t from './src/lone.ts' with { type: 'text' }; console.log(t.length)\"])",
        "console.log(built.includes('a'), walked, globbed, handed.includes('b'), other.includes('c'), child)",
      ],
      events: [],
      searches: 0,
      namesOnly: [],
    },
  ]
  const root = mkdtempSync(join(tmpdir(), 'source-text-reads-'))
  for (const { file, lines } of planted) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), lines.join('\n') + '\n')
  }
  const { facts, read, aside } = factsOf(root, { scripts: planted.map(p => p.file), src: srcOf([ONE, TWO, THREE, JSON_ROWS, LONE]), listed: true })
  rmSync(root, { recursive: true, force: true })
  const seen = (file: string): string => {
    const f = facts.get(file)
    return f === undefined ? 'not read' : `opened [${[...f.events].sort((a, b) => Number(a.split(' ')[0]) - Number(b.split(' ')[0]) || (a < b ? -1 : 1)).join(' · ')}] searches ${f.searches.length} names only [${[...f.namesOnly.keys()].sort().join(' ')}]`
  }
  const want = (p: (typeof planted)[number]): string => `opened [${p.events.map(([line, file]) => `${line} ${file}`).sort((a, b) => Number(a.split(' ')[0]) - Number(b.split(' ')[0]) || (a < b ? -1 : 1)).join(' · ')}] searches ${p.searches} names only [${[...p.namesOnly].sort().join(' ')}]`
  const holds = (file: string): boolean => seen(file) === want(planted.find(p => p.file === file)!)
  const differs = (file: string): string => `seen ${seen(file)} · want ${want(planted.find(p => p.file === file)!)}`
  const PINS = 'scripts/a/prove-pins.ts'
  check(
    'a file a script opens as text is a pin, with the line that opens it: a path handed to a read, in one piece or in segments, a text import, a helper of the file that reads what it is handed, a helper that holds the folder and is handed the name, a . or .. inside the path, a list mapped into a read, a table looped into a read, a helper of a module the script imports, handed a path or holding one, a tool that reads (git show, grep), and the source of a function taken from an imported module',
    holds(PINS),
    differs(PINS),
  )
  check('a search on text read from a pinned file is counted where it is made: includes, test, split, indexOf, match, startsWith and endsWith, one for each call of a helper that searches what it is handed (9 on the one line)', facts.get(PINS)?.searches.every(s => s.line === 23) === true && facts.get(PINS)?.searches.length === 9, differs(PINS))
  check('a name that is only listed is no pin and is counted apart: a list nothing opens, a label, a pattern, a test that the file is there, a fixture written under another root, a file run as a program, a sentence', holds('scripts/a/prove-names.ts'), differs('scripts/a/prove-names.ts'))
  check('an import is neither: static, for its effect, of a type, of data, re-exported, assigned from require, dynamic, dynamic on a built path or a template, require, in a type, through mock.module, through a helper that imports what it is handed, in the text of a child program, and neither is a comment', holds('scripts/a/prove-imports.ts'), differs('scripts/a/prove-imports.ts'))
  check('a helper that imports what it is handed and reads it as text too opens it, and so do a read inside the argument of an import and a path joined by a joiner taken under another name', holds('scripts/a/prove-closed.ts'), differs('scripts/a/prove-closed.ts'))
  check('a helper module holds the pin of the file its own function names, and nothing for the path it is handed', holds('scripts/lib/door.ts'), differs('scripts/lib/door.ts'))
  check('in shell, Python and a script with no extension every name on a line that is no comment is taken as opened, and each such line as one search', ['run-all.sh', 'reader.py', 'hook'].every(f => holds(`scripts/a/${f}`)), ['run-all.sh', 'reader.py', 'hook'].map(f => differs(`scripts/a/${f}`)).join(' · '))
  const far = facts.get('scripts/a/out-of-reach.ts')
  check(
    `a data file, a document and a binary file are not read (${read} of ${planted.length} files read, ${aside} set aside that names a src file), and out of reach stay a name assembled at run time, a walked folder, a glob, a path from outside the file, a src folder of another tree and a text import in the text of a child program: no pin, and the script is counted for its folder, its run-time name and its child program`,
    read === planted.length - 3 && aside === 2 && holds('scripts/a/out-of-reach.ts') && far?.folder === true && far.fragment === true && far.childText === true && !facts.has('scripts/a/list.txt') && !facts.has('scripts/a/notes.md') && !facts.has('scripts/a/packed.bin'),
    `${differs('scripts/a/out-of-reach.ts')} · folder ${far?.folder} · run-time name ${far?.fragment} · child program ${far?.childText} · read ${read} · aside ${aside}`,
  )
  const listed = (file: string): string => [...(facts.get(file)?.listed ?? [])].map(([folder, line]) => `${folder}:${line}`).join(' ')
  check(
    'a script that opens files of a folder under src by a name made at run time (a listing, a name put together) is kept with the folder and the line of the first such read; a script that opens only files it names keeps none',
    listed('scripts/a/out-of-reach.ts') === 'src/planted:2' && listed(PINS) === '' && listed('scripts/a/prove-closed.ts') === '',
    `${listed('scripts/a/out-of-reach.ts')} · ${listed(PINS)} · ${listed('scripts/a/prove-closed.ts')}`,
  )
  const rows = rowsOf(facts)
  const text = render(rows)
  const table = tableOf(text)
  const counts = [...rows].map(([script, row]) => `${script} ${row.pins} ${row.searches}`).join(' · ')
  check('the table is one row for each script that opens a src file: the files it opens, its searches, a digest of the files, in order, and reads back as written', counts === 'scripts/lib/door.ts 1 0 · scripts/a/prove-pins.ts 5 9 · scripts/a/prove-closed.ts 3 2 · scripts/a/run-all.sh 3 4 · scripts/a/reader.py 2 2 · scripts/a/hook 1 1' && table !== null && render(table) === text && text.startsWith('scripts/a/hook\t1\t1\t'), counts)
  check('a table with a row that is no script with its two counts and its digest, or with a script twice, does not read', tableOf('scripts/a/hook\t1\n') === null && tableOf('scripts/a/hook\t0\t0\t0123456789ab\n') === null && tableOf('scripts/a/hook\t1\t1\t0123456789ab\nscripts/a/hook\t1\t1\t0123456789ab\n') === null && tableOf('src/lone.ts\t1\t0\t0123456789ab\n') === null)
  if (table === null) return
  const held = judge(facts, table)
  check('on its own table the estate stands: 15 files opened, 18 searches, no row above its script', held.over.length === 0 && held.pins === 15 && held.searches === 18 && held.allowed === 15 && held.slack === 0, JSON.stringify(held))
  const with_ = (script: string, row: Partial<Row>): Table => new Map([...table].map(([s, r]) => [s, s === script ? { ...r, ...row } : r]))
  const without = (script: string): Table => new Map([...table].filter(([s]) => s !== script))
  const unrowed = judge(facts, without('scripts/a/hook'))
  check('a script with no row that opens a file is named with the line and the file', unrowed.over.length === 1 && told(unrowed.over, facts).includes('scripts/a/hook opens 1 src file as text and searches 1 time in what it read: has no row:\n        scripts/a/hook:2 src/lone.ts'), told(unrowed.over, facts))
  const raised = judge(facts, with_('scripts/a/run-all.sh', { pins: 2 }))
  check('a script that opens one file more than its row allows is named with every file it opens', raised.over.length === 1 && ['its row allows 2 files:', 'scripts/a/run-all.sh:4 src/planted/one.ts', 'scripts/a/run-all.sh:5 src/planted/deep/three.ts', 'scripts/a/run-all.sh:7 src/planted/two.tsx'].every(s => told(raised.over, facts).includes(s)), told(raised.over, facts))
  const worded = judge(facts, with_(PINS, { searches: 8 }))
  check('a script that searches once more than its row allows is named with the line and file of every search', worded.over.length === 1 && told(worded.over, facts).includes('its row allows 8 searches:') && told(worded.over, facts).split(`${PINS}:23 `).length === 10, told(worded.over, facts))
  const swapped = judge(facts, with_('scripts/a/prove-closed.ts', { digest: digestOf([ONE, TWO, THREE]) }))
  check('a script that opens as many files as its row and not the same ones is named: one was swapped for another', swapped.over.length === 1 && swapped.over[0]!.why.includes('swapped'), told(swapped.over, facts))
  const fallen = judge(facts, with_('scripts/a/hook', { pins: 2, searches: 3 }))
  check('a row above its script passes and is counted', fallen.over.length === 0 && fallen.slack === 1, JSON.stringify(fallen))
  const moved = new Map([['scripts/a/hook', 'scripts/a/old-hook']])
  const renamed = (row: Row): Table => new Map([...without('scripts/a/hook'), ['scripts/a/old-hook', row]])
  check(
    'the write rule: a row is written when it falls, leaves or holds other files; a new row and a higher row are refused; a row moves with its file when git reads the rename and its counts are no higher',
    refused(facts, table, new Map()).length === 0 &&
      refused(facts, with_('scripts/a/hook', { pins: 5, searches: 5 }), new Map()).length === 0 &&
      refused(facts, with_('scripts/a/prove-closed.ts', { digest: digestOf([ONE, TWO, THREE]) }), new Map()).length === 0 &&
      refused(facts, without('scripts/a/hook'), new Map()).map(o => o.script).join() === 'scripts/a/hook' &&
      refused(facts, with_(PINS, { pins: 4 }), new Map()).map(o => o.script).join() === PINS &&
      refused(facts, with_(PINS, { searches: 8 }), new Map()).map(o => o.script).join() === PINS &&
      refused(facts, renamed({ pins: 1, searches: 1, digest: digestOf([LONE]) }), moved).length === 0 &&
      refused(facts, renamed({ pins: 1, searches: 0, digest: digestOf([LONE]) }), moved).map(o => o.script).join() === 'scripts/a/hook',
    JSON.stringify(refused(facts, renamed({ pins: 1, searches: 0, digest: '' }), moved)),
  )
  const before = new Map([...renamed({ pins: 1, searches: 1, digest: digestOf([LONE]) })].filter(([s]) => s !== 'scripts/a/reader.py').map(([s, r]): [string, Row] => [s, s === PINS ? { ...r, searches: 8 } : s === 'scripts/a/prove-closed.ts' ? { ...r, digest: digestOf([ONE, TWO, THREE]) } : r]))
  const read2 = risen(before, table, moved)
  check(
    'the comparison of two tables prints a row that is new, a row that is higher and a row that holds other files, counts the first two, and passes a row that moved with its file; a table of the older shape gives its count of names for the files',
    read2.higher === 2 && read2.lines.length === 3 && read2.lines.some(l => l.startsWith('NEW ') && l.endsWith('scripts/a/reader.py')) && read2.lines.some(l => l.startsWith('ROSE ') && l.includes('8 searches -> 5 files, 9 searches') && l.endsWith(PINS)) && read2.lines.some(l => l.startsWith('SWAP ') && l.endsWith('scripts/a/prove-closed.ts')) && risen(olderTableOf('scripts/a/hook\t1\nscripts/a/prove-pins.ts\t4\n'), new Map([...table].filter(([s]) => s === 'scripts/a/hook' || s === PINS)), new Map()).lines.join() === `ROSE  4 files -> 5 files, 9 searches\t${PINS}`,
    read2.lines.join(' · '),
  )
  check('an estate git lists nothing of is not read as an empty one: with no file listed the floor fails', floor({ scripts: [], src: srcOf([]), listed: true }, 0) !== '' && floor({ scripts: [SELF], src: srcOf([]), listed: false }, 1) !== '' && floor({ scripts: [SELF], src: srcOf([ONE]), listed: true }, 1) === '')
}

function plantedTools(): void {
  const ONE = 'src/planted/one.ts'
  const LONE = 'src/lone.ts'
  const PACK = 'scripts/release/pack.mjs'
  const MADE = 'scripts/a/prove-made.ts'
  const BOTH = 'scripts/a/prove-both.ts'
  const planted: Array<[string, string[]]> = [
    [PACK, ["import { readFileSync } from 'node:fs'", "import { join, resolve } from 'node:path'", "const ROOT = resolve(import.meta.dirname, '..', '..')", 'export function made() {', "  return readFileSync(join(ROOT, 'src/lone.ts'), 'utf8')", '}']],
    [MADE, ["import { made } from '../release/pack.mjs'", "console.log(made().includes('x'))"]],
    [BOTH, ["import { readFileSync } from 'node:fs'", "import { join } from 'node:path'", "import { made } from '../release/pack.mjs'", "const ROOT = join(import.meta.dir, '..', '..')", "console.log(made().includes('x'), readFileSync(join(ROOT, 'src/planted/one.ts'), 'utf8').includes('y'))"]],
  ]
  const root = mkdtempSync(join(tmpdir(), 'source-text-tools-'))
  for (const [file, lines] of planted) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), lines.join('\n') + '\n')
  }
  const scripts = planted.map(([file]) => file)
  const src = srcOf([ONE, LONE])
  const followed = factsOf(root, { scripts, src, listed: true }).facts
  const aside = factsOf(root, { scripts, src, listed: true, tools: toolsOf(scripts, '') }).facts
  rmSync(root, { recursive: true, force: true })
  const seen = (facts: Map<string, Facts>, file: string): string => {
    const f = facts.get(file)
    return f === undefined ? 'not read' : `[${[...f.pins.keys()].sort().join(' ')}] ${f.searches.length}`
  }
  const named = toolsOf(
    ['scripts/gen/make.ts', 'scripts/gen/prove-made.ts', 'scripts/release/pack.mjs', 'scripts/release/prove-pack.ts', 'scripts/release/run-all.sh', 'scripts/b/other.ts', ...NAMED_TOOLS],
    '# asset\tbun scripts/b/other.ts\na.json\tbun run build.ts && bun scripts/gen/make.ts\tbun scripts/gen/prove-made.ts\tsrc/**\nb.json\tbun scripts/gen/prove-made.ts --record\tbun scripts/gen/prove-made.ts\tsrc/**\nc.json\tbun scripts/gen/gone.ts\t\tsrc/**\n',
  )
  check(
    `a tool is a script the generator column of ${GENERATORS} names, a file under scripts/release/ or one of the ${NAMED_TOOLS.length} the reader names, and never a file named prove-* or run-all.sh, a script only a comment or a check column names, or one git does not list`,
    [...named].join(' ') === ['scripts/gen/make.ts', ...NAMED_TOOLS, 'scripts/release/pack.mjs'].sort().join(' '),
    [...named].join(' '),
  )
  check(
    'a tool is not read and what a script takes from it is not followed: a test that searches only what a tool returns opens nothing, a test that also reads a file itself keeps that file and its own search, and with no tool named the same estate charges all three scripts',
    seen(aside, PACK) === 'not read' && seen(aside, MADE) === '[] 0' && seen(aside, BOTH) === `[${ONE}] 1` && seen(followed, PACK) === `[${LONE}] 0` && seen(followed, MADE) === `[${LONE}] 1` && seen(followed, BOTH) === `[${LONE} ${ONE}] 2`,
    `set aside: ${[PACK, MADE, BOTH].map(f => seen(aside, f)).join(' · ')} — followed: ${[PACK, MADE, BOTH].map(f => seen(followed, f)).join(' · ')}`,
  )
}

function setAside(estate: Estate, facts: Map<string, Facts>): void {
  const before = rowsOf(factsOf(ROOT, { ...estate, tools: new Set() }).facts)
  const after = rowsOf(facts)
  const lines = [...before].filter(([script, row]) => after.get(script)?.pins !== row.pins || after.get(script)?.searches !== row.searches).sort(([a], [b]) => (a < b ? -1 : 1))
  const less = (of: (row: Row) => number): number => lines.reduce((n, [script, row]) => n + of(row) - (after.has(script) ? of(after.get(script)!) : 0), 0)
  console.log(`\n  set aside as tooling, and so in no count above: ${less(r => r.pins)} files opened and ${less(r => r.searches)} searches in ${lines.length} scripts (a tool reads src to do its work; a script that takes from a tool is charged only for what it opens itself):`)
  for (const [script, row] of lines) {
    const now = after.get(script)
    console.log(`    ${estate.tools?.has(script) ? 'a tool      ' : 'takes from one'}  ${row.pins} files, ${row.searches} searches${now ? ` -> ${now.pins} files, ${now.searches} searches` : ''}\t${script}`)
  }
}

function floor(estate: Estate, read: number): string {
  if (!estate.listed) return `git lists nothing here: run the proof inside the checkout, with no GIT_DIR, GIT_INDEX_FILE or GIT_WORK_TREE in its environment`
  if (!estate.scripts.includes(SELF)) return `git lists ${estate.scripts.length} files under scripts and not ${SELF}: the proof reads the files git lists, so a tree git lists nothing of proves nothing`
  return read === 0 ? 'no script was read' : ''
}

function report(facts: Map<string, Facts>): void {
  const readers = new Map<string, number>()
  for (const f of facts.values()) for (const file of f.pins.keys()) readers.set(file, (readers.get(file) ?? 0) + 1)
  const top = (m: Map<string, number>): string =>
    [...m]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 40)
      .map(([name, n]) => `\n  ${String(n).padStart(5)}  ${name}`)
      .join('')
  console.log(`\n  the 40 src files most scripts open as text (scripts that open the file; ${readers.size} files are opened by at least one):${top(readers)}`)
  console.log(`\n  the 40 scripts that open the most src files:${top(new Map([...facts].map(([script, f]) => [script, f.pins.size])))}`)
  console.log(`\n  the 40 scripts with the most searches in what they read:${top(new Map([...facts].map(([script, f]) => [script, f.searches.length])))}`)
  console.log(`\n  the 40 scripts with the most names only:${top(new Map([...facts].map(([script, f]) => [script, f.namesOnly.size])))}`)
}

function readersOf(facts: Map<string, Facts>, files: string[]): void {
  const byName = (a: [string, Facts], b: [string, Facts]): number => (a[0] < b[0] ? -1 : 1)
  for (const file of files) {
    const opens = [...facts].filter(([, f]) => f.pins.has(file)).sort(byName)
    const names = [...facts].filter(([, f]) => f.namesOnly.has(file)).sort(byName)
    const folder = dirname(file)
    const lists = [...facts].filter(([, f]) => f.listed.has(folder.toLowerCase()) && !f.pins.has(file)).sort(byName)
    console.log(`\n  ${file}: ${opens.length} scripts open it as text · ${names.length} only name it · ${lists.length} open files of its folder by a name made at run time`)
    for (const [script, f] of opens) console.log(`    opens  ${script}:${f.pins.get(file)} · ${f.searches.filter(hit => hit.file === file).length} searches in it`)
    for (const [script, f] of names) console.log(`    names  ${script}:${f.namesOnly.get(file)}`)
    for (const [script, f] of lists) console.log(`    lists  ${folder} at ${script}:${f.listed.get(folder.toLowerCase())}`)
  }
}

if (process.argv.includes('--risen')) {
  const [base, tip] = process.argv.slice(process.argv.indexOf('--risen') + 1)
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
  if (!base || !tip) {
    console.log(`usage: bun ${SELF} --risen <base commit> <tip commit>`)
    process.exit(2)
  }
  let was = ''
  try {
    was = git('show', `${base}:${TABLE}`)
  } catch {
    was = ''
  }
  const now = git('show', `${tip}:${TABLE}`)
  const moved = new Map<string, string>()
  for (const line of git('diff', '-M', '--name-status', base, tip, '--', 'scripts').split('\n')) {
    const [status, from, to] = line.split('\t')
    if (status?.startsWith('R') && from && to) moved.set(to, from)
  }
  const older = olderTableOf(was)
  const read = risen(older, olderTableOf(now), moved)
  if ([...older.values()].some(row => row.searches < 0)) console.log(`the table at ${base} is of the older shape (a script and the src files it names): its count stands for the files opened, and searches and digests begin at ${tip}`)
  for (const line of read.lines) console.log(line)
  console.log(`${read.higher} rows new or higher · ${read.lines.length - read.higher} rows that hold other files · ${older.size} rows at ${base}, ${olderTableOf(now).size} at ${tip}`)
  process.exit(read.higher === 0 ? 0 : 1)
}

section('§0 the reader on a planted estate: what is a pin, what is a search, what is only a name, and how the table is kept')
plantedEstate()
plantedTools()

section(`§1 the estate: the src files each script opens as text and its searches in what it read, against ${TABLE}`)
const estate = estateOf(ROOT)
const { facts, read, aside } = factsOf(ROOT, estate)
const rows = rowsOf(facts)
const sum = (of: (f: Facts) => number): number => [...facts.values()].reduce((n, f) => n + of(f), 0)
const count = (of: (f: Facts) => boolean): number => [...facts.values()].filter(of).length
const totals = { pins: sum(f => f.pins.size), searches: sum(f => (f.pins.size > 0 ? f.searches.length : 0)), namesOnly: sum(f => f.namesOnly.size) }
const text = existsSync(join(ROOT, TABLE)) ? readFileSync(join(ROOT, TABLE), 'utf8') : null
const table = text === null ? null : tableOf(text)
const REACH = `the fence reads scripts/ and counts files under src/: a test in another folder and source outside src/ are not read. Out of reach, with the scripts that do it today: a folder under src that is walked, globbed or searched by a tool, or the base of a name built at run time (${count(f => f.folder)} name one); a name under src assembled at run time (${count(f => f.fragment)} read one; --readers prints each for a file of the folder it reads in); a search in a shell or Python script, where every name counts as opened and every line that names a file as one search (${count(f => f.shell && f.pins.size > 0)}); a text import spelled in the text of a child program (${count(f => f.childText)}); a script whose helper calls outrun the ${STEPS} steps the reader follows them for (${count(f => f.spent)}); a list kept in a data file or a document (${aside} such files name a src file); and with no count a path that arrives from outside the file, a copy of the tree under a named folder, a search by another method than includes, indexOf, match, search, split, startsWith, endsWith, test and exec, and more needles handed to one call; and not read at all, a tool (${estate.tools?.size ?? 0}: a script the generator column of ${GENERATORS} names, a file under scripts/release/, ${NAMED_TOOLS.join(' and ')}, never a file named prove-* or run-all.sh), whose reads of src are its work, so what a script takes from one is not followed (--report prints what that sets aside)`
const REPAIR = `${INSTEAD}; a row is written only when it falls, leaves, holds other files or moves with its file (git mv, then bun ${SELF} --write)`
console.log(`  ${estate.scripts.length} files under scripts · ${read} read (code by its syntax tree, shell and Python by the line; data files, documents and binary files aside) · ${estate.src.files.size} files under src · ${rows.size} scripts open a src file as text · ${totals.pins} files opened · ${totals.searches} searches · ${totals.namesOnly} names only`)
const low = floor(estate, read)
check('git lists the proof among the files under scripts, and scripts were read', low === '', low)
if (process.argv.includes('--write')) {
  const no = table === null ? [] : refused(facts, table, movedIn(ROOT))
  if (failures > 0) console.log('  nothing written: the reader failed on its own estate or the estate is not listed')
  else if (text !== null && table === null) check(`${TABLE} reads as rows of a script, the files it opens, its searches and a digest`, false, `nothing written: a table of another shape stands there; a first table is written where none stands (git rm ${TABLE}, then --write)`)
  else if (no.length > 0) check(`no row is new or higher (${no.length} are)`, false, `nothing written — ${REPAIR}:${told(no, facts)}`)
  else {
    writeFileSync(join(ROOT, TABLE), render(rows))
    console.log(`  wrote ${TABLE}: ${rows.size} rows · ${totals.pins} files opened · ${totals.searches} searches${table === null ? ' (the first table)' : ` (it held ${table.size} rows)`}`)
  }
} else if (table === null) {
  check(`${TABLE} reads as rows of a script, the files it opens, its searches and a digest`, false, text === null ? `no table: bun ${SELF} --write writes the first one` : 'a row is not a script under scripts, two counts and a digest of 12 hex digits, or a script stands twice')
} else {
  const found = judge(facts, table)
  check(`no script opens more src files as text than its row allows, searches more often in what it read, or opens other files; a script with no row opens none (${table.size} rows · ${REACH})`, found.over.length === 0, `${found.over.length} found — ${REPAIR}:${told(found.over, facts)}`)
  if (found.slack > 0) console.log(`  rows above their script's count: ${found.slack} (the fold lowers them with bun ${SELF} --write)`)
}
if (process.argv.includes('--report')) {
  report(facts)
  setAside(estate, facts)
}
if (process.argv.includes('--readers')) readersOf(facts, process.argv.slice(process.argv.indexOf('--readers') + 1).filter(arg => !arg.startsWith('--')))
console.log(`\nprove-source-text-reads: ${failures === 0 ? 'green' : `${failures} failed`} · pins ${totals.pins} (src files opened as text) · searches ${totals.searches} · names only ${totals.namesOnly} · scripts with a row ${rows.size}`)
process.exit(failures === 0 ? 0 : 1)
