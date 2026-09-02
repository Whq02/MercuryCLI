#!/usr/bin/env bun
// ============================================================================
//  scripts/project-intel/prove-context-capsule.ts — PROOF: the ContextCapsule:
//
//    (1) ranking law — exact task-named paths (T1) rank ABOVE active-work
//        zones (T2), import adjacency (T3), changed/recent paths (T4),
//        instructions (T5), knowledge (T6); recency never crosses tiers.
//    (2) explainability — every item carries role · one-line reason ·
//        freshness generation · bodyPresent:false (refs, never bodies).
//    (3) import adjacency is real and bounded (the fixture's known edges).
//    (4) budget honesty — item cap + byte cap trim with COUNTED, NAMED
//        omissions; never a silent truncation.
//    (5) digest stability — the dedup key is stable across re-assembly of
//        an unchanged world and changes when the working set changes.
//    (6) determinism — two assemblies agree on everything but assembleMs.
//    (7) gate + latency receipts; the adapter's context child round-trips
//        through the REAL registry with the explanation text.
//
//  Run:  ~/.bun/bin/bun run scripts/project-intel/prove-context-capsule.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { rmSync, writeFileSync } from 'node:fs'
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
  console.log('\n❌ TIMEOUT — proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

async function main(): Promise<void> {
  delete process.env.MERCURY_PROJECT_INTEL
  const { materializeFixture } = await import('./fixtures/materialize.js')
  const { assembleContextCapsule, importNeighbours, pathTokens, renderCapsule } = await import(
    '../../src/services/projectIntel/capsule.js'
  )
  const intel = await import('../../src/services/projectIntel/snapshot.js')
  const owner = await import('../../src/services/primitives/owner.js')
  const registry = await import('../../src/services/resources/registry.js')
  await import('../../src/services/resources/adapters/project.js')

  const dir = materializeFixture('ts')
  const ctx = {
    owner: owner.makeOwnerKey({ workspace: dir, sessionId: 'proof-capsule', lane: owner.MAIN_LANE }),
    cwd: dir,
  }

  // ── (1)+(2)+(3) ranking, explainability, adjacency ───────────────────────
  section('(1)(2)(3) ranking law + explainability + import adjacency')
  const task = 'Change the rounding applied in src/core/pricing.ts and update tests/pricing.test.ts'
  const capsule = assembleContextCapsule({ workspace: dir, task })
  check('capsule assembles', capsule !== null)
  if (!capsule) throw new Error('no capsule')
  const byPath = new Map(capsule.items.map(i => [i.path, i]))
  check('exact-named file is tier 1 primary edit', byPath.get('src/core/pricing.ts')?.tier === 1 && byPath.get('src/core/pricing.ts')?.role === 'primary edit')
  check('exact-named test carries the test role', byPath.get('tests/pricing.test.ts')?.role === 'test')
  const neighbours = importNeighbours(dir, 'src/core/pricing.ts')
  check(
    'import adjacency finds the fixture edges (types · rules · money)',
    ['src/core/types.ts', 'src/core/rules.ts', 'src/util/money.ts'].every(p => neighbours.includes(p)),
    neighbours.join(','),
  )
  check('adjacency items land tier 3 with the importing file named', byPath.get('src/core/rules.ts')?.tier === 3 && /imported by src\/core\/pricing\.ts/.test(byPath.get('src/core/rules.ts')?.reason ?? ''))
  check(
    'every item explains itself (role + reason + freshness + refs-only)',
    capsule.items.every(i => i.role.length > 0 && i.reason.length > 0 && i.freshness.length > 0 && i.bodyPresent === false && i.ref.startsWith('mercury://file/')),
  )
  check('tier order is monotone in the item list', capsule.items.every((it, i, xs) => i === 0 || xs[i - 1]!.tier <= it.tier))

  // Recency never crosses tiers: dirty a file, then confirm it ranks BELOW
  // the exact-named primary. The digest cache is RESET instead of slept
  // past (the TTL law itself is asserted in prove-project-snapshot — here
  // the validation semantics are identical and 10s of gate time is waste).
  writeFileSync(join(dir, 'src', 'services', 'checkout.ts'), '// touched\n' + (await import('node:fs')).readFileSync(join(dir, 'src', 'services', 'checkout.ts'), 'utf8'))
  const { _resetVerificationStateForTesting } = await import(
    '../../src/utils/verification/verificationState.js'
  )
  _resetVerificationStateForTesting()
  intel._resetProjectIntelForTesting()
  const capsule2 = assembleContextCapsule({ workspace: dir, task })
  const changedItem = capsule2?.items.find(i => i.path === 'src/services/checkout.ts')
  check('changed path appears as tier-4 recent change', changedItem?.tier === 4 && changedItem.role === 'recent change', JSON.stringify(changedItem))
  const primaryIdx = capsule2?.items.findIndex(i => i.path === 'src/core/pricing.ts') ?? -1
  const changedIdx = capsule2?.items.findIndex(i => i.path === 'src/services/checkout.ts') ?? -1
  check('recency ranks BELOW exact evidence', primaryIdx !== -1 && changedIdx > primaryIdx)

  // ── zones (T2) ────────────────────────────────────────────────────────────
  const zoned = assembleContextCapsule({ workspace: dir, task: 'general cleanup', zonePaths: ['src/services/invoicing.ts'] })
  check('accepted zone path rides tier 2 active work', zoned?.items.some(i => i.path === 'src/services/invoicing.ts' && i.tier === 2 && i.role === 'active work') === true)

  // ── (4) budget honesty ───────────────────────────────────────────────────
  section('(4) budget: caps trim with named omissions')
  const tight = assembleContextCapsule({ workspace: dir, task, budget: { maxItems: 3 } })
  check('item cap respected', (tight?.items.length ?? 99) <= 3)
  check('omissions counted + named', (tight?.caps.omitted.count ?? 0) > 0 && (tight?.caps.omitted.reasons.length ?? 0) > 0, JSON.stringify(tight?.caps))
  const bytes = assembleContextCapsule({ workspace: dir, task, budget: { maxBytes: 600 } })
  check('byte cap trims and names it', bytes !== null && Buffer.byteLength(JSON.stringify(bytes.items), 'utf8') <= 600 && bytes.caps.omitted.count > 0, JSON.stringify(bytes?.caps))

  // ── (5)+(6) digest stability + determinism ───────────────────────────────
  section('(5)(6) digest stability + determinism')
  const a = assembleContextCapsule({ workspace: dir, task })
  const b = assembleContextCapsule({ workspace: dir, task })
  const strip = (c: NonNullable<typeof a>) => JSON.stringify({ ...c, assembleMs: 0, generation: { ...c.generation, scannedAtMs: 0, buildMs: 0 } })
  check('two assemblies identical (minus timing)', a !== null && b !== null && strip(a!) === strip(b!))
  check('digest stable across re-assembly (the dedup key)', a?.digest === b?.digest)
  const other = assembleContextCapsule({ workspace: dir, task: 'Refactor src/util/validate.ts error text' })
  check('different working set ⇒ different digest', other !== null && other.digest !== a?.digest)

  // ── (7) gate + latency + the adapter child ───────────────────────────────
  section('(7) gate · latency receipts · mercury:// context child')
  process.env.MERCURY_PROJECT_INTEL = '0'
  check('gate off ⇒ null', assembleContextCapsule({ workspace: dir, task }) === null)
  delete process.env.MERCURY_PROJECT_INTEL
  console.log(`  assembleMs: cold-ish ${capsule.assembleMs}ms · warm ${b?.assembleMs}ms`)
  check('warm assembly within 4× the §10 gate (pooled-load ceiling)', (b?.assembleMs ?? 999) <= 200, `${b?.assembleMs}ms`)
  const viaRef = await registry.resolveResource(
    `mercury://project/current?child=context&q=${encodeURIComponent(task)}`,
    ctx,
  )
  check('context child resolves through the registry', viaRef.state === 'ok', viaRef.state)
  if (viaRef.state === 'ok') {
    check('explanation text renders roles + reasons', /primary edit; named exactly in the task/.test(viaRef.resource.text ?? ''), (viaRef.resource.text ?? '').slice(0, 200))
    check('capsule digest rides as version', typeof viaRef.resource.version === 'string' && viaRef.resource.version.length === 16)
  }
  const noQ = await registry.resolveResource('mercury://project/current?child=context', ctx)
  check('missing q ⇒ absent with the usage note', noQ.state === 'absent')

  // pathTokens hygiene.
  const toks = pathTokens('see "src/core/pricing.ts", ./README.md, and bogus/nope.ts.', dir)
  check('pathTokens: quotes/punct stripped, nonexistent dropped', JSON.stringify(toks) === JSON.stringify(['README.md', 'src/core/pricing.ts']), JSON.stringify(toks))

  check('renderCapsule names omissions when present', /omitted/.test(renderCapsule(tight!)))

  rmSync(dir, { recursive: true, force: true })

  console.log('\n' + '═'.repeat(76))
  if (failures > 0) {
    console.log(`❌ ${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('✅ CONTEXT CAPSULE PROOF PASSES')
  process.exit(0)
}

void main()
