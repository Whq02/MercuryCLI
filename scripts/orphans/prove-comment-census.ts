#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { censusFiles, censusTree, commentRanges, KEEP_REASONS, keepFolders, withoutComments } from '../lib/commentCensus.ts'
import { HASH_KEEP_RULES, hashComments, hashKindOf, SCRIPT_KEEP_READERS } from '../lib/hashComments.ts'

const ROOT = join(import.meta.dir, '..', '..')
const TABLE = join(import.meta.dir, 'comment-census.tsv')
const TABLE_NAME = 'scripts/orphans/comment-census.tsv'
const WRITE = process.argv.includes('--write')
const OUT_OF_REACH = "a program quoted to node, awk, sed, bash or python, and a no-op ':' with a quoted string"
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' the comment census: every tracked code file the project writes carries no comments; directives a tool reads and the counted exceptions are the only comment text')
console.log('============================================================')

const found: string[] = []
let files = 0
for (const path of censusFiles(ROOT)) {
  files++
  const text = readFileSync(path, 'utf8')
  const ranges = commentRanges(path, text)
  if (ranges.length > 0) found.push(`${path.slice(ROOT.length + 1)}: ${ranges.length} (first at offset ${ranges[0]!.pos}: ${JSON.stringify(text.slice(ranges[0]!.pos, Math.min(ranges[0]!.end, ranges[0]!.pos + 60)))})`)
}
check(`every source file under src and scripts is read (${files})`, files > 0)
check('zero comments', found.length === 0, `${found.length} file(s):\n    ${found.join('\n    ')}`)

const tree = censusTree(ROOT)
const outside: string[] = []
const kinds = new Map<string, number>()
const keptByRule = new Map<string, number>(HASH_KEEP_RULES.map(rule => [rule.name, 0]))
const PROSE = HASH_KEEP_RULES.filter(rule => rule.prose).map(rule => rule.name)
const proseFiles = new Map<string, number[]>()
const linesOf = (text: string, at: { pos: number }[]): number[] => at.map(one => text.slice(0, one.pos).split('\n').length)
let outsideComments = 0
const firstOf = (path: string, text: string, open: { pos: number; end: number }[]): string => `${path}:${text.slice(0, open[0]!.pos).split('\n').length}: ${open.length} (first: ${JSON.stringify(text.slice(open[0]!.pos, Math.min(open[0]!.end, open[0]!.pos + 60)))})`
for (const file of tree.read) {
  const text = readFileSync(join(ROOT, file.path), 'utf8')
  kinds.set(file.kind, (kinds.get(file.kind) ?? 0) + 1)
  const comments = hashComments(file.path, text)
  for (const comment of comments) if (comment.keep !== null) keptByRule.set(comment.keep, (keptByRule.get(comment.keep) ?? 0) + 1)
  const prose = comments.filter(comment => comment.keep !== null && PROSE.includes(comment.keep))
  if (prose.length > 0) proseFiles.set(file.path, linesOf(text, prose))
  const open = comments.filter(comment => comment.keep === null)
  if (open.length === 0) continue
  outsideComments += open.length
  outside.push(firstOf(file.path, text, open))
}
const tally = (counts: Map<string, number>): string =>
  [...counts]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} ${n}`)
    .join(' · ')
check(
  `every tracked shell, Python, YAML, GDScript, PowerShell, TOML, sed, JavaScript, C# and other code file is placed and read (${tree.read.length}: ${tally(kinds)}; ${tree.plain} tracked files are data, markup or binary)`,
  tree.unplaced.length === 0,
  `${tree.unplaced.length} tracked file(s) of a kind the census cannot place; name the kind in HASH_KINDS, or the extension in PLAIN_EXTENSIONS, in scripts/lib/hashComments.ts:\n    ${tree.unplaced.join('\n    ')}`,
)
check(
  `zero comments outside TypeScript under src and scripts (kept by rule: ${tally(keptByRule)}; out of reach: ${OUT_OF_REACH})`,
  outside.length === 0,
  `${outsideComments} comment(s) in ${outside.length} file(s); delete each one (a line a tool reads is a rule in scripts/lib/hashComments.ts with its reader and its whole grammar):\n    ${outside.join('\n    ')}`,
)

