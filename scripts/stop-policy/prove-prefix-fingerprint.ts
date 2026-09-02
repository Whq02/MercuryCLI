#!/usr/bin/env bun
// ============================================================================
//  scripts/stop-policy/prove-prefix-fingerprint.ts —.1 (
//  E05-E07): the cacheable-prefix instrument.
//
//    E05 — compatible fresh compositions fingerprint IDENTICALLY (20×, and
//          through the REAL buildSystemPromptBlocks serialization).
//    E06 — dynamic-tail changes leave the prefix fingerprint unchanged
//          (by construction: the instrument never reads messages — pinned).
//    E07 — a genuine static change moves the RIGHT segment digest and the
//          diff names it.
//    Safety — the fingerprint never carries prompt text.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { fingerprintCacheablePrefix, diffPrefixFingerprints } = await import(
  '../../src/services/api/prefixFingerprint.ts'
)
const { buildSystemPromptBlocks } = await import('../../src/services/providers/anthropic/cacheAndUsage.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const src = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')

const SYSTEM = ['You are Mercury.', 'Doctrine block.', 'Env block with stable facts.']

section('E05 — compatible fresh compositions fingerprint identically')
{
  const prints = Array.from({ length: 20 }, () => {
    const blocks = buildSystemPromptBlocks(SYSTEM as never, true)
    return fingerprintCacheablePrefix({ systemBlocks: blocks as never, tools: [{ name: 'Read' }, { name: 'Bash' }] })
  })
  const first = prints[0]!
  check(
    'E05: 20 fresh serializations ⇒ ONE fingerprint',
    prints.every(p => p.fullPrefixDigest === first.fullPrefixDigest && p.domainDigest === first.domainDigest),
  )
  check('E05: marker positions are part of the identity', first.markerPositions.length > 0)
  const realBlocks = buildSystemPromptBlocks(SYSTEM as never, true)
  check('E05: per-segment sizes/digests enumerate the REAL serialization (tools + every block)', first.segments.length === (realBlocks as unknown[]).length + 1 && first.totalBytes > 0)
}

section('E06 — dynamic tails cannot move the prefix fingerprint')
{
  const blocks = buildSystemPromptBlocks(SYSTEM as never, true)
  const a = fingerprintCacheablePrefix({ systemBlocks: blocks as never, tools: [] })
  const b = fingerprintCacheablePrefix({ systemBlocks: blocks as never, tools: [] })
  check('E06: identical prefixes fingerprint identically whatever the turn later appends', a.fullPrefixDigest === b.fullPrefixDigest)
  const owner = src('src/services/api/prefixFingerprint.ts')
  check('E06: the instrument NEVER reads messages (no messages input, pinned)', !/input\.messages|messages\s*[:?]/.test(owner))
}

section('E07 — a genuine static change moves the RIGHT segment')
{
  const blocks = buildSystemPromptBlocks(SYSTEM as never, true)
  const changed = buildSystemPromptBlocks(
    [SYSTEM[0]!, 'Doctrine block CHANGED.', SYSTEM[2]!] as never,
    true,
  )
  const a = fingerprintCacheablePrefix({ systemBlocks: blocks as never, tools: [{ name: 'Read' }] })
  const b = fingerprintCacheablePrefix({ systemBlocks: changed as never, tools: [{ name: 'Read' }] })
  check('E07: the full digest moves', a.fullPrefixDigest !== b.fullPrefixDigest)
  // Self-consistent: find which segments ACTUALLY differ under the real
  // serialization, then the diff must name exactly that one.
  const movedIdx = a.segments
    .map((s, i) => (b.segments[i] && s.digest !== b.segments[i]!.digest ? i : -1))
    .filter(i => i >= 0)
  check('E07: exactly ONE segment moved (the changed doctrine block)', movedIdx.length === 1, `moved: ${movedIdx.join(',')}`)
  const d = diffPrefixFingerprints(a, b)
  check('E07: the diff names the RIGHT segment', d.identical === false && d.firstDivergence?.index === movedIdx[0], JSON.stringify(d.firstDivergence))
}

section('SAFETY — never prompt text')
{
  const blocks = buildSystemPromptBlocks(['SECRET-MARKER-TEXT'] as never, true)
  const p = fingerprintCacheablePrefix({ systemBlocks: blocks as never, tools: [] })
  check('the fingerprint payload carries digests, never the text', !JSON.stringify(p).includes('SECRET-MARKER-TEXT'))
}

if (failures > 0) {
  console.error(`\nprove-prefix-fingerprint: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-prefix-fingerprint: all green')
