// ============================================================================
//  effectObserver — the ONE seam through which a terminal tool call reaches
//  every run-state consumer.
//
//  toolExecution's single-fire chokepoint (traceOnce) calls
//  observeToolTerminal exactly once per executed call with the owner, tool
//  id, input, duration, and — when the tool provided one — its typed
//  ToolEffect. Consumers:
//    · verification state — a typed effect is judged by its OUTCOME + actual
//      changedPaths (succeeded+paths ⇒ mutation; failed/no-change/
//      indeterminate ⇒ never a mutation). A tool WITHOUT an effect keeps the
//      legacy input-shape path (observeCompletedToolCall).
//    · run coordinator — subscribes here for tool started/effected
//      run events.
//  Never throws; observation must never break tool execution.
// ============================================================================

import type { ChangeIntentProjection, ToolEffect } from '../../Tool.js'
import {
  markMutation,
  observeCompletedToolCall,
  verifyEvidenceEnabled,
} from '../../utils/verification/verificationState.js'
import type { OwnerKey } from './ownerKey.js'

export interface ToolTerminalEvent {
  owner: OwnerKey
  toolName: string
  toolUseId: string | undefined
  input: unknown
  /** Did the call resolve (and, when an effect exists, not report failure)? */
  ok: boolean
  durationMs: number | undefined
  effect: ToolEffect | undefined
  /** the tool-provided typed intent projection, when one exists
   *  (receipts prefer it over input-shape extraction). */
  intentProjection?: ChangeIntentProjection
  cwd: string
  /** 'launch' = this call merely STARTED a background task
   *  (shell tools returning a backgroundTaskId) — its ok/code are
   *  presentation, not outcome; verification evidence must not mint from it.
   *  Absent/'terminal' = the historical meaning: the call's result IS the
   *  outcome. */
  lifecycle?: 'terminal' | 'launch'
}

type EffectSubscriber = (event: ToolTerminalEvent) => void

const subscribers = new Set<EffectSubscriber>()

/** Subscribe to terminal tool events (the slice-2 run coordinator's feed). */
export function subscribeToolTerminal(cb: EffectSubscriber): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

export interface ToolStartEvent {
  owner: OwnerKey
  toolName: string
  toolUseId: string | undefined
}

type StartSubscriber = (event: ToolStartEvent) => void
const startSubscribers = new Set<StartSubscriber>()

/** Subscribe to tool-start events (run uncertainty markers). */
export function subscribeToolStart(cb: StartSubscriber): () => void {
  startSubscribers.add(cb)
  return () => {
    startSubscribers.delete(cb)
  }
}

/** The universal chokepoint's pre-execution observation (post-permission,
 *  immediately before tool.call). Never throws. */
export function observeToolStart(event: ToolStartEvent): void {
  for (const cb of startSubscribers) {
    try {
      cb(event)
    } catch {
      /* subscriber errors never break the writer */
    }
  }
}

/** TEST-ONLY: current subscriber counts (leak proofs). */
export function _toolTerminalSubscriberCountForTesting(): number {
  return subscribers.size + startSubscribers.size
}

/**
 * The single terminal observation. Called exactly once per EXECUTED tool
 * call (pre-execution refusals — kills, denials — never reach it).
 */
export function observeToolTerminal(event: ToolTerminalEvent): void {
  try {
    if (event.effect) {
      // Typed path: mutation truth comes from the effect, never the input.
      // The changed paths ride along.
      if (
        verifyEvidenceEnabled() &&
        event.effect.outcome === 'succeeded' &&
        event.effect.changedPaths.length > 0
      ) {
        markMutation(event.owner, event.effect.changedPaths, event.cwd, {
          digestReceipted:
            typeof (event.effect.details as { artifactDigest?: unknown } | undefined)
              ?.artifactDigest === 'string',
        })
      }
      // failed / no-change / indeterminate: no mutation. Bash-style evidence
      // classification does not apply to effect-bearing tools today.
    } else {
      // Legacy path: input-shape classification (Edit/Write/…, Bash evidence).
      observeCompletedToolCall(
        event.toolName,
        event.input,
        event.ok,
        event.cwd,
        event.owner,
        event.lifecycle,
      )
    }
  } catch {
    /* observation must never break tool execution */
  }
  for (const cb of subscribers) {
    try {
      cb(event)
    } catch {
      /* subscriber errors never break the writer */
    }
  }
}
