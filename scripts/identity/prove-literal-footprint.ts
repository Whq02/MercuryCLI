#!/usr/bin/env bun
// ============================================================================
//  scripts/identity/prove-literal-footprint.ts
//  PROOF: the re-cut rosters and rewords hold — re-curated rosters and reworded
//  literals cannot silently revert to their earlier shapes.
//
//  FINGERPRINT-FREE BY DESIGN: retired spellings never appear here whole.
//  Rosters are pinned as sha256 over the sorted membership; retired
//  sentences are pinned ABSENT via composed fragments (split-join, the
//  seal idiom, so this prover never matches itself); the two read-forever
//  LEGACY marker spellings are BOUNDED to their documented dual-accept
//  homes rather than banned (persisted transcripts still carry them).
//
//  Run: ~/.bun/bin/bun run scripts/identity/prove-literal-footprint.ts
// ============================================================================
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

console.log('============================================================')
console.log(' literal footprint — re-cut rosters and rewords hold')
console.log('============================================================')

// ── (1) words.ts roster equality ───────────────────────────────────────────
const wordsSrc = read('src/utils/words.ts')
const roster = (name: string): string[] => {
  const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(wordsSrc)
  if (!m) return []
  return [...m[1]!.matchAll(/'([a-z-]+)'/g)].map(x => x[1]!)
}
const PINNED: Array<[string, number, string]> = [
  ['ADJECTIVES', 275, 'f8f07c81d2b4ac82'],
  ['NOUNS', 460, 'ef8df4fc3cda4a96'],
  ['VERBS', 164, '9367c6380192b80e'],
]
for (const [name, count, hash] of PINNED) {
  const words = roster(name)
  const sorted = [...words].sort()
  const digest = createHash('sha256').update(sorted.join('|')).digest('hex').slice(0, 16)
  check(`${name}: exactly ${count} members`, words.length === count, String(words.length))
  check(`${name}: alphabetical order holds`, JSON.stringify(words) === JSON.stringify(sorted))
  check(`${name}: membership hash pinned`, digest === hash, digest)
}
// Retired-theme sentinels: exact-member absence via the extracted roster
// (composed names — this file never carries them whole).
const nouns = new Set(roster('NOUNS'))
for (const composed of [['bab', 'bage'].join(''), ['love', 'lace'].join(''), ['tur', 'ing'].join('')]) {
  check(`NOUNS: retired surname absent (${composed.length} chars)`, !nouns.has(composed))
}

// ── (2) reworded spellings present (the new text is ours — plain pins) ─────
const compactPrompt = read('src/services/compact/prompt.ts')
check('compact opener speaks the running-record cut', compactPrompt.includes('running record of this conversation'))
check('compact headings wear the re-cut names', compactPrompt.includes('Operator Intent:') && compactPrompt.includes('Where Work Stands:'))
const prompts = read('src/constants/prompts.ts')
check('scratchpad brief speaks the re-cut lead', prompts.includes('belongs in the session scratchpad'))
check('env block wears the re-cut lead', prompts.includes('The environment this session runs in:'))
const digestSrc = read('src/services/compact/microCompactDigest.ts')
check('cleared placeholder wears the new spelling', digestSrc.includes("'[stale tool result pruned — content cleared]'"))
check('digest prefix wears the new spelling', digestSrc.includes("'[stale tool result · digest:'"))
check('placeholder does not start with the digest prefix (distinguishability invariant)',
  !'[stale tool result pruned — content cleared]'.startsWith('[stale tool result · digest:'))
const compactSrc = read('src/services/compact/compact.ts')
check('PTL marker wears the new spelling', compactSrc.includes("'[earlier turns folded for the compaction retry]'"))
check('FileEdit identical-strings sentence wears the new cut', read('src/tools/FileEditTool/FileEditTool.ts').includes('there is no edit to apply'))

// ── (3) retired spellings absent (composed fragments only) ─────────────────
const gone: Array<[string, string, string]> = [
  ['src/services/compact/prompt.ts', ['Your task is to create a detailed ', 'summary'].join(''), 'old compact opener'],
  ['src/services/compact/prompt.ts', ['Primary Request', ' and Intent'].join(''), 'old heading set'],
  ['src/constants/prompts.ts', ['Always use this scratchpad', ' directory'].join(''), 'old scratchpad lead'],
  ['src/constants/prompts.ts', ['Here is useful information', ' about the environment'].join(''), 'old env lead'],
]
for (const [rel, needle, label] of gone) {
  check(`${label} absent from ${rel}`, !read(rel).includes(needle))
}

// ── (4) LEGACY marker spellings bounded to their dual-accept homes ─────────
// Read-forever (persisted transcripts), never emitted: the spelling may live
// ONLY in the three documented matcher/const homes.
const LEGACY_CLEARED = ['[Old tool result', ' content cleared]'].join('')
const LEGACY_PTL = ['[earlier conversation', ' truncated for compaction retry]'].join('')
const ALLOWED_CLEARED = new Set([
  'src/utils/toolResultStorage.ts',
  'src/services/compact/microCompactDigest.ts',
])
const ALLOWED_PTL = new Set(['src/services/compact/compact.ts'])
const hits = (needle: string): string[] => {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e) && readFileSync(p, 'utf8').includes(needle)) out.push(relative(ROOT, p))
    }
  }
  walk(join(ROOT, 'src'))
  return out
}
const clearedHomes = hits(LEGACY_CLEARED)
check('legacy cleared spelling only in its dual-accept homes', clearedHomes.every(h => ALLOWED_CLEARED.has(h)) && clearedHomes.length > 0, clearedHomes.join(','))
const ptlHomes = hits(LEGACY_PTL)
check('legacy PTL spelling only in its dual-accept home', ptlHomes.every(h => ALLOWED_PTL.has(h)) && ptlHomes.length > 0, ptlHomes.join(','))

// ── (5) self-tests: composed needles really are the intended text ──────────
check('self-test: composed cleared needle shape', LEGACY_CLEARED.startsWith('[Old') && LEGACY_CLEARED.endsWith('cleared]'))
check('self-test: composed PTL needle shape', LEGACY_PTL.startsWith('[earlier') && LEGACY_PTL.endsWith('retry]'))
check('self-test: an absence needle matches a planted sample', ('x ' + ['Primary Request', ' and Intent'].join('') + ' y').includes(['Primary Request', ' and Intent'].join('')))

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} LITERAL-FOOTPRINT PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL LITERAL-FOOTPRINT PROOFS PASS')
