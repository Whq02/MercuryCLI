#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { declarationOf, functionOf, parseSource, stringText, unwrap, visit } from './sourceCensus.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const SELF = 'scripts/gate/prove-source-text-reads.ts'
const TABLE = 'scripts/gate/source-text-reads.tsv'
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const DOCUMENT = /\.md$/
const SEP = String.raw`(?:\[[\\/]+\]|[\\/])+`
const NAME = 'A-Za-z0-9_@+-'
const OWN_TREE = String.raw`(?<![.${NAME}])(?<!(?<![$${NAME}])[${NAME}]+[\\/]+)`
const SPELLED = new RegExp(String.raw`${OWN_TREE}src(?:${SEP}(?:\\?[.-]|[A-Za-z0-9_@+])+)+`, 'gi')
const FOLDER = new RegExp(String.raw`${OWN_TREE}src(?:[\\/]+[.${NAME}]+)*[\\/]*$`, 'i')
const UNDER = new RegExp(String.raw`(?:(?<![.\\/${NAME}])|(?<=\$\{?[A-Za-z_][A-Za-z0-9_]*\}?"?[\\/]))[A-Za-z0-9_@][.${NAME}]*(?:[\\/]+[.${NAME}]+)+`, 'g')
const TAIL = new RegExp(String.raw`^[\\/]+[.\\/${NAME}]+`)
const QUOTED_SEGMENTS = /['"]\s*[,+/]\s*['"]/g
const IMPORT_SPELLED = /(?:\b(?:import|export)\b[^;'"`]*\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)\\?['"`](?:[^'"`\s]*[\\/])?$/
const IMPORT_OPEN = /(?:\b(?:import|export)\b[^;'"`]*\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)\\?['"`]?$/
const AS_TEXT = /\b(?:text|file)\b/
const NAMES_SRC = /src/i
const INSTEAD = 'import the module and call it, look the value up, or run the built product and read what it prints'
const OUT_OF_REACH = 'a name assembled from fragments at run time, a path that arrives in a variable, a bare file name whose folder is said elsewhere, a folder that is walked, a glob'

type Read = { script: string; line: number; file: string }
type Src = { files: Map<string, string>; folders: Set<string>; names: Set<string> }
type Estate = { scripts: string[]; src: Src }
type Rows = Map<string, Map<string, number>>
type Over = { script: string; row: number; files: Map<string, number> }
type Verdict = { over: Over[]; total: number; allowed: number; slack: number }

function srcOf(files: string[]): Src {
  const src: Src = { files: new Map(), folders: new Set(['src']), names: new Set() }
  for (const file of files) {
    if (!file.startsWith('src/')) continue
    const key = file.toLowerCase()
    src.files.set(key, file)
    src.names.add(key.slice(key.lastIndexOf('/') + 1))
    for (let at = key.lastIndexOf('/'); at > 3; at = key.lastIndexOf('/', at - 1)) src.folders.add(key.slice(0, at))
  }
  return src
}

function estateOf(root: string): Estate {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'scripts', 'src'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
  const files = [...new Set(listed.split('\0').filter(Boolean))].sort()
  return { scripts: files.filter(f => f.startsWith('scripts/')), src: srcOf(files) }
}

const pathOf = (spelled: string): string => spelled.replace(/\\([.-])/g, '$1').replace(new RegExp(SEP, 'g'), '/').toLowerCase()

function fileUnder(src: Src, folder: string, rest: string, least = 1): string | undefined {
  const parts = pathOf(rest).split('/').filter(Boolean)
  for (let n = parts.length; n >= least; n--) {
    const file = src.files.get(`${folder}/${parts.slice(0, n).join('/')}`.replace(/\.+$/, ''))
    if (file !== undefined) return file
  }
  return undefined
}

const fileAt = (src: Src, spelled: string): string | undefined => fileUnder(src, 'src', pathOf(spelled).slice(3))
const fileIn = (src: Src, folder: string, rel: string): string | undefined => src.files.get(pathOf(`${folder}/${rel}`))
const inAFolder = (rel: string): boolean => /[^\\/][\\/]+[^\\/]/.test(rel)
const baseName = (rel: string): string => pathOf(rel).replace(/^.*\//, '')

function spelledFolder(src: Src, text: string): string | undefined {
  const m = FOLDER.exec(text)
  const folder = m ? pathOf(m[0]).replace(/\/+$/, '') : undefined
  return folder !== undefined && src.folders.has(folder) ? folder : undefined
}

function folderOf(src: Src, e: ts.Expression, depth = 0): string | undefined {
  const x = unwrap(e)
  const text = stringText(x)
  if (text !== undefined) return spelledFolder(src, text)
  if (depth > 4) return undefined
  const under = (base: ts.Expression | undefined, rest: string): string | undefined => {
    const spelled = spelledFolder(src, rest)
    const folder = spelled !== undefined || base === undefined ? undefined : folderOf(src, base, depth + 1)
    const deeper = folder === undefined ? undefined : [folder, ...pathOf(rest).split('/').filter(Boolean)].join('/')
    return spelled ?? (deeper !== undefined && src.folders.has(deeper) ? deeper : undefined)
  }
  if (ts.isIdentifier(x)) {
    const decl = declarationOf(x)
    const known = decl && ts.isVariableDeclaration(decl) && decl.initializer ? folderOf(src, decl.initializer, depth + 1) : undefined
    return known ?? (NAMES_SRC.test(x.text) ? 'src' : undefined)
  }
  if (ts.isPropertyAccessExpression(x)) return NAMES_SRC.test(x.name.text) ? 'src' : undefined
  if (ts.isBinaryExpression(x)) {
    const op = x.operatorToken.kind
    const right = stringText(unwrap(x.right))
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) return folderOf(src, x.right, depth + 1)
    return op === ts.SyntaxKind.PlusToken && right !== undefined ? under(x.left, right) : undefined
  }
  if (ts.isTemplateExpression(x)) return x.head.text === '' && x.templateSpans.length === 1 ? under(x.templateSpans[0]!.expression, x.templateSpans[0]!.literal.text) : undefined
  if (!ts.isCallExpression(x)) return undefined
  const args = [...x.arguments]
  let start = args.length
  while (start > 0 && stringText(unwrap(args[start - 1]!)) !== undefined) start--
  if (start === args.length) return args.length === 1 ? folderOf(src, args[0]!, depth + 1) : undefined
  return under(
    args[start - 1],
    args
      .slice(start)
      .map(a => stringText(unwrap(a))!)
      .join('/'),
  )
}

const loadsModule = (callee: ts.Expression): boolean =>
  callee.kind === ts.SyntaxKind.ImportKeyword ||
  (ts.isIdentifier(callee) && callee.text === 'require') ||
  (ts.isPropertyAccessExpression(callee) && callee.name.text === 'module' && ts.isIdentifier(callee.expression) && callee.expression.text === 'mock')

function handsToImport(callee: ts.Identifier, index: number): boolean {
  const fn = functionOf(declarationOf(callee))
  const param = fn?.parameters[index]?.name
  if (!fn?.body || !param || !ts.isIdentifier(param)) return false
  const carried = new Set([param.text])
  const carries = (e: ts.Node): boolean => {
    let hit = false
    visit(e, n => {
      if (ts.isIdentifier(n) && carried.has(n.text)) hit = true
    })
    return hit
  }
  let found = false
  visit(fn.body, n => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && carries(n.initializer)) carried.add(n.name.text)
    if (ts.isCallExpression(n) && loadsModule(unwrap(n.expression)) && n.arguments[0] && carries(n.arguments[0])) found = true
  })
  return found
}

