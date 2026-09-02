#!/usr/bin/env bun
// ============================================================================
//  scripts/projectdirs/prove-no-literal-homes.ts — the P3 RATCHET: literal
//  `.mercury`/`.claude` home references in src/ are law-bound
// the recorded worklist).
//
//  Two classes, two laws:
//
//  JOIN class — '"-quoted path fragments ('.claude/…', ".mercury") at code
//  positions: the shape join()/path-building uses. STRICT ZERO outside the
//  adjudicated allowlist. Every Mercury-owned project store rides
//  src/utils/projectConfig.ts (candidates/resolve) and every user-scope
//  artifact rides getMercuryHome(). `.mercury` is ratcheted too: a raw
//  `.mercury` join bypasses the seam and its alias refusal — the same
//  defect class as a foreign literal.
//
//  PROSE class — backtick-quoted or slash-prefixed fragments
//  (`.mercury/skills/`, '~/.claude/settings.json') in strings: text shown to
//  models and users. A hardcoded home here LIES whenever the resolved store
//  differs. Held as an EXACT per-file census — the prose worklist
// task: prose truth alignment). New prose literals FAIL; burned-
//  down rows must be removed from the census (deliberate, reviewed); zero
//  flips the class strict via the census simply emptying.
//
//  The terminator class [/'"`] makes `.claude.json` intrinsically a
//  non-match (the name continues with .): a FILENAME inside an
//  already-resolved home, not a join.
//  Comments are masked (line-preserving) before scanning — prose in comments
//  is documentation, policed by review, not by this gate.
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

/** JOIN class: file → why its quoted home fragments are lawful. */
const JOIN_ALLOWLIST: Record<string, string> = {
  'src/utils/projectConfig.ts': 'THE seam — the home names live here',
  'src/utils/projectStoreAdoption.ts':
    'the D11 alias-refusal guard NAMES the external dir it refuses to write through — a boundary refusal, never a home join',
  'src/utils/worktree.ts':
 'classifier vocabulary — the exact Mercury-ephemeral lane registry NAMES cache-clock debris paths across both homes so pre-fix lanes settle; a classifier row, never a write path',
  'src/utils/envUtils.ts': 'THE config-home resolver + label derivation',
  'src/entrypoints/cli.tsx':
    'pre-import compile-cache arm — mirrors the LAUNCHER config-home rungs with builtin-only imports before any src module can load; the seam is unreachable here by construction',
  'src/utils/permissions/filesystem.ts': 'guard vocabulary — DANGEROUS_DIRECTORIES + scope tuples NAME the homes',
  'src/utils/sandbox/sandbox-adapter.ts': 'OS sandbox deny-write vocabulary across both homes',
  'src/substrate/themis/integrity.ts': 'enroll list names committed content paths in both estates',
  'src/utils/verification/verificationState.ts': 'tree-digest exclusion names both harness dirs',
  'src/services/projectIntel/impact.ts': 'scan-ignore vocabulary (both homes)',
  'src/skills/loadSkillsDir.ts': 'managed-policy dir joins (external convention); project paths ride the seam',
  'src/utils/config/derived.ts': 'managed-policy dir join + user-scope compat file names',
  'src/utils/healthReport.ts': 'foreign-artifact + foreign-home comparison rows (deliberate cross-harness checks)',
  'src/utils/secureStorage/macOsKeychainHelpers.ts': 'foreign-home comparison (bare vs suffixed keychain service)',
  'src/utils/accounts/scopeScan.ts': 'the foreign identity file + the Claude-family basename test (class isolation)',
}

/** PROSE class: file → why its prose literal is FROZEN (truthful/external), excluded from the census. */
const PROSE_ALLOWLIST: Record<string, string> = {
  'src/constants/prompts.ts':
    'the .mercury parcel doctrine — operator-ruled instruction prose names the project-local working directory',
  'src/tools/FileEditTool/constants.ts': 'legacy permission-pattern vocabulary (saved rules keep matching; recognizer accepts the estate triple)',
 'src/tools/EnterWorktreeTool/prompt.ts': 'truthful naming of the worktree store under the project-local home',
  'src/services/privateChannel/installLayout.ts': 'the stable shim BODY carries the full home chain (the D-1 runtime mirror)',
  'src/substrate/flagRegistry.ts': 'registry off:/summary prose names the sticky store truthfully (F9)',
}

/**
 * PROSE census — the prose worklist, exact per-file counts. Shrink-only:
 * fixing a site means updating (or deleting) its row HERE in the same change.
 */
