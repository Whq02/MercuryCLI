// ============================================================================
//  primitives/canonicalStream — the backend-neutral stream spine (
// Δ3).
//
//  ONE event language for active model turns, converged at three layers:
//    · the CanonicalModelEvent vocabulary + the ModelRuntime capability
//      contract (what any future engine adapter speaks);
//    · a PURE projection from the existing Anthropic SSE shapes onto
//      canonical events (projectAnthropicStreamEvent) — the live request
//      construction and streaming core (services/providers/anthropic/streamCore.ts)
//      are UNTOUCHED: that file is the off-distribution hot core, and the
//      spine's consumers
//      adopt the adapter at their own seams;
//    · model turn = execution record — wired at the EXISTING turn-observer
//      seam (runTurnObserver), one record per turn on the bounded plane
//      ring (Δ6 — never durable, never per-token writes; the transcript
//      remains the durable record).
//
//  No account/config/model-selection surface is touched (out of scope).
// ============================================================================

import type { OwnerKey } from '../run/ownerKey.js'
import {
  getExecution,
  registerExecution,
  settleExecution,
} from './executionPlane.js'
import { isTerminalExecutionState } from './execution.js'

// ── the canonical event vocabulary ──────────────────────────────────────────

export type CanonicalModelEvent =
  | { type: 'response.started'; model?: string }
  | { type: 'text.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'tool.started'; toolUseId: string; name: string }
  | { type: 'tool.delta'; toolUseId: string; partialJson: string }
  | { type: 'tool.completed'; toolUseId: string }
  | { type: 'usage.updated'; inputTokens?: number; outputTokens?: number }
  | { type: 'response.completed'; stopReason?: string }
  | { type: 'response.failed'; error: string }
  | { type: 'response.cancelled' }

/** Typed capability extensions — model-specific features stay available,
 *  never flattened to a lowest common denominator. */
export interface ModelRuntimeCapabilities {
  reasoning: boolean
  toolUse: boolean
  usageAccounting: boolean
  /** Model-family extras ('anthropic.citations', …) — typed extension
   *  point, never a behavior switch inside the spine. */
  extensions: string[]
}

/** The contract a model engine adapter satisfies AFTER a model has been
 *  selected and configured. */
export interface ModelRuntime {
  id: string
  capabilities: ModelRuntimeCapabilities
  stream(
    request: unknown,
    signal: AbortSignal,
  ): AsyncIterable<CanonicalModelEvent>
}

// ── the Anthropic SSE projection (pure — fixture-proven) ────────────────────

interface SseLikeEvent {
  type?: string
  message?: { model?: string }
  content_block?: { type?: string; id?: string; name?: string }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string
  }
  index?: number
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string }
}

/** Per-stream projection state: SSE addresses blocks by index; canonical
 *  events address tools by id. */
export interface AnthropicProjectionState {
  blocks: Map<number, { kind: 'text' | 'thinking' | 'tool'; toolUseId?: string }>
}

export function newAnthropicProjectionState(): AnthropicProjectionState {
  return { blocks: new Map() }
}

/**
 * Project ONE Anthropic SSE event onto canonical events. Pure over
 * (event, state); unknown event types project to nothing (forward-
 * compatible — the raw stream remains authoritative for its own consumers).
 */
