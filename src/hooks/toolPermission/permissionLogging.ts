// Permission decision recording — the React-free bookkeeping half of the
// tool-permission flow. Every approve/reject lands here as one record on the
// tool-use context; the analytics fan-out this module once owned was removed
// with the telemetry estate, so recording is ALL it does.

/** Approval provenance for an accepted permission request. */
export type PermissionApprovalSource =
  | { type: 'hook'; permanent?: boolean }
  | { type: 'user'; permanent: boolean }
  | { type: 'classifier' }

/** Rejection provenance for a refused permission request. */
export type PermissionRejectionSource =
  | { type: 'hook' }
  | { type: 'userAbort' }
  | { type: 'userReject'; hasFeedback: boolean }

/**
 * One accept/reject with its provenance. The literal `config` marks a
 * rule-engine decision (an allow rule re-check, a deny rule) rather than an
 * actor.
 */
export type PermissionDecisionArgs =
  | { decision: 'accept'; source: PermissionApprovalSource | 'config' }
  | { decision: 'reject'; source: PermissionRejectionSource | 'config' }

/** The stored per-decision record. */
export type RecordedPermissionDecision = {
  source: FlattenedDecisionSource
  decision: 'accept' | 'reject'
  timestampMs: number
}

// The flattened labels are stable vocabulary — recorded decisions are read
// downstream, so the strings must not drift.
export type FlattenedDecisionSource =
  | 'hook'
  | 'user_permanent'
  | 'user_temporary'
  | 'user_abort'
  | 'user_reject'
  | 'unknown'
  | 'config'

/**
 * The slice of the tool-use context this module touches: the TOOL-USE
 * CONTEXT's own `toolDecisions` map (the field the tool execution layer reads
 * by tool-use id and deletes after execution — L4). The map is created
 * lazily on first write ON THAT CONTEXT; nothing else on it is read.
 */
export type PermissionLogContext = {
  toolUseID: string
  toolUseContext: { toolDecisions?: Map<string, unknown> }
}

function flattenSource(
  source: PermissionApprovalSource | PermissionRejectionSource | 'config',
): FlattenedDecisionSource {
  if (source === 'config') return 'config'
  switch (source.type) {
    case 'hook':
      return 'hook'
    case 'user':
      return source.permanent ? 'user_permanent' : 'user_temporary'
    case 'userAbort':
      return 'user_abort'
    case 'userReject':
      return 'user_reject'
    default:
      return 'unknown'
  }
}

/**
 * Record one permission decision on the tool-use context, keyed by tool-use
 * id: the flattened source label, the verdict, and a wall-clock timestamp.
 * The third parameter is accepted for call-shape compatibility and ignored —
 * the timing fan-out it fed does not exist.
 */
export function logPermissionDecision(
  ctx: PermissionLogContext,
  args: PermissionDecisionArgs,
  _promptStartMs?: number,
): void {
  if (!ctx.toolUseContext.toolDecisions) {
    ctx.toolUseContext.toolDecisions = new Map()
  }
  const record: RecordedPermissionDecision = {
    source: flattenSource(args.source),
    decision: args.decision,
    timestampMs: Date.now(),
  }
  ctx.toolUseContext.toolDecisions.set(ctx.toolUseID, record)
}
