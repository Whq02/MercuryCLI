
import { Event } from './event.js'

export class ClickEvent extends Event {
  readonly col: number
  readonly row: number
  readonly cellIsBlank: boolean
  localCol: number
  localRow: number

  constructor(col: number, row: number, cellIsBlank: boolean) {
    super()
    this.col = col
    this.row = row
    this.cellIsBlank = cellIsBlank
    this.localCol = col
    this.localRow = row
  }
}
