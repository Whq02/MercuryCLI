#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { closeSync, constants, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const React = await import('react')
const h = React.createElement
const { default: Ink } = await import('../../src/ink/ink.tsx')
const { default: instances } = await import('../../src/ink/instances.ts')
const { Box, Text } = await import('../../src/ink.ts')
const { AlternateScreen } = await import('../../src/ink/components/AlternateScreen.tsx')

const COLS = 100
const ROWS = 30

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const dir = mkdtempSync(join(tmpdir(), 'undelivered-frame-'))
const fifo = join(dir, 'terminal')
execFileSync('mkfifo', [fifo])
const fd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK)

const refuses = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'EAGAIN' || (error as NodeJS.ErrnoException).code === 'EWOULDBLOCK'

function read(): string {
  const chunk = Buffer.alloc(65536)
  const parts: Buffer[] = []
  for (;;) {
    let n = 0
    try {
      n = readSync(fd, chunk, 0, chunk.length, null)
    } catch (error) {
      if (refuses(error)) break
      throw error
    }
    if (n <= 0) break
    parts.push(Buffer.from(chunk.subarray(0, n)))
  }
  return Buffer.concat(parts).toString('utf8')
}

function fill(): number {
  const filler = Buffer.alloc(4096, 0x23)
  let written = 0
  for (;;) {
    try {
      written += writeSync(fd, filler)
    } catch (error) {
      if (refuses(error)) return written
      throw error
    }
  }
}

class Terminal extends EventEmitter {
  isTTY = true
  columns = COLS
  rows = ROWS
  fd = fd
  write(): boolean {
    return true
  }
}

class Keys extends EventEmitter {
  isTTY = true
  isRaw = false
  readableLength = 0
  setEncoding(): this {
    return this
  }
  setRawMode(raw: boolean): this {
    this.isRaw = raw
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
  pause(): this {
    return this
  }
  resume(): this {
    return this
  }
  read(): string | null {
    return null
  }
}

const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const scene = (word: string): React.ReactNode =>
  h(AlternateScreen, { mouseTracking: false }, h(Box, { flexDirection: 'column' }, ...Array.from({ length: ROWS - 2 }, (_, i) => h(Text, { key: i }, `row-${String(i).padStart(2, '0')}-${word}-${'x'.repeat(40)}`))))

const screen = new Terminal()
const ink = new Ink({ stdout: screen as never, stdin: new Keys() as never, stderr: new Terminal() as never, patchConsole: false, exitOnCtrlC: false })
instances.set(screen as never, ink)

try {
  ink.render(scene('first'))
  await settle(300)
  const first = read()
  t('§0 a frame reaches a terminal that reads', first.includes('row-27-first'), `${first.length} bytes`)

  const filled = fill()
  ink.render(scene('second'))
  await settle(200)
  const refused = read()
  t(`§1 a terminal that takes nothing (its ${filled} bytes of room full) is not given the next frame`, !refused.includes('row-27-second'), `${refused.length} bytes read back`)

  let arrived = ''
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline && !arrived.includes('row-27-second')) {
    await settle(100)
    arrived += read()
  }
  t('§2 once the terminal reads again the frame arrives by itself, with nothing else changing on screen', arrived.includes('row-27-second'), `${arrived.length} bytes in twelve seconds`)
  t('§2 and it is the whole frame, from its first row', arrived.includes('row-00-second') && arrived.includes('row-13-second'))

  await settle(2500)
  const after = read()
  t('§3 a frame that was taken is not sent again', after.length === 0, `${after.length} more bytes at rest`)
} finally {
  const exited = ink.waitUntilExit()
  ink.unmount()
  await exited
  instances.delete(screen as never)
  closeSync(fd)
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? 'UNDELIVERED FRAME: ALL PASS' : 'UNDELIVERED FRAME: RED')
process.exit(failures)
