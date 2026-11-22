import { Event } from './event.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

export type EventTarget = Unbuilt

type EventPhase = Unbuilt

export class TerminalEvent extends Event {
  readonly type: string
  readonly timeStamp: number
  readonly bubbles: boolean = unbuilt('src/ink/events/terminal-event.ts:14')
  readonly cancelable: boolean = unbuilt('src/ink/events/terminal-event.ts:15')
  target: EventTarget | null = unbuilt('src/ink/events/terminal-event.ts:16')
  currentTarget: EventTarget | null = unbuilt('src/ink/events/terminal-event.ts:17')
  eventPhase: EventPhase = unbuilt('src/ink/events/terminal-event.ts:18')
  defaultPrevented: boolean = unbuilt('src/ink/events/terminal-event.ts:19')

  private _propagationStopped: boolean = unbuilt('src/ink/events/terminal-event.ts:21')

  constructor(type: string) {
    notBuilt('src/ink/events/terminal-event.ts:23')
    super(...(notBuilt('src/ink/events/terminal-event.ts:23') as ConstructorParameters<typeof Event>))
  }

  stopPropagation(): void {
    return notBuilt('src/ink/events/terminal-event.ts:29')
  }

  override stopImmediatePropagation(): void {
    return notBuilt('src/ink/events/terminal-event.ts:33')
  }

  preventDefault(): void {
    return notBuilt('src/ink/events/terminal-event.ts:38')
  }

  isPropagationStopped(): boolean {
    return notBuilt('src/ink/events/terminal-event.ts:43')
  }

  isImmediatePropagationStopped(): boolean {
    return notBuilt('src/ink/events/terminal-event.ts:47')
  }

  prepareForNode(_node: EventTarget): void {
    return notBuilt('src/ink/events/terminal-event.ts:51')
  }
}
