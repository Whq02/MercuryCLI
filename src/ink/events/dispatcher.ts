// Capture/bubble dispatch + React event-priority resolution. Listener order
// is root capture … target capture, target bubble … root bubble; stopping
// propagation still runs the remaining handlers on the SAME node, stopping
// immediate propagation stops everything; a throwing handler is logged and
// the remaining handlers still run.

import {
  ContinuousEventPriority,
  DefaultEventPriority,
  DiscreteEventPriority,
  NoEventPriority,
} from 'react-reconciler/constants.js'
import { logError } from '../../utils/log.js'
import { HANDLER_FOR_EVENT } from './event-handlers.js'
import type { EventTarget, TerminalEvent } from './terminal-event.js'

const DISCRETE_EVENTS = new Set(['keydown', 'keyup', 'click', 'focus', 'blur', 'paste'])
const CONTINUOUS_EVENTS = new Set(['resize', 'scroll', 'mousemove'])

type CollectedListener = {
  node: EventTarget
  handler: (event: TerminalEvent) => void
  phase: 'capturing' | 'at_target' | 'bubbling'
}

function collectListeners(
  target: EventTarget,
  event: TerminalEvent,
): CollectedListener[] {
  const mapping = HANDLER_FOR_EVENT[event.type]
  if (!mapping) return []
  const captures: CollectedListener[] = []
  const bubbles: CollectedListener[] = []
  let node: EventTarget | undefined = target
  while (node) {
    const handlers = node._eventHandlers
    if (handlers) {
      const phase = node === target ? 'at_target' : undefined
      if (mapping.capture) {
        const capture = handlers[mapping.capture]
        if (typeof capture === 'function') {
          // Prepended, so captures end up root-first.
          captures.unshift({
            node,
            handler: capture as (event: TerminalEvent) => void,
            phase: phase ?? 'capturing',
          })
        }
      }
      // A bubble handler is collected only when the event bubbles OR the
      // node IS the target.
      if (event.bubbles || node === target) {
        const bubble = handlers[mapping.bubble]
        if (typeof bubble === 'function') {
          bubbles.push({
            node,
            handler: bubble as (event: TerminalEvent) => void,
            phase: phase ?? 'bubbling',
          })
        }
      }
    }
    node = node.parentNode
  }
  return [...captures, ...bubbles]
}

export class Dispatcher {
  currentEvent: TerminalEvent | null = null
  currentUpdatePriority: number = NoEventPriority
  /** Wired by the reconciler after construction — this is what breaks the
   *  module cycle between the dispatcher and the reconciler. */
  discreteUpdates: (<T>(fn: () => T) => T) | null = null

  resolveEventPriority(): number {
    if (this.currentUpdatePriority !== NoEventPriority) {
      return this.currentUpdatePriority
    }
    const event = this.currentEvent
    if (event) {
      if (DISCRETE_EVENTS.has(event.type)) return DiscreteEventPriority
      if (CONTINUOUS_EVENTS.has(event.type)) return ContinuousEventPriority
      return DefaultEventPriority
    }
    return DefaultEventPriority
  }

  /** Returns whether the default was NOT prevented. */
  dispatch(target: EventTarget, event: TerminalEvent): boolean {
    const previousEvent = this.currentEvent
    this.currentEvent = event
    try {
      event.target = target
      const queue = collectListeners(target, event)
      let previousNode: EventTarget | null = null
      for (const entry of queue) {
        if (event.isImmediatePropagationStopped()) break
        if (event.isPropagationStopped() && entry.node !== previousNode) break
        event.eventPhase = entry.phase
        event.currentTarget = entry.node
        event.prepareForNode(entry.node)
        try {
          entry.handler(event)
        } catch (error) {
          logError(error)
        }
        previousNode = entry.node
      }
      event.eventPhase = 'none'
      event.currentTarget = null
      return !event.defaultPrevented
    } finally {
      this.currentEvent = previousEvent
    }
  }

  /** For user-initiated events: keyboard, click, focus, paste. */
  dispatchDiscrete(target: EventTarget, event: TerminalEvent): boolean {
    if (this.discreteUpdates) {
      return this.discreteUpdates(() => this.dispatch(target, event))
    }
    return this.dispatch(target, event)
  }

  /** For high-frequency events: resize, scroll, mouse move. */
  dispatchContinuous(target: EventTarget, event: TerminalEvent): boolean {
    const previousPriority = this.currentUpdatePriority
    this.currentUpdatePriority = ContinuousEventPriority
    try {
      return this.dispatch(target, event)
    } finally {
      this.currentUpdatePriority = previousPriority
    }
  }
}
