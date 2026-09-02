#!/usr/bin/env bun
// ============================================================================
//  scripts/project-intel/prove-orient-surface.ts — PROOF: the /orient operator
//  surface:
//
//    (1) /orient bare — gate ON appends the Project intelligence section
//        (generation · freshness · changes · drill-in refs); gate OFF is
//        BYTE-IDENTICAL to the bare surface-map output.
//    (2) /orient pin|drop|clear|pins — the operator's context marks, with
//        caps and honest notes.
//    (3) marks correct the capsule: a pin rides tier 2 'operator-pinned';
//        a drop is excluded AND counted in the named omissions; a cleared
//        mark restores derivation.
//    (4) the attachment producer consumes the marks (the end-to-end path
//        the operator actually touches).
//
//  Run:  ~/.bun/bin/bun run scripts/project-intel/prove-orient-surface.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { rmSync } from 'node:fs'

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
  const dir = materializeFixture('ts')

  const bootstrap = await import('../../src/bootstrap/state.js')
  const setOriginalCwd = (bootstrap as unknown as { setOriginalCwd?: (p: string) => void }).setOriginalCwd
  if (typeof setOriginalCwd === 'function') setOriginalCwd(dir)
  else process.chdir(dir)

  const orient = await import('../../src/commands/orient/orient.js')
  const { buildRepoSurfaceMap } = await import('../../src/utils/cockpit/repoSurfaceMap.js')
  const pins = await import('../../src/services/projectIntel/pins.js')
  const { assembleContextCapsule } = await import('../../src/services/projectIntel/capsule.js')
  const { processOwnerForLane } = await import('../../src/services/run/resolveOwner.js')
  const intel = await import('../../src/services/projectIntel/snapshot.js')
  const producer = await import('../../src/utils/attachments/contextCapsule.js')

  const ctxStub = {} as never
  const asText = (r: unknown): string => (r as { value: string }).value

  // ── (1) bare output, gate on/off ─────────────────────────────────────────
  section('(1) /orient bare — intelligence section ON, byte-identical OFF')
  intel._resetProjectIntelForTesting()
  const on = asText(await orient.call('', ctxStub))
  check('surface map present', on.includes('# Repo surface map'))
  check('intelligence section appended', on.includes('## Project intelligence'), on.slice(0, 200))
  check('generation + freshness line', /generation `[0-9a-f]{12}` · (fresh|cache-validated|cache-ttl)/.test(on))
  check('drill-in refs named', on.includes('mercury://project/current'))
  check('correction verbs named', on.includes('/orient pin <path>'))
  process.env.MERCURY_PROJECT_INTEL = '0'
  const off = asText(await orient.call('', ctxStub))
  const bare = buildRepoSurfaceMap(dir)
  check('gate off ⇒ byte-identical to the bare surface-map output', off === bare, off.slice(-120))
  delete process.env.MERCURY_PROJECT_INTEL

  // ── (2) verbs ────────────────────────────────────────────────────────────
  section('(2) pin/drop/clear/pins verbs')
  pins._resetContextMarksForTesting()
  const pinned = asText(await orient.call('pin src/core/rules.ts', ctxStub))
  check('pin answers with the mark note', pinned.includes('pinned src/core/rules.ts'))
  const droppedNote = asText(await orient.call('drop src/util/money.ts', ctxStub))
  check('drop answers with the exclusion note', droppedNote.includes('dropped src/util/money.ts'))
  const listing = asText(await orient.call('pins', ctxStub))
  check('pins lists both marks', listing.includes('src/core/rules.ts') && listing.includes('src/util/money.ts'))
  const bare2 = asText(await orient.call('', ctxStub))
  check('bare output shows the marks', bare2.includes('pinned: src/core/rules.ts') && bare2.includes('dropped: src/util/money.ts'))

  // ── (3) marks correct the capsule ────────────────────────────────────────
  section('(3) capsule integration')
  const owner = processOwnerForLane(null)
  const marks = pins.getContextMarks(owner)
  const capsule = assembleContextCapsule({
    workspace: dir,
    task: 'Adjust rounding in src/core/pricing.ts',
    pins: marks.pins,
    drops: marks.drops,
  })
  check('assembles', capsule !== null)
  const pinnedItem = capsule?.items.find(i => i.path === 'src/core/rules.ts')
  check('pinned path rides tier 2 as operator-pinned', pinnedItem?.tier === 2 && /operator-pinned/.test(pinnedItem?.reason ?? ''), JSON.stringify(pinnedItem))
  check('dropped path excluded (money.ts was an import neighbour)', !capsule?.items.some(i => i.path === 'src/util/money.ts'))
  check('drop counted in named omissions', capsule?.caps.omitted.reasons.some(r => r.includes('operator-dropped')) === true, JSON.stringify(capsule?.caps))
  asText(await orient.call('clear src/util/money.ts', ctxStub))
  const cleared = pins.getContextMarks(owner)
  const capsule2 = assembleContextCapsule({
    workspace: dir,
    task: 'Adjust rounding in src/core/pricing.ts',
    pins: cleared.pins,
    drops: cleared.drops,
  })
  check('cleared drop restores derivation', capsule2?.items.some(i => i.path === 'src/util/money.ts') === true)

  // ── (4) the attachment producer consumes the marks ───────────────────────
  section('(4) end-to-end: producer honors the marks')
  producer._resetContextCapsuleForTesting()
  const attach = await producer.getContextCapsuleAttachment(
    null,
    [{ type: 'user', message: { content: 'Adjust rounding in src/core/pricing.ts' } }] as never,
    { agentId: undefined, readFileState: new Map(), options: {}, getAppState: () => ({}) } as never,
  )
  check('attachment produced', attach.length === 1)
  const refs = (attach[0] as { refs: string[] }).refs
  check('producer capsule carries the pinned path', refs.includes('mercury://file/src/core/rules.ts'))

  // caps on marks + the C3 canonicalization law
  const absPin = pins.pinContextItem(owner, `${dir}/src/core/types.ts`, dir)
  check('ABSOLUTE workspace path canonicalizes to relative', absPin.ok === true && absPin.note.includes('pinned src/core/types.ts'), absPin.note)
  const outsidePin = pins.pinContextItem(owner, '/etc/passwd', dir)
  check('outside-workspace path REFUSED with the reason', outsidePin.ok === false && outsidePin.note.includes('outside'), outsidePin.note)
  const capNote = (() => {
    for (let i = 0; i < 40; i++) pins.pinContextItem(owner, `src/f${i}.ts`, dir)
    return pins.pinContextItem(owner, 'src/one-more.ts', dir)
  })()
  check('pin cap answers honestly', capNote.ok === false && capNote.note.includes('cap'), capNote.note)

  rmSync(dir, { recursive: true, force: true })

  console.log('\n' + '═'.repeat(76))
  if (failures > 0) {
    console.log(`❌ ${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('✅ ORIENT SURFACE PROOF PASSES')
  process.exit(0)
}

void main()
