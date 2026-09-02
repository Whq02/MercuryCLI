#!/usr/bin/env bun
// ============================================================================
//  scripts/longrun-invariants/prove-context-cadence.ts — item 7: capsule
//  context emits ONLY on semantic change or a relevant entry; unchanged
//  identity adds ZERO payload. Replays the AVS field shape (the working-set
//  capsule reprinting on incidental recency churn) against the PRODUCTION
//  emission law (capsuleShouldEmit — the one owner; the producer calls the
//  same function). The room-context half retired with the multiplayer
//  estate's attachment.
//
//  Run:  ~/.bun/bin/bun run scripts/longrun-invariants/prove-context-cadence.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { capsuleShouldEmit, priorCapsuleFromTranscript } = await import(
  '../../src/utils/attachments/contextCapsule.js'
)
type Message = import('../../src/types/message.js').Message

// ── B. the working-set capsule churn law ──
console.log('\n=== B. capsule cadence: churn never reprints, entries do ===')
{
  const sem = 'sem-aaaa'
  const prior = { digest: 'd1', refs: ['mercury://file/a.ts', 'mercury://file/b.ts', 'mercury://file/README.md'], semDigest: sem }

  check('exact identity never re-emits (the capsule dedup, pinned)', capsuleShouldEmit(prior, { digest: 'd1', semDigest: sem, refs: prior.refs }) === false)
  check(
    'removals-only recency churn never re-emits (the AVS "+README −recon" reprint)',
    capsuleShouldEmit(prior, { digest: 'd2', semDigest: sem, refs: ['mercury://file/a.ts'] }) === false,
  )
  check(
    'a RELEVANT ENTRY (new ref) re-emits',
    capsuleShouldEmit(prior, { digest: 'd3', semDigest: sem, refs: ['mercury://file/a.ts', 'mercury://file/new.ts'] }) === true,
  )
  check(
    'a SEMANTIC change (task/goal/marks) re-emits even with fewer refs',
    capsuleShouldEmit(prior, { digest: 'd4', semDigest: 'sem-bbbb', refs: ['mercury://file/a.ts'] }) === true,
  )
  check('no prior (first attach / post-compaction) emits', capsuleShouldEmit(null, { digest: 'd5', semDigest: sem, refs: [] }) === true)
  check(
    'a PRE-LAW prior (no semDigest) falls back to exact-digest dedup (changed ⇒ emit)',
    capsuleShouldEmit({ digest: 'd1', refs: prior.refs }, { digest: 'd2', semDigest: sem, refs: ['mercury://file/a.ts'] }) === true,
  )

  // The transcript reader round-trips semDigest for the law.
  const window: Message[] = [
    {
      type: 'attachment',
      attachment: { type: 'context_capsule', digest: 'd1', refs: prior.refs, semDigest: sem },
    } as unknown as Message,
  ]
  const read = priorCapsuleFromTranscript(window)
  check('priorCapsuleFromTranscript round-trips digest+refs+semDigest', read?.digest === 'd1' && read?.semDigest === sem && read?.refs.length === 3)
}

console.log(`\n${failures === 0 ? '✅ ALL PASS — unchanged identity adds zero payload' : `❌ ${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
