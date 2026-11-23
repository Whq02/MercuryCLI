import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import React from 'react'
import { useLayoutTimer } from '../effects/effects.js'
import stripAnsi from 'strip-ansi'

import { render, useApp } from '../themedRenderer.js'
import { chromeModeLive } from '../fullscreen-layout/useLayoutTier.js'
import { railPlan } from '../fullscreen-layout/helmGeometry.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

export function staticPrintColumns(): number {
  const cols = process.stdout.columns ?? 80
  const rows = process.stdout.rows
  if (chromeModeLive(cols, rows) === 'cockpit') {
    return Math.max(20, railPlan(cols).centerCols - 2)
  }
  return cols
}

function createOffscreenStdout(columns?: number): NodeJS.WriteStream {
  const stream = new PassThrough()
  stream.resume()
  const writable: NodeJS.WritableStream = Object.assign(stream, {
    columns: columns ?? 80,
    rows: 24,
    isTTY: false,
  })
  return writable as NodeJS.WriteStream
}

function createOffscreenStdin(): NodeJS.ReadStream {
  const emitter: EventEmitter = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode() {
      return this
    },
    setEncoding() {
      return this
    },
    read() {
      return null
    },
    unref() {
      return this
    },
    ref() {
      return this
    },
    pause() {
      return this
    },
    resume() {
      return this
    },
  })
  return emitter as NodeJS.ReadStream
}

function StaticRenderHost({ children }: { children: React.ReactNode }): React.ReactNode {
  const { exit } = useApp()
  useLayoutTimer(() => {
    const timer = startTimeout(() => {
      exit()
    }, 0)
    return () => {
      stopTimeout(timer)
    }
  }, [exit])
  return <>{children}</>
}

export async function renderToAnsiString(node: React.ReactNode, columns?: number): Promise<string> {
  const stdout = createOffscreenStdout(columns)
  const stderr = createOffscreenStdout(columns)
  const stdin = createOffscreenStdin()
  const instance = await render(<StaticRenderHost>{node}</StaticRenderHost>, {
    stdout,
    stderr,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  try {
    await instance.waitUntilExit()
    return instance.lastFrame()
  } finally {
    instance.cleanup()
  }
}

export async function renderToString(node: React.ReactNode, columns?: number): Promise<string> {
  return stripAnsi(await renderToAnsiString(node, columns))
}
