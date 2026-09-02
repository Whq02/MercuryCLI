
export type PermissionApprovalSource =
  | { type: 'hook'; permanent?: boolean }
  | { type: 'user'; permanent: boolean }
  | { type: 'classifier' }

export type PermissionRejectionSource =
  | { type: 'hook' }
  | { type: 'userAbort' }
  | { type: 'userReject'; hasFeedback: boolean }

export type PermissionDecisionArgs =
  | { decision: 'accept'; source: PermissionApprovalSource | 'config' }
  | { decision: 'reject'; source: PermissionRejectionSource | 'config' }

export type RecordedPermissionDecision = {
  source: FlattenedDecisionSource
  decision: 'accept' | 'reject'
  timestampMs: number
}

export type FlattenedDecisionSource =
  | 'hook'
  | 'user_permanent'
  | 'user_temporary'
  | 'user_abort'
  | 'user_reject'
  | 'unknown'
  | 'config'

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
