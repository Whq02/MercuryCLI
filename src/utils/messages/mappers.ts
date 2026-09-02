// ============================================================================
//  THE MERCURY STREAM PROJECTION — the named mapping between the internal
//  message model and Mercury's own stream-json wire vocabulary, both
//  directions (the compat dialect is retired;
//  this projection IS the one dialect). Which fields survive each direction
//  IS the wire contract: external stream-json consumers match it field for
//  field.
// ============================================================================

import { randomUUID, type UUID } from 'node:crypto'
import stripAnsi from 'strip-ansi'
import { getSessionId } from '../../bootstrap/state.js'
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKRateLimitInfo,
} from '../../entrypoints/agentSdkTypes.js'
import type { ClaudeAILimits } from '../../services/claudeAiLimits.js'
import {
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../../tools/ExitPlanModeTool/constants.js'
import { getPlan } from '../plans.js'
import type {
  AssistantMessage,
  CompactMetadata,
  Message,
  SystemCompactBoundaryMessage,
  SystemModelTransitionMessage,
  UserMessage,
} from '../../types/message.js'
import type { DeepImmutable } from '../../types/utils.js'
import { SYNTHETIC_MODEL } from './factories.js'

// ── compact metadata (snake ↔ camel) ────────────────────────────────────────

export function toSDKCompactMetadata(meta: CompactMetadata): {
  trigger: CompactMetadata['trigger']
  pre_tokens: number
  preserved_segment?: { head_uuid: string; anchor_uuid: string; tail_uuid: string }
} {
  return {
    trigger: meta.trigger,
    pre_tokens: meta.preTokens,
    ...(meta.preservedSegment
      ? {
          preserved_segment: {
            head_uuid: meta.preservedSegment.headUuid,
            anchor_uuid: meta.preservedSegment.anchorUuid,
            tail_uuid: meta.preservedSegment.tailUuid,
          },
        }
      : {}),
  }
}

export function fromSDKCompactMetadata(meta: {
  trigger: CompactMetadata['trigger']
  pre_tokens: number
  preserved_segment?: { head_uuid: string; anchor_uuid: string; tail_uuid: string }
}): CompactMetadata {
  return {
    trigger: meta.trigger,
    preTokens: meta.pre_tokens,
    ...(meta.preserved_segment
      ? {
          preservedSegment: {
            headUuid: meta.preserved_segment.head_uuid as UUID,
            anchorUuid: meta.preserved_segment.anchor_uuid as UUID,
            tailUuid: meta.preserved_segment.tail_uuid as UUID,
          },
        }
      : {}),
  }
}

// ── rate limits ─────────────────────────────────────────────────────────────

/** No limits yields nothing; otherwise the status plus every optional field
 *  that is defined — internal-only fields are stripped. */
export function toSDKRateLimitInfo(
  limits: ClaudeAILimits | undefined,
): SDKRateLimitInfo | undefined {
  if (!limits) return undefined
  const out: Record<string, unknown> = { status: limits.status }
  if (limits.resetsAt !== undefined) out.resetsAt = limits.resetsAt
  if (limits.rateLimitType !== undefined) out.rateLimitType = limits.rateLimitType
  if (limits.utilization !== undefined) out.utilization = limits.utilization
  if (limits.overageStatus !== undefined) out.overageStatus = limits.overageStatus
  if (limits.overageResetsAt !== undefined) out.overageResetsAt = limits.overageResetsAt
  if (limits.overageDisabledReason !== undefined) {
    out.overageDisabledReason = limits.overageDisabledReason
  }
  if (limits.isUsingOverage !== undefined) out.isUsingOverage = limits.isUsingOverage
  if (limits.surpassedThreshold !== undefined) out.surpassedThreshold = limits.surpassedThreshold
  return out as SDKRateLimitInfo
}

// ── SDK → internal ──────────────────────────────────────────────────────────

export function toInternalMessages(messages: readonly DeepImmutable<SDKMessage>[]): Message[] {
  const out: Message[] = []
  for (const row of messages as readonly unknown[]) {
    const sdk = row as {
      type?: string
      subtype?: string
      message?: unknown
      uuid?: string
      timestamp?: string
      isSynthetic?: boolean
      compact_metadata?: Parameters<typeof fromSDKCompactMetadata>[0]
      transition?: {
        previous: string | null
        requested: string | null
        applied: string | null
        resolution: 'applied' | 'cancelled-pending'
        boundary: 'idle' | 'turn-boundary' | 'autopilot-tool'
        cross_provider: boolean
        cache_disposition: string
      }
    }
    if (sdk.type === 'assistant' && sdk.message) {
      out.push({
        type: 'assistant',
        message: sdk.message as AssistantMessage['message'],
        uuid: (sdk.uuid ?? randomUUID()) as UUID,
        requestId: undefined,
        timestamp: new Date().toISOString(),
      } as AssistantMessage)
      continue
    }
    if (sdk.type === 'user' && sdk.message) {
      out.push({
        type: 'user',
        message: sdk.message as UserMessage['message'],
        uuid: (sdk.uuid ?? randomUUID()) as UUID,
        timestamp: sdk.timestamp ?? new Date().toISOString(),
        ...(sdk.isSynthetic ? { isMeta: true as const } : {}),
      } as UserMessage)
      continue
    }
    if (sdk.type === 'system' && sdk.subtype === 'compact_boundary' && sdk.compact_metadata) {
      out.push({
        type: 'system',
        subtype: 'compact_boundary',
        level: 'info',
        content: 'Conversation compacted',
        compactMetadata: fromSDKCompactMetadata(sdk.compact_metadata),
        uuid: (sdk.uuid ?? randomUUID()) as UUID,
        timestamp: new Date().toISOString(),
      } as SystemCompactBoundaryMessage)
      continue
    }
    if (sdk.type === 'system' && sdk.subtype === 'model_transition' && sdk.transition) {
      // The settlement receipt with camel-case fields and an explicitly
      // false meta flag.
      out.push({
        type: 'system',
        subtype: 'model_transition',
        previous: sdk.transition.previous,
        requested: sdk.transition.requested,
        applied: sdk.transition.applied,
        resolution: sdk.transition.resolution,
        boundary: sdk.transition.boundary,
        crossProvider: sdk.transition.cross_provider,
        cacheDisposition: sdk.transition.cache_disposition,
        uuid: (sdk.uuid ?? randomUUID()) as UUID,
        timestamp: sdk.timestamp ?? new Date().toISOString(),
        isMeta: false,
      } as SystemModelTransitionMessage)
      continue
    }
    // Every other row is dropped.
  }
  return out
}

// ── local command output → synthetic SDK assistant ──────────────────────────

/**
 * Escape sequences stripped, then the FIRST stdout wrapper and the FIRST
 * stderr wrapper unwrapped (a second wrapper of the same kind survives as
 * literal tags), trimmed, and built into a complete synthetic assistant
 * message — emitted as an `assistant` row because the local-command subtype
 * is internal-only, outside the stream dialect's public vocabulary.
 */
export function localCommandOutputToSDKAssistantMessage(
  content: string,
  uuid: UUID,
): SDKAssistantMessage {
  const stripped = stripAnsi(content)
  const unwrapped = stripped
    .replace(new RegExp(`<${LOCAL_COMMAND_STDOUT_TAG}>([\\s\\S]*?)</${LOCAL_COMMAND_STDOUT_TAG}>`), '$1')
    .replace(new RegExp(`<${LOCAL_COMMAND_STDERR_TAG}>([\\s\\S]*?)</${LOCAL_COMMAND_STDERR_TAG}>`), '$1')
    .trim()
  return {
    type: 'assistant',
    message: {
      id: `msg_${randomUUID()}`,
      type: 'message',
      model: SYNTHETIC_MODEL,
      role: 'assistant',
      content: [{ type: 'text', text: unwrapped }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    session_id: getSessionId(),
    uuid,
  } as unknown as SDKAssistantMessage
}

// ── assistant normalisation for the SDK ─────────────────────────────────────

/** Tool-use blocks for the second-generation exit-plan tool get the current
 *  plan text injected into their input (that tool reads the plan from a
 *  file; SDK consumers expect it inline — read at call time, the one impure
 *  row). Every other block passes through by reference. */
function normalizeAssistantContentForSdk(
  message: AssistantMessage['message'],
): AssistantMessage['message'] {
  const content = message.content
  if (!Array.isArray(content)) return message
  let changed = false
  const mapped = content.map(block => {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: string }).type === 'tool_use' &&
      (block as { name?: string }).name === EXIT_PLAN_MODE_V2_TOOL_NAME
    ) {
      changed = true
      const input = (block as { input?: Record<string, unknown> }).input
      return {
        ...(block as Record<string, unknown>),
        input: { ...(input ?? {}), plan: getPlan() ?? '' },
      }
    }
    return block
  })
  if (!changed) return message
  return { ...message, content: mapped } as AssistantMessage['message']
}

