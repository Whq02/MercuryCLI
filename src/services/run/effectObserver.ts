
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
  ok: boolean
  durationMs: number | undefined
  effect: ToolEffect | undefined
  intentProjection?: ChangeIntentProjection
  cwd: string
  lifecycle?: 'terminal' | 'launch'
}

type EffectSubscriber = (event: ToolTerminalEvent) => void

const subscribers = new Set<EffectSubscriber>()

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

export function subscribeToolStart(cb: StartSubscriber): () => void {
  startSubscribers.add(cb)
  return () => {
    startSubscribers.delete(cb)
  }
}

export function observeToolStart(event: ToolStartEvent): void {
  for (const cb of startSubscribers) {
    try {
      cb(event)
    } catch {
    }
  }
}

export function _toolTerminalSubscriberCountForTesting(): number {
  return subscribers.size + startSubscribers.size
}

export function observeToolTerminal(event: ToolTerminalEvent): void {
  try {
    if (event.effect) {
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
    } else {
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
  }
  for (const cb of subscribers) {
    try {
      cb(event)
    } catch {
    }
  }
}
