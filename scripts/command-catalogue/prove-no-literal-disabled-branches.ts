#!/usr/bin/env bun
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
