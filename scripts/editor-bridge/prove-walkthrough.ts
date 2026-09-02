#!/usr/bin/env bun
// ============================================================================
//  scripts/editor-bridge/prove-walkthrough.ts — PROOF: the evidence-backed
//  walkthrough assembler:
//
//    (1) anti-fabrication by construction — EVERY factual claim the pure
//        composer emits carries ≥1 evidence ref; the input shape has no
//        transcript field to spin prose from.
//    (2) origin honesty — a 'declared' check renders as DECLARED only and
//        auto-joins the limitations; stale verification and failed
//        journeys auto-join too.
//    (3) determinism — identical inputs compose byte-identical markdown +
//        claims (journey 12).
//    (4) observed-only changed areas — grouped from receipt facts with the
//        receipt refs attached; an empty ring reads honestly empty.
//    (5) the live mint — createWalkthroughArtifact against a quiet owner
//        produces a valid ready-for-review walkthrough artifact whose
//        evidence refs are the deduped union of its claims' refs.
//    (6) the structured visual journey — a REAL runJourney record (file
//        inspects, loopback-free) composes into a 'journey' artifact with
//        per-step results + attached before/after capture refs; a missing
//        journey refuses by name.
//
//  Run:  ~/.bun/bin/bun run scripts/editor-bridge/prove-walkthrough.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

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

