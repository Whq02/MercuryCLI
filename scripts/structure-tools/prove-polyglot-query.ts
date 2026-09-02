#!/usr/bin/env bun
// ============================================================================
//  scripts/structure-tools/prove-polyglot-query.ts — Family 1, the pattern-query
//  laws over a DISPOSABLE fixture tree (never the calibration machine):
//
//    1. mixed-language inference: one pattern, per-file language, matches in
//       (file, position) order with capture annotations;
//    2. the four mandated languages each match (python · go · rust · ts);
//    3. project ignore rules: .gitignore'd dirs and suffix rules excluded;
//    4. per-file parse honesty: a broken file is REPORTED, never matched;
//    5. explicit lang pin narrows; unknown lang refuses by name;
//    6. files globs scope; limit caps flag truncation; two runs identical
//       (deterministic ids and order);
//    7. a nowhere-parsing pattern yields per-file refusals, not silence.
// ============================================================================

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_TREESITTER_VENDOR_DIR ??= join(import.meta.dir, '..', '..', 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')

const { runPolyglotQuery } = await import('../../src/services/structure/polyglotQuery.ts')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const root = mkdtempSync(join(tmpdir(), 'lathe-query-'))
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

// 1+3+4: inference + ignore rules + parse honesty in ONE query
{
  const r = await runPolyglotQuery(root, { pattern: 'print($X)' })
  if ('state' in r) {
    check('print($X) runs', false, r.note)
  } else {
    check('print($X): exactly the 2 app.py calls', r.matches.length === 2 && r.matches.every(m => m.file === 'app.py'))
    check('matches carry the inferred language', r.matches.every(m => m.language === 'python'))
    check('captures annotated in context', r.matches[0]!.context.includes('$X=name'))
    check('document order', r.matches[0]!.range.startLine < r.matches[1]!.range.startLine)
    check(
      'broken.py reported as a parse failure, never matched over',
      r.parseFailures.some(f => f.file === 'broken.py'),
      JSON.stringify(r.parseFailures),
    )
    check('gitignored dir + suffix rule excluded', !r.matches.some(m => m.file.includes('skipme') || m.file.endsWith('.skip.py')))
  }
}

// 2: the mandated languages
for (const [pattern, lang, file, kind] of [
  ['fmt.Println($$$A)', 'go', 'main.go', 'call_expression'],
  ['println!($$$A)', 'rust', 'lib.rs', 'macro_invocation'],
  ['console.log($A)', 'typescript', 'src/util.ts', 'call_expression'],
] as const) {
  const r = await runPolyglotQuery(root, { pattern })
  if ('state' in r) {
    check(`${lang} pattern runs`, false, r.note)
  } else {
    check(
      `${lang}: ${pattern} matches ${file}`,
      r.matches.length === 1 && r.matches[0]!.file === file && r.matches[0]!.kind === kind && r.matches[0]!.language === lang,
      JSON.stringify(r.matches.map(m => [m.file, m.kind, m.language])),
    )
  }
}

// 5: lang pin + unknown lang
{
  const pinned = await runPolyglotQuery(root, { pattern: 'print($X)', lang: 'go' })
  check('lang pin narrows to zero here', !('state' in pinned) && pinned.matches.length === 0)
  const unknown = await runPolyglotQuery(root, { pattern: 'print($X)', lang: 'klingon' })
  check('unknown lang refuses by name', 'state' in unknown && unknown.note.includes("unknown lang 'klingon'"))
}

// 6: glob scope, caps, determinism
{
  const scoped = await runPolyglotQuery(root, { pattern: 'console.log($A)', files: ['src/**/*.ts'] })
  check('files glob scopes', !('state' in scoped) && scoped.matches.length === 1 && scoped.matches[0]!.file === 'src/util.ts')
  const capped = await runPolyglotQuery(root, { pattern: 'print($X)', limit: 1 })
  check('limit caps + truncation flagged', !('state' in capped) && capped.matches.length === 1 && capped.truncated === true)
  const a = await runPolyglotQuery(root, { pattern: 'print($X)' })
  const b = await runPolyglotQuery(root, { pattern: 'print($X)' })
  const proj = (r: typeof a) => ('state' in r ? 'x' : JSON.stringify(r.matches.map(m => [m.id, m.range, m.kind])))
  check('two runs identical (ids · ranges · order)', proj(a) === proj(b))
}

// 7: a nowhere-parsing pattern refuses per file, never silently zero
{
  const r = await runPolyglotQuery(root, { pattern: ')((broken' })
  check(
    'unparseable pattern yields per-file refusal rows',
    !('state' in r) && r.matches.length === 0 && r.parseFailures.length > 0,
    'state' in r ? r.note : `${r.parseFailures.length} rows`,
  )
}

// 8 (verify-wave regressions): operator discrimination · whitespace-split
// member chains · trailing-** globs · whitespace-empty argument lists ·
// malformed metavars stay literal
{
  writeFileSync(join(root, 'ops.py'), 'a = x + y\nb = x - y\nc = x * y\nd = x < y\ne = x > y\n')
  const plus = await runPolyglotQuery(root, { pattern: '$A + $B', lang: 'python' })
  check(
    'operator tokens discriminate ($A + $B never matches x - y)',
    !('state' in plus) && plus.matches.length === 1 && plus.matches[0]!.text === 'x + y',
    'state' in plus ? plus.note : JSON.stringify(plus.matches.map(m => m.text)),
  )
  const lt = await runPolyglotQuery(root, { pattern: '$A < $B', lang: 'python' })
  check('comparison operators discriminate', !('state' in lt) && lt.matches.length === 1 && lt.matches[0]!.text === 'x < y')

  writeFileSync(join(root, 'chain.js'), 'console\n  .log(42)\n')
  const chain = await runPolyglotQuery(root, { pattern: 'console.log($X)', lang: 'javascript' })
  check(
    'whitespace-split member chains still match (pre-filter honesty)',
    !('state' in chain) && chain.matches.some(m => m.file === 'chain.js'),
    'state' in chain ? chain.note : JSON.stringify(chain.matches.map(m => m.file)),
  )

  mkdirSync(join(root, 'deep', 'er'), { recursive: true })
  writeFileSync(join(root, 'deep', 'er', 'd.py'), 'target(1)\n')
  const glob = await runPolyglotQuery(root, { pattern: 'target($X)', files: ['deep/**'] })
  check("trailing '**' glob crosses directories", !('state' in glob) && glob.matches.length === 1 && glob.matches[0]!.file === 'deep/er/d.py')

  writeFileSync(join(root, 'ws.js'), 'foo(  );\nfoo();\n')
  const ws = await runPolyglotQuery(root, { pattern: 'foo()', lang: 'javascript' })
  check('foo() matches foo(  ) (interior whitespace)', !('state' in ws) && ws.matches.length === 2, 'state' in ws ? ws.note : String(ws.matches.length))

  const { encodePattern } = await import('../../src/services/structure/pattern.ts')
  check('$$$foo (lowercase) stays literal', encodePattern('$$$foo') === '$$$foo', encodePattern('$$$foo'))
  check('$$X stays literal', encodePattern('$$X') === '$$X', encodePattern('$$X'))
  check('$$$ still encodes', encodePattern('f($$$)') === 'f(__MVM_ANON__)')
}

// 9 (verify-wave regression): a .gitignore with negation degrades to the
// skip set — a re-included file must never turn invisible
{
  const negRoot = mkdtempSync(join(tmpdir(), 'lathe-query-neg-'))
  writeFileSync(join(negRoot, '.gitignore'), '*.py\n!keep.py\n')
  writeFileSync(join(negRoot, 'keep.py'), 'print(2)\n')
  const r = await runPolyglotQuery(negRoot, { pattern: 'print($X)' })
  check('negated .gitignore never hides files', !('state' in r) && r.matches.length === 1 && r.matches[0]!.file === 'keep.py')
}

console.log(failures === 0 ? '\nPOLYGLOT QUERY LAWS GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
