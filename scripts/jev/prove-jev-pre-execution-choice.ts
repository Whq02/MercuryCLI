#!/usr/bin/env bun
// gate-watch: src/tools/JevEvalTool/jevEvalRequest.ts src/tools/JevEvalTool/jevEvalEvidence.ts src/tools/JevEvalTool/jevEvalResult.ts
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'jev-pre-exec-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const key of ['TYPESAFE_API_KEY', 'NODE_ENV', 'MERCURY_API_UNIX_SOCKET']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://example.invalid/mercury' }

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { assembleJevEvalRequest } = await import('../../src/tools/JevEvalTool/jevEvalRequest.ts')
const { jevEvalRefusedText } = await import('../../src/tools/JevEvalTool/jevEvalResult.ts')
type Input = Parameters<typeof assembleJevEvalRequest>[0]
type Question = Input['questions'][number]

const fileChoice: Question = { id: 'where', kind: 'choice', ask: 'Which file holds the bug?', options: { 'src/parser.ts': null, 'src/lexer.ts': null, 'lib/tokens.py': 'the python side' }, allow_none: true }
const assemble = (evidence: Input['evidence'], questions: Question[] = [fileChoice]) => assembleJevEvalRequest({ goal: 'locate the bug', evidence, questions })
const reasonOf = (result: ReturnType<typeof assembleJevEvalRequest>): string => (result.ok ? 'ASSEMBLED (sent!)' : result.reason)

section('§1 a choice between file paths with nothing measured beside it is refused, and the refusal says what to bring')
{
  const bare = assemble([{ issue: 'the parser drops the last field of every row' }])
  check('refused', !bare.ok, reasonOf(bare))
  const reason = bare.ok ? '' : bare.reason
  check('the refusal names the question and the paths', /question "where"/.test(reason) && /src\/parser\.ts, src\/lexer\.ts, lib\/tokens\.py/.test(reason), reason)
  check('it says a file chosen before anything ran is a guess', /before anything ran is a guess/.test(reason), reason)
  check('it names the evidence it needs: a test, diff, output or exit fact per option', /`test`, `diff`, `output` or `exit` fact per option/.test(reason), reason)
  check('it offers the other road: ask about the code with its lines quoted', /ask about the code itself with its lines quoted/.test(reason), reason)
  check('nothing was sent', /nothing was sent$/.test(reason), reason)
  check('the tool renders it as a refusal row', jevEvalRefusedText(reason).startsWith('JEV — | status=refused | question "where"'))
  const paragraph = assemble(['The parser drops the last field of every row and the lexer was touched last week.'])
  check('a prose paragraph is not measurement either', !paragraph.ok, reasonOf(paragraph))
  const fourPaths: Question = { ...fileChoice, options: { 'a/one.ts': null, 'a/two.ts': null, 'a/three.ts': null, 'a/four.ts': null } }
  const many = assemble([{ issue: 'x' }], [fourPaths])
  check('a long option list is abbreviated in the refusal', !many.ok && /a\/one\.ts, a\/two\.ts, a\/three\.ts, …/.test(many.reason), reasonOf(many))
  const mixed = assemble([{ issue: 'x' }], [{ id: 'sure', kind: 'noul', ask: 'Is `issue` reproducible?' }, fileChoice])
  check('one bare file choice among other questions refuses the whole request (nothing is sent in part)', !mixed.ok && /question "where"/.test(reasonOf(mixed)), reasonOf(mixed))
}

section('§2 the same choice passes once the evidence carries a measurement')
{
  const measured: Array<[string, Input['evidence']]> = [
    ['a test fact', [{ test: 'bun test parser — 1 failed: expects 4 fields, got 3' }]],
    ['a diff fact', [{ diff: '--- a/src/parser.ts\n+++ b/src/parser.ts\n@@ -10,3 +10,4 @@\n-  return fields\n+  return [...fields, last]' }]],
    ['an exit code in a plain fact', [{ note: 'the suite ended with exit code 1 after the lexer change' }]],
    ['a traceback in a plain fact', [{ crash: 'Traceback (most recent call last): File "lib/tokens.py", line 12' }]],
    ['a shell transcript', [{ session: '$ bun test\n3 passed, 1 failed' }]],
    ['a table with a result column', [{ table: { columns: ['file', 'result'], rows: [['src/parser.ts', 'FAIL'], ['src/lexer.ts', 'PASS']] } }]],
    ['an output fact beside the issue', [{ issue: 'the parser drops the last field' }, { output: 'row 3: expected 4 fields, parsed 3' }]],
  ]
  for (const [label, evidence] of measured) {
    const result = assemble(evidence)
    check(`${label}: assembled`, result.ok, reasonOf(result))
  }
  const file = join(HOME, 'runs.tsv')
  writeFileSync(file, 'id\tfile\tstderr\n1\tsrc/parser.ts\tAssertionError: 4 != 3\n2\tsrc/lexer.ts\t\n')
  const fromFile = assemble([{ file: { path: file } }])
  check('a file of rows with a stderr column counts as measured', fromFile.ok, reasonOf(fromFile))
}

