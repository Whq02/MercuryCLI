import { stringWidth } from '../../src/ink/stringWidth.js'

const ESC = '\x1b'

export type SgrState = {
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
  strike: boolean
  fg: string
  bg: string
}

export function defaultSgr(): SgrState {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
    strike: false,
    fg: 'default',
    bg: 'default',
  }
}

export function applySgrParams(state: SgrState, params: number[]): void {
  let i = 0
  if (params.length === 0) params = [0]
  while (i < params.length) {
    const p = params[i]!
    switch (p) {
      case 0: Object.assign(state, defaultSgr()); break
      case 1: state.bold = true; break
      case 2: state.dim = true; break
      case 3: state.italic = true; break
      case 4: state.underline = true; break
      case 7: state.inverse = true; break
      case 9: state.strike = true; break
      case 21: state.bold = false; break
      case 22: state.bold = false; state.dim = false; break
      case 23: state.italic = false; break
      case 24: state.underline = false; break
      case 27: state.inverse = false; break
      case 29: state.strike = false; break
      case 39: state.fg = 'default'; break
      case 49: state.bg = 'default'; break
      case 38:
      case 48: {
        const kind = params[i + 1]
        let val: string
        if (kind === 5) {
          val = `${p};5;${params[i + 2]}`
          i += 2
        } else if (kind === 2) {
          val = `${p};2;${params[i + 2]};${params[i + 3]};${params[i + 4]}`
          i += 4
        } else {
          throw new Error(`ansiEmulator: SGR ${p};${kind} extended-color form`)
        }
        if (p === 38) state.fg = val
        else state.bg = val
        break
      }
      default:
        if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) state.fg = String(p)
        else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) state.bg = String(p)
        else throw new Error(`ansiEmulator: unknown SGR param ${p}`)
    }
    i++
  }
}

export function sgrStateOfStyleString(s: string): SgrState {
  const state = defaultSgr()
  const re = /\x1b\[([0-9;]*)m/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    const params = m[1] === '' ? [0] : m[1]!.split(';').map(v => parseInt(v, 10))
    applySgrParams(state, params)
  }
  return state
}

export class AnsiEmulator {
  readonly width: number
  readonly height: number
  grid: string[][]
  cellStyles: Array<Array<SgrState | null>>
  cellLinks: Array<Array<string | null>>
  scrollback: string[] = []
  cursorX = 0
  cursorY = 0
  cursorVisible = true
  sgr: SgrState = defaultSgr()
  activeLink: string | null = null
  region: { top: number; bottom: number } | null = null
  edClears = 0
  scrollbackErased = 0
  private readonly altScreen: boolean

  constructor(width: number, height: number, altScreen: boolean) {
    this.width = width
    this.height = height
    this.altScreen = altScreen
    this.grid = Array.from({ length: height }, () => this.blankRow())
    this.cellStyles = Array.from({ length: height }, () => this.blankStyleRow())
    this.cellLinks = Array.from({ length: height }, () => this.blankLinkRow())
  }

  private blankRow(): string[] {
    return Array.from({ length: this.width }, () => ' ')
  }

  private blankStyleRow(): Array<SgrState | null> {
    return Array.from({ length: this.width }, () => null)
  }

  private blankLinkRow(): Array<string | null> {
    return Array.from({ length: this.width }, () => null)
  }

  styleAt(x: number, y: number): SgrState | null {
    return this.cellStyles[y]?.[x] ?? null
  }

  linkAt(x: number, y: number): string | null {
    return this.cellLinks[y]?.[x] ?? null
  }

  rowText(y: number): string {
    const row = this.grid[y]
    if (!row) return ''
    return row.join('').replace(/\s+$/, '')
  }

  lines(): string[] {
    return this.grid.map((_, y) => this.rowText(y))
  }

  feed(bytes: string): void {
    let i = 0
    while (i < bytes.length) {
      const ch = bytes[i]!
      if (ch === ESC) {
        const next = bytes[i + 1]
        if (next === '[') {
          i = this.handleCsi(bytes, i + 2)
        } else if (next === ']') {
          i = this.handleOsc(bytes, i + 2)
        } else {
          throw new Error(
            `ansiEmulator: unknown escape ${JSON.stringify(bytes.slice(i, i + 8))} at ${i}`,
          )
        }
        continue
      }
      if (ch === '\r') {
        this.cursorX = 0
        i++
        continue
      }
      if (ch === '\n') {
        this.lineFeed()
        i++
        continue
      }
      let unit = ch
      const code = ch.codePointAt(0)!
      if (code > 0xffff) {
        unit = bytes.slice(i, i + 2)
      }
      this.writeChar(unit)
      i += unit.length
    }
  }

