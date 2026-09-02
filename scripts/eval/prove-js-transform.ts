#!/usr/bin/env bun
// ============================================================================
//  scripts/eval/prove-js-transform.ts
//  PROOF (spec 01 a.2 / the JS dialect contract): transformJsCell is
//  best-effort by construction — it either produces a VALID async-function
//  body or passes the segment through byte-identical; it never manufactures
//  broken code out of code that was already broken-free.
//    · export <decl> → the export is stripped and the name persists;
//    · export default / export * / export { } — un-salvageable in a cell's
//      function body — pass through byte-identical so the syntax error names
//      the model's own `export` keyword (truth-ranked surfaces), never a
//      mangled `default …` derivative;
//    · a spread of realistic cells all yield parseable function bodies.
//  The transform is pure; no kernel, no config home.
// ============================================================================
import { transformJsCell } from '../../src/services/eval/jsCellTransform.js'
import { check, finish, section } from './lib.js'

/** Does `code` parse as the body of the async function the JS kernel runs it
 *  in? (Syntax probe only — never executed.) */
function parsesAsCellBody(code: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    new Function(`return (async () => {\n${code}\n})()`)
    return true
  } catch {
    return false
  }
}

section('export <decl>: the export is stripped and the name persists')
{
  const t = transformJsCell('export const answer = 42')
  check('valid cell body', parsesAsCellBody(t.code), t.code)
  check('the export keyword is gone', !/\bexport\b/.test(t.code), t.code)
  check('the declared name persists', t.persistedNames.includes('answer'), JSON.stringify(t.persistedNames))
}
{
  const t = transformJsCell('export async function f(){ return 1 }')
  check('async function export stripped + persisted', parsesAsCellBody(t.code) && t.persistedNames.includes('f') && !/\bexport\b/.test(t.code), t.code)
}

section('un-salvageable export forms pass through byte-identical (honest error)')
for (const src of ['export default foo', "export * from './m.js'", 'export { a, b }']) {
  const t = transformJsCell(src)
  // Byte-identity for the export statement itself: the transform never
  // rewrites it into a different (mangled) syntax error. `export` survives so
  // the runtime error names the model's own keyword.
  check(`\`${src}\` keeps its export keyword verbatim`, t.code.includes(src), t.code)
  check(`\`${src}\` is NOT turned into a \`default …\`/\`* …\` fragment`, !/^default\s|\n\* from/.test(t.code.trim()), t.code)
}

section('realistic cells all yield parseable function bodies')
const realistic: Array<[string, string]> = [
  ['final var expr', 'const o = {a:1}\no'],
  ['for loop then expr', 'let total = 0\nfor (const x of [1,2,3]) total += x\ntotal'],
  ['func decl then call', 'function greet(n){ return `hi ${n}` }\ngreet("x")'],
  ['await chain then expr', 'const data = await Promise.resolve([1])\ndata.length'],
  ['regex quantifier', 'const re = /a{2,3}/g\nre.test("aaa")'],
  ['class then expr', 'class A { m(){ return 1 } }\nnew A().m()'],
  ['multiline template', 'const s = `l1\nl2 ${1+1}`\ns'],
  ['nested brackets', 'const m = new Map([[1,2]])\nm.get(1)'],
]
for (const [label, src] of realistic) {
  const t = transformJsCell(src)
  check(label, parsesAsCellBody(t.code), t.code)
}

finish('JS-TRANSFORM')
