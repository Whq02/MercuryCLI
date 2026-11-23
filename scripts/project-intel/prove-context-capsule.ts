#!/usr/bin/env bun
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

const capsuleSrcHint = 'look in assembleContextCapsule, src/sessions/project-intel/capsule.ts'

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 120s; a capsule assembly or the mercury://project/current context child hung, look in src/sessions/project-intel/capsule.ts and src/integrations/resources/adapters/project.ts')
  process.exit(1)
}, 120_000)
guard.unref?.()

async function main(): Promise<void> {
  delete process.env.MERCURY_PROJECT_INTEL
  const { materializeFixture } = await import('./fixtures/materialize.js')
  const { assembleContextCapsule, importNeighbours, pathTokens, renderCapsule } = await import(
    '../../src/sessions/project-intel/capsule.js'
  )
  const intel = await import('../../src/sessions/project-intel/snapshot.js')
  const owner = await import('../../src/engine/execution-plane/owner.js')
  const registry = await import('../../src/integrations/resources/registry.js')

  const dir = materializeFixture('ts')
  const ctx = {
    owner: owner.makeOwnerKey({ workspace: dir, sessionId: 'proof-capsule', lane: owner.MAIN_LANE }),
    cwd: dir,
  }

  section('(1)(2)(3) ranking law + explainability + import adjacency')
  const task = 'Change the rounding applied in src/core/pricing.ts and update tests/pricing.test.ts'
  const capsule = assembleContextCapsule({ workspace: dir, task })
  check('capsule assembles', capsule !== null, 'assembleContextCapsule returned null; ' + capsuleSrcHint + ' (and check MERCURY_PROJECT_INTEL is not 0)')
  if (!capsule) throw new Error('no capsule')
  const byPath = new Map(capsule.items.map(i => [i.path, i]))
  check('exact-named file is tier 1 primary edit', byPath.get('src/core/pricing.ts')?.tier === 1 && byPath.get('src/core/pricing.ts')?.role === 'primary edit', 'a path named exactly in the task must be tier 1 primary edit; ' + capsuleSrcHint)
  check('exact-named test carries the test role', byPath.get('tests/pricing.test.ts')?.role === 'test', 'a test file named in the task must carry the test role; ' + capsuleSrcHint)
  const neighbours = importNeighbours(dir, 'src/core/pricing.ts')
  check(
    'import adjacency finds the fixture edges (types · rules · money)',
    ['src/core/types.ts', 'src/core/rules.ts', 'src/util/money.ts'].every(p => neighbours.includes(p)),
    neighbours.join(',') + ' (look in importNeighbours, src/sessions/project-intel/capsule.ts)',
  )
  check('adjacency items land tier 3 with the importing file named', byPath.get('src/core/rules.ts')?.tier === 3 && /imported by src\/core\/pricing\.ts/.test(byPath.get('src/core/rules.ts')?.reason ?? ''), JSON.stringify(byPath.get('src/core/rules.ts')) + ' (an import neighbour must be tier 3 and name the importing file; ' + capsuleSrcHint + ')')
  check(
    'every item explains itself (role + reason + freshness + refs-only)',
    capsule.items.every(i => i.role.length > 0 && i.reason.length > 0 && i.freshness.length > 0 && i.bodyPresent === false && i.ref.startsWith('mercury://file/')),
    'every item needs a role, reason, freshness, bodyPresent false and a mercury://file/ ref; ' + capsuleSrcHint,
  )
  check('tier order is monotone in the item list', capsule.items.every((it, i, xs) => i === 0 || xs[i - 1]!.tier <= it.tier), 'items must be sorted by tier; ' + capsuleSrcHint)

  writeFileSync(join(dir, 'src', 'services', 'checkout.ts'), '// touched\n' + (await import('node:fs')).readFileSync(join(dir, 'src', 'services', 'checkout.ts'), 'utf8'))
  const { _resetVerificationStateForTesting } = await import(
    '../../src/platform/verification/verificationState.js'
  )
  _resetVerificationStateForTesting()
  intel._resetProjectIntelForTesting()
  const capsule2 = assembleContextCapsule({ workspace: dir, task })
  const changedItem = capsule2?.items.find(i => i.path === 'src/services/checkout.ts')
  check('changed path appears as tier-4 recent change', changedItem?.tier === 4 && changedItem.role === 'recent change', JSON.stringify(changedItem) + ' (a path changed in the tree must be tier 4 recent change; ' + capsuleSrcHint + ')')
  const primaryIdx = capsule2?.items.findIndex(i => i.path === 'src/core/pricing.ts') ?? -1
  const changedIdx = capsule2?.items.findIndex(i => i.path === 'src/services/checkout.ts') ?? -1
  check('recency ranks BELOW exact evidence', primaryIdx !== -1 && changedIdx > primaryIdx, `primary at ${primaryIdx}, changed at ${changedIdx}; a recent change must rank below an exact-named file, ${capsuleSrcHint}`)

  const zoned = assembleContextCapsule({ workspace: dir, task: 'general cleanup', zonePaths: ['src/services/invoicing.ts'] })
  check('accepted zone path rides tier 2 active work', zoned?.items.some(i => i.path === 'src/services/invoicing.ts' && i.tier === 2 && i.role === 'active work') === true, 'an accepted zonePaths entry must ride tier 2 active work; ' + capsuleSrcHint)

  section('(T6) a doc rides on a whole word of its name — never a filler word or a word inside the name')
  const noisy = assembleContextCapsule({ workspace: dir, task: 'read the file and want the tests' })
  const noisyDocs = noisy?.items.filter(i => i.role === 'knowledge').map(i => i.path) ?? []
  check('filler words and the word read attach no doc (README.md stays out)', noisyDocs.length === 0, noisyDocs.join(',') + ' (the doc-name match must ignore filler words, look in assembleContextCapsule, src/sessions/project-intel/capsule.ts)')
  const named = assembleContextCapsule({ workspace: dir, task: 'update the readme' })
  check('the whole word readme attaches README.md as knowledge', named?.items.some(i => i.path === 'README.md' && i.role === 'knowledge') === true, 'a whole word of a doc name in the task must attach that doc as knowledge; ' + capsuleSrcHint)

  section('(4) budget: caps trim with named omissions')
  const tight = assembleContextCapsule({ workspace: dir, task, budget: { maxItems: 3 } })
  check('item cap respected', (tight?.items.length ?? 99) <= 3, `${tight?.items.length} items; budget.maxItems must cap the list, ${capsuleSrcHint}`)
  check('omissions counted + named', (tight?.caps.omitted.count ?? 0) > 0 && (tight?.caps.omitted.reasons.length ?? 0) > 0, JSON.stringify(tight?.caps) + ' (a trimmed capsule must count and name what it omitted; ' + capsuleSrcHint + ')')
  const bytes = assembleContextCapsule({ workspace: dir, task, budget: { maxBytes: 600 } })
  check('byte cap trims and names it', bytes !== null && Buffer.byteLength(JSON.stringify(bytes.items), 'utf8') <= 600 && bytes.caps.omitted.count > 0, JSON.stringify(bytes?.caps) + ' (budget.maxBytes must trim and name the omission; ' + capsuleSrcHint + ')')

  section('(5)(6) digest stability + determinism')
  const a = assembleContextCapsule({ workspace: dir, task })
  const b = assembleContextCapsule({ workspace: dir, task })
  const strip = (c: NonNullable<typeof a>) => JSON.stringify({ ...c, assembleMs: 0, generation: { ...c.generation, scannedAtMs: 0, buildMs: 0 } })
  check('two assemblies identical (minus timing)', a !== null && b !== null && strip(a!) === strip(b!), 'assembly must be deterministic apart from timing; ' + capsuleSrcHint)
  check('digest stable across re-assembly (the dedup key)', a?.digest === b?.digest, `${a?.digest} vs ${b?.digest}; the digest must depend only on the working set, ${capsuleSrcHint}`)
  const other = assembleContextCapsule({ workspace: dir, task: 'Refactor src/util/validate.ts error text' })
  check('different working set ⇒ different digest', other !== null && other.digest !== a?.digest, 'a different task must give a different digest; ' + capsuleSrcHint)

  section('(7) gate · latency receipts · mercury:// context child')
  process.env.MERCURY_PROJECT_INTEL = '0'
  check('gate off ⇒ null', assembleContextCapsule({ workspace: dir, task }) === null, 'MERCURY_PROJECT_INTEL=0 must make the assembly return null; ' + capsuleSrcHint)
  delete process.env.MERCURY_PROJECT_INTEL
  console.log(`  assembleMs: cold-ish ${capsule.assembleMs}ms · warm ${b?.assembleMs}ms`)
  check('warm assembly within 4× the §10 gate (pooled-load ceiling)', (b?.assembleMs ?? 999) <= 200, `${b?.assembleMs}ms`)
  const viaRef = await registry.resolveResource(
    `mercury://project/current?child=context&q=${encodeURIComponent(task)}`,
    ctx,
  )
  check('context child resolves through the registry', viaRef.state === 'ok', viaRef.state + ' (look at the context child in src/integrations/resources/adapters/project.ts)')
  if (viaRef.state === 'ok') {
    check('explanation text renders roles + reasons', /primary edit; named exactly in the task/.test(viaRef.resource.text ?? ''), (viaRef.resource.text ?? '').slice(0, 200) + ' (look at the context child in src/integrations/resources/adapters/project.ts and renderCapsule in src/sessions/project-intel/capsule.ts)')
    check('capsule digest rides as version', typeof viaRef.resource.version === 'string' && viaRef.resource.version.length === 16, 'the context child must return the capsule digest as a 16-character version; look in src/integrations/resources/adapters/project.ts')
  }
  const noQ = await registry.resolveResource('mercury://project/current?child=context', ctx)
  check('missing q ⇒ absent with the usage note', noQ.state === 'absent', noQ.state + ' (a context child with no q must be absent with a usage note; look in src/integrations/resources/adapters/project.ts)')

  const toks = pathTokens('see "src/core/pricing.ts", ./README.md, and bogus/nope.ts.', dir)
  check('pathTokens: quotes/punct stripped, nonexistent dropped', JSON.stringify(toks) === JSON.stringify(['README.md', 'src/core/pricing.ts']), JSON.stringify(toks) + ' (look in pathTokens, src/sessions/project-intel/capsule.ts)')

  check('renderCapsule names omissions when present', /omitted/.test(renderCapsule(tight!)), 'renderCapsule must print an omitted line when caps.omitted is non-empty; look in renderCapsule, src/sessions/project-intel/capsule.ts')

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