const reviewRoot = mkdtempSync(join(tmpdir(), 'mosaic-walk-review-'))
const fixtures = mkdtempSync(join(tmpdir(), 'mosaic-walk-fixtures-'))
process.env.MERCURY_REVIEW_ARTIFACTS_DIR = reviewRoot
process.on('exit', () => {
  for (const dir of [reviewRoot, fixtures]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

const { composeWalkthroughBody, createWalkthroughArtifact, createVisualJourneyArtifact } =
  await import('../../src/services/walkthrough/assembleWalkthrough.js')
const { readReviewArtifactState } = await import('../../src/utils/artifacts/reviewStore.js')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.js')

const richInputs = {
  title: 'Ship the parser fix',
  objective: 'fix the tokenizer edge case',
  runPhase: 'settling',
  runLifecycle: 'active',
  receipts: [
    { id: 'rcpt-1', toolName: 'Edit', changedPaths: ['src/parser.ts', 'src/lexer.ts'] },
    { id: 'rcpt-2', toolName: 'Write', changedPaths: ['scripts/prove-parser.ts'] },
  ],
  checks: [
    { id: 'ev-1', claim: 'parser prover', origin: 'observed' as const, state: 'present', refs: ['mercury://run/current'] },
    { id: 'ev-2', claim: 'lint clean', origin: 'declared' as const, state: 'present', refs: [] },
  ],
  verification: { state: 'stale', detail: 'tree moved after the last green' },
  gitFacts: { branch: 'main', head: 'abcdef1234567890', dirtyPaths: 3 },
  journeys: [
    {
      id: 'jy-x',
      title: 'smoke the CLI',
      state: 'failed',
      steps: [
        { id: '0', title: 'boot', state: 'passed' },
        { id: '1', title: 'ask', state: 'failed' },
      ],
    },
  ],
  visualRefs: ['mercury://artifact/shots/before'],
  reviewDecisions: ['plan v2 accepted by the operator'],
  integrationStatus: null,
  limitations: ['no Windows coverage on this machine'],
}

section('(1) anti-fabrication — every claim carries evidence')
const composed = composeWalkthroughBody(richInputs)
{
  check('claims minted', composed.claims.length >= 8, String(composed.claims.length))
  check('EVERY claim has ≥1 evidence ref', composed.claims.every(c => c.evidenceRefs.length > 0))
  check(
    'receipt-backed changed areas link the receipts',
    composed.claims.some(c => c.text.includes('src:') && c.evidenceRefs.includes('mercury://receipt/rcpt-1')),
  )
}

section('(2) origin honesty + auto limitations')
{
  check('declared check labeled DECLARED only', composed.markdown.includes('lint clean: present — DECLARED only'))
  check('declared-only joins limitations', composed.markdown.includes('1 check(s) are DECLARED only'))
  check('stale verification joins limitations', composed.markdown.includes("verification is 'stale'"))
  check('failed journey joins limitations', composed.markdown.includes("journey 'smoke the CLI' FAILED"))
  check('caller limitation kept', composed.markdown.includes('no Windows coverage'))
}

section('(2b) verify-wave fixes — stated prose marked · absolute-path bucketing')
{
  check('operator-stated decisions are MARKED, never evidence-shaped', composed.markdown.includes('## Review decisions (operator-stated)') && composed.markdown.includes('- [stated] plan v2 accepted'))
  check('caller limitations carry the [stated] marker', composed.markdown.includes('- [stated] no Windows coverage'))
  check('stated prose mints NO claim', composed.claims.every(c => !c.text.includes('[stated]')))
  const absInputs = { ...richInputs, receipts: [{ id: 'rcpt-abs', toolName: 'Edit', changedPaths: ['/Users/x/repo/src/parser.ts', '/Users/x/repo/src/lexer.ts'] }] }
  const absComposed = composeWalkthroughBody(absInputs)
  check('absolute paths bucket by the final directory pair', absComposed.markdown.includes('- repo/src: 2 observed change(s)'), absComposed.markdown.split('## Changed areas')[1]?.slice(0, 120) ?? '')
}

section('(3) determinism')
{
  const again = composeWalkthroughBody(richInputs)
  check('byte-identical markdown', again.markdown === composed.markdown)
  check('identical claims', JSON.stringify(again.claims) === JSON.stringify(composed.claims))
}

section('(4) honest empty — a quiet owner fabricates nothing')
{
  const empty = composeWalkthroughBody({
    ...richInputs,
    receipts: [],
    checks: [],
    journeys: [],
    visualRefs: [],
    reviewDecisions: [],
    verification: null,
    gitFacts: null,
    limitations: [],
    objective: null,
    runPhase: null,
    runLifecycle: null,
  })
  check('empty ring reads honestly empty', empty.markdown.includes('no observed file changes'))
  check('no checks reads honestly', empty.markdown.includes('no recorded checks'))
  check('no fabricated claims', empty.claims.length === 0)
}

section('(5) the live mint')
{
  const minted = createWalkthroughArtifact({
    owner: processMainOwner(),
    sessionId: 'sess-walk',
    cwd: process.cwd(),
    title: 'live walkthrough',
    treeDigest: 'tree-live',
  })
  check('mint ok', minted.ok, minted.ok ? '' : minted.reason)
  if (minted.ok) {
    const state = readReviewArtifactState(minted.value.id)!
    check('artifact is a ready-for-review walkthrough', state.kind === 'walkthrough' && state.statuses[1] === 'ready-for-review')
    const body = state.versions[0]!.body
    check('body carries markdown + claims', body.kind === 'walkthrough' && Array.isArray(body.claims))
    if (body.kind === 'walkthrough') {
      const claimRefs = new Set((body.claims ?? []).flatMap(c => c.evidenceRefs))
      check(
        'artifact evidenceRefs ≡ deduped claim refs',
        state.versions[0]!.evidenceRefs.every(r => claimRefs.has(r)) &&
          claimRefs.size === state.versions[0]!.evidenceRefs.length,
      )
    }
  }
}

section('(6) the structured visual journey from a REAL journey record')
{
  const { runJourney } = await import('../../src/services/journeys/runner.js')
  const probe = join(fixtures, 'probe.txt')
  writeFileSync(probe, 'the probe content\n')
  const owner = processMainOwner()
  const record = await runJourney(
    {
      objective: 'inspect the fixture pair',
      steps: [
        { kind: 'file.inspect', path: probe, expect: { exists: true, contains: 'probe' }, label: 'probe exists' },
        { kind: 'file.inspect', path: join(fixtures, 'missing.txt'), expect: { exists: false }, label: 'missing absent' },
      ],
    },
    { owner, root: fixtures, sessionId: 'sess-walk' },
  )
  check('journey ran to a verdict', record.state === 'succeeded', record.state)

  const artifact = createVisualJourneyArtifact({
    owner,
    journeyId: record.id,
    sessionId: 'sess-walk',
    cwd: fixtures,
    captures: [
      { stepId: '0', beforeRef: 'mercury://artifact/shots/s0-before', afterRef: 'mercury://artifact/shots/s0-after', delta: 'no console errors' },
    ],
  })
  check('journey artifact minted', artifact.ok, artifact.ok ? '' : artifact.reason)
  if (artifact.ok) {
    const state = readReviewArtifactState(artifact.value.id)!
    const body = state.versions[0]!.body
    check('journey body kind', body.kind === 'journey')
    if (body.kind === 'journey') {
      check('ordered steps with results', body.steps.length === 2 && body.steps[0]!.result?.startsWith('passed') === true)
      check(
        'captures attached to the right step',
        body.steps[0]!.beforeRef === 'mercury://artifact/shots/s0-before' && body.steps[0]!.delta === 'no console errors',
      )
      check('uncaptured step carries no fabricated frames', body.steps[1]!.beforeRef === undefined)
    }
    check('evidence links the journey record', state.versions[0]!.evidenceRefs[0] === `mercury://journey/${record.id}`)
  }

  const missing = createVisualJourneyArtifact({ owner, journeyId: 'jy-nope', sessionId: 'sess-walk' })
  check('missing journey refuses by name', !missing.ok && missing.reason.includes('jy-nope'))
}

console.log('')
if (failures > 0) {
  console.error(`✗ ${failures} failure(s)`)
  process.exit(1)
}
console.log('✓ walkthrough proofs green')
