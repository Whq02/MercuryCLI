#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { censusFiles, commentRanges, hashCensusFiles, withoutComments } from '../lib/commentCensus.ts'
import { HASH_KEEP_RULES, hashComments, hashKindOf } from '../lib/hashComments.ts'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' the comment census: the product, its proofs and the scripts of the tree carry no comments; directives and vendored code are the only comment text')
console.log('============================================================')

const found: string[] = []
let files = 0
for (const path of censusFiles(ROOT)) {
  files++
  const text = readFileSync(path, 'utf8')
  const ranges = commentRanges(path, text)
  if (ranges.length > 0) found.push(`${path.slice(ROOT.length + 1)}: ${ranges.length} (first at offset ${ranges[0]!.pos}: ${JSON.stringify(text.slice(ranges[0]!.pos, Math.min(ranges[0]!.end, ranges[0]!.pos + 60)))})`)
}
check(`every source file under src and scripts is read (${files})`, files > 5000)
check('zero comments', found.length === 0, `${found.length} file(s):\n    ${found.slice(0, 12).join('\n    ')}`)

const outside: string[] = []
const kinds = new Map<string, number>()
const keptByRule = new Map<string, number>()
let outsideComments = 0
let outsideFiles = 0
for (const path of hashCensusFiles(ROOT)) {
  const text = readFileSync(path, 'utf8')
  const kind = hashKindOf(path, text)
  if (kind === null) continue
  outsideFiles++
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
  const comments = hashComments(path, text)
  for (const comment of comments) if (comment.keep !== null) keptByRule.set(comment.keep, (keptByRule.get(comment.keep) ?? 0) + 1)
  const open = comments.filter(comment => comment.keep === null)
  if (open.length === 0) continue
  outsideComments += open.length
  const first = open[0]!
  outside.push(`${path.slice(ROOT.length + 1)}:${text.slice(0, first.pos).split('\n').length}: ${open.length} (first: ${JSON.stringify(text.slice(first.pos, Math.min(first.end, first.pos + 60)))})`)
}
const tally = (counts: Map<string, number>): string =>
  [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} ${n}`)
    .join(' · ')
check(`every tracked shell, Python, YAML, GDScript, PowerShell, TOML and sed file outside vendor and native is read (${outsideFiles}: ${tally(kinds)})`, outsideFiles > 400)
check(
  `zero comments outside TypeScript (kept by rule: ${tally(keptByRule)})`,
  outside.length === 0,
  `${outsideComments} comment(s) in ${outside.length} file(s); delete each one, or name the tool that reads it as a rule in scripts/lib/hashComments.ts:\n    ${outside.slice(0, 12).join('\n    ')}`,
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
const HASH_CASES: HashCase[] = [
  {
    path: 'fixture.sh',
    lines: [
      '#!/usr/bin/env bash',
      '# gate-class: pure',
      '# gate-watch: src/one/**',
      '# gate-env: MERCURY_ONE',
      '# a banner line',
      '# shellcheck disable=SC2034',
      '# managed by scripts/splash/deploy.sh',
      'set -euo pipefail # trailing words',
      'count=$# ; name=${1#prefix} ; hex=$(( 16#ff ))',
      'echo "a # inside double quotes" \'and # inside single quotes\'',
      "cat <<'EOF'",
      '# a here-document line',
      'EOF',
      'kind=$(case "$name" in a) echo one ;; esac) # after a substitution',
      '',
    ],
    kept: [
      ['shebang', '#!/usr/bin/env bash'],
      ['gate header', '# gate-class: pure'],
      ['gate header', '# gate-watch: src/one/**'],
      ['gate header', '# gate-env: MERCURY_ONE'],
      ['shellcheck', '# shellcheck disable=SC2034'],
      ['generated marker', '# managed by scripts/splash/deploy.sh'],
    ],
    gone: ['# a banner line', '# trailing words', '# after a substitution'],
    stays: ['count=$# ; name=${1#prefix} ; hex=$(( 16#ff ))', '"a # inside double quotes" \'and # inside single quotes\'', '# a here-document line', 'esac)'],
  },
  {
    path: 'fixture.py',
    lines: [
      '#!/usr/bin/env python3',
      '# -*- coding: utf-8 -*-',
      '# a banner line',
      'import os  # trailing words',
      'value = "# inside a string"  # type: ignore',
      "text = '''",
      '# inside a triple-quoted string',
      "'''",
      'def sep():  # noqa: E501',
      '    return os.sep  # pragma: no cover',
      '# pylint: disable=invalid-name',
      '',
    ],
    kept: [
      ['shebang', '#!/usr/bin/env python3'],
      ['encoding', '# -*- coding: utf-8 -*-'],
      ['type', '# type: ignore'],
      ['noqa', '# noqa: E501'],
      ['pragma', '# pragma: no cover'],
      ['linter', '# pylint: disable=invalid-name'],
    ],
    gone: ['# a banner line', '# trailing words'],
    stays: ['"# inside a string"', '# inside a triple-quoted string'],
  },
  {
    path: 'fixture.yml',
    lines: [
      '# yaml-language-server: $schema=https://json.schemastore.org/github-workflow.json',
      '# a banner line',
      'name: fixture # trailing words',
      'jobs:',
      '  one:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567 # v7',
      '      - run: |',
      '          # a bash run block line',
      '          echo "# inside a string"',
      '      - shell: pwsh',
      '        run: |',
      '          # a PowerShell run block line',
      '          Write-Host 1',
      '',
    ],
    kept: [
      ['language server', '# yaml-language-server: $schema=https://json.schemastore.org/github-workflow.json'],
      ['action pin', '# v7'],
    ],
    gone: ['# a banner line', '# trailing words', '# a bash run block line'],
    stays: ['echo "# inside a string"', '# a PowerShell run block line'],
  },
  {
    path: 'fixture.gd',
    lines: ['@tool', 'extends Node', '#region helpers', '## a documentation line', '# warning-ignore:unused_variable', 'var colour = "#ff0000" # trailing words', '# gdlint: disable=max-line-length', '#endregion', ''],
    kept: [
      ['region', '#region helpers'],
      ['warning-ignore', '# warning-ignore:unused_variable'],
      ['gdtoolkit', '# gdlint: disable=max-line-length'],
      ['region', '#endregion'],
    ],
    gone: ['## a documentation line', '# trailing words'],
    stays: ['@tool', 'var colour = "#ff0000"'],
  },
  {
    path: 'fixture.ps1',
    lines: ['#Requires -Version 7.0', '# a banner line', '<# a block', '   comment #>', "$colour = '#ff0000' # trailing words", '$text = @"', '# inside a here-string', '"@', ''],
    kept: [['requires', '#Requires -Version 7.0']],
    gone: ['# a banner line', 'a block', '# trailing words'],
    stays: ["$colour = '#ff0000'", '# inside a here-string'],
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
    lines: ['#n', '# a banner line', 's/#.*//p', ''],
    kept: [['quiet', '#n']],
    gone: ['# a banner line'],
    stays: ['s/#.*//p'],
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
    `${kind}: the scanner keeps ${fixture.kept.length} directive(s) by rule (${[...new Set(fixture.kept.map(([rule]) => rule))].join(', ') || 'the kind has none'})`,
    kept.length === fixture.kept.length && fixture.kept.every(([rule, line]) => kept.some(comment => comment.keep === rule && text.slice(comment.pos, comment.end) === line) && result.out.includes(line)),
    JSON.stringify(kept.map(comment => [comment.keep, text.slice(comment.pos, comment.end)])),
  )
  check(
    `${kind}: the scanner removes its ${fixture.gone.length} comments and leaves a # inside a string, a here-document or a command alone`,
    result.removed === fixture.gone.length && fixture.gone.every(words => !result.out.includes(words)) && fixture.stays.every(words => result.out.includes(words)),
    JSON.stringify(result),
  )
}
check(
  'every keep rule has a self-test case',
  HASH_KEEP_RULES.every(rule => exercised.has(rule.name)),
  `no case for: ${HASH_KEEP_RULES.filter(rule => !exercised.has(rule.name))
    .map(rule => rule.name)
    .join(', ')}; add a line that the rule keeps to HASH_CASES in this file`,
)

console.log(failures === 0 ? `\n✅ COMMENT CENSUS — ${checks} checks` : `\n❌ ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
