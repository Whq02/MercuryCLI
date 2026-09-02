// Click event with absolute + handler-relative coordinates and a blank-cell
// flag. Rides the MINIMAL event base: no type, no preventDefault, no phase —
// the hit-test bubbler recomputes the local coordinates before each handler
// fires so a container's handler sees coordinates relative to ITSELF.

import { Event } from './event.js'

export class ClickEvent extends Event {
  readonly col: number
  readonly row: number
  /** Both packed cell words are zero: no visible content under the click. */
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
