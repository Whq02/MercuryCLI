#!/usr/bin/env bun
// ============================================================================
//  scripts/project-intel/prove-project-snapshot.ts — PROOF: the project-
//  intelligence snapshot owner:
//
//    (1) composition truth — the snapshot's surface facts come from the ONE
//        repoSurfaceMap walk (scan/render split byte-identical is pinned by
//        scripts/onboarding); git facts from the typed gitGraph owner;
//        generation from the verify-evidence tree digest.
//    (2) determinism — two builds of an unchanged tree agree on every
//        content fact and on the generation digest.
//    (3) cache law — fresh → cache-validated (digest match) → MUTATION
//        invalidates (rebuild with a NEW digest); a digest-less tree reuses
//        only within the named TTL ('cache-ttl'), never 'cache-validated'.
//    (4) honesty — caps/omissions named; disabled gate ⇒ null owner +
//        'unavailable' adapter; unknown child ⇒ absent.
//    (5) the mercury://project projection resolves through the REAL registry
//        (current · modules · changes · knowledge), generation-stamped.
//    (6) latency receipts — base build + warm validated read measured with
//        generous ceilings (exact p95 gates ride the closure bench, not the
//        pooled gate — load-sensitivity doctrine).
//
//  Run:  ~/.bun/bin/bun run scripts/project-intel/prove-project-snapshot.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

