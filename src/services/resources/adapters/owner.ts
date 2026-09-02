// resources/adapters/owner — the Owner primitive as a resource
// The empty id answers for the CURRENT
// conversation owner; a full canonical OwnerKey id answers for that owner.
// Children are owner-relative refs ONLY for the current owner — a foreign
// owner's records read as bounded structured state (its executions resolve
// against ITS owner, which the ref grammar keeps owner-relative by design).

import { describeOwner, ownerEquals } from '../../primitives/owner.js'
import { isOwnerKey, type OwnerKey } from '../../run/ownerKey.js'
import { listExecutions } from '../../primitives/executionPlane.js'
import { receiptCursor } from '../../changeTransaction/receipts.js'
import { verificationSummary } from '../../../utils/verification/verificationState.js'
import {
  formatRef,
  type ParsedRef,
  type ResourceAdapter,
  type ResourceContext,
  type ResourceResult,
} from '../contracts.js'

function ownerResource(key: OwnerKey, ctx: ResourceContext): ResourceResult {
  const descriptor = describeOwner(key)
  const isCurrent = ownerEquals(key, ctx.owner)
  const executions = listExecutions(key, { limit: 32 })
  const verification = verificationSummary(ctx.cwd, { skipDigest: true, owner: key })
  return {
    state: 'ok',
    resource: {
      ref: formatRef('owner', key),
      kind: 'owner',
      title: `${descriptor.scope} owner${isCurrent ? ' (current)' : ''}`,
      summary:
        `scope ${descriptor.scope} · workspace ${descriptor.workspace || '(machine)'}` +
        (descriptor.sessionId ? ` · session ${descriptor.sessionId}` : '') +
        (descriptor.lane ? ` · lane ${descriptor.lane}` : '') +
        ` · ${executions.length} execution(s) · receipts@${receiptCursor(key)} · verify ${verification.state}`,
      mutable: false,
      ...(isCurrent && {
        children: executions.map(r => ({
          ref: formatRef('execution', r.spec.id),
          title: r.spec.label,
          summary: `${r.spec.kind} · gen ${r.generation} · ${r.state}`,
        })),
      }),
      structured: {
        scope: descriptor.scope,
        workspace: descriptor.workspace,
        sessionId: descriptor.sessionId ?? null,
        lane: descriptor.lane ?? null,
        parent: descriptor.parent ?? null,
        executions: executions.map(r => ({
          id: r.spec.id,
          kind: r.spec.kind,
          state: r.state,
          generation: r.generation,
        })),
        receiptCursor: receiptCursor(key),
        verification: verification.state,
      },
    },
  }
}

export const ownerAdapter: ResourceAdapter = {
  kind: 'owner',
  describe:
    'owner identity + its executions/receipts/verification (mercury://owner = the current owner)',
  async resolve(ref: ParsedRef, ctx: ResourceContext): Promise<ResourceResult> {
    if (ref.id === '') return ownerResource(ctx.owner, ctx)
    if (!isOwnerKey(ref.id)) {
      return {
        state: 'absent',
        note: `'${ref.id}' is not a canonical owner key — use mercury://owner for the current owner`,
      }
    }
    return ownerResource(ref.id, ctx)
  },
}
