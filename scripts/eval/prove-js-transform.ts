#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { splitTopLevelSegments, transformJsCell } from '../../src/services/eval/jsCellTransform.js'
import { check, finish, section } from './lib.js'

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

section('declarator separators belong to code, not strings, templates or comments')
const lexicalCells: Array<[string, string, Record<string, unknown>]> = [
  ['quoted delimiters', "var s = 'a, in b'; var t = `x, for y`; const u = \"p = q\", v = 2", { s: 'a, in b', t: 'x, for y', u: 'p = q', v: 2 }],
  ['escaped quotes and brackets', String.raw`const single = 'a\', in [b', double = "x\", for }y", after = 3`, { single: "a', in [b", double: 'x", for }y', after: 3 }],
  ['nested template interpolation', 'const text = `a, in ${[1, 2].map(n => `x, for ${n}`).join(",")}`, after = 4', { text: 'a, in x, for 1,x, for 2', after: 4 }],
  ['leading comment line', '// setup\nconst a = 1\nconst b = 2', { a: 1, b: 2 }],
  ['trailing comment line', 'const c = 3 // note\nconst d = 4', { c: 3, d: 4 }],
  ['leading block comment', '/* setup */ const first = 1\n/* next */ const second = 2', { first: 1, second: 2 }],
  ['regex comma and keyword', 'const splitter = /,\\s*in\\s+/, n = 1', { splitter: /,\s*in\s+/, n: 1 }],
  ['regex quote and bracket', "const q = /['{},]/; const after = 1", { q: /['{},]/, after: 1 }],
  ['division remains an operator', 'const d = 10 / 2, e = 3 / 4', { d: 5, e: 0.75 }],
  ['postfix increment then division', 'let i = 3; const half = i++ / 2, after = 1', { i: 4, half: 1.5, after: 1 }],
  ['postfix decrement then division', 'let n = 8; const rest = n-- / 4, next = 2', { n: 7, rest: 2, next: 2 }],
  ['postfix in parentheses then division', 'let p = 5; const q = (p++) / 5, r = p++ / 3, s = 9', { p: 7, q: 1, r: 2, s: 9 }],
  ['a regex after a binary plus still reads as a regex', 'const joined = "a" + /b/.source, more = 1', { joined: 'ab', more: 1 }],
  ['a regex after an operator keyword still reads as a regex', 'const kind = typeof /a,b/, tail = 2', { kind: 'object', tail: 2 }],
  ['a regex after a closing brace still reads as a regex', 'let hit = 0\nif (hit === 0) { hit = 1 }\n/x,y/.test("x,y") ? hit++ : hit--\nconst done = hit', { hit: 2, done: 2 }],
  ['block comment punctuation', 'const first = 1 /* , in = } ] ) */, second = 2', { first: 1, second: 2 }],
  ['line comment punctuation', 'const first = 1, second = 2 // , in = } ] )', { first: 1, second: 2 }],
  ['assignment after comment punctuation', 'var first /* = , } ] ) */ = 1, second = 2', { first: 1, second: 2 }],
  ['prose ledger', "var ledgerIntro = '# Source issues\\n\\nEvidence register, not a runnable rulings file. Cross-references in the index, not automatic invention.\\n'; var sections = ['one', 'two']; var ledgerMd = ledgerIntro + sections.join(', ')", { ledgerIntro: '# Source issues\n\nEvidence register, not a runnable rulings file. Cross-references in the index, not automatic invention.\n', sections: ['one', 'two'], ledgerMd: '# Source issues\n\nEvidence register, not a runnable rulings file. Cross-references in the index, not automatic invention.\none, two' }],
]
for (const [label, source, expected] of lexicalCells) {
  const t = transformJsCell(source)
  check(`${label}: the raw cell parses`, parsesAsCellBody(source))
  check(`${label}: transformed cell parses`, parsesAsCellBody(t.code), t.code)
  check(`${label}: only declared names persist`, JSON.stringify(t.persistedNames) === JSON.stringify(Object.keys(expected)), JSON.stringify(t.persistedNames))
  check(`${label}: segment bytes are unchanged`, splitTopLevelSegments(source).map(s => s.text).join('') === source)
  const scope: Record<string, unknown> = {}
  try {
    await runInNewContext(`(async () => {\n${t.code}\n})()`, scope)
    check(`${label}: values and the actual persistence ledger agree`, JSON.stringify(Object.fromEntries(Object.keys(expected).map(name => [name, scope[name]]))) === JSON.stringify(expected) && JSON.stringify(scope.__mercuryPersistedNames) === JSON.stringify(Object.keys(expected)))
  } catch (error) {
    check(`${label}: transformed cell executes`, false, String(error))
  }
}
{
  const scanner = readFileSync(new URL('../../src/services/eval/jsCellTransform.ts', import.meta.url), 'utf8')
  check('the regex-start decision reads back from the slash (a postfix ++/-- is division) instead of re-scanning the whole prefix at every slash', scanner.includes("if (c === '/' && regexCanStart(source, i))") && !scanner.includes('source.slice(0, i)'))
}

section('dynamic import(): rewritten to __mercuryImport at any depth, never inside a string, a comment or an identifier')
{
  const t = transformJsCell("const mod = await import('./lib.mjs')\nconst lazy = async () => (await import ('zod')).z\nmod.x")
  check('a top-level dynamic import becomes __mercuryImport', t.code.includes("await __mercuryImport('./lib.mjs')"), t.code)
  check('a nested dynamic import (inside an arrow body, with a space before the paren) is rewritten too', t.code.includes("__mercuryImport ('zod')"), t.code)
  check('the declared names still persist', JSON.stringify(t.persistedNames) === JSON.stringify(['mod', 'lazy']), JSON.stringify(t.persistedNames))
  check('the transformed cell parses', parsesAsCellBody(t.code), t.code)
  const untouched = transformJsCell("const s = 'import(x)' // import(y)\nconst imports = () => 1\nconst r = imports() + s.length + obj.import(1)")
  check('import inside a string, a comment, an identifier prefix or a member access is left alone', !untouched.code.includes('__mercuryImport'), untouched.code)
}

section('destructuring with defaults: only the bound names persist, never the default expressions')
{
  const t = transformJsCell("const raw = '{\"a\":1}'\nconst { a = defaultVal, b = JSON.parse(raw).a, c: { d = f(x, y) } = {}, ...rest } = { a: 1 }\nconst [p = g(), , q = [1, 2].length] = []\na + b")
  check('the bound identifiers persist', ['raw', 'a', 'b', 'd', 'rest', 'p', 'q'].every(n => t.persistedNames.includes(n)), JSON.stringify(t.persistedNames))
  check('no identifier from a default-value expression persists', ['defaultVal', 'JSON', 'parse', 'f', 'x', 'y', 'g', 'length', 'c'].every(n => !t.persistedNames.includes(n)), JSON.stringify(t.persistedNames))
  check('the transformed cell parses', parsesAsCellBody(t.code), t.code)
}

section('var inside a top-level control block persists; var inside a nested function does not')
{
  const t = transformJsCell("try { var parsed = JSON.parse('{\"x\":5}') } catch (e) { var failed = true }\nif (parsed) { var inIf = 7, alsoIf = 8 } else { var inElse = 9 }\nfor (var i = 0; i < 2; i++) { var inLoop = i }\nfunction helper() { var local = 1; return local }\nconst run = () => { var inArrow = 2; return inArrow }\nparsed.x + inIf")
  check('block-nested vars persist', ['parsed', 'failed', 'inIf', 'alsoIf', 'inElse', 'i', 'inLoop'].every(n => t.persistedNames.includes(n)), JSON.stringify(t.persistedNames))
  check('function-local vars do not', !t.persistedNames.includes('local') && !t.persistedNames.includes('inArrow'), JSON.stringify(t.persistedNames))
  const heads = transformJsCell('for (var key in { a: 1 }) { var seenKey = key }\nfor (var item of [1]) { var seenItem = item in globalThis }\nseenKey')
  check('for-in and for-of heads bind the loop variable, never the of/in keyword, and an in-expression after = is read whole', JSON.stringify(heads.persistedNames) === JSON.stringify(['key', 'seenKey', 'item', 'seenItem']), JSON.stringify(heads.persistedNames))
  check('the function and the arrow binding persist as before', t.persistedNames.includes('helper') && t.persistedNames.includes('run'))
  check('the transformed cell parses', parsesAsCellBody(t.code), t.code)
  const scope: Record<string, unknown> = {}
  try {
    await runInNewContext(`(async () => {\n${t.code}\n})()`, scope)
    check('the block-nested values reach the persistence ledger', scope.parsed !== undefined && scope.inIf === 7 && scope.alsoIf === 8 && scope.inLoop === 1 && scope.i === 2 && scope.local === undefined && scope.inArrow === undefined, JSON.stringify(scope.__mercuryPersistedNames))
  } catch (error) {
    check('the nested-var cell executes', false, String(error))
  }
}

finish('JS-TRANSFORM')
