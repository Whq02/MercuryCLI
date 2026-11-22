import { Event } from './event.js'
import { notBuilt } from '../../pi/holes.js'

export class ClickEvent extends Event {
  readonly col: number
  readonly row: number
  readonly cellIsBlank: boolean
  localCol: number
  localRow: number

  constructor(col: number, row: number, cellIsBlank: boolean) {
    notBuilt('src/ink/events/click-event.ts:11')
    super(...(notBuilt('src/ink/events/click-event.ts:11') as ConstructorParameters<typeof Event>))
  }
}
