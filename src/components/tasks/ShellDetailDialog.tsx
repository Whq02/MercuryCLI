import React, { useDeferredValue, useMemo, useRef, useState } from 'react'
import { useTimer } from '../../hooks/effects.js'
import { closeSync, openSync, readSync } from 'node:fs'
import { exitChordNoticeText } from '../PromptInput/ExitChordNotice.js'
import { Box, Text, useInput } from '../../ink.js'
import { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import { useExitOnCtrlCD } from '../../hooks/useExitOnCtrlCD.js'
import type { BashTaskKind, LocalShellTaskState } from '../../tasks/LocalShellTask/guards.js'
import type { WorkRowV1 } from '../../services/engine-connector/types.js'
import { formatFileSize } from '../../utils/format.js'
import { tailFileSync } from '../../utils/fsOperations.js'
import wrapText from '../../ink/wrap-text.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { CommandCenter, SectionHeader } from '../mercury-ui/components.js'
import { WorkingGlyph } from '../mercury-ui/LiveGlyphs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { subscribeTaskOutputPath } from '../../utils/task/diskOutput.js'
import { notBuilt } from '../../pi/holes.js'

const TAIL_BYTES = 8 * 1024
const COUNT_CHUNK_BYTES = 64 * 1024
const OUTPUT_LINES = 10
const FRAME_ROWS = 12
const FRAME_ROWS_FLOOR = 3
const CARD_CHROME_ROWS = 11
const CARD_ROWS_ABOVE_KEYS = 6 + FRAME_ROWS_FLOOR
const HOST_FOOTER_ROWS = 1
const LABEL_WIDTH = 8
const OUTPUT_UNREPORTED = 'output not reported by the runner'
const OUTPUT_ABSENT = 'output file not found on this box'

type ShellCardFacts = {
  command: string
  description?: string
  status: string
  startTime: number
  endTime?: number
  totalPausedMs?: number
  outputFile?: string
  cwd?: string
  kind?: BashTaskKind
  exitCode?: number
}

export function shellCardFactsOfTask(shell: LocalShellTaskState): ShellCardFacts {
  return notBuilt('src/components/tasks/ShellDetailDialog.tsx:48')
}

export function shellCardFactsOfRow(row: WorkRowV1): ShellCardFacts {
  return {
    command: row.command ?? row.name,
    ...(row.description !== undefined ? { description: row.description } : {}),
    status: row.status,
    startTime: row.startTime,
    ...(row.endTime !== undefined ? { endTime: row.endTime } : {}),
    ...(row.outputFile !== undefined ? { outputFile: row.outputFile } : {}),
    ...(row.cwd !== undefined ? { cwd: row.cwd } : {}),
    ...(row.kind === 'monitor' ? { kind: 'monitor' as const } : {}),
    ...(row.exitCode !== undefined ? { exitCode: row.exitCode } : {}),
  }
}

type Tail = { content: string; totalBytes: number; totalLines: number; present: boolean }

type LineCount = { path: string | undefined; scanned: number; lines: number; open: boolean }

function freshLineCount(path: string | undefined): LineCount {
  return { path, scanned: 0, lines: 0, open: false }
}

function advanceLineCount(count: LineCount, size: number): number {
  if (count.path === undefined) return 0
  if (size < count.scanned) {
    count.scanned = 0
    count.lines = 0
    count.open = false
  }
  if (size > count.scanned) {
    const fd = openSync(count.path, 'r')
    try {
      const chunk = Buffer.alloc(Math.min(COUNT_CHUNK_BYTES, size - count.scanned))
      while (count.scanned < size) {
        const read = readSync(fd, chunk, 0, Math.min(chunk.length, size - count.scanned), count.scanned)
        if (read === 0) break
        for (let i = 0; i < read; i++) {
          if (chunk[i] === 10) {
            if (count.open) count.lines++
            count.open = false
          } else {
            count.open = true
          }
        }
        count.scanned += read
      }
    } finally {
      closeSync(fd)
    }
  }
  return count.lines + (count.open ? 1 : 0)
}

function readTail(path: string | undefined, count: LineCount): Tail {
  if (path === undefined) return { content: '', totalBytes: 0, totalLines: 0, present: false }
  try {
    const tail = tailFileSync(path, TAIL_BYTES)
    return { content: tail.content, totalBytes: tail.bytesTotal, totalLines: advanceLineCount(count, tail.bytesTotal), present: true }
  } catch (error) {
    const missing = (error as { code?: string }).code === 'ENOENT'
    return { content: '', totalBytes: 0, totalLines: 0, present: !missing }
  }
}

const wrappedRows = (text: string, width: number): number => wrapText(text, width, 'wrap').split('\n').length

function fitRows(text: string, width: number, maxRows: number): string {
  if (wrappedRows(text, width) <= maxRows) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (wrappedRows(`${text.slice(0, mid)}…`, width) <= maxRows) low = mid
    else high = mid - 1
  }
  return `${text.slice(0, low)}…`
}

function stateWord(shell: ShellCardFacts): string {
  switch (shell.status) {
    case 'completed':
      return 'done'
    case 'killed':
      return 'killed'
    case 'failed':
      return 'failed'
    default:
      return 'running'
  }
}

export function ShellDetailDialog(arg0: {
  shell: ShellCardFacts
  onDone: () => void
  onKillShell?: () => void
  onBack?: () => void
}): React.ReactNode {
  return notBuilt('src/components/tasks/ShellDetailDialog.tsx:154')
}