// ── internal → SDK ──────────────────────────────────────────────────────────

export function toSDKMessages(messages: Message[]): SDKMessage[] {
  const sessionId = getSessionId()
  const out: SDKMessage[] = []
  for (const msg of messages) {
    if (msg.type === 'assistant') {
      out.push({
        type: 'assistant',
        message: normalizeAssistantContentForSdk(msg.message),
        session_id: sessionId,
        parent_tool_use_id: null,
        uuid: msg.uuid,
        error: msg.error,
      } as unknown as SDKMessage)
      continue
    }
    if (msg.type === 'user') {
      const user = msg as UserMessage
      out.push({
        type: 'user',
        message: user.message,
        session_id: sessionId,
        parent_tool_use_id: null,
        uuid: user.uuid,
        timestamp: user.timestamp,
        // The synthetic flag is the disjunction of "is meta" and "is
        // visible in transcript only" — emitted ONLY when true; a plain user
        // message carries no isSynthetic key at all.
        ...(Boolean(user.isMeta) || Boolean(user.isVisibleInTranscriptOnly) ? { isSynthetic: true } : {}),
        // The structured tool output rides iff the field is PRESENT — an
        // undefined value is excluded, a null value is included. It is the
        // full result object, on the wire's catch-all, so remote viewers
        // can read fields the model never sees.
        ...(user.toolUseResult !== undefined ? { tool_use_result: user.toolUseResult } : {}),
      } as unknown as SDKMessage)
      continue
    }
    if (msg.type === 'system') {
      if (msg.subtype === 'compact_boundary' && msg.compactMetadata) {
        out.push({
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: toSDKCompactMetadata(msg.compactMetadata),
          uuid: msg.uuid,
          session_id: sessionId,
        } as unknown as SDKMessage)
        continue
      }
      if (msg.subtype === 'model_transition') {
        const t = msg as SystemModelTransitionMessage
        out.push({
          type: 'system',
          subtype: 'model_transition',
          uuid: t.uuid,
          session_id: sessionId,
          transition: {
            previous: t.previous,
            requested: t.requested,
            applied: t.applied,
            resolution: t.resolution,
            boundary: t.boundary,
            cross_provider: t.crossProvider,
            cache_disposition: t.cacheDisposition,
          },
        } as unknown as SDKMessage)
        continue
      }
      if (msg.subtype === 'local_command') {
        // Only when the content actually contains a stdout or stderr tag —
        // the same subtype also carries command INPUT metadata, which must
        // never leak to the remote UI.
        const content = (msg as { content?: string }).content ?? ''
        if (
          content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
          content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`)
        ) {
          out.push(localCommandOutputToSDKAssistantMessage(content, msg.uuid) as SDKMessage)
        }
        continue
      }
      continue
    }
    // Everything else is dropped.
  }
  return out
}