function importKind(node: ts.Node): 'module' | 'text' | null {
  for (let at = node; at.parent; at = at.parent) {
    const p = at.parent
    if ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === at) return p.attributes && AS_TEXT.test(p.attributes.getText()) ? 'text' : 'module'
    if (ts.isExternalModuleReference(p) || ts.isImportTypeNode(p)) return 'module'
    if (ts.isTemplateSpan(p) && p.expression === at) {
      const spans = p.parent.templateSpans
      const i = spans.indexOf(p)
      if (IMPORT_OPEN.test(i === 0 ? p.parent.head.text : spans[i - 1]!.literal.text)) return 'module'
    }
    if (ts.isCallExpression(p) && p.arguments.includes(at as ts.Expression)) {
      const callee = unwrap(p.expression)
      const options = callee.kind === ts.SyntaxKind.ImportKeyword ? p.arguments[1] : undefined
      if (options && (!ts.isObjectLiteralExpression(options) || AS_TEXT.test(options.getText()))) return 'text'
      if (loadsModule(callee) || (ts.isIdentifier(callee) && handsToImport(callee, p.arguments.indexOf(at as ts.Expression)))) return 'module'
    }
    if (ts.isStatement(p) || ts.isSourceFile(p)) return null
  }
  return null
}

const isLiteral = (node: ts.Node): boolean => ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isRegularExpressionLiteral(node)

