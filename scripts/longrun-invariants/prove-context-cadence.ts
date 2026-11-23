#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { capsuleShouldEmit, priorCapsuleFromTranscript } = await import(
  '../../src/engine/attachments/contextCapsule.js'
)
type Message = import('../../src/engine/message-shapes/message.js').Message

console.log('\n=== B. capsule cadence: churn never reprints, entries do ===')
{
  const sem = 'sem-aaaa'
  const prior = { digest: 'd1', refs: ['mercury://file/a.ts', 'mercury://file/b.ts', 'mercury://file/README.md'], semDigest: sem }

  check('exact identity never re-emits (the capsule dedup, pinned)', capsuleShouldEmit(prior, { digest: 'd1', semDigest: sem, refs: prior.refs }) === false, 'capsuleShouldEmit in src/engine/attachments/contextCapsule.ts must not re-emit when the digest is unchanged')
  check(
    'removals-only recency churn never re-emits (the AVS "+README −recon" reprint)',
    capsuleShouldEmit(prior, { digest: 'd2', semDigest: sem, refs: ['mercury://file/a.ts'] }) === false,
    'capsuleShouldEmit in src/engine/attachments/contextCapsule.ts must not re-emit when refs were only removed and semDigest is unchanged',
  )
  check(
    'a RELEVANT ENTRY (new ref) re-emits',
    capsuleShouldEmit(prior, { digest: 'd3', semDigest: sem, refs: ['mercury://file/a.ts', 'mercury://file/new.ts'] }) === true,
    'capsuleShouldEmit in src/engine/attachments/contextCapsule.ts must re-emit when a ref is new',
  )
  check(
    'a SEMANTIC change (task/goal/marks) re-emits even with fewer refs',
    capsuleShouldEmit(prior, { digest: 'd4', semDigest: 'sem-bbbb', refs: ['mercury://file/a.ts'] }) === true,
    'capsuleShouldEmit in src/engine/attachments/contextCapsule.ts must re-emit when semDigest changes',
  )
  check('no prior (first attach / post-compaction) emits', capsuleShouldEmit(null, { digest: 'd5', semDigest: sem, refs: [] }) === true, 'capsuleShouldEmit in src/engine/attachments/contextCapsule.ts must emit when there is no prior capsule')
  check(
    'a PRE-LAW prior (no semDigest) falls back to exact-digest dedup (changed ⇒ emit)',
    capsuleShouldEmit({ digest: 'd1', refs: prior.refs }, { digest: 'd2', semDigest: sem, refs: ['mercury://file/a.ts'] }) === true,
    'capsuleShouldEmit in src/engine/attachments/contextCapsule.ts must fall back to exact-digest comparison when the prior has no semDigest',
  )

  const window: Message[] = [
    {
      type: 'attachment',
      attachment: { type: 'context_capsule', digest: 'd1', refs: prior.refs, semDigest: sem },
    } as unknown as Message,
  ]
  const read = priorCapsuleFromTranscript(window)
  check('priorCapsuleFromTranscript round-trips digest+refs+semDigest', read?.digest === 'd1' && read?.semDigest === sem && read?.refs.length === 3, 'priorCapsuleFromTranscript in src/engine/attachments/contextCapsule.ts must read digest, refs and semDigest back from the context_capsule attachment')
}

console.log(`\n${failures === 0 ? '✅ ALL PASS — unchanged identity adds zero payload' : `❌ ${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
