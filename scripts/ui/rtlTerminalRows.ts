import { getGraphemeSegmenter } from '../../src/platform/text/textSegments.js'
import { stringWidth } from '../../src/screen/renderer/stringWidth.js'

const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/
const OPENING_MARK = /[\u2066-\u2068\u202A\u202B\u202D\u202E]/g
const CLOSING_MARK = /[\u2069\u202C]/g

type RowFault = { frame: number; row: number; what: 'written in part' | 'unpaired marks'; detail: string; text: string }

export class TerminalRows {
  readonly cells: string[][]
  readonly lead: string[]
  readonly faults: RowFault[] = []
  readonly inverse: boolean[][]
  frames = 0
  private inverted = false
  private pending = ''
  private readonly written: boolean[][]
  private readonly touched: boolean[]
  private readonly heldRtl: boolean[]
  private x = 0
  private y = 0
  private top = 0
  private bottom: number
  private carry = ''

  constructor(public cols: number, readonly rows: number) {
    this.cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ' '))
    this.written = Array.from({ length: rows }, () => Array.from({ length: cols }, () => false))
    this.inverse = Array.from({ length: rows }, () => Array.from({ length: cols }, () => false))
    this.lead = Array.from({ length: rows }, () => '')
    this.touched = Array.from({ length: rows }, () => false)
    this.heldRtl = Array.from({ length: rows }, () => false)
    this.bottom = rows - 1
  }

  resize(cols: number): void {
    for (let y = 0; y < this.rows; y++) {
      for (const line of [this.cells[y]!, this.inverse[y]!, this.written[y]!]) line.length = Math.min(line.length, cols)
      while (this.cells[y]!.length < cols) {
        this.cells[y]!.push(' ')
        this.inverse[y]!.push(false)
        this.written[y]!.push(false)
      }
    }
    this.cols = cols
    this.x = Math.min(this.x, cols - 1)
  }

  snapshot(): TerminalRows {
    const copy = new TerminalRows(this.cols, this.rows)
    for (let y = 0; y < this.rows; y++) {
      copy.cells[y] = this.cells[y]!.slice()
      copy.inverse[y] = this.inverse[y]!.slice()
      copy.lead[y] = this.lead[y]!
    }
    return copy
  }

  rowText(y: number): string {
    return this.lead[y]! + this.cells[y]!.join('')
  }

  get column(): number {
    return this.x
  }

  get line(): number {
    return this.y
  }

  rtlRows(): number[] {
    const out: number[] = []
    for (let y = 0; y < this.rows; y++) if (RTL_LETTER.test(this.rowText(y))) out.push(y)
    return out
  }

  endFrame(): void {
    for (let y = 0; y < this.rows; y++) {
      const text = this.rowText(y)
      const holds = RTL_LETTER.test(text)
      if (this.touched[y] && (holds || this.heldRtl[y])) {
        const missed: number[] = []
        for (let x = 0; x < this.cols; x++) {
          const cell = this.cells[y]![x]!
          if (cell !== ' ' && cell !== '' && !this.written[y]![x]) missed.push(x)
        }
        if (missed.length > 0) {
          this.faults.push({ frame: this.frames, row: y, what: 'written in part', detail: `${missed.length} inked cells kept from an earlier frame, the first at column ${missed[0]! + 1}`, text })
        }
        const opened = (text.match(OPENING_MARK) ?? []).length
        const closed = (text.match(CLOSING_MARK) ?? []).length
        if (opened !== closed) {
          this.faults.push({ frame: this.frames, row: y, what: 'unpaired marks', detail: `${opened} opening against ${closed} closing`, text })
        }
      }
      this.heldRtl[y] = holds
      this.touched[y] = false
      this.written[y]!.fill(false)
    }
    this.frames++
  }

  private blank(y: number, from: number, to: number): void {
    for (let x = from; x < to; x++) {
      this.cells[y]![x] = ' '
      this.written[y]![x] = true
      this.inverse[y]![x] = false
    }
    if (from === 0) this.lead[y] = ''
  }

  private scroll(lines: number): void {
    const up = lines > 0
    for (let n = Math.abs(lines); n > 0; n--) {
      const moved = up ? this.cells.splice(this.top, 1)[0]! : this.cells.splice(this.bottom, 1)[0]!
      moved.fill(' ')
      this.cells.splice(up ? this.bottom : this.top, 0, moved)
      const shade = up ? this.inverse.splice(this.top, 1)[0]! : this.inverse.splice(this.bottom, 1)[0]!
      shade.fill(false)
      this.inverse.splice(up ? this.bottom : this.top, 0, shade)
      const lead = up ? this.lead.splice(this.top, 1) : this.lead.splice(this.bottom, 1)
      lead[0] = ''
      this.lead.splice(up ? this.bottom : this.top, 0, lead[0])
      const held = up ? this.heldRtl.splice(this.top, 1) : this.heldRtl.splice(this.bottom, 1)
      held[0] = false
      this.heldRtl.splice(up ? this.bottom : this.top, 0, held[0])
    }
  }

  private csi(raw: string, final: string): void {
    const priv = /^[?>=]/.test(raw)
    const params = raw.replace(/^[?>=]/, '').split(';').map(p => (p === '' ? undefined : Number(p)))
    const n = params[0] ?? 1
    if (priv) {
      if (raw === '?2026' && final === 'h') this.endFrame()
      return
    }
    if (final === 'm') {
      for (let at = 0; at < params.length; at++) {
        const code = params[at] ?? 0
        if (code === 38 || code === 48 || code === 58) at += params[at + 1] === 2 ? 4 : 2
        else if (code === 0 || code === 27) this.inverted = false
        else if (code === 7) this.inverted = true
      }
      return
    }
    this.pending = ''
    switch (final) {
      case 'A': this.y = Math.max(0, this.y - n); break
      case 'B': this.y = Math.min(this.rows - 1, this.y + n); break
      case 'C': this.x = Math.min(this.cols - 1, this.x + n); break
      case 'D': this.x = Math.max(0, this.x - n); break
      case 'G': this.x = Math.max(0, Math.min(this.cols - 1, n - 1)); break
      case 'd': this.y = Math.max(0, Math.min(this.rows - 1, n - 1)); break
      case 'H':
      case 'f':
        if (raw === '') this.endFrame()
        this.y = Math.max(0, Math.min(this.rows - 1, n - 1))
        this.x = Math.max(0, Math.min(this.cols - 1, (params[1] ?? 1) - 1))
        break
      case 'J':
        if (params[0] === 2 || params[0] === 3) for (let y = 0; y < this.rows; y++) this.blank(y, 0, this.cols)
        else if ((params[0] ?? 0) === 0) {
          this.blank(this.y, this.x, this.cols)
          for (let y = this.y + 1; y < this.rows; y++) this.blank(y, 0, this.cols)
        }
        break
      case 'K':
        if ((params[0] ?? 0) === 0) this.blank(this.y, this.x, this.cols)
        else if (params[0] === 2) this.blank(this.y, 0, this.cols)
        break
      case 'r':
        this.top = Math.max(0, (params[0] ?? 1) - 1)
        this.bottom = Math.min(this.rows - 1, (params[1] ?? this.rows) - 1)
        break
      case 'S': this.scroll(n); break
      case 'T': this.scroll(-n); break
      default: break
    }
  }

  private print(text: string): void {
    for (const { segment } of getGraphemeSegmenter().segment(text)) {
      const width = stringWidth(segment)
      if (width === 0) {
        if (this.x > 0) this.cells[this.y]![this.x - 1] += segment
        else this.pending += segment
        this.touched[this.y] = true
        continue
      }
      if (this.x + width > this.cols) continue
      if (this.x === 0) this.lead[this.y] = this.pending
      this.pending = ''
      this.cells[this.y]![this.x] = segment
      this.written[this.y]![this.x] = true
      this.inverse[this.y]![this.x] = this.inverted
      for (let t = 1; t < width; t++) {
        this.cells[this.y]![this.x + t] = ''
        this.written[this.y]![this.x + t] = true
      }
      this.touched[this.y] = true
      this.x += width
    }
  }

  feed(chunk: string): void {
    const bytes = this.carry + chunk
    this.carry = ''
    let i = 0
    while (i < bytes.length) {
      const ch = bytes[i]!
      if (ch === '\x1b') {
        const next = bytes[i + 1]
        if (next === undefined) {
          this.carry = bytes.slice(i)
          return
        }
        if (next === '[') {
          let j = i + 2
          while (j < bytes.length && !/[@-~]/.test(bytes[j]!)) j++
          if (j >= bytes.length) {
            this.carry = bytes.slice(i)
            return
          }
          this.csi(bytes.slice(i + 2, j), bytes[j]!)
          i = j + 1
          continue
        }
        if (next === ']' || next === 'P' || next === '_' || next === '^') {
          const bel = bytes.indexOf('\x07', i)
          const st = bytes.indexOf('\x1b\\', i)
          const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
          if (end === -1) {
            this.carry = bytes.slice(i)
            return
          }
          i = end + (bytes[end] === '\x07' ? 1 : 2)
          continue
        }
        i += 2
        continue
      }
      if (ch === '\r') {
        this.x = 0
        this.pending = ''
        i++
        continue
      }
      if (ch === '\n') {
        this.y = Math.min(this.rows - 1, this.y + 1)
        this.pending = ''
        i++
        continue
      }
      if (ch < ' ') {
        i++
        continue
      }
      let k = i
      while (k < bytes.length && bytes[k]! >= ' ' && bytes[k] !== '\x1b') k++
      this.print(bytes.slice(i, k))
      i = k
    }
  }
}
