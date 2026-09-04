import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import React, { useLayoutEffect } from 'react'
import stripAnsi from 'strip-ansi'

import { render, useApp } from '../ink.js'
import { chromeModeLive } from '../hooks/useLayoutTier.js'
import { railPlan } from './helmGeometry.js'


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
  stream.resume()
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
  return instance.lastFrame()
}

export async function renderToString(node: React.ReactNode, columns?: number): Promise<string> {
  return stripAnsi(await renderToAnsiString(node, columns))
}
