import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, finish, REPO } from '../ast-tools/lib/harness.ts'

const env = armEnvironment()
const { resolveAstScope, searchAstPattern, isAstRefusal } = await import('../../src/utils/astPatterns.ts')
const { encodePattern } = await import('../../src/services/structure/pattern.ts')
const root = mkdtempSync(join(tmpdir(), 'ast-query-'))
const negRoot = mkdtempSync(join(tmpdir(), 'ast-query-neg-'))
async function query(pattern: string, opts: { lang?: string; glob?: string; matchCap?: number; cwd?: string } = {}) {
  const scope = resolveAstScope({ cwd: opts.cwd ?? root, ...(opts.lang ? { lang: opts.lang } : {}), ...(opts.glob ? { glob: opts.glob } : {}) })
  if (isAstRefusal(scope)) return scope
  return searchAstPattern(scope, { pattern, ...(opts.matchCap ? { matchCap: opts.matchCap } : {}) })
}
try {
  writeFileSync(join(root, 'app.py'), 'def greet(name):\n    print(name)\n    print("hi")\n')
  writeFileSync(join(root, 'broken.py'), 'def broken(:\n    print(\n')
  writeFileSync(join(root, 'main.go'), 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("x")\n}\n')
  writeFileSync(join(root, 'lib.rs'), 'fn main() { println!("{}", 1); }\n')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'util.ts'), 'export function f(a: number) { console.log(a) }\n')
  writeFileSync(join(root, 'notes.skip.py'), 'print("suffix-ignored")\n')
  mkdirSync(join(root, 'skipme'))
  writeFileSync(join(root, 'skipme', 'hidden.py'), 'print("dir-ignored")\n')
  writeFileSync(join(root, '.gitignore'), 'skipme/\n*.skip.py\n')
  const r = await query('print($X)')
  if (isAstRefusal(r)) throw new Error(r.refused)
  check('print($X): exactly the two app.py calls', r.matches.length === 2 && r.matches.every(m => m.rel === 'app.py'))
  check('matches carry the inferred language', r.matches.every(m => m.lang === 'python'))
  check('captures carry the exact source', r.matches[0]?.captures.some(c => c.key === '$X' && c.text === 'name') === true)
  check('document order', r.matches[0]!.startLine < r.matches[1]!.startLine)
  check('broken.py reported, never matched over', r.parseFailures.some(f => f.rel === 'broken.py') && !r.matches.some(m => m.rel === 'broken.py'))
  check('gitignored dir and suffix excluded', !r.matches.some(m => m.rel.includes('skipme') || m.rel.endsWith('.skip.py')))
  for (const [pattern, lang, file, kind] of [
    ['fmt.Println($$$A)', 'go', 'main.go', 'call_expression'],
    ['println!($$$A)', 'rust', 'lib.rs', 'macro_invocation'],
    ['console.log($A)', 'typescript', 'src/util.ts', 'call_expression'],
  ] as const) {
    const result = await query(pattern)
    check(`${lang}: ${pattern} matches ${file}`, !isAstRefusal(result) && result.matches.length === 1 && result.matches[0]?.rel === file && result.matches[0]?.nodeType === kind && result.matches[0]?.lang === lang)
  }
  const pinned = await query('print($X)', { lang: 'go' })
  check('language pin narrows to zero', !isAstRefusal(pinned) && pinned.matches.length === 0)
  const unknown = await query('print($X)', { lang: 'klingon' })
  check('unknown language refuses by name', isAstRefusal(unknown) && unknown.refused.includes('Unknown language "klingon"'))
  const scoped = await query('console.log($A)', { glob: 'src/**/*.ts' })
  check('glob scopes', !isAstRefusal(scoped) && scoped.matches.length === 1 && scoped.matches[0]?.rel === 'src/util.ts')
  const capped = await query('print($X)', { matchCap: 1 })
  check('cap truncation is flagged', !isAstRefusal(capped) && capped.matches.length === 1 && capped.capped)
  const a = await query('print($X)')
  const b = await query('print($X)')
  const project = (result: typeof a) => isAstRefusal(result) ? null : result.matches.map(m => [m.rel, m.startLine, m.startCol, m.endLine, m.endCol, m.nodeType, m.text])
  check('two runs are identical: paths, positions, kind, text and order', !isAstRefusal(a) && !isAstRefusal(b) && JSON.stringify(project(a)) === JSON.stringify(project(b)))
  const malformed = await query(')((broken')
  check('unparseable pattern has explicit language refusals, never silent absence', !isAstRefusal(malformed) && malformed.matches.length === 0 && malformed.patternRefusals.length > 0)
  writeFileSync(join(root, 'ops.py'), 'a = x + y\nb = x - y\nc = x * y\nd = x < y\ne = x > y\n')
  for (const [pattern, text] of [['$A + $B', 'x + y'], ['$A < $B', 'x < y']]) {
    const result = await query(pattern!, { lang: 'python' })
    check(`operator tokens discriminate ${pattern}`, !isAstRefusal(result) && result.matches.length === 1 && result.matches[0]?.text === text)
  }
  writeFileSync(join(root, 'chain.js'), 'console\n  .log(42)\n')
  const chain = await query('console.log($X)', { lang: 'javascript' })
  check('whitespace-split member chains still match', !isAstRefusal(chain) && chain.matches.some(m => m.rel === 'chain.js'))
  mkdirSync(join(root, 'deep', 'er'), { recursive: true })
  writeFileSync(join(root, 'deep', 'er', 'd.py'), 'target(1)\n')
  const glob = await query('target($X)', { glob: 'deep/**' })
  check('trailing double-star crosses directories', !isAstRefusal(glob) && glob.matches.length === 1 && glob.matches[0]?.rel === 'deep/er/d.py')
  writeFileSync(join(root, 'ws.js'), 'foo(  );\nfoo();\n')
  const ws = await query('foo()', { lang: 'javascript' })
  check('empty argument whitespace does not matter', !isAstRefusal(ws) && ws.matches.length === 2)
  check('lowercase sequence placeholder remains literal', encodePattern('$$$foo') === '$$$foo')
  check('double-dollar placeholder remains literal', encodePattern('$$X') === '$$X')
  check('anonymous sequence still encodes', encodePattern('f($$$)') === 'f(__MVM_ANON__)')
  writeFileSync(join(negRoot, '.gitignore'), '*.py\n!keep.py\n')
  writeFileSync(join(negRoot, 'keep.py'), 'print(2)\n')
  const negated = await query('print($X)', { cwd: negRoot })
  check('negated ignore never hides the re-included file', !isAstRefusal(negated) && negated.matches.length === 1 && negated.matches[0]?.rel === 'keep.py')
} finally {
  for (const dir of [root, negRoot, env.home, env.engineDir]) rmSync(dir, { recursive: true, force: true })
}
finish('POLYGLOT QUERY LAWS')
