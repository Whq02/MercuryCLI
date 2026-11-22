import {
  ContinuousEventPriority,
  DefaultEventPriority,
  DiscreteEventPriority,
  NoEventPriority,
} from 'react-reconciler/constants.js'
import { logError } from '../../utils/log.js'
import { HANDLER_FOR_EVENT } from './event-handlers.js'
import type { EventTarget, TerminalEvent } from './terminal-event.js'
import { notBuilt, unbuilt } from '../../pi/holes.js'

const DISCRETE_EVENTS = new Set(['keydown', 'keyup', 'click', 'focus', 'blur', 'paste'])
const CONTINUOUS_EVENTS = new Set(['resize', 'scroll', 'mousemove'])

export class Dispatcher {
  currentEvent: TerminalEvent | null = unbuilt('src/ink/events/dispatcher.ts:61')
  currentUpdatePriority: number = unbuilt('src/ink/events/dispatcher.ts:62')
  discreteUpdates: (<T>(fn: () => T) => T) | null = unbuilt('src/ink/events/dispatcher.ts:63')

  resolveEventPriority(): number {
    return notBuilt('src/ink/events/dispatcher.ts:65')
  }

  dispatch(target: EventTarget, event: TerminalEvent): boolean {
    return notBuilt('src/ink/events/dispatcher.ts:78')
  }

  dispatchDiscrete(target: EventTarget, event: TerminalEvent): boolean {
    return notBuilt('src/ink/events/dispatcher.ts:106')
  }

  dispatchContinuous(target: EventTarget, event: TerminalEvent): boolean {
    return notBuilt('src/ink/events/dispatcher.ts:113')
  }
}
