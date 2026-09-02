#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-win32-size-reconcile.ts — the win32 size reconcile can
//  SEE the resize it exists to catch (FN-015 rank 43).
//
//  The runtime keeps stdout.columns/rows current only when its own resize
//  detection runs — on Windows, the console reader thread, which watches
//  for WINDOW_BUFFER_SIZE_EVENT only while stdin is in raw mode. So during
//  an external-editor handover or any suspendStdin window the cached pair
//  never moved, and reconcileSize() — the five-second win32 poll and the
//  post-resume heal — did nothing but re-read that pair through
//  handleResize: inert for exactly the case its comments described. The
//  public getWindowSize() returns the SAME cache (verified against node
//  v24: `return [this.columns, this.rows]`), so the packet's named remedy
//  would have been inert too; the runtime's own refresh road
//  (_refreshSize, what its SIGWINCH handler calls) queries the console
//  handle, updates the cache and emits resize when the answer moved.
//    §1 refreshConsoleSize — takes the road when it exists (moved ⇒ the
//       cache updates and resize fires; unchanged ⇒ nothing fires), answers
//       false without it, and swallows a refused query.
//    §2 the renderer under a FORCED win32 platform: a fake console whose
//       true size moves without a resize event — reconcileSize() asks the
//       console and the renderer adopts the live geometry.
//    §3 the structural pins live in prove-screen-reassert (F2).
//  The live Windows leg — resize the window while an external editor is
//  open, return, the cockpit repaints at the new width — is field work.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-win32-size-reconcile.ts
// ============================================================================
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

/** A console stream in the runtime's shape: a cached pair, and the refresh
 *  road that re-queries the "console" (trueSize) and emits resize on a move. */
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
  // Import BEFORE forcing the platform so module-level constants keep the
  // live host; only the construction and the reconcile run as win32.
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
    // The console moves while no resize event is delivered (the handover shape).
    stdout.trueSize = [120, 40]
    ink.reconcileSize()
    check('reconcileSize asks the console through the runtime refresh road', stdout.refreshCalls === before + 1, `refreshCalls before=${before} after=${stdout.refreshCalls}`)
    await sleep(400)
    const cached = ink as unknown as { cachedColumns: number; cachedRows: number }
    check('the renderer adopted the live geometry after the settle window', cached.cachedColumns === 120 && cached.cachedRows === 40, `${cached.cachedColumns}x${cached.cachedRows}`)
    // A reconcile with nothing moved is quiet: no second resize, same cache.
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
