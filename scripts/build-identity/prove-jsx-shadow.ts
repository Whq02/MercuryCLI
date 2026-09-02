#!/usr/bin/env bun
// ============================================================================
//  scripts/build-identity/prove-jsx-shadow.ts — the JSX-factory SHADOWING
//  ratchet.
//
//  Bun's automatic JSX runtime compiles every element in a .tsx file to a
//  bare `jsx(...)` / `jsxs(...)` call (+ `Fragment` as an identifier), and
//  those emitted identifiers resolve LEXICALLY. A local binding named `jsx`
//  therefore captures its own scope's compiled elements:
//
//    let jsx: React.ReactNode                     // processBashCommand.tsx
//    setToolJSX({ jsx: <BashModeProgress/> })     // → jsx(eV$,…) → TypeError
//
//  That single shadow killed EVERY `!` bang command fork-wide — the throw
//  fired before processBashCommand's try, the submit died silently (no
//  transcript entry, no error), and nothing in the gate noticed because the
//  crash lives only in the BUILT bundle's name binding, not in tsc's world
//  (tsc happily typechecks a shadowed `jsx`). This ratchet greps the .tsx
//  sources for every binding position of the runtime's identifiers so the
//  class stays dead:
//
//    · let/const/var declarations         · arrow params `jsx =>`
//    · function params `function f(jsx`   · catch params
//    · import aliases `as jsx`            · destructure shorthand `{ jsx }`
//
//  Property keys (`jsx:`) and member access (`.jsx`) stay legal — they are
//  not bindings. Zero tolerance: even a binding in a scope with no elements
//  today is a landmine (the PromptInput option-meta hint survived ONLY
//  because the bundler happened to inline its const away).
// ============================================================================
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const NAMES = ['jsx', 'jsxs', 'jsxDEV', 'Fragment'] as const
const NAME_RE = NAMES.join('|')

let failures = 0
function check(label: string, cond: boolean, detail?: string): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? `\n         ${detail}` : ''}`)
}

// The index can list a file that's deleted in the working tree (an
// uncommitted deletion) — nothing to scan there; the gate must stay
// runnable over the dirty tree it's about to certify.
const files = execSync(`git -C '${REPO}' ls-files 'src/**/*.tsx'`, { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean)
  .filter(rel => existsSync(join(REPO, rel)))

// Binding-position patterns. Fragment is included for declarations/imports
// (a shadowed Fragment breaks <>…</>), but NOT for the param patterns —
// `Fragment` as a param name doesn't occur and components legitimately
// receive `Fragment`-typed props under other names.
const BINDING_PATTERNS: Array<{ why: string; re: RegExp }> = [
  { why: 'declaration', re: new RegExp(`\\b(?:let|const|var)\\s+(?:${NAME_RE})\\b`) },
  { why: 'arrow param', re: new RegExp(`(?<![\\w.])(?:${NAME_RE})(?:_\\d+)?\\s*=>`) },
  { why: 'function param', re: new RegExp(`\\bfunction\\s*\\w*\\s*\\(\\s*(?:${NAME_RE})\\b`) },
  { why: 'catch param', re: new RegExp(`\\bcatch\\s*\\(\\s*(?:${NAME_RE})\\b`) },
  { why: 'import alias', re: new RegExp(`\\bas\\s+(?:${NAME_RE})\\b`) },
]

// Destructure shorthand needs context: `const { jsx } = x` binds jsx (BAD),
// `{ jsx: y } = x` binds y (fine), and `{ jsx: <El/> }` is a property key
// in an expression (fine). Only flag shorthand inside a let/const/var
// destructuring pattern.
const DESTRUCTURE_RE = new RegExp(
  `\\b(?:let|const|var)\\s*\\{[^}]*(?<![\\w.:])(?:${NAME_RE})\\s*[,}]`,
)

const offenders: string[] = []
for (const rel of files) {
  const text = readFileSync(join(REPO, rel), 'utf8')
  // Strip line comments + block comments + strings coarsely so prose
  // mentioning `jsx` (docs, the class's own comments) can't false-positive.
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  for (const { why, re } of BINDING_PATTERNS) {
    const m = stripped.match(re)
    if (m) offenders.push(`${rel}: ${why} → ${JSON.stringify(m[0])}`)
  }
  const d = stripped.match(DESTRUCTURE_RE)
  if (d) offenders.push(`${rel}: destructure shorthand → ${JSON.stringify(d[0])}`)
}

console.log('============================================================')
console.log(' prove-jsx-shadow — no JSX-runtime identifier is ever shadowed')
console.log('============================================================')
console.log(`  scanned ${files.length} .tsx files for bindings of: ${NAMES.join(', ')}`)

check('no jsx/jsxs/jsxDEV/Fragment binding in any .tsx file', offenders.length === 0, offenders.join('\n         '))

// The original defect stays named: processBashCommand's progress slot must
// not regress back to a `jsx` local.
const pbc = readFileSync(join(REPO, 'src/utils/processUserInput/processBashCommand.tsx'), 'utf8')
check('processBashCommand carries the renamed progressJsx slot', /progressJsx/.test(pbc) && !/let jsx\b/.test(pbc))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
