#!/usr/bin/env bun
// ============================================================================
//  scripts/identity/prove-descriptor-divergence.ts — THE DESCRIPTOR RATCHET
//
//  LAW: no descriptor surface in the product carries readable foreign text.
//  The foreign corpus lives ONLY as one-way 64-bit hashes
//  (descriptor-stock-hashes.json, built by gen-descriptor-stock-hashes.ts
//  from the frozen base the roster prover names) — this proof and its data
//  survive a fresh-history repo and never expose a byte of the text they ban.
//
//  Two floors, matching the corpus families:
//    (1) SHINGLE floor — no 6-word normalized prose run from the foreign
//        descriptor corpus appears in any live descriptor surface. Inline
//        code spans (`...`) are stripped on BOTH sides before comparison:
//        shared interface (command names, flags, API paths) is reality, not
//        authorship, and never trips the ratchet.
//    (2) EXACT floor — no live description field equals a foreign description
//        (normalized), at any length.
//
//  Live descriptor surfaces scanned:
//    - src/commands/**  description: / argumentHint: fields
//    - src/tools/**/prompt.ts        every string literal
//    - src/tools/AgentTool/built-in/* every string literal
//    - src/skills/bundled/*.ts       description fields
//    - the repo skill estates' SKILL.md descriptions
//
//  Run: ~/.bun/bin/bun run scripts/identity/prove-descriptor-divergence.ts
// ============================================================================
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const DATA = JSON.parse(readFileSync(join(import.meta.dir, 'descriptor-stock-hashes.json'), 'utf8')) as
  { shingleWords: number, shingles: string[], exacts: string[] }
const SH = DATA.shingleWords
const shingles = new Set(DATA.shingles)
const exacts = new Set(DATA.exacts)

const norm = (s: string) => s.toLowerCase().replace(/`[^`]*`/g, ' ').replace(/\$\{[^}]*\}/g, ' ').replace(/[^a-z0-9']+/g, ' ').trim()
const words = (s: string) => norm(s).split(/\s+/).filter(Boolean)
const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

function* walk(dir: string, exts: RegExp): Generator<string> {
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return }
  for (const e of entries) {
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) { if (e !== 'node_modules') yield* walk(p, exts) }
    else if (exts.test(e)) yield p
  }
}
function literals(src: string): string[] {
  const out: string[] = []
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\[\s\S])*)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) { const t = (m[1] ?? m[2] ?? m[3] ?? ''); if (t) out.push(t) }
  return out
}

type Hit = { file: string, kind: string, sample: string }
const hits: Hit[] = []
function scanText(file: string, text: string, checkExact: boolean): void {
  const w = words(text)
  for (let i = 0; i + SH <= w.length; i++) {
    if (shingles.has(h(w.slice(i, i + SH).join(' ')))) {
      hits.push({ file, kind: 'shingle', sample: w.slice(i, i + SH).join(' ') })
      break
    }
  }
  if (checkExact) {
    const n = norm(text)
    if (n && n.split(' ').length >= 2 && exacts.has(h(n))) hits.push({ file, kind: 'exact', sample: n.slice(0, 60) })
  }
}
const fieldRe = /(?:description|argumentHint)\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\[\s\S])*)`)/g

// 1 — command descriptor fields
for (const f of walk(join(ROOT, 'src/commands'), /\.(ts|tsx)$/)) {
  const src = readFileSync(f, 'utf8')
  let m: RegExpExecArray | null
  const rel = f.slice(ROOT.length + 1)
  while ((m = fieldRe.exec(src))) scanText(rel, (m[1] ?? m[2] ?? m[3])!, true)
}
// 2 — tool prompts + built-in agents: every literal
for (const f of walk(join(ROOT, 'src/tools'), /\.(ts|tsx)$/)) {
  const rel = f.slice(ROOT.length + 1)
  if (!/\/prompt\.tsx?$|\/built-in\//.test(rel)) continue
  const src = readFileSync(f, 'utf8')
  for (const t of literals(src)) scanText(rel, t, false)
}
// 3 — bundled skill descriptors
for (const f of walk(join(ROOT, 'src/skills/bundled'), /\.ts$/)) {
  const src = readFileSync(f, 'utf8')
  let m: RegExpExecArray | null
  const rel = f.slice(ROOT.length + 1)
  while ((m = fieldRe.exec(src))) scanText(rel, (m[1] ?? m[2] ?? m[3])!, true)
}
// 4 — shipped skill packs
for (const pack of ['mercury-skills']) {
  for (const f of walk(join(ROOT, pack), /^SKILL\.md$/)) {
    const src = readFileSync(f, 'utf8')
    const fm = src.match(/^---\n([\s\S]*?)\n---/)
    const desc = fm?.[1].match(/description:\s*([\s\S]*?)(?=\n\w|$)/)
    if (desc) scanText(f.slice(ROOT.length + 1), desc[1], true)
  }
}

console.log('============================================================')
console.log(' descriptor divergence — no readable foreign text on any descriptor surface')
console.log(`   corpus: ${shingles.size} shingle + ${exacts.size} exact hashes`)
console.log('============================================================')
if (hits.length) {
  for (const hit of hits.slice(0, 200)) console.log(`  [FAIL] ${hit.kind} :: ${hit.file} :: ${hit.sample}`)
  console.log(`\n ${hits.length} DESCRIPTOR SURFACE(S) STILL CARRY FOREIGN TEXT`)
  process.exit(1)
}
console.log('  [PASS] shingle floor — zero foreign prose runs on the descriptor surfaces')
console.log('  [PASS] exact floor — zero foreign description strings')
process.exit(0)
