#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { FLAG_REGISTRY } from '../../src/substrate/flagRegistry.ts'
import { flagRegistryFiles, flagRegistryText, isFlagRegistryFile } from '../lib/flagRegistrySource.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const J = (...parts: string[]): string => parts.join('')
const M = J('flag', 'Registry')
const S = J('sub', 'strate')
const spell = (text: string): string => text.replaceAll('@M@', M).replaceAll('@S@', S)
const MODULE_PATH = spell('src/@S@/@M@.ts')
const ROWS_DIR = spell('src/@S@/flags')
const DOOR = 'scripts/lib/flagRegistrySource.ts'
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const DOCUMENT = /\.md$/
const SEP = String.raw`(?:\[[\\/]+\]|[\\/])+`
const QUICK = new RegExp(`${M}|${S}`, 'i')
const SPELLINGS = [
  `${M}\\\\?\\.[cm]?[jt]sx?(?![A-Za-z0-9_])`,
  `${SEP}${M}(?![A-Za-z0-9_])`,
  `${S}${SEP}flags(?![A-Za-z0-9_])`,
  `${S}${SEP}(?:[*?$\\[{]|flag[a-z]*[*?\\[{])`,
].join('|')
const FOLDER = `(?<![A-Za-z0-9_])src${SEP}${S}(?:${SEP})?(?=$|[\\s'"\`),;:|&<>\\]])`
const IN_A_LITERAL = new RegExp(`${SPELLINGS}|${FOLDER}`, 'gi')
const IN_A_SEGMENT = new RegExp(SPELLINGS, 'gi')
const IN_A_LINE = new RegExp(`${SPELLINGS}|${FOLDER}|(?<![A-Za-z0-9_.-])${M}(?![A-Za-z0-9_])`, 'i')
const WHOLE = new RegExp(`^${M}(?:[.*?]\\S*)?$`, 'i')
const FOLDER_WORD = new RegExp(S, 'i')
const ROWS_SEGMENT = /^[\\/]*flags(?![A-Za-z0-9_])/i
const FOLDER_SEGMENT = new RegExp(`(?:^|[\\\\/])${S}[\\\\/]*$`, 'i')
const SRC_SEGMENT = /(?:^|[\\/])src[\\/]*$/i
const SRC_NAME = /^src|src$/i
const INSTEAD = spell(`look the row up through getFlagSpec or FLAG_REGISTRY (a plain import of src/@S@/@M@.ts); a fact the rows cannot say reads the text through flagRegistryText, and a sweep tests a path with isFlagRegistryFile, both from ${DOOR}`)
const OUT_OF_REACH = 'a name assembled from fragments at run time, a path that arrives in a variable, a walk of the whole of src'

type Mention = { file: string; line: number; text: string }
type Scan = { read: number; imports: number; mentions: Mention[] }
type Row = { file: string; line: string; why: string }
type Near = { before: ts.Node | undefined; after: ts.Node | undefined; argument: boolean }

