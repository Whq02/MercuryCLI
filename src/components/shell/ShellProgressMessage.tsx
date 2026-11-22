import React, { useRef } from 'react'
import { Box, Text } from '../../ink.js'
import stripAnsi from 'strip-ansi'
import { MessageResponse } from '../MessageResponse.js'
import { OffscreenFreeze } from '../OffscreenFreeze.js'
import { formatFileSize } from '../../utils/format.js'
import { ShellTimeDisplay } from './ShellTimeDisplay.js'
import { notBuilt } from '../../pi/holes.js'

const TAIL_LINES = 5

export function reserveShellRows(shown: number, latched: number): { latch: number; pad: number } {
  const latch = Math.min(TAIL_LINES, Math.max(shown, latched))
  return { latch, pad: latch - shown }
}

export function ShellProgressMessage(arg0: {
  output: string
  fullOutput: string
  elapsedTimeSeconds?: number
  totalLines?: number
  totalBytes?: number
  timeoutMs?: number
  taskId?: string
  verbose: boolean
}): React.ReactNode {
  return notBuilt('src/components/shell/ShellProgressMessage.tsx:17')
}
