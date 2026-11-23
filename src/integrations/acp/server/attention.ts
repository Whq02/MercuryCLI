import { registerWorkbenchAttentionGatherer, workbenchFactsOf } from '../../../screen/workbench/attentionBridge.js'
import {
  bucketItems,
  ATTENTION_BUCKETS,
  foldAttention,
  emptyAttentionState,
} from '../../../screen/attention/contracts.js'
import type { AttentionItem, AttentionState } from '../../../screen/attention/contracts.js'
import { foldRelations, emptyRelationState } from '../../../screen/attention/relations.js'
import type { RelationState } from '../../../screen/attention/relations.js'

registerWorkbenchAttentionGatherer()

interface AttentionWireItem {
  subjectId: string
  owner: string
  sourceEventId: string
  reasonCode: string
  reasonLabel: string
  sinceMs: number
  atMs: number
  urgency: number
  title?: string
}

interface AttentionWire {
  v: 1
  version: number
  atMs: number
  needsYou: number
  buckets: Partial<Record<string, AttentionWireItem[]>>
  edges: Array<{
    kind: string
    from: string
    to: string
    owner: string
    sourceEventId: string
  }>
}

export function attentionWire(view: {
  v: 1
  version: number
  atMs: number
  attention: AttentionState
  relations: RelationState
  needsYou: number
}): AttentionWire {
  const buckets: Partial<Record<string, AttentionWireItem[]>> = {}
  for (const bucket of ATTENTION_BUCKETS) {
    const items = bucketItems(view.attention, bucket)
    if (items.length === 0) continue
    buckets[bucket] = items.map((i: AttentionItem) => ({
      subjectId: i.subjectId,
      owner: i.owner,
      sourceEventId: i.sourceEventId,
      reasonCode: i.reasonCode,
      reasonLabel: i.reasonLabel,
      sinceMs: i.sinceMs,
      atMs: i.atMs,
      urgency: i.urgency,
      ...(i.title !== undefined && { title: i.title }),
    }))
  }
  return {
    v: 1,
    version: view.version,
    atMs: view.atMs,
    needsYou: view.needsYou,
    buckets,
    edges: [...view.relations.edges.values()].map(e => ({
      kind: e.kind,
      from: e.from,
      to: e.to,
      owner: e.owner,
      sourceEventId: e.sourceEventId,
    })),
  }
}

export function attentionWireFromSnapshot(
  snap: NonNullable<Parameters<typeof workbenchFactsOf>[0]>,
): AttentionWire {
  const facts = workbenchFactsOf(snap)
  const attention = foldAttention(emptyAttentionState(), facts.attention)
  const relations = foldRelations(emptyRelationState(), facts.relations)
  return attentionWire({
    v: 1,
    version: snap.refreshedAt,
    atMs: snap.refreshedAt,
    attention,
    relations,
    needsYou: bucketItems(attention, 'needs-you').length,
  })
}