const NAMED: Row[] = [
  { file: 'scripts/gate/impact-doors.txt', line: 'src/@S@/flags/** src/@S@/@M@.ts', why: "the planner's door row: a glob and a path that scripts/verify/impactManifest.ts matches against changed paths; it opens no registry file" },
  { file: 'scripts/identity/prove-docs-altitude.ts', line: "const CONFIG_INDEX_SPELLING = J('src/@S@/', '@M@.ts')", why: 'the spelling a document may cite: the proof strips it from document text and opens no registry file' },
  { file: 'scripts/memory/prove-memory-always-on.ts', line: "for (const dir of ['src/mneme', 'src/tools/MemoryTools', 'src/components/memory', 'src/commands/memory', 'src/utils/capability', 'src/utils/cockpit', 'src/services/mcp', 'src/@S@', 'src/query', 'src/utils/attachments']) {", why: "ten folders walked for memory gate words: the registry's files are skipped by the path test and read through the door" },
  { file: 'scripts/motion/prove-motion-wire-trip.ts', line: "check('the governor is still config-free (flag reads only)', !/utils\\/config/.test(governorSrc) && /@M@/.test(governorSrc))", why: "tests the motion governor's own source for its import of the registry: it reads the governor" },
  { file: 'scripts/notifications/prove-surface-router.ts', line: "l => l.includes('@M@') || l.includes('ink/events/input-event') || l.includes('utils/fullscreen') || l.includes('services/concourse/concourseEnabled') || l.includes('components/mercury-ui/keyHintLabel'),", why: "an import the route owner may carry: the proof reads the owner's import lines" },
  { file: 'scripts/orphans/gen-reachability-manifest.ts', line: "'src/@S@/@M@.ts',", why: 'a root-class label written into the generated manifest: the generator reads the rows through its import' },
  { file: 'scripts/substrate/gen-flag-table.ts', line: '> Derived from \\`src/@S@/@M@.ts\\` by \\`scripts/@S@/gen-flag-table.ts\\`.', why: 'a sentence in the header of the rendered table: the renderer reads the rows through its import' },
  { file: 'scripts/transcript-rows/prove-motion-governor.ts', line: "check('the governor is config-free (flag reads only — the ink layer taps it)', !/utils\\/config/.test(governor) && /@M@/.test(governor))", why: "tests the motion governor's own source for its import of the registry: it reads the governor" },
  { file: 'scripts/vulcan/vulcan-audit-waves.js', line: 'The new surfaces: src/utils/vulcan/*, src/services/vulcan/*, src/tools/GodotTool/*, assets/vulcan/addon/**, scripts/vulcan/*, plus edits in src/tools.ts, src/constants/prompts.ts, src/constants/subagentDoctrine.ts, src/utils/cockpit/harnessMap.ts, src/@S@/startupMenu.ts, src/@S@/@M@.ts, src/utils/healthReport.ts, assets/splash/mercury-splash.mjs.', why: 'a file list inside the audit prompt text: the script opens none of them' },
  { file: 'scripts/wards/prove-wards-model-free.ts', line: "'../@S@/@M@.js',", why: "an import specifier the wards guard may carry: the proof reads the guard's imports" },
].map(row => ({ ...row, line: spell(row.line) }))
const NAMED_ROWS = 10

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

function importKind(node: ts.Node): 'plain' | 'attributed' | null {
  for (let at = node; at.parent; at = at.parent) {
    const p = at.parent
    if ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === at) return p.attributes ? 'attributed' : 'plain'
    if (ts.isExternalModuleReference(p) || ts.isImportTypeNode(p)) return 'plain'
    if (ts.isCallExpression(p) && p.arguments.includes(at as ts.Expression)) {
      const callee = p.expression
      if (callee.kind === ts.SyntaxKind.ImportKeyword) return p.arguments.length > 1 ? 'attributed' : 'plain'
      if (ts.isIdentifier(callee) && callee.text === 'require') return 'plain'
    }
    if (ts.isStatement(p) || ts.isSourceFile(p)) return null
  }
  return null
}

function nearOf(node: ts.Node): Near | null {
  const p = node.parent
  const call = ts.isCallExpression(p) || ts.isNewExpression(p)
  const list = call ? p.arguments : ts.isArrayLiteralExpression(p) ? p.elements : undefined
  const at = list ? list.indexOf(node as ts.Expression) : -1
  if (!list || at < 0) return null
  return { before: at > 0 ? list[at - 1] : call ? p.expression : undefined, after: list[at + 1], argument: call }
}

const plainSegment = (node: ts.Node | undefined): boolean => node !== undefined && ts.isStringLiteralLike(node)
const namesSrc = (node: ts.Node | undefined): boolean => node !== undefined && ((ts.isStringLiteralLike(node) && SRC_SEGMENT.test(node.text)) || (ts.isIdentifier(node) && SRC_NAME.test(node.text)))

