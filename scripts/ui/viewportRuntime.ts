import { EventEmitter } from 'node:events'
import Ink from '../../src/ink/ink.js'
import type { FrameEvent } from '../../src/ink/frame.js'
import stripAnsi from 'strip-ansi'

export class ConsoleStream extends EventEmitter {
  isTTY = true
  columns: number
  rows: number
  consoleSize: [number, number]
  refreshCalls = 0
  resizeEvents = 0
  bytes = ''
  writes: string[] = []
  constructor(columns: number, rows: number) {
    super()
    this.columns = columns
    this.rows = rows
    this.consoleSize = [columns, rows]
    this.on('resize', () => this.resizeEvents++)
  }
  write(value: string): boolean {
    this.bytes += value
    this.writes.push(value)
    return true
  }
  _refreshSize(): void {
    this.refreshCalls++
    const [columns, rows] = this.consoleSize
    if (columns === this.columns && rows === this.rows) return
    this.columns = columns
    this.rows = rows
    this.emit('resize')
  }
}

export class InputStream extends EventEmitter {
  isTTY = false
  isRaw = false
  readableLength = 0
  setEncoding(): this { return this }
  setRawMode(raw: boolean): this { this.isRaw = raw; return this }
  ref(): this { return this }
  unref(): this { return this }
  read(): null { return null }
}

export function runtime(columns: number, rows: number) {
  const stdout = new ConsoleStream(columns, rows)
  const stdin = new InputStream()
  const events: FrameEvent[] = []
  const frames: string[][] = []
  const ink = new Ink({
    stdout: stdout as never, stdin: stdin as never, stderr: new ConsoleStream(columns, rows) as never,
    exitOnCtrlC: false, patchConsole: false,
    onFrame: event => {
      events.push(event)
      frames.push(plain(ink))
    },
  })
  ink.setAltScreenActive(true, false)
  return { ink, stdout, stdin, events, frames, dispose() { stdin.isTTY = false; ink.unmount() } }
}

export function plain(ink: Ink): string[] {
  return stripAnsi(ink.lastFrameText()).split('\n').map(line => line.trimEnd())
}

export function checks() {
  let failed = 0
  let total = 0
  return {
    check(name: string, condition: boolean, detail = '') {
      total++
      if (!condition) failed++
      console.log(`${condition ? 'ok' : 'FAIL'} ${name}${!condition && detail ? `: ${detail}` : ''}`)
    },
    finish() {
      console.log(`${total} checks, ${failed} failed`)
      process.exit(failed ? 1 : 0)
    },
  }
}
