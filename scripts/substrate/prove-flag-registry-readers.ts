#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { flagRegistryFiles, flagRegistryText, isFlagRegistryFile } from '../lib/flagRegistrySource.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const J = (...parts: string[]): string => parts.join('')
const MODULE = J('flag', 'Registry')
const ROWS = J('substrate', '/flags')
const MODULE_PATH = `src/substrate/${MODULE}.ts`
const DOOR = 'scripts/lib/flagRegistrySource.ts'
const NAMES = new RegExp(`${MODULE}\\\\?\\.[cm]?[jt]s|substrate\\\\?/${MODULE}|substrate\\\\?/flags(?![A-Za-z0-9_])`)
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const SHELL = /\.(?:sh|bash|zsh|py|ps1|cmd|bat)$/
const INSTEAD = `look the row up through getFlagSpec or FLAG_REGISTRY (import ../../src/substrate/${MODULE}.ts); a fact the rows cannot say reads the text through flagRegistryText, or tests a path with isFlagRegistryFile, from ${DOOR}`

type Mention = { file: string; line: number; text: string }
type Scan = { imports: number; mentions: Mention[] }
type Row = { file: string; has: string; why: string }

const NAMED: Row[] = [
  { file: 'scripts/identity/prove-docs-altitude.ts', has: `const CONFIG_INDEX_SPELLING = J('src/substrate/', '${MODULE}.ts')`, why: 'the spelling a document may cite: the proof strips it from document text and opens no registry file' },
  { file: 'scripts/orphans/gen-reachability-manifest.ts', has: `'src/substrate/${MODULE}.ts',`, why: 'a root-class label written into the generated manifest: the generator reads the rows through its import' },
  { file: 'scripts/substrate/gen-flag-table.ts', has: `> Derived from \\\`src/substrate/${MODULE}.ts\\\` by`, why: 'a sentence in the header of the rendered table: the renderer reads the rows through its import' },
  { file: 'scripts/vulcan/vulcan-audit-waves.js', has: `src/substrate/startupMenu.ts, src/substrate/${MODULE}.ts, src/utils/healthReport.ts`, why: 'a file list inside the audit prompt text: the script opens none of them' },
  { file: 'scripts/wards/prove-wards-model-free.ts', has: `'../substrate/${MODULE}.js',`, why: "an import specifier the wards guard may carry: the proof reads the guard's imports, not the registry" },
]
const NAMED_ROWS = 5

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