function codeReads(root: string, script: string, src: Src): Read[] {
  const { sf } = parseSource(root, join(root, script))
  const text = sf.text
  const out: Read[] = []
  const spelledAsImport = (at: number): boolean => IMPORT_SPELLED.test(text.slice(Math.max(0, at - 240), at))
  const named = (node: ts.Node, at: number, file: string | undefined, asImport = false): void => {
    if (file === undefined) return
    const kind = importKind(node)
    if (kind === 'module' || (kind === null && asImport)) return
    out.push({ script, line: sf.getLineAndCharacterOfPosition(at).line + 1, file })
  }
  visit(sf, node => {
    if (isLiteral(node)) {
      const start = node.getStart(sf)
      for (const m of text.slice(start, node.getEnd()).matchAll(SPELLED)) named(node, start + m.index, fileAt(src, m[0]), spelledAsImport(start + m.index))
      const whole = stringText(node)
      if (whole !== undefined && inAFolder(whole)) named(node, start, fileIn(src, 'src', whole))
      if ((ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && ts.isTemplateSpan(node.parent)) {
        const tail = TAIL.exec(node.text)?.[0]
        const folder = tail === undefined ? undefined : folderOf(src, node.parent.expression)
        if (tail !== undefined) named(node, start, (folder !== undefined ? fileUnder(src, folder, tail) : undefined) ?? fileUnder(src, 'src', tail, 2), spelledAsImport(start + 1 + tail.length - tail.replace(/^[\\/]+/, '').length))
      }
      return
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const right = stringText(unwrap(node.right))
      const folder = right !== undefined && src.names.has(baseName(right)) ? folderOf(src, node.left) : undefined
      if (right !== undefined && folder !== undefined) named(node.right, node.right.getStart(sf), fileIn(src, folder, right))
      return
    }
    const call = ts.isCallExpression(node) || ts.isNewExpression(node) ? node : undefined
    const list = call ? call.arguments : ts.isArrayLiteralExpression(node) ? node.elements : undefined
    if (!list) return
    for (let i = 0; i < list.length; i++) {
      let end = i
      while (end < list.length && stringText(unwrap(list[end]!)) !== undefined) end++
      if (end === i) continue
      const texts = list.slice(i, end).map(e => stringText(unwrap(e))!)
      const joined = texts.join('/')
      const first = unwrap(list[i]!)
      const at = first.getStart(sf)
      const before = i > 0 ? list[i - 1] : call?.expression
      if (texts.length > 1) {
        const starts = texts.map((_, k) => texts.slice(0, k).join('/').length + (k > 0 ? 1 : 0))
        for (const m of joined.matchAll(SPELLED)) {
          const inOne = starts.some((s, k) => m.index >= s && m.index + m[0].length <= s + texts[k]!.length)
          if (!inOne) named(first, at, fileAt(src, m[0]), IMPORT_SPELLED.test(joined.slice(0, m.index)))
        }
        named(first, at, fileIn(src, 'src', joined))
      }
      const folder = before !== undefined && src.names.has(baseName(joined)) ? folderOf(src, before) : undefined
      if (folder !== undefined) named(first, at, fileIn(src, folder, joined))
      i = end
    }
  })
  return out
}

function textReads(script: string, text: string, src: Src): Read[] {
  const out: Read[] = []
  text.split('\n').forEach((line, i) => {
    if (line.trimStart().startsWith('#')) return
    for (const view of new Set([line, line.replace(QUOTED_SEGMENTS, '/')])) {
      for (const m of view.matchAll(SPELLED)) {
        const file = fileAt(src, m[0])
        if (file !== undefined && !IMPORT_SPELLED.test(view.slice(0, m.index))) out.push({ script, line: i + 1, file })
      }
      for (const m of view.matchAll(UNDER)) {
        const file = fileUnder(src, 'src', m[0], 2)
        if (file !== undefined && !IMPORT_SPELLED.test(view.slice(0, m.index))) out.push({ script, line: i + 1, file })
      }
    }
  })
  return out
}

function sourceTextReads(root: string, estate: Estate): { reads: Read[]; read: number } {
  const reads: Read[] = []
  let read = 0
  for (const script of estate.scripts) {
    if (DOCUMENT.test(script)) continue
    let found: Read[]
    try {
      const text = readFileSync(join(root, script), 'utf8')
      if (text.includes('\0')) continue
      found = CODE.test(script) ? codeReads(root, script, estate.src) : textReads(script, text, estate.src)
    } catch {
      continue
    }
    read++
    const seen = new Set<string>()
    for (const r of found.sort((a, b) => a.line - b.line || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
      const key = `${r.line}\t${r.file}`
      if (!seen.has(key)) reads.push(r)
      seen.add(key)
    }
  }
  return { reads, read }
}

function rowsOf(reads: Read[]): Rows {
  const rows: Rows = new Map()
  for (const r of reads) {
    let files = rows.get(r.script)
    if (!files) rows.set(r.script, (files = new Map()))
    if (!files.has(r.file)) files.set(r.file, r.line)
  }
  return rows
}

const render = (rows: Rows): string =>
  [...rows]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([script, files]) => `${script}\t${files.size}\n`)
    .join('')

function tableOf(text: string): Map<string, number> | null {
  const table = new Map<string, number>()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const m = /^(scripts\/[^\t]+)\t([1-9][0-9]*)$/.exec(line)
    if (!m || table.has(m[1]!)) return null
    table.set(m[1]!, Number(m[2]))
  }
  return table
}