const readers = new Map<string, string>([...HASH_KEEP_RULES.map((rule): [string, string] => [rule.name, rule.reader]), ...SCRIPT_KEEP_READERS])
const unread = [...keptByRule].filter(([name, n]) => n > 0 && !readers.has(name)).map(([name]) => name)
check(
  `every kept line has a reader (${[...keptByRule]
    .filter(([, n]) => n > 0)
    .map(([name]) => `${name}: ${readers.get(name) ?? 'none named'}`)
    .join(' · ')})`,
  unread.length === 0,
  `no reader named for: ${unread.join(', ')}; a kept script directive is a row of SCRIPT_KEEP_READERS in scripts/lib/hashComments.ts`,
)

const exceptedRows: string[] = []
const exceptedNames: string[] = []
const exceptedFiles = new Map<string, number[]>()
for (const [folder, held] of tree.excepted) {
  let comments = 0
  let commented = 0
  for (const file of held) {
    const text = readFileSync(join(ROOT, file.path), 'utf8')
    const open = hashComments(file.path, text).filter(comment => comment.keep === null)
    if (open.length === 0) continue
    comments += open.length
    commented++
    exceptedFiles.set(file.path, linesOf(text, open))
  }
  exceptedRows.push(`excepted\t${folder}\t${commented}\t${comments}`)
  exceptedNames.push(`${folder} ${comments} in ${commented} of ${held.length} file(s)`)
}
const unreasoned = keepFolders().filter(folder => !KEEP_REASONS.some(([under, reason]) => under === folder && reason.trim() !== ''))
check(
  `every excepted folder is named with its reason (${exceptedNames.join(' · ')})`,
  unreasoned.length === 0,
  `no reason for: ${unreasoned.join(', ')}; an exception is a row of KEEP_REASONS in scripts/lib/commentCensus.ts with why its comments stay, and its counts in ${TABLE_NAME}`,
)

const rows: string[] = [
  ...[...PROSE].sort().map(rule => `kept\t${rule}\t${keptByRule.get(rule) ?? 0}`),
  ...[...proseFiles].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([path, lines]) => `kept-file\t${path}\t${lines.length}`),
  ...exceptedRows.sort(),
  ...[...exceptedFiles].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([path, lines]) => `excepted-file\t${path}\t${lines.length}`),
]
const keyOf = (row: string): string => row.split('\t').slice(0, 2).join('\t')
const lastOf = (row: string): number => Number(row.split('\t').at(-1))
const held = existsSync(TABLE) ? readFileSync(TABLE, 'utf8').split('\n').filter(Boolean) : null

if (WRITE) {
  const text = `${rows.join('\n')}\n`
  if (held === null && !process.argv.includes('--first')) {
    console.log(`\n${TABLE_NAME} is absent: a first table is written with --write --first`)
    process.exit(1)
  }
  const before = new Map((held ?? []).map(row => [keyOf(row), lastOf(row)]))
  const rises: string[] = []
  for (const family of ['kept-file', 'excepted-file']) {
    let up = 0
    let down = 0
    const named: string[] = []
    const after = new Map(rows.filter(row => row.startsWith(`${family}\t`)).map(row => [keyOf(row), lastOf(row)]))
    for (const [key, n] of after) {
      const was = before.get(key) ?? 0
      if (n > was) {
        up += n - was
        named.push(`${key.replace('\t', ' ')}: ${was} to ${n}`)
      } else down += was - n
    }
    for (const [key, was] of before) if (key.startsWith(`${family}\t`) && !after.has(key)) down += was
    if (held !== null && up > down) rises.push(`${family === 'kept-file' ? 'lines of prose kept by rule' : 'comments in excepted files'} rise by ${up} and fall by ${down}: ${named.join(' · ')}`)
  }
  if (rises.length > 0) {
    console.log(`\n--write refused, ${TABLE_NAME} is unchanged: ${rises.join('; ')}. Delete the new docstring or comment; one that has a reader is raised by hand in the table, its file's row alone.`)
    process.exit(1)
  }
  if (held !== null && held.join('\n') === rows.join('\n')) console.log(`\n${TABLE_NAME} is current (${rows.length} rows)`)
  else {
    writeFileSync(TABLE, text)
    console.log(`\nwrote ${TABLE_NAME} (${rows.length} rows)`)
  }
  process.exit(0)
}

