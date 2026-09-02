// ============================================================================
//  Prompt provenance — the turn bill-of-materials (sovereign-harness W3;
//  typed-contract pass).
//
//  Since the recorder consumes the TYPED behaviour contract the composer
//  actually built (src/prompt/behaviourContract.ts) instead of positional
//  group math: every composed section lands with its stable semantic ID,
//  owner, provider scope, cache class, exact chars, and a short content
//  digest. TRUE CAPTURE, not a recompute — the numbers cannot drift from what
//  the API request carried.
//
//  Shape-only by construction: names, sizes, and sha-8 digests — ZERO prompt
//  content is stored (the shape-only-digest discipline). In-memory,
//  session-scoped, never-throws (provenance must not be able to break prompt
//  composition). The PREVIOUS composition's totals are retained so the panel
//  can show a before/after delta across recompositions.
// ============================================================================

import { createHash } from 'crypto'
import type { BehaviourContract } from '../../prompt/behaviourContract.js'

export type ProvenanceSectionRecord = {
  group: string
  /** Stable semantic ID. */
  name: string
  /** Provider applicability: all · anthropic-only · openai-only. */
  scope: string
  /** The module that owns this section's text. */
  owner: string
  /** Cache stability: stable · session · turn. */
  cacheClass: string
  chars: number
  /** sha256(text) prefix — shape-only fingerprint, content never stored. */
  sha8: string
}

export type ProvenanceAbsentSection = {
  name: string
  /** Why the section is absent from this composition. */
  reason: string
}

export type ProvenanceTotals = {
  digest: string
  /** Chars/segments of the Anthropic render (what the request carried). */
  totalChars: number
  segmentCount: number
  /** Chars of the OpenAI instructions render of the same contract. */
  openaiChars: number
}

export type PromptProvenance = ProvenanceTotals & {
  recordedAt: string
  sections: ProvenanceSectionRecord[]
  /** Registry sections that computed to null (composed away) with reasons. */
  absent: ProvenanceAbsentSection[]
  /** The previous composition's totals (before/after visibility). */
  previous: ProvenanceTotals | null
}

let lastProvenance: PromptProvenance | null = null

export function recordPromptComposition(input: {
  contract: BehaviourContract
  /** The composed (Anthropic-rendered) segment list, as returned. */
  composedSegments: string[]
  /** Registry sections that resolved to null, with the absence reason. */
  absentDynamic?: ProvenanceAbsentSection[]
}): void {
  try {
    const { contract, composedSegments } = input
    const openaiChars = contract.sections
      .filter(s => s.scope !== 'anthropic-only')
      .reduce((a, s, i, arr) => a + s.text.length + (i < arr.length - 1 ? 2 : 0), 0)
    const totals: ProvenanceTotals = {
      digest: contract.digest,
      totalChars: composedSegments.reduce((a, s) => a + s.length, 0),
      segmentCount: composedSegments.length,
      openaiChars,
    }
    lastProvenance = {
      ...totals,
      recordedAt: new Date().toISOString(),
      sections: contract.sections.map(s => ({
        group: s.group,
        name: s.name,
        scope: s.scope,
        owner: s.owner,
        cacheClass: s.cacheClass,
        chars: s.text.length,
        sha8: createHash('sha256').update(s.text, 'utf8').digest('hex').slice(0, 8),
      })),
      absent: input.absentDynamic ?? [],
      previous: lastProvenance
        ? {
            digest: lastProvenance.digest,
            totalChars: lastProvenance.totalChars,
            segmentCount: lastProvenance.segmentCount,
            openaiChars: lastProvenance.openaiChars,
          }
        : null,
    }
  } catch {
    // never-throws by contract
  }
}

export function readPromptProvenance(): PromptProvenance | null {
  return lastProvenance
}

/** test-only */
export function __resetPromptProvenanceForTest(): void {
  lastProvenance = null
}
