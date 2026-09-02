#!/usr/bin/env bun
// ============================================================================
//  scripts/project-services/prove-counsel.ts — the Counsel lane,
//  proved with a DETERMINISTIC injected runner (no paid call anywhere).
//
//  Laws:
//    G. gating — off by default; manual/auto parse; off ⇒ no auto trigger
//    W. windowing — no new receipts ⇒ no-new-evidence (no runner call);
//       a review covers EXACTLY the un-reviewed window (reviewedSeqs);
//       the next review starts after it
//    P. prompt — bounded evidence (receipts + objective + verification),
//       never a transcript
//    D. dedupe — an exact/near-duplicate finding is suppressed on the next
//       review (and counted)
//    U. unavailability — a throwing runner and unparseable output both read
//       UNAVAILABLE, never block, and leave the window UN-reviewed
//    A. auto mode — fires only at the batch size, once (in-flight latch),
//       delivers a card; clean approvals stay silent
//    C. the card — approve-with-findings renders the block; clean approve
//       is one line; the coverage claim is the real window
//
//  Run:  ~/.bun/bin/bun run scripts/project-services/prove-counsel.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'vanguard-counsel-'))
delete process.env.MERCURY_COUNSEL
delete process.env.MERCURY_CHANGE_RECEIPTS

const {
  _resetCounselForTesting,
  buildReviewPrompt,
  COUNSEL_BATCH_SIZE,
  counselEnabled,
  counselMode,
  counselStatus,
  formatCounselCard,
  maybeAutoCounsel,
  runCounsel,
} = await import('../../src/services/counsel/counsel.ts')
const { observeToolTerminal } = await import('../../src/services/run/effectObserver.ts')
const { _resetChangeReceiptsForTesting } = await import(
  '../../src/services/changeTransaction/receipts.ts'
)
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — counsel proof exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()

const owner = makeOwnerKey({
  workspace: '/tmp/counsel',
  sessionId: 'counsel-session',
  lane: 'main',
} as never)

let seq = 0
function seedReceipt(path: string): void {
  observeToolTerminal({
    owner,
    toolName: 'Edit',
    toolUseId: `toolu_c${++seq}`,
    input: { file_path: path },
    ok: true,
    durationMs: 1,
    cwd: '/tmp/counsel',
    effect: {
      outcome: 'succeeded',
      operation: 'file.edit',
      changedPaths: [path],
      evidence: `edited ${path}`,
      startedAt: 1,
      completedAt: 2,
    },
  } as never)
}

function runnerReturning(json: unknown, calls?: { n: number }) {
  return async (_prompt: string) => {
    if (calls) calls.n++
    return { text: `Here is my review:\n${JSON.stringify(json)}`, model: 'fixture-model' }
  }
}

// ── G. gating ───────────────────────────────────────────────────────────────
section('G. gating')
{
  check('G1 off by default', counselMode() === 'off' && !counselEnabled())
  process.env.MERCURY_COUNSEL = 'manual'
  check('G2 manual arms', counselMode() === 'manual')
  process.env.MERCURY_COUNSEL = 'auto'
  check('G3 auto arms', counselMode() === 'auto')
  process.env.MERCURY_COUNSEL = 'off'
  check('G4 explicit off', counselMode() === 'off')
  process.env.MERCURY_COUNSEL = 'manual'
}

// ── W. windowing ────────────────────────────────────────────────────────────
section('W. review windows are exact')
{
  _resetCounselForTesting()
  _resetChangeReceiptsForTesting()
  const calls = { n: 0 }
  const empty = await runCounsel(owner, '/tmp/counsel', runnerReturning({ disposition: 'approve', findings: [] }, calls))
  check('W1 no receipts ⇒ no-new-evidence and NO runner call',
    empty.disposition === 'no-new-evidence' && calls.n === 0)

  seedReceipt('/tmp/a.ts')
  seedReceipt('/tmp/b.ts')
  const first = await runCounsel(owner, '/tmp/counsel', runnerReturning({ disposition: 'approve', findings: [] }, calls))
  check('W2 the review covers exactly the un-reviewed window',
    first.reviewedSeqs.length === 2 && first.reviewedSeqs[0] === 1 && first.reviewedSeqs[1] === 2)

  seedReceipt('/tmp/c.ts')
  const second = await runCounsel(owner, '/tmp/counsel', runnerReturning({ disposition: 'approve', findings: [] }))
  check('W3 the next review starts AFTER the last (no overlap, no gap)',
    second.reviewedSeqs.length === 1 && second.reviewedSeqs[0] === 3)
}

// ── P. bounded prompt ───────────────────────────────────────────────────────
section('P. the bounded evidence prompt')
{
  seedReceipt('/tmp/prompt-target.ts')
  const built = buildReviewPrompt(owner, '/tmp/counsel')
  check('P1 the prompt names receipts + objective + verification, never a transcript',
    built !== null &&
    built.prompt.includes('/tmp/prompt-target.ts') &&
    built.prompt.includes('objective:') &&
    built.prompt.includes('verification evidence') &&
    !built.prompt.includes('Human:') && !built.prompt.includes('Assistant:'))
}

