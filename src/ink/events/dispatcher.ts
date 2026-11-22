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

type Handler = (event: TerminalEvent) => void
type Listener = { node: EventTarget; phase: TerminalEvent['eventPhase']; handler: Handler }

function isHandler(value: unknown): value is Handler {
  return typeof value === 'function'
}

function collectListeners(target: EventTarget, event: TerminalEvent): Listener[] {
  if (!Object.hasOwn(HANDLER_FOR_EVENT, event.type)) return []
  const slots = HANDLER_FOR_EVENT[event.type]!
  const capturing: Listener[] = []
  const bubbling: Listener[] = []
  for (let node: EventTarget | undefined = target; node; node = node.parentNode) {
    const atTarget = node === target
    const onCapture = slots.capture === undefined ? undefined : node._eventHandlers?.[slots.capture]
    if (isHandler(onCapture)) capturing.unshift({ node, phase: atTarget ? 'at_target' : 'capturing', handler: onCapture })
    const onBubble = node._eventHandlers?.[slots.bubble]
    if (isHandler(onBubble) && (atTarget || event.bubbles)) bubbling.push({ node, phase: atTarget ? 'at_target' : 'bubbling', handler: onBubble })
  }
  return [...capturing, ...bubbling]
}

export class Dispatcher {
  currentEvent: TerminalEvent | null = null
  currentUpdatePriority: number = NoEventPriority
  discreteUpdates: (<T>(fn: () => T) => T) | null = null

  resolveEventPriority(): number {
    if (this.currentUpdatePriority !== NoEventPriority) return this.currentUpdatePriority
    const type = this.currentEvent?.type
    if (type === undefined) return DefaultEventPriority
    if (DISCRETE_EVENTS.has(type)) return DiscreteEventPriority
    if (CONTINUOUS_EVENTS.has(type)) return ContinuousEventPriority
    return DefaultEventPriority
  }

  dispatch(target: EventTarget, event: TerminalEvent): boolean {
    const outerEvent = this.currentEvent
    this.currentEvent = event
    try {
      event.target = target
      for (const listener of collectListeners(target, event)) {
        if (event.isImmediatePropagationStopped()) break
        if (event.isPropagationStopped() && listener.node !== event.currentTarget) break
        event.currentTarget = listener.node
        event.eventPhase = listener.phase
        event.prepareForNode(listener.node)
        try {
          listener.handler(event)
        } catch (error) {
          logError(error)
        }
      }
      event.eventPhase = 'none'
      event.currentTarget = null
      return !event.defaultPrevented
    } finally {
      this.currentEvent = outerEvent
    }
  }

  dispatchDiscrete(target: EventTarget, event: TerminalEvent): boolean {
    if (!this.discreteUpdates) return this.dispatch(target, event)
    return this.discreteUpdates(() => this.dispatch(target, event))
  }

  dispatchContinuous(target: EventTarget, event: TerminalEvent): boolean {
    const heldPriority = this.currentUpdatePriority
    this.currentUpdatePriority = ContinuousEventPriority
    try {
      return this.dispatch(target, event)
    } finally {
      this.currentUpdatePriority = heldPriority
    }
  }
}
