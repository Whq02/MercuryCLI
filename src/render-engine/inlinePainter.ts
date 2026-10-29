
import { HIDE_CURSOR, SHOW_CURSOR } from '../ink/termio/dec.js'
import { cursorDown, cursorTo, cursorUp, eraseToEndOfLine } from '../ink/termio/csi.js'

const EL = eraseToEndOfLine()
const SGR_RESET = '\x1b[0m'

export interface PaintResult {
  body: string
  settledLinesWritten: number
  tailRowsWritten: number
}

export class InlineTailPainter {
  private prev: string[] = ['']
  private parkRow = 0
  private parkCol = 0

  blockHeight(): number {
    return this.prev.length
  }

  forget(): void {
    this.prev = ['']
    this.parkRow = 0
    this.parkCol = 0
  }

  paint(
    settled: readonly string[],
    next: readonly string[],
    park: { row: number; col: number },
    options: { forceRepaint?: boolean } = {},
  ): PaintResult {
    const prev = this.prev
    let body = ''
    let row = this.parkRow
    let col = this.parkCol
    let settledWrites = 0
    let tailWrites = 0

    const cr = (): void => {
      if (col !== 0) {
        body += '\r'
        col = 0
      }
    }
    const moveToRow = (target: number): void => {
      if (target === row) return
      cr()
      body += target < row ? cursorUp(row - target) : cursorDown(target - row)
      row = target
    }

    if (settled.length > 0) {
      moveToRow(0)
      cr()
      for (let i = 0; i < settled.length; i++) {
        body += EL + settled[i] + SGR_RESET + '\r\n'
        settledWrites++
        row++
        col = 0
      }
      if (next.length === 0) {
        body += EL
      }
      for (let j = 0; j < next.length; j++) {
        body += EL + next[j]
        col = Number.MAX_SAFE_INTEGER
        tailWrites++
        if (j < next.length - 1) {
          body += '\r\n'
          row++
          col = 0
        }
      }
      const consumed = settled.length + Math.max(next.length, 1)
      const staleBeyond = prev.length - consumed
      for (let k = 0; k < staleBeyond; k++) {
        cr()
        body += cursorDown(1)
        row++
        body += EL
      }
    } else {
      const force = options.forceRepaint === true
      const shared = Math.min(prev.length, next.length)
      for (let r = 0; r < shared; r++) {
        if (!force && prev[r] === next[r]) continue
        moveToRow(r)
        cr()
        body += EL + next[r]
        col = Number.MAX_SAFE_INTEGER
        tailWrites++
      }
      if (next.length > prev.length) {
        moveToRow(prev.length - 1)
        cr()
        for (let r = prev.length; r < next.length; r++) {
          body += '\r\n' + EL + next[r]
          row++
          col = Number.MAX_SAFE_INTEGER
          tailWrites++
        }
      } else if (next.length < prev.length) {
        for (let r = next.length; r < prev.length; r++) {
          moveToRow(r)
          cr()
          body += EL
        }
      }
    }

    const blockTop = settled.length > 0 ? settled.length : 0
    const parkAbs = blockTop + Math.min(park.row, Math.max(0, next.length - 1))
    moveToRow(parkAbs)
    cr()
    if (park.col > 0) {
      body += cursorTo(park.col + 1)
      col = park.col
    }

    this.prev = next.slice()
    if (this.prev.length === 0) this.prev = ['']
    this.parkRow = Math.min(parkAbs - blockTop, this.prev.length - 1)
    this.parkCol = col === Number.MAX_SAFE_INTEGER ? 0 : col

    if (body === '') return { body: '', settledLinesWritten: 0, tailRowsWritten: 0 }
    return {
      body: HIDE_CURSOR + body + SGR_RESET + SHOW_CURSOR,
      settledLinesWritten: settledWrites,
      tailRowsWritten: tailWrites,
    }
  }
}