function judge(rows: Rows, table: Map<string, number>): Verdict {
  const over: Over[] = []
  let total = 0
  for (const [script, files] of rows) {
    total += files.size
    const row = table.get(script) ?? 0
    if (files.size > row) over.push({ script, row, files })
  }
  let allowed = 0
  let slack = 0
  for (const [script, row] of table) {
    allowed += row
    if ((rows.get(script)?.size ?? 0) < row) slack++
  }
  return { over, total, allowed, slack }
}

const told = (over: Over[]): string =>
  over
    .slice(0, 25)
    .map(o => `\n      ${o.script} names ${o.files.size} src file${o.files.size === 1 ? '' : 's'} as text and ${o.row === 0 ? 'has no row' : `its row allows ${o.row}`}:` + [...o.files].map(([file, line]) => `\n        ${o.script}:${line} ${file}`).join(''))
    .join('') + (over.length > 25 ? `\n      … and ${over.length - 25} more scripts` : '')

const REPAIR = `${INSTEAD}; a name that is no read (a fixture of the same name, a label) takes another spelling; a test that moved takes its rows with it through bun ${SELF} --write, which writes no total above the one it finds`

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

function plantedEstate(): void {
  const ONE = 'src/planted/one.ts'
  const TWO = 'src/planted/two.tsx'
  const THREE = 'src/planted/deep/three.ts'
  const JSON_ROWS = 'src/planted/rows.json'
  const LONE = 'src/lone.ts'
  const planted: Array<{ file: string; lines: string[]; named: Array<[number, string]> }> = [
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
        "const kid = `import { one } from '${SRC}/planted/one.ts'`",
        '// a comment may name src/planted/one.ts',
        'export const out = [one, rows, legacy, late, joined, href, old, loaded, child, inline, quoted, onTemplate, kid]',
      ],
      named: [],
    },
    {
      file: 'scripts/a/prove-reads.ts',
      lines: [
        "const whole = readFileSync(join(ROOT, 'src/planted/one.ts'), 'utf8')",
        "const relative = readFileSync(new URL('../../src/planted/two.tsx', import.meta.url), 'utf8')",
        "const segments = readFileSync(join(ROOT, 'src', 'planted', 'deep', 'three.ts'), 'utf8')",
        "const helper = text('planted/deep/three.ts')",
        "const bare = readFileSync(join(SRC, 'lone.ts'), 'utf8')",
        "const template = readFileSync(`${ROOT}/src/planted/one.ts`, 'utf8')",
        'const plain = read(`src/planted/two.tsx`)',
        String.raw`const pattern = files.filter(f => /src\/planted\/one\.ts$/.test(f) || /src[\\/]planted[\\/]deep[\\/]three\.ts/.test(f))`,
        String.raw`const windows = read('src\\planted\\one.ts')`,
        "const command = execSync('grep -c export src/planted/two.tsx src/lone.ts')",
        "const argv = execFileSync('git', ['show', 'HEAD:src/planted/rows.json'])",
        "const label = { 'src/planted/one.ts': 'a label is a name too' }",
        "const resolved = require.resolve('../../src/lone.ts')",
        "const cased = read('src/Planted/One.ts')",
        "import text from '../../src/planted/one.ts' with { type: 'text' }",
        "const late = await import('../../src/planted/two.tsx', { with: { type: 'file' } })",
        "const sentence = 'the row type lives in src/planted/deep/three.ts.'",
        "const pinned = \"from '../../src/planted/one.ts'\"",
        "const DEEP = join(ROOT, 'src', 'planted')",
        "const beside = readFileSync(join(DEEP, 'two.tsx'), 'utf8')",
        "const source = process.env.PROVE_SRC ?? join(ROOT, 'src')",
        "const after = [read(`${source}/lone.ts`), read(source + '/planted/rows.json')]",
        'const under = read(`${base}/planted/deep/three.ts`)',
        "const loose = await import('../../src/lone.ts', options)",
        'export const out = [whole, relative, segments, helper, bare, template, plain, pattern, windows, command, argv, label, resolved, cased, text, late, sentence, pinned, beside, after, under, loose]',
      ],
      named: [[1, ONE], [2, TWO], [3, THREE], [4, THREE], [5, LONE], [6, ONE], [7, TWO], [8, THREE], [8, ONE], [9, ONE], [10, LONE], [10, TWO], [11, JSON_ROWS], [12, ONE], [13, LONE], [14, ONE], [15, ONE], [16, TWO], [17, THREE], [18, ONE], [20, TWO], [22, LONE], [22, JSON_ROWS], [23, THREE], [24, LONE]],
    },
    {
      file: 'scripts/a/run-all.sh',
      lines: ['#!/usr/bin/env bash', '# gate-watch: src/planted/one.ts src/lone.ts', 'set -u', 'grep -c export src/planted/one.ts', 'test -s "$ROOT/src/planted/deep/three.ts"', "bun -e \"import { one } from './src/planted/one.ts'; console.log(one)\"", 'cat "${SRC_DIR}/planted/two.tsx"', 'cd "$ROOT/src" && cat lone.ts'],
      named: [[4, ONE], [5, THREE], [7, TWO]],
    },
    { file: 'scripts/a/reader.py', lines: ['# src/planted/one.ts in a comment', "text = open('src/planted/two.tsx').read()", "rows = open(os.path.join(ROOT, 'src', 'planted', 'rows.json')).read()"], named: [[2, TWO], [3, JSON_ROWS]] },
    { file: 'scripts/a/list.txt', lines: ['# paths a reader opens', 'src/lone.ts', 'planted/deep/three.ts'], named: [[2, LONE], [3, THREE]] },
    { file: 'scripts/a/rows.json', lines: [String.raw`{ "file": "src\/planted\/rows.json", "other": "src/planted/one.ts" }`], named: [[1, ONE], [1, JSON_ROWS]] },
    { file: 'scripts/a/hook', lines: ['#!/bin/sh', 'grep -q export src/lone.ts'], named: [[2, LONE]] },
    { file: 'scripts/a/notes.md', lines: ['src/planted/one.ts is where the rows live'], named: [] },
    { file: 'scripts/a/packed.bin', lines: ['\0src/planted/one.ts'], named: [] },
    {
      file: 'scripts/a/out-of-reach.ts',
      lines: [
        "const name = 'one'",
        "const built = readFileSync(join(ROOT, 'src/planted', name + '.ts'), 'utf8')",
        "const holed = readFileSync(`${ROOT}/src/planted/${name}.ts`, 'utf8')",
        "const walked = walk(join(ROOT, 'src', 'planted'))",
        "const globbed = new Bun.Glob('src/planted/*.ts')",
        'const handed = read(process.argv[2])',
        "const gone = existsSync(join(ROOT, 'src/planted/gone.ts'))",
        "const elsewhere = read('lone.ts')",
        "const other = [resolve('/work/proj/src/lone.ts'), join(scratch, 'proj', 'src', 'lone.ts')]",
        "const peek = (dir: string): string => read(join(dir, 'lone.ts'))",
        'export const out = [built, holed, walked, globbed, handed, gone, elsewhere, other, peek]',
      ],
      named: [],
    },
  ]
  const root = mkdtempSync(join(tmpdir(), 'source-text-reads-'))
  for (const { file, lines } of planted) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), lines.join('\n') + '\n')
  }
  const { reads, read } = sourceTextReads(root, { scripts: planted.map(p => p.file), src: srcOf([ONE, TWO, THREE, JSON_ROWS, LONE]) })
  rmSync(root, { recursive: true, force: true })
  const seen = reads.map(r => `${r.script}:${r.line} ${r.file}`)
  const want = planted.flatMap(p => p.named.map(([line, file]) => `${p.file}:${line} ${file}`))
  const differs = [...seen.filter(s => !want.includes(s)).map(s => `named and not wanted ${s}`), ...want.filter(w => !seen.includes(w)).map(w => `wanted and not named ${w}`)].join(' · ')
  const of = (file: string): string[] => seen.filter(s => s.startsWith(`${file}:`))
  check(
    'in code each read is named with its line and its src file: a whole path, a path from the script, a path in segments, a path from inside src handed to a helper, a bare name beside a name that says src, a template, a regular expression, the other separator, a command, an argument list, a label, a resolved specifier, another case, an import with a text or a file attribute or with options that arrive in a variable, a sentence, an import line held as text, a file beside a folder held in a constant, a path after a variable that holds src or is not known',
    of('scripts/a/prove-reads.ts').join(' ') === want.filter(w => w.startsWith('scripts/a/prove-reads.ts:')).join(' '),
    differs,
  )
  check(
    'an import is not named in any of its forms: static, for its effect, of a type, of data, re-exported, assigned from require, dynamic, dynamic on a built path or a template, require, in a type, through mock.module, through a helper of the script that imports what it is handed, in the text of a child program, and neither is a comment',
    of('scripts/a/prove-imports.ts').length === 0,
    of('scripts/a/prove-imports.ts').join(' · '),
  )
  check('shell, Python, a list, JSON and a script with no extension are read as text, line by line: a whole path, a path in quoted segments and a path from inside src, alone or after a shell variable, are named, and a comment line, an import spelled in a command and a bare name after a cd are not', ['run-all.sh', 'reader.py', 'list.txt', 'rows.json', 'hook'].every(f => of(`scripts/a/${f}`).length > 0) && differs === '', differs)
  check(`a document and a binary file are not read (${read} of ${planted.length} files read), and out of reach stay ${OUT_OF_REACH}; a path that names no file, a bare name beside no name that says src and a src folder of another tree are no reads`, read === planted.length - 2 && of('scripts/a/notes.md').length + of('scripts/a/packed.bin').length + of('scripts/a/out-of-reach.ts').length === 0, differs)
  const rows = rowsOf(reads)
  const text = render(rows)
  const table = tableOf(text)
  check('the table is one row per script that names a src file, with the number of distinct files, in order, and reads back as written', text === 'scripts/a/hook\t1\nscripts/a/list.txt\t2\nscripts/a/prove-reads.ts\t5\nscripts/a/reader.py\t2\nscripts/a/rows.json\t2\nscripts/a/run-all.sh\t3\n' && table !== null && render(rowsOf(reads)) === text, text.replaceAll('\n', ' · '))
  check('a table with a row that is no script and a count, or with a script twice, does not read', tableOf('scripts/a/hook\tone\n') === null && tableOf('scripts/a/hook\t0\n') === null && tableOf('scripts/a/hook\t1\nscripts/a/hook\t1\n') === null && tableOf('src/lone.ts\t1\n') === null)
  if (table === null) return
  const held = judge(rows, table)
  check('on its own table the estate stands: no script over its row, 15 reads of 15 allowed', held.over.length === 0 && held.total === 15 && held.allowed === 15 && held.slack === 0, JSON.stringify(held))
  const unrowed = judge(rows, new Map([...table].filter(([script]) => script !== 'scripts/a/hook')))
  check('a script with no row that names a file is named with the line and the file', unrowed.over.length === 1 && told(unrowed.over).includes('scripts/a/hook names 1 src file as text and has no row:') && told(unrowed.over).includes('scripts/a/hook:2 src/lone.ts') && unrowed.total > unrowed.allowed, told(unrowed.over))
  const raised = judge(rows, new Map([...table].map(([script, n]) => [script, script === 'scripts/a/run-all.sh' ? 1 : n])))
  check('a script that names one file more than its row allows is named with every line and file it holds', raised.over.length === 1 && told(raised.over).includes('its row allows 1:') && told(raised.over).includes('scripts/a/run-all.sh:4 src/planted/one.ts') && told(raised.over).includes('scripts/a/run-all.sh:5 src/planted/deep/three.ts'), told(raised.over))
  const fallen = judge(rowsOf(reads.filter(r => r.script !== 'scripts/a/list.txt' && r.file !== JSON_ROWS)), table)
  check('a count that fell stands, and its rows are counted as standing above it', fallen.over.length === 0 && fallen.total === 10 && fallen.slack === 4, JSON.stringify(fallen))
}