// ── D. dedupe ───────────────────────────────────────────────────────────────
section('D. duplicate findings suppress')
{
  const finding = { summary: 'The cache key ignores the TTL variant', path: '/tmp/a.ts' }
  const r1 = await runCounsel(owner, '/tmp/counsel', runnerReturning({ disposition: 'concerns', findings: [finding] }))
  check('D1 the first occurrence surfaces', r1.findings.length === 1)
  seedReceipt('/tmp/d.ts')
  const r2 = await runCounsel(
    owner,
    '/tmp/counsel',
    runnerReturning({
      disposition: 'concerns',
      findings: [
        { summary: 'the   CACHE key ignores the ttl variant', path: '/tmp/a.ts' },
        { summary: 'a genuinely new concern about error handling' },
      ],
    }),
  )
  check('D2 a near-duplicate is dropped and counted; the new one surfaces',
    r2.findings.length === 1 &&
    r2.findings[0]!.summary.includes('genuinely new') &&
    r2.duplicatesDropped === 1)
}

// ── U. unavailability never blocks ──────────────────────────────────────────
section('U. unavailability honesty')
{
  seedReceipt('/tmp/e.ts')
  const cursorBefore = counselStatus(owner).pendingReceipts
  const thrown = await runCounsel(owner, '/tmp/counsel', async () => {
    throw new Error('model unreachable')
  })
  check('U1 a throwing runner reads UNAVAILABLE with the cause',
    thrown.disposition === 'unavailable' && thrown.missingEvidence[0]?.includes('model unreachable') === true)
  check('U2 the window stays UN-reviewed (no false coverage claim)',
    counselStatus(owner).pendingReceipts === cursorBefore)
  const garbage = await runCounsel(owner, '/tmp/counsel', async () => ({ text: 'sounds good to me!' }))
  check('U3 unparseable output reads UNAVAILABLE too', garbage.disposition === 'unavailable')
  check('U4 still un-reviewed', counselStatus(owner).pendingReceipts === cursorBefore)
}

// ── A. auto mode — through the REAL observer + delivery path ────────────────
section('A. the auto trigger (real observer, real pending-notification queue)')
{
  _resetCounselForTesting()
  _resetChangeReceiptsForTesting()
  const { _setAutoRunnerForTesting } = await import('../../src/services/counsel/counsel.ts')
  const { dequeueAll } = await import('../../src/utils/messageQueueManager.ts')
  dequeueAll()
  process.env.MERCURY_COUNSEL = 'auto'
  _setAutoRunnerForTesting(
    runnerReturning({ disposition: 'concerns', findings: [{ summary: 'auto finding one' }] }),
  )

  for (let i = 1; i < COUNSEL_BATCH_SIZE; i++) seedReceipt(`/tmp/auto-${i}.ts`)
  await new Promise(r => setTimeout(r, 80))
  check('A1 below the batch size nothing delivers', dequeueAll().length === 0)

  seedReceipt(`/tmp/auto-${COUNSEL_BATCH_SIZE}.ts`)
  // The observer fired and latched — an immediate explicit trigger refuses.
  check('A2 the in-flight latch refuses a concurrent trigger',
    maybeAutoCounsel(owner, '/tmp/counsel',
      runnerReturning({ disposition: 'concerns', findings: [{ summary: 'x' }] }),
      () => {}) === false)
  await new Promise(r => setTimeout(r, 150))
  const cards = dequeueAll()
  check('A3 the card lands ONCE on the pending-notification queue (next turn boundary)',
    cards.length === 1 &&
    String((cards[0] as { value?: string }).value).includes('auto finding one'),
    JSON.stringify(cards.map(c => String((c as { value?: string }).value).slice(0, 60))))

  // Clean approvals stay silent.
  _setAutoRunnerForTesting(runnerReturning({ disposition: 'approve', findings: [] }))
  for (let i = 0; i < COUNSEL_BATCH_SIZE; i++) seedReceipt(`/tmp/clean-${i}.ts`)
  await new Promise(r => setTimeout(r, 150))
  check('A4 a clean approve delivers NOTHING (empty notes disappear)', dequeueAll().length === 0)

  process.env.MERCURY_COUNSEL = 'off'
  for (let i = 0; i < COUNSEL_BATCH_SIZE; i++) seedReceipt(`/tmp/off-${i}.ts`)
  await new Promise(r => setTimeout(r, 80))
  check('A5 mode off ⇒ the observer never triggers', dequeueAll().length === 0)
  _setAutoRunnerForTesting(null)
  process.env.MERCURY_COUNSEL = 'manual'
}

// ── C. the card ─────────────────────────────────────────────────────────────
section('C. the compact card')
{
  _resetCounselForTesting()
  _resetChangeReceiptsForTesting()
  seedReceipt('/tmp/card.ts')
  const clean = await runCounsel(owner, '/tmp/counsel', runnerReturning({ disposition: 'approve', findings: [] }))
  const cleanCard = formatCounselCard(clean)
  check('C1 a clean approve is ONE line with the real coverage claim',
    !cleanCard.includes('\n') && cleanCard.includes('APPROVE') && cleanCard.includes('reviewed receipts'))
  seedReceipt('/tmp/card2.ts')
  const concerns = await runCounsel(
    owner,
    '/tmp/counsel',
    runnerReturning({
      disposition: 'block',
      findings: [{ summary: 'the write path loses errors', path: '/tmp/card2.ts' }],
      missingEvidence: ['no test covers the failure branch'],
      recommendedNextAction: 'add the failing-branch test before finishing',
    }),
  )
  const card = formatCounselCard(concerns)
  check('C2 a blocking card carries findings + missing evidence + next action',
    card.includes('<counsel disposition="block">') &&
    card.includes('loses errors') &&
    card.includes('missing evidence') &&
    card.includes('add the failing-branch test'))
}

// ── verdict ─────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ counsel: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ counsel: every law holds')
