
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { Event } from './event.js'
import { InputEvent, inputConsumedThroughSeq } from './input-event.js'

export class EventEmitter extends NodeEventEmitter {
  constructor() {
    super()
    this.setMaxListeners(0)
  }

  override emit(type: string | symbol, ...args: unknown[]): boolean {
    if (type === 'error') {
      return super.emit(type, ...args)
    }
    const listeners = this.rawListeners(type)
    if (listeners.length === 0) return false
    const first = args[0]
    for (const listener of listeners) {
      if (first instanceof InputEvent && first.seq <= inputConsumedThroughSeq()) {
        break
      }
      ;(listener as (...a: unknown[]) => void).apply(this, args)
      if (first instanceof Event && first.didStopImmediatePropagation()) {
        break
      }
    }
    return true
  }
}