function report(rows: Rows, asked: string[]): void {
  const kind = (script: string): string => (CODE.test(script) ? 'code' : /\.(?:sh|py|ps1)$|\/[^./]+$/.test(script) ? 'shell and Python' : 'data')
  const kinds = new Map<string, [number, number]>()
  const readers = new Map<string, number>()
  for (const [script, files] of rows) {
    const k = kinds.get(kind(script)) ?? [0, 0]
    kinds.set(kind(script), [k[0] + 1, k[1] + files.size])
    for (const file of files.keys()) readers.set(file, (readers.get(file) ?? 0) + 1)
  }
  const top = (m: Map<string, number>): string =>
    [...m]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 40)
      .map(([name, n]) => `\n  ${String(n).padStart(5)}  ${name}`)
      .join('')
  console.log(`\n  by kind: ${[...kinds].map(([k, [scripts, reads]]) => `${k} ${reads} reads in ${scripts} scripts`).join(' · ')} · ${readers.size} src files named`)
  console.log(`\n  the 40 src files most scripts read as text (scripts that name the file):${top(readers)}`)
  console.log(`\n  the 40 scripts with the most reads (distinct src files named):${top(new Map([...rows].map(([script, files]) => [script, files.size])))}`)
  for (const file of asked) {
    const at = [...rows].flatMap(([script, files]) => (files.has(file) ? [`${script}:${files.get(file)}`] : []))
    console.log(`\n  ${file} is named as text by ${at.length} scripts:${at.map(a => `\n    ${a}`).join('')}`)
  }
}

