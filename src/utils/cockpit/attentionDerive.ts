
export const ATTENTION_KINDS = new Set<string>([
  'tool_permission_request',
  'clarifying_question',
])

export interface NeedsInputItem {
  status?: string
  kind?: string
  sessionId?: string
  [extra: string]: unknown
}

export interface AttentionCount {
  count: number
  permissions: number
  questions: number
  unknown: boolean
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

const UNKNOWN: AttentionCount = { count: 0, permissions: 0, questions: 0, unknown: true }
const EMPTY: AttentionCount = { count: 0, permissions: 0, questions: 0, unknown: false }

export function deriveAttentionCount(
  items: readonly NeedsInputItem[] | null | undefined,
): AttentionCount {
  if (!Array.isArray(items)) return UNKNOWN
  if (items.length === 0) return EMPTY

  const permSessions = new Set<string>()
  const qSessions = new Set<string>()
  let anonPerms = 0
  let anonQuestions = 0

  for (const it of items) {
    if (!isObj(it) || it.status !== 'pending') continue
    const kind = isStr(it.kind) ? it.kind : ''
    if (!ATTENTION_KINDS.has(kind)) continue
    const sid = isStr(it.sessionId) ? it.sessionId : null
    if (kind === 'tool_permission_request') {
      if (sid) permSessions.add(sid)
      else anonPerms += 1
    } else {
      if (sid) qSessions.add(sid)
      else anonQuestions += 1
    }
  }

  const permissions = permSessions.size + anonPerms
  const questions = qSessions.size + anonQuestions
  return { count: permissions + questions, permissions, questions, unknown: false }
}

export function reconcileAttention(
  prev: AttentionCount | null | undefined,
  next: AttentionCount,
): AttentionCount {
  if (next.unknown && prev && !prev.unknown) return prev
  return next
}
