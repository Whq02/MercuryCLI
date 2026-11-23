#!/usr/bin/env bun
import { Event } from '../../src/screen/renderer/events/event.ts'

const WHERE = 'Event in src/screen/renderer/events/event.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('§1 one event')
{
  const event = new Event()
  check('a new event has not been stopped', event.didStopImmediatePropagation() === false, `${WHERE}: a fresh event answers false`)
  check('asking does not stop it', event.didStopImmediatePropagation() === false)
  const answer = event.stopImmediatePropagation() as unknown
  check('stopImmediatePropagation answers nothing', answer === undefined, String(answer))
  check('after it the event says it was stopped', event.didStopImmediatePropagation() === true, `${WHERE}: a stopped event answers true`)
  event.stopImmediatePropagation()
  check('stopping twice leaves it stopped', event.didStopImmediatePropagation() === true)
  check('nothing brings it back: it still says stopped when asked again', event.didStopImmediatePropagation() === true)
}

console.log('§2 events are apart from one another')
{
  const first = new Event()
  const second = new Event()
  first.stopImmediatePropagation()
  check('stopping one event does not stop another', first.didStopImmediatePropagation() && !second.didStopImmediatePropagation(), `${WHERE}: the mark belongs to the one event`)
}

console.log('§3 a kind of event built on it')
{
  class Tagged extends Event {
    constructor(readonly tag: string) {
      super()
    }
  }
  const tagged = new Tagged('probe')
  check('it is an Event and keeps its own members', tagged instanceof Event && tagged.tag === 'probe')
  check('it starts not stopped and can be stopped the same way', !tagged.didStopImmediatePropagation() && (tagged.stopImmediatePropagation(), tagged.didStopImmediatePropagation()))
  class Counting extends Event {
    stops = 0
    override stopImmediatePropagation(): void {
      this.stops++
      super.stopImmediatePropagation()
    }
  }
  const counting = new Counting()
  counting.stopImmediatePropagation()
  check('a kind that adds to stopImmediatePropagation still ends up stopped', counting.stops === 1 && counting.didStopImmediatePropagation())
}

if (failures > 0) {
  console.error(`\nprove-ink-event-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-ink-event-behaviour: all green')