section('§0 the reader on a planted estate: each read is named with its line and file, each import is not')
plantedEstate()

section(`§1 the estate: the src files a script names as text, counted for each script and in all, against ${TABLE}`)
const estate = estateOf(ROOT)
const { reads, read } = sourceTextReads(ROOT, estate)
const rows = rowsOf(reads)
const total = [...rows.values()].reduce((n, files) => n + files.size, 0)
const text = existsSync(join(ROOT, TABLE)) ? readFileSync(join(ROOT, TABLE), 'utf8') : null
const table = text === null ? null : tableOf(text)
console.log(`  ${estate.scripts.length} files under scripts · ${read} read (documents and binary files aside) · ${estate.src.files.size} files under src · ${rows.size} scripts name a src file outside an import · ${total} text reads`)
if (process.argv.includes('--write')) {
  const found = table === null ? null : judge(rows, table)
  if (failures > 0) console.log('  nothing written: the reader failed on its own estate')
  else if (text !== null && found === null) check(`${TABLE} reads as rows of a script and its count`, false, 'put the committed table back, then write')
  else if (found !== null && found.total > found.allowed) check(`the total does not rise (${found.total} now, ${found.allowed} in the table)`, false, `nothing written — ${REPAIR}:${told(found.over)}`)
  else {
    writeFileSync(join(ROOT, TABLE), render(rows))
    console.log(`  wrote ${TABLE}: ${rows.size} rows, ${total} text reads${found === null ? '' : ` (it allowed ${found.allowed})`}`)
  }
} else if (table === null) {
  check(`${TABLE} reads as rows of a script and its count`, false, text === null ? `no table: bun ${SELF} --write writes the first one` : 'a row is not a script under scripts and a count of 1 or more, or a script stands twice')
} else {
  const found = judge(rows, table)
  check(`no script names more src files as text than its row allows, and a script with no row names none (${table.size} rows; out of reach: ${OUT_OF_REACH})`, found.over.length === 0, `${found.over.length} found — ${REPAIR}:${told(found.over)}`)
  check(`the total is at most the table's (${found.total} text reads, ${found.allowed} allowed)`, found.total <= found.allowed, `${found.total - found.allowed} above — ${INSTEAD}`)
  if (found.slack > 0) console.log(`  rows above their script's count: ${found.slack} (bun ${SELF} --write lowers them)`)
}
if (process.argv.includes('--report')) report(rows, process.argv.flatMap(a => estate.src.files.get(a.toLowerCase()) ?? []))
console.log(failures === 0 ? '\nprove-source-text-reads: green' : `\nprove-source-text-reads: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
