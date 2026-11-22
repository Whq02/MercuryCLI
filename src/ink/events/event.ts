import { notBuilt, unbuilt } from '../../pi/holes.js'

export class Event {
  private halted: boolean = unbuilt('src/ink/events/event.ts:2')

  didStopImmediatePropagation(): boolean {
    return notBuilt('src/ink/events/event.ts:4')
  }

  stopImmediatePropagation(): void {
    return notBuilt('src/ink/events/event.ts:8')
  }
}