export function projectAnthropicStreamEvent(
  event: SseLikeEvent,
  state: AnthropicProjectionState,
): CanonicalModelEvent[] {
  switch (event.type) {
    case 'message_start':
      return [
        { type: 'response.started', ...(event.message?.model && { model: event.message.model }) },
        ...(event.usage || (event.message as { usage?: SseLikeEvent['usage'] } | undefined)?.usage
          ? [usageEvent(event.usage ?? (event.message as { usage?: SseLikeEvent['usage'] }).usage!)]
          : []),
      ]
    case 'content_block_start': {
      const idx = event.index ?? 0
      const block = event.content_block
      if (block?.type === 'tool_use' || block?.type === 'server_tool_use') {
        const toolUseId = block.id ?? `tool-${idx}`
        state.blocks.set(idx, { kind: 'tool', toolUseId })
        return [{ type: 'tool.started', toolUseId, name: block.name ?? 'unknown' }]
      }
      state.blocks.set(idx, { kind: block?.type === 'thinking' ? 'thinking' : 'text' })
      return []
    }
    case 'content_block_delta': {
      const idx = event.index ?? 0
      const block = state.blocks.get(idx)
      const delta = event.delta
      if (!delta) return []
      switch (delta.type) {
        case 'text_delta':
          return delta.text ? [{ type: 'text.delta', text: delta.text }] : []
        case 'thinking_delta':
          return delta.thinking ? [{ type: 'reasoning.delta', text: delta.thinking }] : []
        case 'input_json_delta': {
          const toolUseId = block?.kind === 'tool' ? block.toolUseId : undefined
          return toolUseId !== undefined && delta.partial_json !== undefined
            ? [{ type: 'tool.delta', toolUseId, partialJson: delta.partial_json }]
            : []
        }
        default:
          return [] // citations/signature deltas stay raw-stream concerns
      }
    }
    case 'content_block_stop': {
      const idx = event.index ?? 0
      const block = state.blocks.get(idx)
      state.blocks.delete(idx)
      return block?.kind === 'tool' && block.toolUseId !== undefined
        ? [{ type: 'tool.completed', toolUseId: block.toolUseId }]
        : []
    }
    case 'message_delta': {
      const events: CanonicalModelEvent[] = []
      if (event.usage) events.push(usageEvent(event.usage))
      if (event.delta?.stop_reason) {
        events.push({ type: 'response.completed', stopReason: event.delta.stop_reason })
      }
      return events
    }
    case 'message_stop':
      return [] // completion is announced by message_delta's stop_reason
    case 'error':
      return [{ type: 'response.failed', error: event.error?.message ?? 'stream error' }]
    default:
      return []
  }
}

function usageEvent(usage: NonNullable<SseLikeEvent['usage']>): CanonicalModelEvent {
  return {
    type: 'usage.updated',
    ...(usage.input_tokens !== undefined && { inputTokens: usage.input_tokens }),
    ...(usage.output_tokens !== undefined && { outputTokens: usage.output_tokens }),
  }
}

// ── model turn = execution (the turn-observer wiring) ───────────────────────

const TURN_EXECUTION_ID = 'model-turn'

/** Begin the turn's execution record (one per turn; the plane's generation
 *  counter is the turn sequence). A stale live record from an abnormal exit
 *  settles indeterminate first — never silently replaced. */
export function beginModelTurnExecution(owner: OwnerKey, label: string): void {
  try {
    const current = getExecution(owner, TURN_EXECUTION_ID)
    if (current && !isTerminalExecutionState(current.state)) {
      settleExecution(owner, TURN_EXECUTION_ID, 'indeterminate', {
        outcome: { reason: 'turn record still live at next turn start (abnormal exit)' },
      })
    }
    registerExecution({
      owner,
      id: TURN_EXECUTION_ID,
      kind: 'model-turn',
      label,
      lifecycle: 'owner',
      initialState: 'running',
    })
  } catch {
    /* turn projection never breaks the query loop */
  }
}

/** Settle the turn's execution record from the query exit. */
export function settleModelTurnExecution(
  owner: OwnerKey,
  outcome: { aborted: boolean; reason: string },
): void {
  try {
    const current = getExecution(owner, TURN_EXECUTION_ID)
    if (!current || isTerminalExecutionState(current.state)) return
    const state = outcome.aborted
      ? 'cancelled'
      : /error|fail/i.test(outcome.reason)
        ? 'failed'
        : 'succeeded'
    settleExecution(owner, TURN_EXECUTION_ID, state, {
      outcome: { reason: outcome.reason },
    })
  } catch {
    /* turn projection never breaks the query loop */
  }
}