const tableMoves = (read: string[]): { moved: string[]; gone: number } => {
  const moved: string[] = []
  let gone = 0
  if (held === null) return { moved, gone }
  const before = new Map(held.map(row => [keyOf(row), row]))
  const after = new Map(read.map(row => [keyOf(row), row]))
  for (const [key, row] of after) {
    const was = before.get(key)
    if (was === row) continue
    const reads = row.split('\t').slice(2)
    if (was !== undefined && reads.every(count => count === '0')) {
      gone++
      continue
    }
    const name = key.replace('\t', ' ')
    const lines = key.startsWith('excepted-file\t') ? exceptedFiles.get(key.split('\t')[1]!) : key.startsWith('kept-file\t') ? proseFiles.get(key.split('\t')[1]!) : undefined
    const where = lines === undefined ? '' : ` (${key.split('\t')[1]!}:${lines[0]}, every one at lines ${lines.join(', ')})`
    moved.push(was === undefined ? `${name}: no row, the tree reads ${reads.join(' ')}${where}` : `${name}: the table holds ${was.split('\t').slice(2).join(' ')}, the tree reads ${reads.join(' ')}${where}`)
  }
  for (const key of before.keys()) if (!after.has(key)) gone++
  return { moved, gone }
}
const { moved, gone } = tableMoves(rows)
check(
  `${TABLE_NAME} holds what the census read of the counts that may only fall: prose kept by rule and the comments of the excepted folders, file by file (${rows.length} rows)`,
  held !== null && moved.length === 0,
  held === null
    ? `${TABLE_NAME} is absent; write it once: bun scripts/orphans/prove-comment-census.ts --write --first`
    : `${moved.length} row(s) moved; delete the new docstring or comment, and where one left write the table: bun scripts/orphans/prove-comment-census.ts --write\n    ${moved.join('\n    ')}`,
)
if (gone > 0) console.log(`    ${gone} row(s) of the table read nothing in this tree: a published checkout carries no comment the publish filter strips and no file it drops; where one left the private tree, write the table: bun scripts/orphans/prove-comment-census.ts --write`)

const published: string[] = rows.filter(row => !row.startsWith('excepted'))
for (const [folder, files] of tree.excepted) {
  let comments = 0
  let commented = 0
  for (const file of files) {
    const left = hashComments(file.path, withoutComments(file.path, readFileSync(join(ROOT, file.path), 'utf8')).out).filter(comment => comment.keep === null).length
    if (left === 0) continue
    comments += left
    commented++
    published.push(`excepted-file\t${file.path}\t${left}`)
  }
  published.push(`excepted\t${folder}\t${commented}\t${comments}`)
}
const publishedMoves = tableMoves(published).moved
check(
  'on a published checkout (every comment stripped, as the publish filter does) no row of the table moves: a row that reads nothing there is no rise',
  held !== null && publishedMoves.length === 0,
  `${publishedMoves.length} row(s) moved once every comment is stripped; the hosted gate reads a published checkout, so tableMoves in scripts/orphans/prove-comment-census.ts must pass a row that reads nothing where the table holds a count:\n    ${publishedMoves.join('\n    ')}`,
)

const fixture = [
  '// @ts-expect-error kept',
  '/* eslint-disable */',
  '/// <reference types="bun" />',
  'const url = "http://example.com/not/a/comment" // trailing',
  '/** doc block */',
  'export const two = `// inside a template ${url}`',
  '/* block */ export const three = 3 /* tail */',
  '',
].join('\n')
const stripped = withoutComments('fixture.ts', fixture)
check('the scanner keeps compiler and linter directives', stripped.out.includes('// @ts-expect-error kept') && stripped.out.includes('/* eslint-disable */') && stripped.out.includes('/// <reference types="bun" />'))
check('the scanner never touches a comment-shaped string or template', stripped.out.includes('"http://example.com/not/a/comment"') && stripped.out.includes('`// inside a template ${url}`'))
check('the scanner removes line, block and doc comments and counts them', !stripped.out.includes('// trailing') && !stripped.out.includes('doc block') && !stripped.out.includes('/* block */') && !stripped.out.includes('/* tail */') && stripped.removed === 4, JSON.stringify(stripped))
check('a stripped file is still the same program (the scanner removed only trivia)', stripped.out.includes('export const three = 3') && stripped.out.includes('export const two = '))