function scriptKind(file: string): ts.ScriptKind {
  if (/\.(?:tsx|jsx)$/.test(file)) return ts.ScriptKind.TSX
  if (/\.(?:js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function isImport(node: ts.Node): boolean {
  for (let at = node; at.parent; at = at.parent) {
    const p = at.parent
    if ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === at) return true
    if (ts.isImportTypeNode(p)) return true
    if (ts.isCallExpression(p) && p.arguments.includes(at as ts.Expression)) {
      const callee = p.expression
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) return true
    }
    if (ts.isStatement(p) || ts.isSourceFile(p)) return false
  }
  return false
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text
  if (ts.isRegularExpressionLiteral(node)) return node.text
  return null
}

function namesRegistry(node: ts.Node, text: string): boolean {
  if (NAMES.test(text)) return true
  if (text !== 'flags' || !ts.isStringLiteralLike(node)) return false
  const p = node.parent
  const siblings = ts.isCallExpression(p) ? p.arguments : ts.isArrayLiteralExpression(p) ? p.elements : undefined
  const before = siblings?.[siblings.indexOf(node as ts.Expression) - 1]
  return before !== undefined && ts.isStringLiteralLike(before) && /(?:^|\/)substrate$/.test(before.text)
}

function scan(root: string, files: string[]): Scan {
  const out: Scan = { imports: 0, mentions: [] }
  for (const file of files) {
    if (file === DOOR || !(CODE.test(file) || SHELL.test(file))) continue
    let text: string
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    if (!text.includes(MODULE) && !text.includes('substrate')) continue
    const lines = text.split('\n')
    const seen = new Set<number>()
    const mention = (line: number): void => {
      if (seen.has(line)) return
      seen.add(line)
      out.mentions.push({ file, line: line + 1, text: (lines[line] ?? '').trim() })
    }
    if (SHELL.test(file)) {
      lines.forEach((line, i) => {
        if (!line.trim().startsWith('#') && NAMES.test(line)) mention(i)
      })
      continue
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
    const visit = (node: ts.Node): void => {
      const literal = literalText(node)
      if (literal !== null && namesRegistry(node, literal)) {
        const start = node.getStart(source)
        const hits = [...text.slice(start, node.getEnd()).matchAll(new RegExp(NAMES.source, 'g'))].map(hit => start + hit.index)
        if (isImport(node)) out.imports++
        else for (const at of hits.length > 0 ? hits : [start]) mention(source.getLineAndCharacterOfPosition(at).line)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return out
}

const listed = (m: Mention, rows: Row[]): boolean => rows.some(r => r.file === m.file && m.text.includes(r.has))
const where = (m: Mention): string => `${m.file}:${m.line}`

section('§0 the reading on a planted estate: every text read is named with its line, an import is not')
{
  const estate = mkdtempSync(join(tmpdir(), 'flag-registry-readers-'))
  const w = (rel: string, body: string): void => {
    mkdirSync(dirname(join(estate, rel)), { recursive: true })
    writeFileSync(join(estate, rel), body)
  }
  w(DOOR, `const MODULE = '${MODULE_PATH}'\nexport const text = (): string => MODULE\n`)
  w('scripts/a/prove-lookup.ts', [
    `import { getFlagSpec } from '../../src/substrate/${MODULE}.ts'`,
    `import { flagRegistryText } from '../lib/flagRegistrySource.ts'`,
    `const { FLAG_REGISTRY } = await import('../../src/substrate/${MODULE}.js')`,
    `const late = await import(join(ROOT, 'src/substrate/${MODULE}.ts'))`,
    `type Spec = import('../../src/substrate/${MODULE}.ts').FlagSpec`,
    `// a comment may name src/substrate/${MODULE}.ts`,
    `export const out = [getFlagSpec, FLAG_REGISTRY, late, flagRegistryText]`,
    '',
  ].join('\n'))
  w('scripts/a/prove-read.ts', [
    `import { readFileSync } from 'node:fs'`,
    `import { join } from 'node:path'`,
    `const text = readFileSync(join(ROOT, 'src/substrate/${MODULE}.ts'), 'utf8')`,
    `const again = src('substrate', '${MODULE}.ts')`,
    `const rows = readFileSync(join(ROOT, 'src', 'substrate', 'flags', 'core.ts'), 'utf8')`,
    `const more = read('src/${ROWS}/core.ts')`,
    `const kept = files.filter(f => f !== 'src/substrate/${MODULE}.ts' && !/${MODULE}\\.ts$/.test(f))`,
    `export const out = [text, again, rows, more, kept]`,
    '',
  ].join('\n'))
  w('scripts/a/run.sh', `#!/usr/bin/env bash\n# gate-watch: src/substrate/${MODULE}.ts\ngrep -c MERCURY src/substrate/${MODULE}.ts\n`)
  w('scripts/a/notes.md', `src/substrate/${MODULE}.ts is where the rows live\n`)
  const got = scan(estate, [DOOR, 'scripts/a/prove-lookup.ts', 'scripts/a/prove-read.ts', 'scripts/a/run.sh', 'scripts/a/notes.md'])
  rmSync(estate, { recursive: true, force: true })
  const seen = got.mentions.map(where).join(' ')
  const want = 'scripts/a/prove-read.ts:3 scripts/a/prove-read.ts:4 scripts/a/prove-read.ts:5 scripts/a/prove-read.ts:6 scripts/a/prove-read.ts:7 scripts/a/run.sh:3'
  check('a direct read, a read through a helper, a read of a rows file, a path test in a sweep and a shell grep are each named with their line', seen === want, `seen ${seen}`)
  check('the four import spellings are counted as lookups, and a comment, a document and the door are not named', got.imports === 4 && !seen.includes('prove-lookup') && !seen.includes('notes.md') && !seen.includes(DOOR), `imports ${got.imports}`)
}

section("§1 the door: the registry's files, their text and the path test")
{
  const files = flagRegistryFiles()
  check('the list holds the registry module first and only registry files', files[0] === MODULE_PATH && files.every(isFlagRegistryFile), files.join(', '))
  check('the text is the text of the listed files and holds the registry', flagRegistryText().includes('export const FLAG_REGISTRY') && flagRegistryText().length >= files.length)
  check('the path test takes the module and anything under the rows folder, in either spelling of the separator', isFlagRegistryFile(MODULE_PATH) && isFlagRegistryFile(`src/${ROWS}/core.ts`) && isFlagRegistryFile(`src\\substrate\\flags\\deep\\core.ts`) && isFlagRegistryFile(`src\\substrate\\${MODULE}.ts`))
  check('the path test refuses a neighbour, a look-alike and the door itself', !isFlagRegistryFile('src/substrate/flagOff.ts') && !isFlagRegistryFile(`src/${ROWS}.ts`) && !isFlagRegistryFile(`src/${ROWS}Extra/core.ts`) && !isFlagRegistryFile(`src/substrate/${MODULE}.tsx`) && !isFlagRegistryFile(DOOR))
  const split = mkdtempSync(join(tmpdir(), 'flag-registry-door-'))
  const w = (rel: string, body: string): void => {
    mkdirSync(dirname(join(split, rel)), { recursive: true })
    writeFileSync(join(split, rel), body)
  }
  w(MODULE_PATH, 'MODULE')
  w(`src/${ROWS}/b.ts`, 'B')
  w(`src/${ROWS}/a.ts`, 'A')
  w(`src/${ROWS}/deep/c.ts`, 'C')
  w('src/substrate/flagOff.ts', 'OFF')
  const after = flagRegistryFiles(split)
  check('on a tree whose rows live in the rows folder the list is the module and every file under the folder, in order', after.join(' ') === [MODULE_PATH, `src/${ROWS}/a.ts`, `src/${ROWS}/b.ts`, `src/${ROWS}/deep/c.ts`].join(' '), after.join(' '))
  check('…and the text is those files joined, a neighbour left out', flagRegistryText(split) === 'MODULE\nA\nB\nC', flagRegistryText(split))
  rmSync(join(split, MODULE_PATH))
  rmSync(join(split, 'src', ROWS), { recursive: true, force: true })
  check('a tree with no registry has no files and no text', flagRegistryFiles(split).length === 0 && flagRegistryText(split) === '')
  rmSync(split, { recursive: true, force: true })
}

section("§2 the estate: a script reads the registry's text through the door or not at all")
{
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'scripts'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)
  const got = scan(ROOT, files)
  const unlisted = got.mentions.filter(m => !listed(m, NAMED))
  const stale = NAMED.filter(r => !got.mentions.some(m => listed(m, [r])))
  console.log(`  ${files.length} files under scripts · ${got.imports} imports of the registry · 1 door (${DOOR}) · ${got.mentions.length - unlisted.length} named lines that read nothing · ${unlisted.length} unlisted`)
  check('the door is a script of this tree', files.includes(DOOR))
  check(
    "no script names the registry's files outside an import and the door (0 unlisted readers)",
    unlisted.length === 0,
    `${unlisted.length} found — ${INSTEAD}; the named list only shrinks:` + unlisted.slice(0, 40).map(m => `\n      ${where(m)} ${m.text.slice(0, 140)}`).join(''),
  )
  check('every named row still stands (a row whose line is gone is removed, and the count below with it)', stale.length === 0, stale.map(r => `${r.file} [${r.has}]`).join(' · '))
  check(`the named list holds ${NAMED_ROWS} rows, each with its reason, and none of them reads the text`, NAMED.length === NAMED_ROWS && NAMED.every(r => r.why.trim().length > 0), `rows ${NAMED.length}`)
}

console.log(failures === 0 ? '\nprove-flag-registry-readers: green' : `\nprove-flag-registry-readers: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
