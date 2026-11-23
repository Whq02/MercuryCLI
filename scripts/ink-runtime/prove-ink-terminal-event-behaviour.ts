#!/usr/bin/env bun
import { Event } from '../../src/screen/renderer/events/event.ts'
import { TerminalEvent, type EventTarget } from '../../src/screen/renderer/events/terminal-event.ts'

const WHERE = 'TerminalEvent in src/screen/renderer/events/terminal-event.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('§1 a new terminal event')
{
  const before = performance.now()
  const event = new TerminalEvent('keydown')
  const after = performance.now()
  check('it is an Event', event instanceof Event && event instanceof TerminalEvent)
  check('it carries the type it was made with', event.type === 'keydown' && new TerminalEvent('focus').type === 'focus' && new TerminalEvent('').type === '', event.type)
  check('its time stamp is the clock reading of its making', typeof event.timeStamp === 'number' && event.timeStamp >= before && event.timeStamp <= after, `${event.timeStamp} outside ${before}..${after}; ${WHERE} stamps performance.now() when made`)
  check('it bubbles and can be cancelled', event.bubbles === true && event.cancelable === true)
  check('it has no target, no current target, and stands in the phase none', event.target === null && event.currentTarget === null && event.eventPhase === 'none', JSON.stringify([event.target, event.currentTarget, event.eventPhase]))
  check('its default is not prevented and nothing is stopped', event.defaultPrevented === false && event.isPropagationStopped() === false && event.isImmediatePropagationStopped() === false && event.didStopImmediatePropagation() === false)
  const later = new TerminalEvent('keydown')
  check('a later event has a time stamp that is not earlier', later.timeStamp >= event.timeStamp, `${later.timeStamp} < ${event.timeStamp}`)
}

console.log('§2 stopping')
{
  const event = new TerminalEvent('keydown')
  event.stopPropagation()
  check('stopPropagation stops the walk and not the handlers of the same node', event.isPropagationStopped() === true && event.isImmediatePropagationStopped() === false && event.didStopImmediatePropagation() === false, `${WHERE}: stopPropagation marks propagation only`)
  check('it does not prevent the default', event.defaultPrevented === false)
  event.stopImmediatePropagation()
  check('stopImmediatePropagation after it marks both', event.isPropagationStopped() && event.isImmediatePropagationStopped() && event.didStopImmediatePropagation())
}
{
  const event = new TerminalEvent('keydown')
  event.stopImmediatePropagation()
  check('stopImmediatePropagation alone marks both the walk and the same node', event.isPropagationStopped() === true && event.isImmediatePropagationStopped() === true && event.didStopImmediatePropagation() === true, `${WHERE}: an immediate stop is also a stop of the walk`)
  check('and still does not prevent the default', event.defaultPrevented === false)
  const other = new TerminalEvent('keydown')
  check('another event is untouched', !other.isPropagationStopped() && !other.isImmediatePropagationStopped())
}

console.log('§3 preventing the default')
{
  const event = new TerminalEvent('keydown')
  event.preventDefault()
  check('preventDefault marks the default prevented', event.defaultPrevented === true)
  check('and stops nothing', event.isPropagationStopped() === false && event.isImmediatePropagationStopped() === false)
  event.preventDefault()
  check('twice is the same as once', event.defaultPrevented === true)
  class Fixed extends TerminalEvent {
    override readonly cancelable = false
  }
  const fixed = new Fixed('focus')
  fixed.preventDefault()
  check('on a kind that cannot be cancelled, preventDefault changes nothing', fixed.cancelable === false && fixed.defaultPrevented === false, `${WHERE}: preventDefault must ask cancelable first`)
  check('such a kind can still be stopped', (fixed.stopPropagation(), fixed.isPropagationStopped()))
}

console.log('§4 what a dispatcher writes on it')
{
  const root: EventTarget = { parentNode: undefined }
  const leaf: EventTarget = { parentNode: root, _eventHandlers: {} }
  const event = new TerminalEvent('keydown')
  event.target = leaf
  event.currentTarget = root
  event.eventPhase = 'capturing'
  check('target, current target and phase hold what is written', event.target === leaf && event.currentTarget === root && event.eventPhase === 'capturing')
  event.eventPhase = 'at_target'
  event.eventPhase = 'bubbling'
  event.currentTarget = null
  check('they can be written again and cleared', event.eventPhase === 'bubbling' && event.currentTarget === null && event.target === leaf)
  const answer = event.prepareForNode(leaf) as unknown
  check('prepareForNode does nothing on the plain event', answer === undefined && event.target === leaf && event.currentTarget === null && event.eventPhase === 'bubbling' && !event.isPropagationStopped() && !event.defaultPrevented)
  class Prepared extends TerminalEvent {
    seen: EventTarget[] = []
    override prepareForNode(node: EventTarget): void {
      this.seen.push(node)
    }
  }
  const prepared = new Prepared('keydown')
  prepared.prepareForNode(root)
  prepared.prepareForNode(leaf)
  check('a kind may give prepareForNode its own work, node by node', prepared.seen.length === 2 && prepared.seen[0] === root && prepared.seen[1] === leaf)
}

if (failures > 0) {
  console.error(`\nprove-ink-terminal-event-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-ink-terminal-event-behaviour: all green')
