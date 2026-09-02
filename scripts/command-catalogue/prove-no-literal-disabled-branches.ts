#!/usr/bin/env bun
// ============================================================================
//  prove-no-literal-disabled-branches.ts — the literal-disabled-branch ratchet
//
//
//  The class: a branch neutered by a literal — `if (false && …)`,
//  `if (true || …)`, `cond && false && <jsx/>`, `x || true) {` — leaves a
//  whole mechanism in the tree that can never run: invisible to
//  discovery law, misleading to every reader, and (the LogSelector case)
//  still able to charge real per-render work for a feature that cannot be
//  reached. The nine live sites are removed (LogSelector deep/agentic
//  search, dumpPrompts response save, /context ant-only breakdown, the
//  ToolUseLoader blink residue, ValidationErrorsList docLink, the ide.tsx
//  JetBrains branch); this ratchet holds the count at ZERO so the class
//  cannot silently return. A deliberate permanent disable is spelled with a
//  plain literal (`useBlink(false)`) or by deleting the branch — never by
//  strangling a live-looking condition.
//
//  Scope: src/**/*.ts, src/**/*.tsx — comments stripped before matching.
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'if (false …)', re: /if \(false(?:[ )&]|$)/ },
  { name: 'if (true || …)', re: /if \(true \|\|/ },
  { name: '… && false && …', re: /&& false &&/ },
  { name: '… && false ? …', re: /&& false \?/ },
  { name: '(… && false)', re: /&& false\)/ },
  { name: '… || true) {', re: /\|\| true\) \{/ },
]

function stripComments(src: string): string {
  // Block comments, then line comments. Defect patterns never contain '//',
  // so the URL-in-string edge (https://…) cannot mask a real hit.
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(name)) yield p
  }
}

const hits: string[] = []
for (const file of walk(SRC)) {
  const cleaned = stripComments(readFileSync(file, 'utf8'))
  const lines = cleaned.split('\n')
  lines.forEach((line, i) => {
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1} [${name}] ${line.trim().slice(0, 120)}`)
    }
  })
}

console.log('literal-disabled-branch ratchet — src/**/*.ts{,x}, baseline 0')
if (hits.length === 0) {
  console.log('  ✓ zero literal-disabled branches')
  process.exit(0)
}
for (const h of hits) console.log(`  ✗ ${h}`)
console.log(`\n❌ ${hits.length} literal-disabled branch(es) — delete the dead branch (or spell a deliberate disable with a plain literal), never strangle a live-looking condition`)
process.exit(1)
