// resources/adapters/evidence — canonical evidence records
// Owner-relative; records
// REFERENCE authoritative domain storage (receipts, executions, artifacts)
// — children are refs, never embedded proof bodies.

import {
  evidenceById,
  evidenceEvicted,
  evidenceFor,
} from '../../primitives/evidencePlane.js'
import type { EvidenceRecord } from '../../primitives/evidence.js'
import {
  formatRef,
  type ParsedRef,
  type ResourceAdapter,
  type ResourceChild,
  type ResourceContext,
  type ResourceResult,
} from '../contracts.js'

function describeEvidence(r: EvidenceRecord): string {
  return `${r.kind} · ${r.origin} · ${r.state} — ${r.claim.slice(0, 120)}`
}

export const evidenceAdapter: ResourceAdapter = {
  kind: 'evidence',
  describe:
    'canonical evidence — observed changes/checks/settlements with source refs (mercury://evidence/<id>)',
  async resolve(ref: ParsedRef, ctx: ResourceContext): Promise<ResourceResult> {
    if (ref.id === '') {
      const children = await this.list!(ctx)
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://evidence',
          kind: 'evidence',
          title: 'evidence',
          summary: `${children.length} record(s) this conversation`,
          mutable: false,
          children,
        },
      }
    }
    const record = evidenceById(ctx.owner, ref.id)
    if (!record) {
      if (evidenceEvicted(ctx.owner, ref.id)) {
        return {
          state: 'expired',
          note: `evidence '${ref.id}' existed but bounded retention dropped it — the claim is no longer backed`,
        }
      }
      return { state: 'absent', note: `no evidence '${ref.id}' for this conversation` }
    }
    return {
      state: 'ok',
      resource: {
        ref: ref.canonical,
        kind: 'evidence',
        title: `${record.kind} evidence (${record.state})`,
        summary: describeEvidence(record),
        version: `t${record.observedAt}`,
        mutable: false,
        children: record.refs.slice(0, 12).map(r => ({
          ref: r,
          title: 'source',
          summary: `source → ${r}`,
        })),
        structured: {
          id: record.id,
          kind: record.kind,
          origin: record.origin,
          state: record.state,
          claim: record.claim,
          observedAt: record.observedAt,
          details: record.details ?? null,
        },
      },
    }
  },
  async list(ctx: ResourceContext): Promise<ResourceChild[]> {
    return evidenceFor(ctx.owner)
      .slice(-50)
      .reverse()
      .map(r => ({
        ref: formatRef('evidence', r.id),
        title: `${r.kind} (${r.origin})`,
        summary: describeEvidence(r),
      }))
  },
}
