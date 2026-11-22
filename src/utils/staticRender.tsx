import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import React from 'react'
import { useLayoutTimer } from '../hooks/effects.js'
import stripAnsi from 'strip-ansi'

import { render, useApp } from '../ink.js'
import { chromeModeLive } from '../hooks/useLayoutTier.js'
import { railPlan } from './helmGeometry.js'
import { startTimeout, stopTimeout } from './timers.js'
import { notBuilt } from '../pi/holes.js'

export function staticPrintColumns(): number {
  const cols = process.stdout.columns ?? 80
  const rows = process.stdout.rows
  if (chromeModeLive(cols, rows) === 'cockpit') {
    return Math.max(20, railPlan(cols).centerCols - 2)
  }
  return cols
}

export async function renderToAnsiString(node: React.ReactNode, columns?: number): Promise<string> {
  return notBuilt('src/utils/staticRender.tsx:38')
}

export async function renderToString(node: React.ReactNode, columns?: number): Promise<string> {
  return notBuilt('src/utils/staticRender.tsx:65')
}
