import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import React, { useLayoutEffect } from 'react'
import stripAnsi from 'strip-ansi'

import { render, useApp } from '../ink.js'
import { chromeModeLive } from '../hooks/useLayoutTier.js'
import { railPlan } from './helmGeometry.js'

/**
 * Renders a component tree once to a string, off-screen. The terminal
 * renderer allows one print-once region per tree; several surfaces need to
 * print finished content once, so they render to a string and write it.
 */

const SYNC_BEGIN = '\u001b[?2026h'
const SYNC_END = '\u001b[?2026l'

/**
 * Exits after the commit completes. The layout effect is load-bearing: it is
 * the earliest point at which the commit is guaranteed complete under the
 * renderer's asynchronous rendering — a plain next-tick deferral from render
 * can fire before the commit lands and capture nothing.
 */
function ExitAfterCommit({ children }: { children: React.ReactNode }): React.ReactNode {
  const { exit } = useApp()
  useLayoutEffect(() => {
    // TWO macrotask hops before exit, not one: narrow-width wrapping can
    // force a measure→relayout pass whose SECOND commit lands on the next
    // task — exiting after the first hop unmounted mid-relayout and the
    // settled frame never painted (the apollo faces harness at 80 cols:
    // two middle Text nodes absent while their neighbours rendered). One
    // extra empty hop is free for single-commit renders.
    let inner: ReturnType<typeof setTimeout> | undefined
    const outer = setTimeout(() => {
      inner = setTimeout(() => exit(), 0)
    }, 0)
    return () => {
      clearTimeout(outer)
      if (inner !== undefined) clearTimeout(inner)
    }
  }, [exit])
  return children
}

/** The LAST NON-EMPTY complete sync window (the settled frame); the whole
 *  output when the markers are absent. The renderer may emit an early
 *  PARTIAL frame when narrow-width wrapping forces a relayout between
 *  commits — slicing the FIRST window then drops the lines the reflow moved
 *  (observed at 80 cols in the apollo faces harness) — and unmount may
 *  trail an empty window, so emptiness is skipped from the back. For a
 *  single-frame render (every print-once consumer) settled == first,
 *  byte-identical. */
function settledFrame(output: string): string {
  const windows: string[] = []
  let cursor = 0
  for (;;) {
    const begin = output.indexOf(SYNC_BEGIN, cursor)
    if (begin === -1) break
    const contentStart = begin + SYNC_BEGIN.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) break
    windows.push(output.slice(contentStart, end))
    cursor = end + SYNC_END.length
  }
  if (windows.length === 0) return output
  for (let i = windows.length - 1; i >= 0; i--) {
    if (stripAnsi(windows[i]!).trim() !== '') return windows[i]!
  }
  return windows[windows.length - 1]!
}

/** The width a DETACHED static print should render at: the
 *  transcript these prints land in is NOT the terminal — in the cockpit it
 *  is the narrowed centre column, and a print rendered at
 *  process.stdout.columns overflowed it (the /context bars clipped). The
 *  derivation reads the SAME pure owners the layout reads —
 *  chromeModeLive (the one cockpit latch, keyed to the real width) and
 *  railPlan — minus the transcript's two gutter columns; every non-cockpit
 *  chrome prints at the full width exactly as before. This helper is the
 *  ONE lawful process.stdout size read for print paths (the render-tree
 *  ratchet forbids the raw read — prove-resize-laws §4). */
export function staticPrintColumns(): number {
  const cols = process.stdout.columns ?? 80
  const rows = process.stdout.rows
  if (chromeModeLive(cols, rows) === 'cockpit') {
    return Math.max(20, railPlan(cols).centerCols - 2)
  }
  return cols
}

export async function renderToAnsiString(node: React.ReactNode, columns?: number): Promise<string> {
  const stream = new PassThrough()
  let output = ''
  stream.on('data', (chunk: Buffer | string) => {
    output += chunk.toString()
  })
  const target = stream as unknown as NodeJS.WriteStream
  // The renderer falls back to 80 columns without this advertisement — the
  // advertised width is what lets dumps match on-screen width.
  if (columns !== undefined) {
    ;(target as { columns?: number }).columns = columns
  }
  // A non-terminal output makes the renderer emit full frames, not diffs;
  // console patching off keeps unrelated console output out of the capture.
  // A RAW-CAPABLE STUB STDIN: the render is a one-frame string capture, but
  // the components under it are the REAL owners — a Select's useInput arms
  // raw mode on mount and App throws on a non-TTY stdin (the proof-harness
  // class). The stub says isTTY and swallows setRawMode; no byte ever flows.
  const stdinStub = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode() { return this },
    setEncoding() { return this },
    read() { return null },
    unref() { return this },
    ref() { return this },
    pause() { return this },
    resume() { return this },
  }) as unknown as NodeJS.ReadStream
  const instance = await render(<ExitAfterCommit>{node}</ExitAfterCommit>, {
    stdout: target,
    stdin: stdinStub,
    patchConsole: false,
  })
  await instance.waitUntilExit()
  return settledFrame(output)
}

export async function renderToString(node: React.ReactNode, columns?: number): Promise<string> {
  return stripAnsi(await renderToAnsiString(node, columns))
}