type HashCase = { path: string; lines: string[]; kept: [rule: string, comment: string][]; gone: string[]; stays: string[] }
const PIN = 'actions/checkout@0123456789abcdef0123456789abcdef01234567'
const HASH_CASES: HashCase[] = [
  {
    path: 'scripts/fixture/run-all.sh',
    lines: [
      '#!/usr/bin/env bash',
      '# gate-class: pure',
      '# gate-watch: src/one/** scripts/lib/two.ts',
      '# gate-env: MERCURY_ONE',
      '# gate-class: pure and prose after the class',
      '# a banner line',
      'set -euo pipefail # trailing words',
      'count=$# ; name=${1#prefix} ; hex=$(( 16#ff )) ; old=$[ 1 << 2 ]',
      'echo "a # inside double quotes" \'and # inside single quotes\'',
      "cat <<'EOF'",
      '# a here-document line that cat reads',
      'EOF',
      ": <<'NOTE'",
      'prose parked in a here-document that nothing reads',
      'NOTE',
      "python3 - <<'PY'",
      '# a Python comment inside a here-document',
      'print("x")',
      'PY',
      'kind=$(case "$name" in a) echo one ;; esac) # after a substitution',
      '# gate-class: cpu',
      '',
    ],
    kept: [
      ['shebang', '#!/usr/bin/env bash'],
      ['gate header', '# gate-class: pure'],
      ['gate header', '# gate-watch: src/one/** scripts/lib/two.ts'],
      ['gate header', '# gate-env: MERCURY_ONE'],
    ],
    gone: ['# gate-class: pure and prose after the class', '# a banner line', '# trailing words', 'prose parked in a here-document', '# a Python comment inside a here-document', '# after a substitution', '# gate-class: cpu'],
    stays: ['old=$[ 1 << 2 ]', '"a # inside double quotes" \'and # inside single quotes\'', '# a here-document line that cat reads', 'esac)', 'print("x")'],
  },
  {
    path: 'scripts/ops/fixture.sh',
    lines: ['# managed by scripts/splash/deploy.sh — do not hand-edit', '# managed by scripts/splash/deploy.sh and words after the script', '# gate-class: pure', '# shellcheck disable=SC2034', 'printf x', ''],
    kept: [['generated marker', '# managed by scripts/splash/deploy.sh — do not hand-edit']],
    gone: ['# managed by scripts/splash/deploy.sh and words', '# gate-class: pure', '# shellcheck disable=SC2034'],
    stays: ['printf x'],
  },
  {
    path: 'assets/completions/_fixture',
    lines: ['#compdef fixture', '# a banner line', '_fixture() { :; }', ''],
    kept: [['compdef', '#compdef fixture']],
    gone: ['# a banner line'],
    stays: ['_fixture() { :; }'],
  },
  {
    path: 'fixture.fish',
    lines: ['# a banner line', 'set colour "a # inside a string" # trailing words', 'echo a#b', ''],
    kept: [],
    gone: ['# a banner line', '# trailing words'],
    stays: ['"a # inside a string"', 'echo a#b'],
  },
  {
    path: 'scripts/ops/fixture.py',
    lines: [
      '#!/usr/bin/env python3',
      '# -*- coding: utf-8 -*-',
      '"""a module docstring"""',
      '# coding: utf-8 and prose after the name',
      'import os  # type: ignore',
      'value = "# inside a string"  # trailing words',
      "text = '''",
      '# inside a triple-quoted string',
      "'''",
      'def sep():',
      '    """a function docstring"""',
      '    "a string statement in a body"',
      '    return os.sep',
      '',
    ],
    kept: [
      ['shebang', '#!/usr/bin/env python3'],
      ['encoding', '# -*- coding: utf-8 -*-'],
    ],
    gone: ['a module docstring', '# coding: utf-8 and prose', '# type: ignore', '# trailing words', 'a function docstring', 'a string statement in a body'],
    stays: ['"# inside a string"', '# inside a triple-quoted string', 'return os.sep'],
  },
  {
    path: 'scripts/ops/usage.py',
    lines: ['"""usage: fixture [words]"""', 'import sys', 'def main():', '    """a function docstring"""', '    sys.stdout.write(__doc__)', ''],
    kept: [['read docstring', '"""usage: fixture [words]"""']],
    gone: ['a function docstring'],
    stays: ['sys.stdout.write(__doc__)'],
  },
  {
    path: 'sdk-py/src/fixture/client.py',
    lines: ['"""the module an SDK user imports"""', '# a banner line', 'def run():', '    """what an editor shows for run"""', '    "a string statement that is no docstring"', '    return 1', ''],
    kept: [
      ['sdk docstring', '"""the module an SDK user imports"""'],
      ['sdk docstring', '"""what an editor shows for run"""'],
    ],
    gone: ['# a banner line', 'a string statement that is no docstring'],
    stays: ['return 1'],
  },
  {
    path: '.github/workflows/fixture.yml',
    lines: [
      '# a banner line',
      'name: fixture # trailing words',
      'jobs:',
      '  linux:',
      "    runs-on: ${{ vars.RUNNER || 'ubuntu-latest' }}",
      '    steps:',
      `      - uses: ${PIN} # v7`,
      `      - uses: ${PIN} # v7 and words`,
      '      - run: |',
      '          # a bash run block line',
      '          echo "# inside a string" # a trailing bash comment',
      '      - shell: python',
      '        run: |',
      '          # a Python run block line',
      '          print(1)',
      '      - run: >',
      '          echo 1',
      '          # a folded run block line',
      '      - uses: actions/github-script@0123456789abcdef0123456789abcdef01234567',
      '        with:',
      '          script: |',
      '            // a JavaScript line in a script block',
      '            return 1',
      '  windows:',
      '    runs-on: windows-latest',
      '    steps:',
      '      - run: |',
      '          #Requires -Version 7.0',
      '          # a PowerShell run block line',
      "          Write-Host '# inside a string'",
      '',
    ],
    kept: [
      ['action pin', '# v7'],
      ['requires', '#Requires -Version 7.0'],
    ],
    gone: ['# a banner line', '# trailing words', '# v7 and words', '# a bash run block line', '# a trailing bash comment', '# a Python run block line', '# a folded run block line', '// a JavaScript line in a script block', '# a PowerShell run block line'],
    stays: ['echo "# inside a string"', 'print(1)', 'return 1', "Write-Host '# inside a string'"],
  },
  {
    path: '.github/actions/fixture/action.yml',
    lines: ['name: fixture', 'runs:', '  using: composite', '  steps:', '    - shell: bash', '      run: |', '        # a bash line of a composite action', '        echo 1', ''],
    kept: [],
    gone: ['# a bash line of a composite action'],
    stays: ['echo 1'],
  },
  {
    path: 'fixture.gd',
    lines: ['@tool', 'extends Node', '#region helpers', '## a documentation line', 'var colour = "#ff0000" # trailing words', 'func block() -> int:', '\t"""a string statement used as a block comment"""', '\treturn 1', ''],
    kept: [],
    gone: ['#region helpers', '## a documentation line', '# trailing words', 'a string statement used as a block comment'],
    stays: ['@tool', 'var colour = "#ff0000"', 'return 1'],
  },
  {
    path: 'fixture.ps1',
    lines: ['#Requires -Version 7.0', '#Requires -Version 7.0 and prose', '# a banner line', '<# a block', '   comment #>', "$colour = '#ff0000' # trailing words", '$list = @(1, 2)# after a parenthesis', '$text = @"', '# inside a here-string', '"@', ''],
    kept: [['requires', '#Requires -Version 7.0']],
    gone: ['#Requires -Version 7.0 and prose', '# a banner line', 'a block', '# trailing words', '# after a parenthesis'],
    stays: ["$colour = '#ff0000'", '$list = @(1, 2)', '# inside a here-string'],
  },
  {
    path: 'fixture.toml',
    lines: ['# a banner line', '[package]', 'name = "a # inside a string" # trailing words', "path = 'C:\\dir\\' # after a literal string", ''],
    kept: [],
    gone: ['# a banner line', '# trailing words', '# after a literal string'],
    stays: ['name = "a # inside a string"', "path = 'C:\\dir\\'"],
  },
  {
    path: 'fixture.sed',
    lines: ['#n', '# a banner line', 's/#.*//p', 's/a/b/;# after a command', ''],
    kept: [['quiet', '#n']],
    gone: ['# a banner line', '# after a command'],
    stays: ['s/#.*//p', 's/a/b/;'],
  },
  {
    path: 'fixture.mjs',
    lines: ['// a banner line', 'export const url = "http://example.com/not/a/comment" /* a block */', ''],
    kept: [],
    gone: ['// a banner line', '/* a block */'],
    stays: ['"http://example.com/not/a/comment"'],
  },
  {
    path: 'Fixture.cs',
    lines: ['// a banner line', '/// a documentation line', 'internal static class Fixture { const string Url = "http://x//y"; const string Path = @"c:\\dir // z"; /* a block */ }', ''],
    kept: [],
    gone: ['// a banner line', '/// a documentation line', '/* a block */'],
    stays: ['"http://x//y"', '@"c:\\dir // z"'],
  },
  {
    path: 'fixture.rs',
    lines: ['// a banner line', '/* a block /* nested */ still the block */', "pub fn f<'a>(s: &'a str) -> &'a str { let _u = \"http://x//y\"; s }", ''],
    kept: [],
    gone: ['// a banner line', 'a block /* nested */ still the block'],
    stays: ['"http://x//y"', "&'a str"],
  },
  {
    path: 'fixture.json',
    lines: ['{', '  // a comment line', '  "url": "http://example.com//x"', '}', ''],
    kept: [],
    gone: ['// a comment line'],
    stays: ['"http://example.com//x"'],
  },
  {
    path: 'fixture.nix',
    lines: ['# a banner line', '{ url = "http://x#y"; /* a block */ }', ''],
    kept: [],
    gone: ['# a banner line', '/* a block */'],
    stays: ['"http://x#y"'],
  },
  {
    path: 'fixture.cfg',
    lines: ['; a banner line', '[section]', 'name="a;b"', ''],
    kept: [],
    gone: ['; a banner line'],
    stays: ['name="a;b"'],
  },
  {
    path: '.gitignore',
    lines: ['# a banner line', 'dist', 'a#b', ''],
    kept: [],
    gone: ['# a banner line'],
    stays: ['dist', 'a#b'],
  },
  {
    path: 'Dockerfile',
    lines: ['# a banner line', 'FROM scratch', 'RUN echo a#b', ''],
    kept: [],
    gone: ['# a banner line'],
    stays: ['FROM scratch', 'RUN echo a#b'],
  },
]
const exercised = new Set<string>()
for (const fixture of HASH_CASES) {
  const text = fixture.lines.join('\n')
  const kind = hashKindOf(fixture.path, text)
  const comments = hashComments(fixture.path, text)
  const result = withoutComments(fixture.path, text)
  const kept = comments.filter(comment => comment.keep !== null)
  for (const comment of kept) exercised.add(comment.keep!)
  check(
    `${kind} (${fixture.path}): the scanner keeps ${fixture.kept.length} directive(s) by rule (${[...new Set(fixture.kept.map(([rule]) => rule))].join(', ') || 'none'})`,
    kept.length === fixture.kept.length && fixture.kept.every(([rule, line]) => kept.some(comment => comment.keep === rule && text.slice(comment.pos, comment.end) === line) && result.out.includes(line)),
    JSON.stringify(kept.map(comment => [comment.keep, text.slice(comment.pos, comment.end)])),
  )
  check(
    `${kind} (${fixture.path}): the scanner counts its ${fixture.gone.length} comments and leaves strings, commands and what a program reads alone`,
    result.removed === fixture.gone.length && fixture.gone.every(words => !result.out.includes(words)) && fixture.stays.every(words => result.out.includes(words)),
    JSON.stringify({ removed: result.removed, out: result.out }),
  )
}
check(
  'every keep rule names its reader and has a self-test case',
  HASH_KEEP_RULES.every(rule => exercised.has(rule.name) && rule.reader.trim() !== ''),
  `no case or no reader for: ${HASH_KEEP_RULES.filter(rule => !exercised.has(rule.name) || rule.reader.trim() === '')
    .map(rule => rule.name)
    .join(', ')}; add a line that the rule keeps to HASH_CASES in this file`,
)

console.log(failures === 0 ? `\n✅ COMMENT CENSUS — ${checks} checks` : `\n❌ ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