async function main(): Promise<void> {
  delete process.env.MERCURY_PROJECT_INTEL
  const { materializeFixture } = await import('./fixtures/materialize.js')
  const intel = await import('../../src/services/projectIntel/snapshot.js')
  const contracts = await import('../../src/services/projectIntel/contracts.js')
  const owner = await import('../../src/services/primitives/owner.js')
  const registry = await import('../../src/services/resources/registry.js')
  await import('../../src/services/resources/adapters/project.js')

  const cleanup: string[] = []
  const ctxFor = (cwd: string) => ({
    owner: owner.makeOwnerKey({ workspace: cwd, sessionId: 'proof-session', lane: owner.MAIN_LANE }),
    cwd,
  })

  // ── (1)+(2) composition + determinism ────────────────────────────────────
  section('(1)(2) composition truth + determinism on an unchanged tree')
  const dir = materializeFixture('ts')
  cleanup.push(dir)
  const r1 = intel.getProjectSnapshot(dir)
  check('owner answers when enabled', r1 !== null)
  if (!r1) throw new Error('no snapshot')
  check('first read is fresh', r1.from === 'fresh', r1.from)
  const s1 = r1.snapshot
  check('generation digest present on a git tree', typeof s1.generation.treeDigest === 'string')
  check('HEAD + branch from the git owner', s1.generation.headSha !== null && s1.generation.branch === 'main', `${s1.generation.branch}`)
  check('surface facts present (the ONE walk)', s1.surface !== null && s1.surface.topDirs.includes('src'))
  check(
    'surface languages see TypeScript',
    s1.surface?.topLangs.some(([l]) => l === 'TypeScript') === true,
  )
  check('instructions: fixture has no CLAUDE.md', s1.instructions.claudeMd === false)
  check('git facts: clean baseline tree', s1.git.state === 'ok' && s1.git.changed.length === 0)

  intel._resetProjectIntelForTesting()
  const r2 = intel.getProjectSnapshot(dir)
  if (!r2) throw new Error('no snapshot 2')
  const contentOf = (s: typeof s1) =>
    JSON.stringify({ ...s, generation: { ...s.generation, scannedAtMs: 0, buildMs: 0 } })
  check('two builds of the unchanged tree agree on every content fact', contentOf(s1) === contentOf(r2.snapshot))
  check('and on the generation digest', s1.generation.treeDigest === r2.snapshot.generation.treeDigest)

  // ── (3) cache law ─────────────────────────────────────────────────────────
  section('(3) cache: validated reuse · mutation invalidates · TTL is named')
  const warm0 = performance.now()
  const r3 = intel.getProjectSnapshot(dir)
  const warmMs = performance.now() - warm0
  check('unchanged tree ⇒ cache-validated', r3?.from === 'cache-validated', r3?.from)
  writeFileSync(join(dir, 'src', 'core', 'NEW_FACT.ts'), 'export const flip = 1\n')
  // The digest layer coalesces bursts inside a 10s TTL: a mutation INSIDE
  // the window is invisible BY DESIGN (the read still answers
  // cache-validated against the pre-mutation digest — assert the law
  // instead of merely riding past it), and is seen no later than the TTL
  // edge. The proof waits out the window rather than weakening the law.
  const withinTtl = intel.getProjectSnapshot(dir)
  check(
    'within the digest TTL a mutation is invisible (cache-validated, the documented ≤10s bound)',
    withinTtl?.from === 'cache-validated',
    withinTtl?.from,
  )
  // The stale-tolerant hot-path read (maxStaleMs) also reuses, NAMED:
  const tolerant = intel.getProjectSnapshot(dir, { maxStaleMs: 60_000 })
  check('maxStaleMs read reuses WITHOUT digest work and says cache-ttl', tolerant?.from === 'cache-ttl', tolerant?.from)
  await new Promise(r => setTimeout(r, 10_100))
  const r4 = intel.getProjectSnapshot(dir)
  check('mutation ⇒ rebuild (fresh)', r4?.from === 'fresh', r4?.from)
  check(
    'new generation digest after mutation',
    r4 !== null && r4.snapshot.generation.treeDigest !== s1.generation.treeDigest,
  )
  check(
    'mutated path visible in git facts',
    r4?.snapshot.git.changed.some(c => c.path.includes('NEW_FACT')) === true,
  )

  const plain = mkdtempSync(join(tmpdir(), 'project-intel-plain-'))
  cleanup.push(plain)
  writeFileSync(join(plain, 'a.py'), 'x = 1\n')
  intel._resetProjectIntelForTesting()
  const p1 = intel.getProjectSnapshot(plain)
  const p2 = intel.getProjectSnapshot(plain)
  check('digest-less tree: first read fresh', p1?.from === 'fresh', p1?.from)
  check('digest-less tree: reuse is NAMED cache-ttl, never cache-validated', p2?.from === 'cache-ttl', p2?.from)
  check(
    'digest-less omission named',
    p1?.snapshot.caps.omissions.some(o => o.includes('no tree digest')) === true,
    JSON.stringify(p1?.snapshot.caps.omissions),
  )

  // ── (4) gate honesty ─────────────────────────────────────────────────────
  section('(4) gate: =0 ⇒ null owner + unavailable adapter')
  process.env.MERCURY_PROJECT_INTEL = '0'
  check('enabled() reads live', contracts.projectIntelEnabled() === false)
  check('owner answers null when disabled', intel.getProjectSnapshot(dir) === null)
  const disabled = await registry.resolveResource('mercury://project/current', ctxFor(dir))
  check('adapter answers unavailable when disabled', disabled.state === 'unavailable', disabled.state)
  delete process.env.MERCURY_PROJECT_INTEL

  // ── (5) the mercury://project projection through the REAL registry ───────
  section('(5) mercury://project/* through the registry')
  intel._resetProjectIntelForTesting()
  const cur = await registry.resolveResource('mercury://project/current', ctxFor(dir))
  check('current resolves ok', cur.state === 'ok', cur.state === 'ok' ? '' : JSON.stringify(cur))
  if (cur.state === 'ok') {
    check('overview carries generation + freshness in summary', /generation .{12} · HEAD/.test(cur.resource.summary))
    check('overview lists the seven children', (cur.resource.children?.length ?? 0) === 7)
    check('version = tree digest (staleness on resume)', cur.resource.version === r4?.snapshot.generation.treeDigest)
  }
  const modules = await registry.resolveResource('mercury://project/current?child=modules', ctxFor(dir))
  check('modules child resolves', modules.state === 'ok')
  if (modules.state === 'ok') {
    const st = modules.resource.structured as { topDirs?: string[]; generation?: { treeDigest?: string } }
    check('modules carries topology + generation stamp', Array.isArray(st.topDirs) && typeof st.generation?.treeDigest === 'string')
  }
  const changes = await registry.resolveResource('mercury://project/current?child=changes&limit=1', ctxFor(dir))
  check('changes child paginates', changes.state === 'ok' && changes.resource.page?.total === 1 && changes.resource.page.hasMore === false)
  const knowledge = await registry.resolveResource('mercury://project/current?child=knowledge', ctxFor(dir))
  check('knowledge child resolves with presence rows', knowledge.state === 'ok' && /CLAUDE\.md: absent/.test(knowledge.resource.text ?? ''))
  const bogus = await registry.resolveResource('mercury://project/current?child=nope', ctxFor(dir))
  check('unknown child ⇒ absent (named)', bogus.state === 'absent')
  const bogusId = await registry.resolveResource('mercury://project/other', ctxFor(dir))
  check('unknown id ⇒ absent (named)', bogusId.state === 'absent')

  // ── (6) latency receipts (generous ceilings; exact p95 = closure bench) ──
  section('(6) latency receipts')
  const coldMs = r4?.snapshot.generation.buildMs ?? 9999
  console.log(`  cold base build: ${coldMs}ms · warm validated read: ${warmMs.toFixed(1)}ms`)
  check('cold base build within 4× the §10 cold gate (pooled-load ceiling)', coldMs <= 1000, `${coldMs}ms`)
  check('warm validated read within 4× the §10 cached gate (pooled-load ceiling)', warmMs <= 300, `${warmMs}ms`)

  for (const d of cleanup) rmSync(d, { recursive: true, force: true })

  console.log('\n' + '═'.repeat(76))
  if (failures > 0) {
    console.log(`❌ ${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('✅ PROJECT SNAPSHOT PROOF PASSES')
  process.exit(0)
}

void main()
