import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import type { ToolAsk } from '../childSession.js'
import type { ElicitationAnswer, ElicitationRequestParams, PermissionAnswer } from '../../../daemon/runner-wire/methods.js'

export function permissionAskWire(
  ask: { toolUseId?: string; toolName: string; input: unknown; suggestions?: unknown[]; title?: string; description?: string },
  requestId: string | number,
  acpSessionId: string,
): {
  sessionId: string
  toolCall: { toolCallId: string; title: string; status: 'pending'; rawInput: unknown }
  options: { optionId: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' }[]
} {
  return {
    sessionId: acpSessionId,
    toolCall: {
      toolCallId: ask.toolUseId || `ask-${requestId}`,
      title: ask.title || ask.description || ask.toolName,
      status: 'pending',
      rawInput: ask.input,
    },
    options: [
      { optionId: 'allow', name: `Allow ${ask.toolName}`, kind: 'allow_once' },
      ...(ask.suggestions !== undefined && ask.suggestions.length > 0 ? [{ optionId: 'allow_always', name: `Always allow ${ask.toolName}`, kind: 'allow_always' as const }] : []),
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  }
}

export function permissionAllowedOf(result: unknown): boolean {
  const o = (result as { outcome?: { outcome?: unknown; optionId?: unknown } } | null)?.outcome
  return o?.outcome === 'selected' && (o?.optionId === 'allow' || o?.optionId === 'allow_always')
}

export function permissionAnswerOf(result: unknown, ask: Pick<ToolAsk, 'suggestions'>): PermissionAnswer {
  const o = (result as { outcome?: { outcome?: unknown; optionId?: unknown } } | null)?.outcome
  if (!permissionAllowedOf(result)) return { outcome: 'deny', message: 'denied by the ACP client' }
  if (o?.optionId === 'allow_always' && ask.suggestions !== undefined && ask.suggestions.length > 0) return { outcome: 'allow', rules: ask.suggestions }
  return { outcome: 'allow' }
}

export function elicitationWire(params: ElicitationRequestParams, acpSessionId: string): CreateElicitationRequest {
  if (params.mode === 'url') {
    return { sessionId: acpSessionId, mode: 'url', message: params.message, url: params.url ?? '', elicitationId: params.elicitation_id ?? '' }
  }
  return { sessionId: acpSessionId, mode: 'form', message: params.message, requestedSchema: params.schema ?? { type: 'object', properties: {} } }
}

export function elicitationAnswerOf(result: unknown): ElicitationAnswer {
  const r = result as { action?: unknown; content?: unknown } | null
  if (r?.action === 'accept') return { action: 'accept', ...(r.content !== null && typeof r.content === 'object' ? { content: r.content as Record<string, unknown> } : {}) }
  if (r?.action === 'decline') return { action: 'decline' }
  return { action: 'cancel' }
}