  private handleCsi(bytes: string, start: number): number {
    let j = start
    while (j < bytes.length && !/[A-Za-z]/.test(bytes[j]!)) j++
    if (j >= bytes.length) throw new Error('ansiEmulator: unterminated CSI')
    const final = bytes[j]!
    const body = bytes.slice(start, j)
    const params = body.replace(/^\?/, '').split(';').map(p => (p === '' ? undefined : parseInt(p, 10)))
    const p0 = params[0]
    switch (final) {
      case 'A':
        this.cursorY = Math.max(0, this.cursorY - (p0 ?? 1))
        break
      case 'B':
        this.cursorY = Math.min(this.height - 1, this.cursorY + (p0 ?? 1))
        break
      case 'C':
        this.cursorX = Math.min(this.width, this.cursorX + (p0 ?? 1))
        break
      case 'D':
        this.cursorX = Math.max(0, this.cursorX - (p0 ?? 1))
        break
      case 'G':
        this.cursorX = Math.max(0, (p0 ?? 1) - 1)
        break
      case 'H': {
        const row = (p0 ?? 1) - 1
        const col = (params[1] ?? 1) - 1
        this.cursorY = Math.max(0, Math.min(this.height - 1, row))
        this.cursorX = Math.max(0, Math.min(this.width, col))
        break
      }
      case 'J': {
        this.edClears++
        const mode = p0 ?? 0
        if (mode === 3) {
          this.scrollbackErased++
          this.scrollback.length = 0
        } else if (mode === 2) {
          for (let y = 0; y < this.height; y++) this.blankOutRow(y, 0)
        } else if (mode === 0) {
          this.blankOutRow(this.cursorY, this.cursorX)
          for (let y = this.cursorY + 1; y < this.height; y++) this.blankOutRow(y, 0)
        } else {
          throw new Error(`ansiEmulator: ED mode ${mode}`)
        }
        break
      }
      case 'K': {
        const mode = p0 ?? 0
        if (mode === 0) {
          this.blankOutRow(this.cursorY, this.cursorX)
        } else if (mode === 2) {
          this.blankOutRow(this.cursorY, 0)
        } else {
          throw new Error(`ansiEmulator: EL mode ${mode}`)
        }
        break
      }
      case 'S':
        this.scrollRegion(p0 ?? 1)
        break
      case 'T':
        this.scrollRegion(-(p0 ?? 1))
        break
      case 'r':
        if (p0 === undefined && params[1] === undefined) {
          this.region = null
        } else {
          this.region = { top: (p0 ?? 1) - 1, bottom: (params[1] ?? this.height) - 1 }
        }
        break
      case 'm': {
        const sgrParams = body === '' ? [0] : body.split(';').map(v => (v === '' ? 0 : parseInt(v, 10)))
        applySgrParams(this.sgr, sgrParams)
        break
      }
      case 'h':
      case 'l':
        if (body === '?25') this.cursorVisible = final === 'h'
        break
      default:
        throw new Error(
          `ansiEmulator: unknown CSI ${JSON.stringify(body + final)}`,
        )
    }
    return j + 1
  }

  private handleOsc(bytes: string, start: number): number {
    let j = start
    while (j < bytes.length) {
      if (bytes[j] === '\x07' || (bytes[j] === ESC && bytes[j + 1] === '\\')) {
        const body = bytes.slice(start, j)
        const m = /^8;[^;]*;(.*)$/s.exec(body)
        if (m) this.activeLink = m[1] === '' ? null : m[1]!
        return bytes[j] === '\x07' ? j + 1 : j + 2
      }
      j++
    }
    throw new Error('ansiEmulator: unterminated OSC')
  }

  private blankOutRow(y: number, startX: number): void {
    const row = this.grid[y]!
    const styleRow = this.cellStyles[y]!
    const linkRow = this.cellLinks[y]!
    for (let x = startX; x < this.width; x++) {
      row[x] = ' '
      styleRow[x] = null
      linkRow[x] = null
    }
  }

  private lineFeed(): void {
    const bottom = this.region ? this.region.bottom : this.height - 1
    if (this.cursorY >= bottom) {
      this.scrollRegion(1)
    } else {
      this.cursorY++
    }
  }

  private scrollRegion(delta: number): void {
    const top = this.region ? this.region.top : 0
    const bottom = this.region ? this.region.bottom : this.height - 1
    if (delta > 0) {
      for (let n = 0; n < delta; n++) {
        const leaving = this.grid[top]!
        if (!this.altScreen && !this.region) {
          this.scrollback.push(leaving.join('').replace(/\s+$/, ''))
        }
        for (let y = top; y < bottom; y++) {
          this.grid[y] = this.grid[y + 1]!
          this.cellStyles[y] = this.cellStyles[y + 1]!
          this.cellLinks[y] = this.cellLinks[y + 1]!
        }
        this.grid[bottom] = this.blankRow()
        this.cellStyles[bottom] = this.blankStyleRow()
        this.cellLinks[bottom] = this.blankLinkRow()
      }
    } else {
      for (let n = 0; n < -delta; n++) {
        for (let y = bottom; y > top; y--) {
          this.grid[y] = this.grid[y - 1]!
          this.cellStyles[y] = this.cellStyles[y - 1]!
          this.cellLinks[y] = this.cellLinks[y - 1]!
        }
        this.grid[top] = this.blankRow()
        this.cellStyles[top] = this.blankStyleRow()
        this.cellLinks[top] = this.blankLinkRow()
      }
    }
  }

  private writeChar(unit: string): void {
    const w = stringWidth(unit)
    if (this.cursorX + Math.max(1, w) > this.width) {
      throw new Error(
        `ansiEmulator: write past right edge at (${this.cursorX},${this.cursorY}): ${JSON.stringify(unit)}`,
      )
    }
    const row = this.grid[this.cursorY]!
    const styleRow = this.cellStyles[this.cursorY]!
    const linkRow = this.cellLinks[this.cursorY]!
    row[this.cursorX] = unit
    styleRow[this.cursorX] = { ...this.sgr }
    linkRow[this.cursorX] = this.activeLink
    if (w === 2) {
      row[this.cursorX + 1] = ''
      styleRow[this.cursorX + 1] = { ...this.sgr }
      linkRow[this.cursorX + 1] = this.activeLink
      this.cursorX += 2
    } else {
      this.cursorX += Math.max(1, w)
    }
  }
}