const PROSE_CENSUS: Record<string, number> = {
  'src/entrypoints/sdk/coreSchemas.ts': 1,
  'src/services/tips/tipRegistry.ts': 1,
  'src/skills/bundled/skillify.ts': 1,
  'src/utils/settings/types.ts': 1,
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' no-literal-homes ratchet — src joins ride the ONE seam')
console.log('============================================================')

const JOIN_RE = /['"]\.(?:mercury|claude)[/'"]/
const PROSE_RE = /[`/]\.(?:mercury|claude)[/'"`]/

/**
 * Mask comments, line-preserving and CONSERVATIVE: only comments that open at
 * line start are stripped (doc blocks, banners, `//`/`*` lines). A `/*`
 * mid-line is left alone — it may sit inside a string (glob patterns like
 * '…/rules/**' contain the sequence) and a string-blind strip would silently
 * swallow real code (false negatives, the dangerous direction for a gate).
 * The cost is prose-in-trailing-comments occasionally counting — visible and
 * adjudicable, never hidden.
 */
const maskComments = (text: string): string => {
  const out: string[] = []
  let inBlock = false
  for (let line of text.split('\n')) {
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end === -1) {
        out.push('')
        continue
      }
      line = ' '.repeat(end + 2) + line.slice(end + 2)
      inBlock = false
    }
    const t = line.trimStart()
    if (t.startsWith('//') || t.startsWith('*')) {
      out.push('')
      continue
    }
    if (t.startsWith('/*')) {
      const end = line.indexOf('*/', line.indexOf('/*') + 2)
      if (end === -1) {
        inBlock = true
        out.push('')
        continue
      }
      line = ' '.repeat(end + 2) + line.slice(end + 2)
    }
    out.push(line)
  }
  return out.join('\n')
}

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

const joinOffenders = new Map<string, number>()
const proseCounts = new Map<string, number>()
const joinLive = new Set<string>()
const proseLive = new Set<string>()
for (const full of walk(join(ROOT, 'src'))) {
  // Windows lane: allowlist rows are /-spelled — normalize the
  // platform separator so the same rows adjudicate on every OS (H33).
  const rel = relative(ROOT, full).replaceAll('\\', '/')
  for (const line of maskComments(readFileSync(full, 'utf8')).split('\n')) {
    if (JOIN_RE.test(line)) {
      joinLive.add(rel)
      if (!JOIN_ALLOWLIST[rel]) joinOffenders.set(rel, (joinOffenders.get(rel) ?? 0) + 1)
    }
    if (PROSE_RE.test(line)) {
      proseLive.add(rel)
      if (!PROSE_ALLOWLIST[rel] && !JOIN_ALLOWLIST[rel])
        proseCounts.set(rel, (proseCounts.get(rel) ?? 0) + 1)
    }
  }
}

// ── JOIN class: strict zero ─────────────────────────────────────────────────
check(
  `JOIN: zero unadjudicated quoted home joins in src (${joinOffenders.size} offender file(s))`,
  joinOffenders.size === 0,
  [...joinOffenders.entries()].slice(0, 8).map(([f, n]) => `${f}(${n})`).join(', '),
)
for (const [file, reason] of Object.entries(JOIN_ALLOWLIST)) {
  check(`JOIN allowlist row live: ${file}`, joinLive.has(file), `no literals remain — drop the row (${reason})`)
}

// ── PROSE class: exact census, shrink-only ──────────────────────────────────
for (const [file, reason] of Object.entries(PROSE_ALLOWLIST)) {
  check(`PROSE allowlist row live: ${file}`, proseLive.has(file), `no literals remain — drop the row (${reason})`)
}
const expected = new Map(Object.entries(PROSE_CENSUS))
for (const [file, n] of proseCounts) {
  const want = expected.get(file)
  check(
    `PROSE census: ${file} = ${n}`,
    want === n,
    want === undefined ? 'NEW prose home literal — fix it or adjudicate' : `census says ${want} — update the row deliberately`,
  )
  expected.delete(file)
}
for (const [file, want] of expected) {
  check(`PROSE census row stale: ${file}`, false, `expected ${want}, found 0 — delete the row (site fixed?)`)
}
const total = [...proseCounts.values()].reduce((a, b) => a + b, 0)
console.log(`  PROSE worklist: ${total} literal line(s) across ${proseCounts.size} file(s) — the prose burn-down`)

console.log('════════════════════════════════════════════════════════════════════════════')
if (failures > 0) {
  console.error(`❌ ${failures} ratchet check(s) failed`)
  process.exit(1)
}
console.log('✅ HOME LITERALS LAW-BOUND (joins strict; prose censused)')
