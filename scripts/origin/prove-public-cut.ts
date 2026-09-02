#!/usr/bin/env bun
// ============================================================================
//  scripts/origin/prove-public-cut.ts — the public-cut gate.
//
//  Runs against a COPY of the tree prepared for the public home and proves
//  the cut held: the private-records directory and the field channel are
//  absent, no filed packet or sealed receipt survives under scripts/, the
//  vocabulary ratchet carries no allow row for a path that left, the
//  package origin names the public repository, and no operator disk path
//  rides in hand-written text. On the private tree it is RED by design
//  (the cut has not happened there) — it has no run-all.sh and never joins
//  the pool. Needles are composed so this file never matches itself.
//
//  Run:  ~/.bun/bin/bun run scripts/origin/prove-public-cut.ts [--public-repo owner/name]
// ============================================================================
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const J = (...parts: string[]): string => parts.join('')
const argRepo = process.argv.indexOf('--public-repo')
const PUBLIC_REPO = argRepo >= 0 ? process.argv[argRepo + 1] ?? '' : ''

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  [PASS] ${name}`)
  else {
    failures++
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('============================================================')
console.log(' public-cut gate — the studio stays private, the sculpture ships')
console.log('============================================================')

const tracked = execSync('git ls-files -z', { cwd: ROOT }).toString('utf8').split('\0').filter(Boolean)

// ── §1 the cut paths are gone ────────────────────────────────────────────────
const CUT_PREFIXES = [J('clean', 'room/'), 'field/']
for (const prefix of CUT_PREFIXES) {
  const left = tracked.filter(p => p.startsWith(prefix))
  check(`§1 no tracked path under ${prefix}`, left.length === 0, `${left.length} path(s): ${left.slice(0, 3).join(' · ')}`)
}
const packets = tracked.filter(p => /^scripts\/.*\/field-packet-[^/]*\.md$/.test(p))
check('§1 no filed field packet survives under scripts/', packets.length === 0, packets.join(' · '))
const receipts = tracked.filter(p => /-LANE-RECEIPT\.md$|-WORKLIST\.md$|-UPSTREAM-REPORT\.md$/.test(p))
check('§1 no sealed receipt or worklist survives anywhere', receipts.length === 0, receipts.join(' · '))

// ── §2 the vocabulary ratchet carries no row for a path that left ───────────
const seal = readFileSync(join(ROOT, 'scripts/identity/prove-no-lineage-vocabulary.ts'), 'utf8')
const deadRows = [J("['clean", "room/receipts/'"), "['field/'", "['field/inbox/", J("['scripts/winreg/field", "-packet-")]
for (const row of deadRows) {
  check(`§2 the seal holds no allow row ${row}…`, !seal.includes(row))
}

// ── §3 the package origin names the public repository ───────────────────────
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { repository?: { url?: string } }
const url = pkg.repository?.url ?? ''
const privateSlug = J('Whq02/', 'Tem', 'pest', 'Terminal')
check('§3 package.json repository.url no longer names the private repository', !url.includes(privateSlug), url)
if (PUBLIC_REPO) check(`§3 package.json repository.url names ${PUBLIC_REPO}`, url.includes(PUBLIC_REPO), url)
const distInvariants = readFileSync(join(ROOT, 'scripts/identity/prove-dist-invariants.sh'), 'utf8')
check('§3 the dist invariants pin the package origin on the public repository', !distInvariants.includes(privateSlug))

// ── §4 no operator disk path in hand-written text ───────────────────────────
const TEXT = /\.(ts|tsx|mjs|js|py|sh|md|json|yml|yaml|tsv|txt)$/
const GENERATED = /^(scripts\/[^/]+\/baselines\/|design-system\/live\/|scripts\/render-continuity\/receipts\/|scripts\/agent-experience\/baselines\/)/
const homePath = new RegExp(J('/Users/', 'whq', '/'))
const hits: string[] = []
for (const p of tracked) {
  if (!TEXT.test(p) || GENERATED.test(p) || p === 'scripts/origin/prove-public-cut.ts') continue
  let text = ''
  try {
    text = readFileSync(join(ROOT, p), 'utf8')
  } catch {
    continue
  }
  if (homePath.test(text)) hits.push(p)
}
check("§4 no hand-written file spells the operator's home path", hits.length === 0, hits.slice(0, 6).join(' · '))

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ public-cut gate: ${failures} FAILED (expected on the private tree; the cut has not happened here)`)
  process.exit(1)
}
console.log('✅ public-cut gate: the cut held')