section('§3 choices that are not between file paths, and questions that are not choices, are untouched')
{
  const strategies: Question = { id: 'how', kind: 'choice', ask: 'Which road?', options: { rebase: 'replay on main', merge: 'a merge commit', squash: null }, allow_none: false }
  check('a choice between strategies with bare evidence assembles', assemble([{ issue: 'x' }], [strategies]).ok)
  const mixedLabels: Question = { ...fileChoice, options: { 'src/parser.ts': null, 'the lexer': null } }
  check('a choice whose labels are not all paths assembles', assemble([{ issue: 'x' }], [mixedLabels]).ok)
  const single: Question = { ...fileChoice, options: { 'src/parser.ts': 'the only candidate' } }
  check('a single path option (with the escape) is not a pick between files', assemble([{ issue: 'x' }], [single]).ok)
  const versions: Question = { id: 'v', kind: 'choice', ask: 'Which version?', options: { 'v1.2': null, 'v2.0': null }, allow_none: false }
  check('version labels are not file paths', assemble([{ issue: 'x' }], [versions]).ok)
  const noul: Question = { id: 'is', kind: 'noul', ask: 'Does `issue` point at src/parser.ts?' }
  check('a yes/no question that mentions a path is not a choice list', assemble([{ issue: 'x' }], [noul]).ok)
  const score: Question = { id: 's', kind: 'score', ask: 'How sure?', levels: ['guess', 'likely', 'certain'] }
  check('a score question is untouched', assemble([{ issue: 'x' }], [score]).ok)
}

section('§4 what reads as a file path: a slash alone is not a path cue')
{
  const pair = (a: string, b: string): Question => ({ id: 'pick', kind: 'choice', ask: 'Which?', options: { [a]: null, [b]: null }, allow_none: false })
  const notPaths: Array<[string, string]> = [
    ['origin/main', 'origin/topic'],
    ['yes/no', 'maybe/later'],
    ['A/B', 'B/A'],
    ['10/15', '10/16'],
    ['@scope/alpha', '@scope/beta'],
    ['either/or', 'both/neither'],
    ['src/components', 'src/screens'],
  ]
  for (const [a, b] of notPaths) check(`${a} vs ${b}: not a pick between files, assembled`, assemble([{ issue: 'x' }], [pair(a, b)]).ok, reasonOf(assemble([{ issue: 'x' }], [pair(a, b)])))
  const paths: Array<[string, string]> = [
    ['src/parser.ts', 'src/lexer.ts'],
    ['a/b/c', 'a/b/d'],
    ['src/', 'docs/'],
    ['/repo/a.ts', '/repo/b.ts'],
    ['./x', './y'],
    ['../other/x', '../other/y'],
    ['~/notes', '~/drafts'],
    ['src/a.ts:12', 'src/b.ts:40-44'],
    ['README.md', 'CHANGELOG.md'],
    ['main.py', 'util.py'],
    ['src\\a.ts', 'src\\b.ts'],
    ['C:\\repo\\a.ts', 'C:\\repo\\b.ts'],
  ]
  for (const [a, b] of paths) check(`${a} vs ${b}: a pick between files with nothing measured, refused`, !assemble([{ issue: 'x' }], [pair(a, b)]).ok, reasonOf(assemble([{ issue: 'x' }], [pair(a, b)])))
  const mixed = pair('src/parser.ts', 'origin/main')
  check('a path beside a branch name is not a pick between files', assemble([{ issue: 'x' }], [mixed]).ok)
}

console.log('\n' + '═'.repeat(76))
console.log(`${failures === 0 ? 'PASS' : 'FAIL'} — prove-jev-pre-execution-choice (${checks} checks, ${failures} failures)`)
process.exit(failures === 0 ? 0 : 1)
