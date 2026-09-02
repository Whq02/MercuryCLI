import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import React, { useLayoutEffect } from 'react'
import stripAnsi from 'strip-ansi'

import { render, useApp } from '../ink.js'
import { chromeModeLive } from '../hooks/useLayoutTier.js'
import { railPlan } from './helmGeometry.js'


const SYNC_BEGIN = '\u001b[?2026h'
const SYNC_END = '\u001b[?2026l'

function ExitAfterCommit({ children }: { children: React.ReactNode }): React.ReactNode {
  const { exit } = useApp()
  useLayoutEffect(() => {
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
  if (columns !== undefined) {
    ;(target as { columns?: number }).columns = columns
  }
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
