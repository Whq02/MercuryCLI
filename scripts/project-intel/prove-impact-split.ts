#!/usr/bin/env bun
// ============================================================================
//  scripts/project-intel/prove-impact-split.ts — PROOF: the impact, split,
//  steering and transcript surfaces:
//
//    (1) impact projection — established relationships only on the fixture:
//        forward imports, reverse importers, tests, change stats; inference
//        LABELED; caps named; deterministic.
//    (2) work-split suggestion — the M8-shaped task pair yields disjoint
//        streams with the contested path FLAGGED; advisory marker present.
//    (3) point-of-use steering — the lexical tools' descriptions carry the
//        capability-gated line when the owners are ON and append NOTHING
//        when every owner is off (the null-line law — descriptions revert).
//    (4) transcript refs — session JSONL + subagent JSONL resolve as
//        bounded concise rows through the REAL registry (hermetic home);
//        absent ≠ unavailable preserved.
//
//  Run:  ~/.bun/bin/bun run scripts/project-intel/prove-impact-split.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  // Hermetic config home BEFORE any src import (transcript adapter paths).
  const home = mkdtempSync(join(tmpdir(), 'project-intel-s4-home-'))
  process.env.MERCURY_CONFIG_DIR = home

  const { materializeFixture } = await import('./fixtures/materialize.js')
  const { projectImpact, collectCodeFiles } = await import('../../src/services/projectIntel/impact.js')
  const { suggestWorkSplit } = await import('../../src/services/projectIntel/split.js')
  const steering = await import('../../src/services/projectIntel/steering.js')
  const owner = await import('../../src/services/primitives/owner.js')
  const registry = await import('../../src/services/resources/registry.js')
  await import('../../src/services/resources/adapters/project.js')
  await import('../../src/services/resources/adapters/transcript.js')

  const dir = materializeFixture('ts')
  const ctx = {
    owner: owner.makeOwnerKey({ workspace: dir, sessionId: 'proof-s4', lane: owner.MAIN_LANE }),
    cwd: dir,
  }

  // ── (1) impact projection ────────────────────────────────────────────────
  section('(1) impact projection — established only, labeled inference, caps')
  const impact = projectImpact(dir, 'src/core/pricing.ts')
  check('projects', impact !== null)
  if (!impact) throw new Error('no impact')
  check(
    'forward imports established',
    JSON.stringify(impact.established.imports) ===
      JSON.stringify(['src/core/rules.ts', 'src/core/types.ts', 'src/util/money.ts'].sort()),
    impact.established.imports.join(','),
  )
  check(
    'reverse importers established (the three services)',
    ['src/services/checkout.ts', 'src/services/invoicing.ts', 'src/services/reporting.ts'].every(p =>
      impact.established.importedBy.includes(p),
    ),
    impact.established.importedBy.join(','),
  )
  check('tests established via reverse imports', impact.established.tests.includes('tests/pricing.test.ts'))
  check('clean file ⇒ null change stats', impact.established.change === null)
  check(
    'second-order reach is LABELED inference (api handlers)',
    impact.inferences.some(i => i.includes('INFERRED') && i.includes('src/api/handlers.ts')),
    JSON.stringify(impact.inferences),
  )
  check('scan caps named', impact.caps.scannedFiles > 0 && impact.caps.capped === false)
  writeFileSync(join(dir, 'src', 'core', 'pricing.ts'), '// touched\n' + (await import('node:fs')).readFileSync(join(dir, 'src', 'core', 'pricing.ts'), 'utf8'))
  const dirty = projectImpact(dir, 'src/core/pricing.ts')
  check('dirty file ⇒ change stats from the git owner', (dirty?.established.change?.added ?? 0) >= 1, JSON.stringify(dirty?.established.change))
  const impact2 = projectImpact(dir, 'src/core/pricing.ts')
  check(
    'deterministic across calls',
    JSON.stringify({ ...dirty, generation: 0 }) === JSON.stringify({ ...impact2, generation: 0 }),
  )
  check('bogus target ⇒ null', projectImpact(dir, 'src/nope.ts') === null)
  const scan = collectCodeFiles(dir)
  check('code-file scan bounded + sorted', scan.files.length > 10 && [...scan.files].sort().join() === scan.files.join())

  // ── (2) work split ───────────────────────────────────────────────────────
  section('(2) advisory work split — disjoint streams, contested flagged')
  const TASK_A =
    'Add a required taxRate to PricingRules in src/core/types.ts, apply it in src/core/pricing.ts and src/core/rules.ts and src/services/checkout.ts, expose taxCents in src/api/handlers.ts'
  const TASK_B =
    'Add CSV export of daily revenue: new src/services/exportCsv.ts using src/services/reporting.ts, route it in src/api/server.ts and src/api/handlers.ts'
  const split = suggestWorkSplit(dir, [TASK_A, TASK_B])
  check('suggests', split !== null)
  if (!split) throw new Error('no split')
  check('advisory marker present', split.advisory === true)
  check('stream A owns the pricing core', split.perTask[0]!.files.includes('src/core/types.ts') && split.perTask[0]!.files.includes('src/core/pricing.ts'))
  check('stream B owns reporting/server', split.perTask[1]!.files.includes('src/services/reporting.ts') && split.perTask[1]!.files.includes('src/api/server.ts'))
  check(
    'the contested path is FLAGGED (handlers.ts in both)',
    split.contested.some(c => c.path === 'src/api/handlers.ts' && c.tasks.length === 2),
    JSON.stringify(split.contested.map(c => c.path)),
  )
  check('tests ride the streams', split.perTask[0]!.tests.includes('tests/pricing.test.ts'))
  const nonContested = split.perTask[0]!.files.filter(
    f => split.perTask[1]!.files.includes(f) && !split.contested.some(c => c.path === f),
  )
  check('every cross-stream overlap is flagged (no silent overlap)', nonContested.length === 0, nonContested.join(','))

  // ── (3) steering gates ───────────────────────────────────────────────────
  section('(3) point-of-use steering — advertised iff ON, byte-identical OFF')
  delete process.env.MERCURY_LSP
  delete process.env.MERCURY_STRUCTURE
  const onLine = steering.searchSteeringLine()
  check('search steering present when owners on', typeof onLine === 'string' && onLine.includes('LSP tool') && onLine.includes('Structure'), onLine ?? 'null')
  process.env.MERCURY_LSP = '0'
  const noLsp = steering.searchSteeringLine()
  check('OFF owner never advertised (no LSP mention)', noLsp !== null && !noLsp.includes('LSP'), noLsp ?? 'null')
  process.env.MERCURY_STRUCTURE = '0'
  check('all owners off ⇒ null (descriptions byte-identical)', steering.searchSteeringLine() === null && steering.editSteeringLine() === null)
  process.env.MERCURY_PROJECT_INTEL = '0'
  check('read steering gates on projectIntel too', steering.readSteeringLine() === null)
  delete process.env.MERCURY_LSP
  delete process.env.MERCURY_STRUCTURE
  check(
    'MERCURY_PROJECT_INTEL is the MASTER gate — =0 alone kills search+edit steering',
    steering.searchSteeringLine() === null && steering.editSteeringLine() === null,
  )
  delete process.env.MERCURY_PROJECT_INTEL
  const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
  const descOn = await GrepTool.description()
  process.env.MERCURY_LSP = '0'
  process.env.MERCURY_STRUCTURE = '0'
  const descOff = await GrepTool.description()
  delete process.env.MERCURY_LSP
  delete process.env.MERCURY_STRUCTURE
  check('Grep description carries the line when on', descOn.includes('Semantic shortcut'))
  check('Grep description drops it entirely when off', !descOff.includes('Semantic shortcut'))

  // ── (4) transcript refs ──────────────────────────────────────────────────
  section('(4) mercury://transcript — bounded concise rows, distinct states')
  const paths = await import('../../src/utils/sessionStorage/paths.js')
  const sid = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'
  const sessionFile = paths.getTranscriptPathForSession(sid)
  mkdirSync(join(sessionFile, '..'), { recursive: true })
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: 'user', message: { content: 'find the pricing owner' } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'computeOrderTotal' } }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'It lives in src/core/pricing.ts.' }] },
      }),
    ].join('\n') + '\n',
  )
  const subDir = join(sessionFile, '..', sid, 'subagents')
  mkdirSync(subDir, { recursive: true })
  writeFileSync(
    join(subDir, 'agent-test1.jsonl'),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x/README.md' } }] } }) + '\n',
  )
  const sess = await registry.resolveResource(`mercury://transcript/session/${sid}`, ctx)
  check('session transcript resolves', sess.state === 'ok', JSON.stringify(sess).slice(0, 120))
  if (sess.state === 'ok') {
    check('rows are concise + include tool one-liners', /user: find the pricing owner/.test(sess.resource.text ?? '') && /→ Grep/.test(sess.resource.text ?? ''))
    check('paged view present', sess.resource.page !== undefined)
  }
  const filtered = await registry.resolveResource(`mercury://transcript/session/${sid}?q=pricing`, ctx)
  check('q= filters rows', filtered.state === 'ok' && (filtered.resource.text ?? '').split('\n').every(l => l.toLowerCase().includes('pricing')))
  const agent = await registry.resolveResource(`mercury://transcript/agent/${sid}/agent-test1`, ctx)
  check('subagent transcript resolves', agent.state === 'ok' && /→ Read \/x\/README\.md/.test(agent.state === 'ok' ? (agent.resource.text ?? '') : ''))
  const missing = await registry.resolveResource(`mercury://transcript/session/aaaabbbb-cccc-dddd-eeee-000000000000`, ctx)
  check('unknown sid ⇒ absent (never an empty ok)', missing.state === 'absent')
  const badForm = await registry.resolveResource('mercury://transcript/bogus/x', ctx)
  check('unknown form ⇒ absent with usage note', badForm.state === 'absent')
  process.env.MERCURY_PROJECT_INTEL = '0'
  const gated = await registry.resolveResource(`mercury://transcript/session/${sid}`, ctx)
  check('=0 gates the transcript adapter (unavailable, named)', gated.state === 'unavailable')
  delete process.env.MERCURY_PROJECT_INTEL

  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  delete process.env.MERCURY_CONFIG_DIR

  console.log('\n' + '═'.repeat(76))
  if (failures > 0) {
    console.log(`❌ ${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('✅ IMPACT + SPLIT + STEERING + TRANSCRIPT PROOF PASSES')
  process.exit(0)
}

void main()
