import { EventEmitter as NodeEventEmitter } from 'node:events'
import { notBuilt } from '../../pi/holes.js'

export class EventEmitter extends NodeEventEmitter {
  constructor() {
    notBuilt('src/ink/events/emitter.ts:7')
    super(...(notBuilt('src/ink/events/emitter.ts:7') as ConstructorParameters<typeof NodeEventEmitter>))
  }

  override emit(type: string | symbol, ...args: unknown[]): boolean {
    return notBuilt('src/ink/events/emitter.ts:12')
  }
}
