#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'win32-size-reconcile-home-'))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

class FakeConsole extends EventEmitter {
  isTTY = true
  columns = 100
  rows = 30
  trueSize: [number, number] = [100, 30]
  refreshCalls = 0
  bytes = ''
  write(s: string): boolean {
    this.bytes += s
    return true
  }
  _refreshSize(): void {
    this.refreshCalls++
    const [columns, rows] = this.trueSize
    if (columns !== this.columns || rows !== this.rows) {
      this.columns = columns
      this.rows = rows
      this.emit('resize')
    }
  }
}
class PlainStream extends EventEmitter {
  isTTY = true
  columns = 80
  rows = 24
  write(): boolean {
    return true
  }
}
class FakeStdin extends EventEmitter {
  isTTY = true
  isRaw = false
  readableLength = 0
  setEncoding(): FakeStdin {
    return this
  }
  setRawMode(v: boolean): FakeStdin {
    this.isRaw = v
    return this
  }
  ref(): FakeStdin {
    return this
  }
  unref(): FakeStdin {
    return this
  }
  read(): null {
    return null
  }
}

section('§1 refreshConsoleSize')
{
  let refreshConsoleSize: ((stdout: unknown) => boolean) | null = null
  try {
    refreshConsoleSize = (await import('../../src/ink/root/console-size.ts')).refreshConsoleSize
  } catch (error) {
    check('the console-size owner exists', false, String(error))
  }
  if (refreshConsoleSize !== null) {
    const plain = new PlainStream()
    check('a stream without the runtime road answers false (the caller falls back)', refreshConsoleSize(plain) === false)
    const fake = new FakeConsole()
    let resized = 0
    fake.on('resize', () => resized++)
    check('an unchanged console: the road is taken, nothing is emitted', refreshConsoleSize(fake) === true && fake.refreshCalls === 1 && resized === 0)
    fake.trueSize = [120, 40]
    check('a moved console: the cache updates and resize fires', refreshConsoleSize(fake) === true && fake.columns === 120 && fake.rows === 40 && resized === 1, `${fake.columns}x${fake.rows} resized=${resized}`)
    const refusing = {
      _refreshSize(): void {
        throw new Error('getWindowSize EBADF')
      },
    }
    check('a refused query is caught; the cached pair stands', refreshConsoleSize(refusing) === true)
  }
}

section('§2 the renderer under a forced win32 platform')
{
  const React = await import('react')
  const { default: Ink } = await import('../../src/ink/ink.js')
  const { Box, Text } = await import('../../src/ink.js')
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')!
  const stdout = new FakeConsole()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try {
    const ink = new Ink({ stdout: stdout as never, stdin: new FakeStdin() as never, stderr: new FakeConsole() as never, exitOnCtrlC: false, patchConsole: false })
    ink.render(React.createElement(Box, null, React.createElement(Text, null, 'geometry')))
    await sleep(150)
    const before = stdout.refreshCalls
    stdout.trueSize = [120, 40]
    ink.reconcileSize()
    check('reconcileSize asks the console through the runtime refresh road', stdout.refreshCalls === before + 1, `refreshCalls before=${before} after=${stdout.refreshCalls}`)
    await sleep(400)
    const cached = ink as unknown as { cachedColumns: number; cachedRows: number }
    check('the renderer adopted the live geometry after the settle window', cached.cachedColumns === 120 && cached.cachedRows === 40, `${cached.cachedColumns}x${cached.cachedRows}`)
    const calls = stdout.refreshCalls
    ink.reconcileSize()
    await sleep(50)
    check('an unmoved console: the road is taken again and nothing else happens', stdout.refreshCalls === calls + 1 && cached.cachedColumns === 120)
    ink.unmount()
  } finally {
    Object.defineProperty(process, 'platform', desc)
  }
}

if (failures > 0) {
  console.error(`\nprove-win32-size-reconcile: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-win32-size-reconcile: all green')
process.exit(0)