function scan(root: string, files: string[]): Scan {
  const out: Scan = { read: 0, imports: 0, mentions: [] }
  for (const file of files) {
    if (file === DOOR || DOCUMENT.test(file)) continue
    let text: string
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    if (text.includes('\0')) continue
    out.read++
    if (!QUICK.test(text)) continue
    const all = text.split('\n')
    const lines = new Set<number>()
    if (CODE.test(file)) {
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isRegularExpressionLiteral(node)) {
          const start = node.getStart(source)
          const near = ts.isStringLiteralLike(node) ? nearOf(node) : null
          const aSegmentFollows = near !== null && near.argument && plainSegment(near.after)
          const hits = [...text.slice(start, node.getEnd()).matchAll(aSegmentFollows ? IN_A_SEGMENT : IN_A_LITERAL)].map(hit => hit.index)
          if (ts.isStringLiteralLike(node)) {
            const rowsAfterTheFolder = near !== null && ROWS_SEGMENT.test(node.text) && near.before !== undefined && FOLDER_WORD.test(near.before.getText(source))
            const theFolderAfterSrc = near !== null && FOLDER_SEGMENT.test(node.text) && namesSrc(near.before) && !plainSegment(near.after)
            if (WHOLE.test(node.text) || rowsAfterTheFolder || theFolderAfterSrc) hits.push(0)
          }
          if (hits.length > 0) {
            if (importKind(node) === 'plain') out.imports++
            else for (const at of hits) lines.add(source.getLineAndCharacterOfPosition(start + at).line)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    } else {
      all.forEach((line, i) => {
        if (!line.trimStart().startsWith('#') && IN_A_LINE.test(line)) lines.add(i)
      })
    }
    for (const line of [...lines].sort((a, b) => a - b)) out.mentions.push({ file, line: line + 1, text: (all[line] ?? '').trim() })
  }
  return out
}

function judge(mentions: Mention[], rows: Row[]): { unlisted: Mention[]; stale: Row[] } {
  const used = new Set<Row>()
  const unlisted: Mention[] = []
  for (const m of mentions) {
    const row = rows.find(r => r.file === m.file && r.line === m.text && !used.has(r))
    if (row) used.add(row)
    else unlisted.push(m)
  }
  return { unlisted, stale: rows.filter(r => !used.has(r)) }
}

const where = (m: Mention): string => `${m.file}:${m.line}`

section('§0 the reading on a planted estate: every reader the net reaches is named with its line')
{
  const estate = mkdtempSync(join(tmpdir(), 'flag-registry-readers-'))
  const planted: Array<{ file: string; lines: string[]; named: number[] }> = [
    { file: DOOR, lines: ["export const text = (): string => readFileSync('src/@S@/@M@.ts', 'utf8')"], named: [] },
    {
      file: 'scripts/a/prove-lookup.ts',
      lines: [
        "import { getFlagSpec } from '../../src/@S@/@M@.ts'",
        "import { flagRegistryText } from '../lib/flagRegistrySource.ts'",
        "const { FLAG_REGISTRY } = await import('../../src/@S@/@M@.js')",
        "const late = await import(join(ROOT, 'src/@S@/@M@.ts'))",
        "type Spec = import('../../src/@S@/@M@.ts').FlagSpec",
        "import legacy = require('../../src/@S@/@M@.ts')",
        '// a comment may name src/@S@/@M@.ts',
        "const menu = readFileSync(join(ROOT, 'src', '@S@', 'startupMenu.ts'), 'utf8')",
        "const lock = read('src/@S@/pidLock.ts')",
        "const identity = walk(join(ROOT, 'src/@S@/identity'))",
        "check('the @M@ row is present exactly once', FLAG_REGISTRY.length > 0)",
        'export const out = [getFlagSpec, late, flagRegistryText, legacy, menu, lock, identity]',
      ],
      named: [],
    },
    {
      file: 'scripts/a/prove-read.ts',
      lines: [
        "import { readFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        "const text = readFileSync(join(ROOT, 'src/@S@/@M@.ts'), 'utf8')",
        "const again = src('@S@', '@M@.ts')",
        "const rows = readFileSync(join(ROOT, 'src', '@S@', 'flags', 'core.ts'), 'utf8')",
        "const more = read('src/@S@/flags/core.ts')",
        "const kept = files.filter(f => f !== 'src/@S@/@M@.ts' && !/@M@\\.ts$/.test(f))",
        'export const out = [text, again, rows, more, kept]',
      ],
      named: [3, 4, 5, 6, 7],
    },
    { file: 'scripts/a/run.sh', lines: ['#!/usr/bin/env bash', '# gate-watch: src/@S@/@M@.ts', 'grep -c MERCURY src/@S@/@M@.ts'], named: [3] },
    { file: 'scripts/a/notes.md', lines: ['src/@S@/@M@.ts is where the rows live'], named: [] },
    { file: 'scripts/a/hole-parts.ts', lines: ["const text = readFileSync(join(ROOT, 'src', '@S@', '@M@' + '.ts'), 'utf8')"], named: [1] },
    { file: 'scripts/a/hole-template.ts', lines: ["const MODULE = '@M@'", "const text = readFileSync(join(ROOT, `src/@S@/${MODULE}.ts`), 'utf8')"], named: [1, 2] },
    { file: 'scripts/lib/hole-second-helper.ts', lines: ["export const @S@Text = (name: string): string => readFileSync(join(ROOT, 'src', '@S@', `${name}.ts`), 'utf8')"], named: [1] },
    { file: 'scripts/a/hole-wrapper.ts', lines: ["import { @S@Text } from '../lib/hole-second-helper.ts'", "const text = @S@Text('@M@')"], named: [2] },
    { file: 'scripts/a/hole-folder.ts', lines: ["for (const full of walk(join(ROOT, 'src', '@S@'))) readFileSync(full, 'utf8')"], named: [1] },
    { file: 'scripts/a/hole-glob.ts', lines: ["const found = [...new Bun.Glob('src/@S@/flag*.ts').scanSync({ cwd: ROOT }), ...new Bun.Glob('src/@S@/flag*/**/*').scanSync({ cwd: ROOT })]"], named: [1] },
    { file: 'scripts/a/hole-exec.ts', lines: ["const out = execFileSync('grep', ['-rc', 'MERCURY_', 'src/@S@'], { cwd: ROOT, encoding: 'utf8' })"], named: [1] },
    { file: 'scripts/a/hole-shell.sh', lines: ['set -u', 'name=@M@', 'grep -c MERCURY_ "src/@S@/$name.ts"', 'cat src/@S@/flagR*.ts', "find src/@S@ -name 'flag*' -type f"], named: [2, 3, 4, 5] },
    { file: 'scripts/a/hole-import-text.ts', lines: ["import text from '../../src/@S@/@M@.ts' with { type: 'text' }", "const late = await import('../../src/@S@/@M@.ts', { with: { type: 'text' } })"], named: [1, 2] },
    { file: 'scripts/a/hole-rows-folder.ts', lines: ["const @S@Dir = join(ROOT, 'src', '@S@')", "const rows = join(@S@Dir, 'flags')", "const core = join(ROOT, 'src', '@S@', 'flags/core.ts')"], named: [1, 2, 3] },
    { file: 'scripts/a/hole-path-test.ts', lines: ["const registry = files.filter(f => f.includes('/@M@') || /@S@[\\\\/]flags[\\\\/]/.test(f))"], named: [1] },
    { file: 'scripts/a/hole-noext', lines: ['grep -c MERCURY_ src/@S@/@M@.ts'], named: [1] },
    { file: 'scripts/a/hole-list.txt', lines: ['# paths a reader opens', 'src/@S@/@M@.ts'], named: [2] },
    { file: 'scripts/a/hole-list-reader.ts', lines: ["const listed = readFileSync(join(import.meta.dir, 'hole-list.txt'), 'utf8').split('\\n')"], named: [] },
    { file: 'scripts/a/gen-list.ts', lines: ['export const roots = [', "  'src/@S@/@M@.ts',", ']', 'export const twice = [', "  'src/@S@/@M@.ts',", ']', "console.log(readFileSync('src/@S@/@M@.ts', 'utf8').length)"], named: [5, 7] },
    { file: 'scripts/a/out-of-reach.ts', lines: ["const built = ['flag', 'Registry.ts'].join('')", "const tail = files.filter(f => f.endsWith('Registry.ts'))", "const whole = walk(join(ROOT, 'src'))"], named: [] },
  ]
  for (const { file, lines } of planted) {
    mkdirSync(dirname(join(estate, file)), { recursive: true })
    writeFileSync(join(estate, file), spell(lines.join('\n') + '\n'))
  }
  const got = scan(estate, planted.map(p => p.file))
  rmSync(estate, { recursive: true, force: true })
  const { unlisted, stale } = judge(got.mentions, [{ file: 'scripts/a/gen-list.ts', line: spell("'src/@S@/@M@.ts',"), why: 'a label' }])
  const seen = unlisted.map(where).join(' ')
  const want = planted.flatMap(p => p.named.map(n => `${p.file}:${n}`)).join(' ')
  check('a direct read, a read through a helper, a read of a rows file, a path test in a sweep and a shell grep are each named with their line', ['scripts/a/prove-read.ts:3', 'scripts/a/prove-read.ts:4', 'scripts/a/prove-read.ts:5', 'scripts/a/prove-read.ts:6', 'scripts/a/prove-read.ts:7', 'scripts/a/run.sh:3'].every(at => unlisted.some(m => where(m) === at)), `seen ${seen}`)
  check("each reader the review planted is named with its line and nothing else is: a path built from parts, a template with a hole, a second helper and its caller, a walk of the folder, a glob, a command over the folder, a shell variable and wildcard, an import with an attribute, the rows folder, a path test of a sweep's own, a script with no extension, a path in a data file", seen === want, `seen ${seen} · want ${want}`)
  check('a named row excuses its whole line once: a copy of the line and a longer line that holds it are named, and the row is not stale', unlisted.some(m => where(m) === 'scripts/a/gen-list.ts:5') && unlisted.some(m => where(m) === 'scripts/a/gen-list.ts:7') && !unlisted.some(m => where(m) === 'scripts/a/gen-list.ts:2') && stale.length === 0)
  check('five plain imports are counted as lookups, and a comment, a document, the door, another file of the folder and a label that says the name are not named', got.imports === 5 && !seen.includes('prove-lookup') && !seen.includes('notes.md') && !seen.includes(DOOR), `imports ${got.imports}`)
  check(`out of reach, as the estate check's label says: ${OUT_OF_REACH}`, !seen.includes('out-of-reach') && !seen.includes('hole-list-reader'))
}

section("§1 the door: the registry's files, their text and the path test")
{
  const files = flagRegistryFiles()
  const text = flagRegistryText()
  check('the list holds the registry module first and only registry files', files[0] === MODULE_PATH && files.every(isFlagRegistryFile), files.join(', '))
  check('the text is the text of the listed files and holds the registry', text.includes('export const FLAG_REGISTRY') && text.length >= files.length)
  const outside = FLAG_REGISTRY.filter(row => !text.includes(`'${row.env}'`) && !text.includes(`"${row.env}"`)).map(row => row.env)
  check('every row of FLAG_REGISTRY is spelled in the text the door reads', outside.length === 0, `${outside.length} of ${FLAG_REGISTRY.length} rows are spelled in no file the door reads, so no absence check sees them: ${outside.slice(0, 12).join(', ')}`)
  check('the text holds the row type', text.includes('export interface FlagSpec'), 'export interface FlagSpec stands in no file the door reads')
  check('the path test takes the module and anything under the rows folder, in either spelling of the separator', isFlagRegistryFile(MODULE_PATH) && isFlagRegistryFile(`${ROWS_DIR}/core.ts`) && isFlagRegistryFile(spell('src\\@S@\\flags\\deep\\core.ts')) && isFlagRegistryFile(spell('src\\@S@\\@M@.ts')))
  check('the path test refuses a neighbour, a look-alike and the door itself', !isFlagRegistryFile(spell('src/@S@/flagOff.ts')) && !isFlagRegistryFile(`${ROWS_DIR}.ts`) && !isFlagRegistryFile(`${ROWS_DIR}Extra/core.ts`) && !isFlagRegistryFile(`${MODULE_PATH}x`) && !isFlagRegistryFile(DOOR))
  const split = mkdtempSync(join(tmpdir(), 'flag-registry-door-'))
  const w = (rel: string, body: string): void => {
    mkdirSync(dirname(join(split, rel)), { recursive: true })
    writeFileSync(join(split, rel), body)
  }
  w(MODULE_PATH, 'MODULE')
  w(`${ROWS_DIR}/b.ts`, 'B')
  w(`${ROWS_DIR}/a.ts`, 'A')
  w(`${ROWS_DIR}/deep/c.ts`, 'C')
  w(`${ROWS_DIR}/b.ts.orig`, 'A BACKUP')
  w(`${ROWS_DIR}/.DS_Store`, 'A FINDER FILE')
  w(spell('src/@S@/flagOff.ts'), 'OFF')
  const after = flagRegistryFiles(split)
  check('on a tree whose rows live in the rows folder the list is the module and every .ts file under the folder, in order', after.join(' ') === [MODULE_PATH, `${ROWS_DIR}/a.ts`, `${ROWS_DIR}/b.ts`, `${ROWS_DIR}/deep/c.ts`].join(' '), after.join(' '))
  check('…and the text is those files joined: a neighbour, a backup and a file that is not .ts are left out', flagRegistryText(split) === 'MODULE\nA\nB\nC', flagRegistryText(split))
  rmSync(join(split, MODULE_PATH))
  rmSync(join(split, ROWS_DIR), { recursive: true, force: true })
  check('a tree with no registry has no files and no text', flagRegistryFiles(split).length === 0 && flagRegistryText(split) === '')
  rmSync(split, { recursive: true, force: true })
}

section("§2 the estate: a script reads the registry's text through the door or not at all")
{
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'scripts'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)
  const got = scan(ROOT, files)
  const { unlisted, stale } = judge(got.mentions, NAMED)
  console.log(`  ${files.length} files under scripts · ${got.read} read, whatever their extension (documents and binary files aside) · ${got.imports} plain imports of the registry · 1 door (${DOOR}) · ${got.mentions.length - unlisted.length} named lines that read nothing · ${unlisted.length} unlisted`)
  check('the door is a script of this tree', files.includes(DOOR))
  check(
    `no script names the registry's files outside a plain import and the door (0 unlisted readers; out of reach: ${OUT_OF_REACH})`,
    unlisted.length === 0,
    `${unlisted.length} found — ${INSTEAD}; the named list only shrinks:` + unlisted.slice(0, 40).map(m => `\n      ${where(m)} ${m.text.slice(0, 140)}`).join(''),
  )
  check('every named row still stands, on its whole line and once (a row whose line is gone is removed, and the count below with it)', stale.length === 0, stale.map(r => `${r.file} [${r.line.slice(0, 60)}]`).join(' · '))
  check(`the named list holds ${NAMED_ROWS} rows, each with its reason, and none of them reads the text`, NAMED.length === NAMED_ROWS && NAMED.every(r => r.why.trim().length > 0), `rows ${NAMED.length}`)
}

console.log(failures === 0 ? '\nprove-flag-registry-readers: green' : `\nprove-flag-registry-readers: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
