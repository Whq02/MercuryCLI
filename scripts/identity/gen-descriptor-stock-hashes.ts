#!/usr/bin/env bun
// ============================================================================
//  scripts/identity/gen-descriptor-stock-hashes.ts — REGENERATOR. It reads
//  the foreign base commit named by MERCURY_DESCRIPTOR_STOCK_BASE, so it runs
//  only in a checkout whose history holds that commit. Output:
//  descriptor-stock-hashes.json — one-way 64-bit hashes of the foreign
//  DESCRIPTOR corpus. No readable foreign text and no commit id land in the
//  JSON; the proof that reads it needs no history at all.
//
//  Corpus = every string literal in the foreign base's src/commands + src/tools trees,
//  minus path/identifier literals, with inline code spans (`...`) stripped —
//  shared INTERFACE (command names, flags, API paths) is reality, not
//  authorship, so it never enters the corpus. Two hash families:
//    shingles : normalized 6-word runs of foreign descriptor prose
//    exacts   : normalized full description-field strings (>=2 words)
// ============================================================================
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const BASE = (process.env.MERCURY_DESCRIPTOR_STOCK_BASE ?? '').trim()
if (!/^[0-9a-f]{7,40}$/.test(BASE)) {
  console.error('gen-descriptor-stock-hashes: set MERCURY_DESCRIPTOR_STOCK_BASE to the foreign base commit; the stock regenerates only where that history exists')
  process.exit(2)
}

const norm = (s: string) => s.toLowerCase().replace(/`[^`]*`/g, ' ').replace(/\$\{[^}]*\}/g, ' ').replace(/[^a-z0-9']+/g, ' ').trim()
const words = (s: string) => norm(s).split(/\s+/).filter(Boolean)
const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

function literals(src: string): string[] {
  const out: string[] = []
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\[\s\S])*)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) { const t = (m[1] ?? m[2] ?? m[3] ?? ''); if (t) out.push(t) }
  return out
}

const files = execSync(`git ls-tree -r --name-only ${BASE} src/commands src/tools`, { cwd: ROOT, encoding: 'utf8' })
  .trim().split('\n').filter(f => /\.(ts|tsx|js|jsx)$/.test(f))
const shingles = new Set<string>()
const exacts = new Set<string>()
const SH = 6
for (const f of files) {
  const src = execSync(`git show ${BASE}:${JSON.stringify(f).slice(1, -1)}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 })
  for (const t of literals(src)) {
    if (/^[.~A-Za-z0-9_@/-]+$/.test(t.trim())) continue
    const w = words(t)
    for (let i = 0; i + SH <= w.length; i++) shingles.add(h(w.slice(i, i + SH).join(' ')))
  }
  // description fields, any length (the short-string family)
  const dre = /(?:description|DESCRIPTION)\s*[:=]\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\[\s\S])*)`)/g
  let m: RegExpExecArray | null
  while ((m = dre.exec(src))) {
    const t = norm((m[1] ?? m[2] ?? m[3])!)
    if (t && t.split(' ').length >= 2) exacts.add(h(t))
  }
}
writeFileSync(join(import.meta.dir, 'descriptor-stock-hashes.json'),
  JSON.stringify({ shingleWords: SH, shingles: [...shingles].sort(), exacts: [...exacts].sort() }))
console.log(`descriptor-stock-hashes.json: ${shingles.size} shingle hashes, ${exacts.size} exact hashes`)
