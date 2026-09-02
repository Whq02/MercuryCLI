
import { createHash } from 'crypto'
import type { BehaviourContract } from '../../prompt/behaviourContract.js'

export type ProvenanceSectionRecord = {
  group: string
  name: string
  scope: string
  owner: string
  cacheClass: string
  chars: number
  sha8: string
}

export type ProvenanceAbsentSection = {
  name: string
  reason: string
}

export type ProvenanceTotals = {
  digest: string
  totalChars: number
  segmentCount: number
  openaiChars: number
}

export type PromptProvenance = ProvenanceTotals & {
  recordedAt: string
  sections: ProvenanceSectionRecord[]
  absent: ProvenanceAbsentSection[]
  previous: ProvenanceTotals | null
}

let lastProvenance: PromptProvenance | null = null

export function recordPromptComposition(input: {
  contract: BehaviourContract
  composedSegments: string[]
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
  }
}

export function readPromptProvenance(): PromptProvenance | null {
  return lastProvenance
}

export function __resetPromptProvenanceForTest(): void {
  lastProvenance = null
}
