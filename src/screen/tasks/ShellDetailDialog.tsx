import React, { useDeferredValue, useMemo, useRef, useState } from 'react'
import { useTimer } from '../effects/effects.js'
import { closeSync, openSync, readSync } from 'node:fs'
import { exitChordNoticeText } from '../composer/ExitChordNotice.js'
import { Box, Text, useInput } from '../themedRenderer.js'
import { useElapsedTime } from '../effects/useElapsedTime.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { useKeybinding } from '../keys/useKeybinding.js'
import { useExitChord } from '../keys/useExitChord.js'
import type { BashTaskKind, LocalShellTaskState } from '../../engine/tasks/local-shell/shellTaskState.js'
import type { WorkRowV1 } from '../../engine/connector/types.js'
import { formatFileSize } from '../../platform/text/format.js'
import { tailFileSync } from '../../platform/files/fsOperations.js'
import wrapText from '../renderer/wrap-text.js'
import { KeyboardShortcutHint } from '../theme/KeyboardShortcutHint.js'
import { CommandCenter, SectionHeader } from '../widgets/components.js'
import { WorkingGlyph } from '../widgets/LiveGlyphs.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { subscribeTaskOutputPath } from '../../engine/task-framework/diskOutput.js'

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
  id: string
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
  return {
    id: shell.id,
    command: shell.command,
    ...(shell.description !== undefined ? { description: shell.description } : {}),
    status: shell.status,
    startTime: shell.startTime,
    ...(shell.endTime !== undefined ? { endTime: shell.endTime } : {}),
    ...(shell.totalPausedMs !== undefined ? { totalPausedMs: shell.totalPausedMs } : {}),
    ...(shell.outputFile !== undefined ? { outputFile: shell.outputFile } : {}),
    ...(shell.verifyCwd !== undefined ? { cwd: shell.verifyCwd } : {}),
    ...(shell.kind !== undefined ? { kind: shell.kind } : {}),
    ...(shell.result !== undefined ? { exitCode: shell.result.code } : {}),
  }
}

export function shellCardFactsOfRow(row: WorkRowV1): ShellCardFacts {
  return {
    id: row.id,
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

export function ShellDetailDialog({
  shell,
  onDone,
  onKillShell,
  onBack,
}: {
  shell: ShellCardFacts
  onDone: () => void
  onKillShell?: () => void
  onBack?: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns, rows } = useTerminalSize()
  const running = shell.status === 'running' || shell.status === 'pending'
  const isMonitor = shell.kind === 'monitor'
  const elapsed = useElapsedTime(shell.startTime, running, 1000, shell.totalPausedMs, shell.endTime)
  const exitState = useExitChord()

  const lineCountRef = useRef<LineCount>(freshLineCount(shell.outputFile))
  if (lineCountRef.current.path !== shell.outputFile) {
    lineCountRef.current = freshLineCount(shell.outputFile)
  }

  const [tail, setTail] = useState<Tail>(() => readTail(shell.outputFile, lineCountRef.current))
  const deferredTail = useDeferredValue(tail)

  useTimer(() => {
    const path = shell.outputFile
    const refresh = (): void => {
      const next = readTail(path, lineCountRef.current)
      setTail(prev =>
        prev.present === next.present &&
        prev.totalBytes === next.totalBytes &&
        prev.totalLines === next.totalLines &&
        prev.content === next.content
          ? prev
          : next,
      )
    }
    refresh()
    if (!running || path === undefined) return
    return subscribeTaskOutputPath(path, refresh)
  }, [shell.outputFile, running])

  useKeybinding('confirm:yes', onDone, { context: 'Confirmation' })

  useInput((input, key) => {
    if (input === ' ' || key.escape) {
      onDone()
      return
    }
    if (key.leftArrow) {
      ;(onBack ?? onDone)()
      return
    }
    if (input === 'x' && running && onKillShell) {
      onKillShell()
    }
  })

  const cwdRows = shell.cwd !== undefined && shell.cwd !== '' ? 1 : 0
  const commandWidth = Math.max(20, columns - 4 - LABEL_WIDTH)
  const commandMaxRows = Math.max(1, rows - CARD_ROWS_ABOVE_KEYS - HOST_FOOTER_ROWS - cwdRows)
  const fittedCommand = useMemo(
    () => fitRows(shell.command, commandWidth, commandMaxRows),
    [shell.command, commandWidth, commandMaxRows],
  )
  const commandRows = wrappedRows(fittedCommand, commandWidth)
  const fixedRows = commandRows + cwdRows + CARD_CHROME_ROWS
  const frameRows = Math.max(FRAME_ROWS_FLOOR, Math.min(FRAME_ROWS, rows - fixedRows))
  const maxOutputLines = Math.min(OUTPUT_LINES, frameRows - 2)
  const frameWidth = Math.max(20, columns - 6)
  const truncated = deferredTail.totalBytes > TAIL_BYTES

  const nonEmptyLines = useMemo(
    () => deferredTail.content.split('\n').filter(line => line.length > 0),
    [deferredTail.content],
  )
  const visibleLines = nonEmptyLines.slice(-maxOutputLines)

  const statusTone =
    shell.status === 'completed'
      ? tokens.success
      : shell.status === 'killed'
        ? tokens.warning
        : tokens.failure

  const subtitle = shell.description !== undefined && shell.description !== '' ? shell.description : undefined

  return (
    <CommandCenter
      elevated
      view={isMonitor ? 'monitor' : 'shell'}
      subtitle={subtitle}
      onClose={onDone}
      captureInput={false}
    >
      <Box flexDirection="column" tabIndex={-1}>
        <Box flexDirection="row">
          <Box width={LABEL_WIDTH} flexShrink={0}>
            <Text dimColor>{isMonitor ? 'script' : 'command'}</Text>
          </Box>
          <Box flexGrow={1} minWidth={0} height={commandRows} overflow="hidden">
            <Text dimColor wrap="wrap">
              {fittedCommand}
            </Text>
          </Box>
        </Box>

        {shell.cwd !== undefined && shell.cwd !== '' ? (
          <Box flexDirection="row">
            <Box width={LABEL_WIDTH} flexShrink={0}>
              <Text dimColor>cwd</Text>
            </Box>
            <Box flexGrow={1} minWidth={0}>
              <Text dimColor wrap="truncate-middle">
                {shell.cwd}
              </Text>
            </Box>
          </Box>
        ) : null}

        <Box>
          {running ? (
            <>
              <WorkingGlyph color={tokens.success} active={true} />
              <Text> running · {elapsed}</Text>
            </>
          ) : (
            <>
              <Text color={statusTone}>
                {stateWord(shell)}
                {shell.exitCode !== undefined ? ` (exit ${shell.exitCode})` : ''}
              </Text>
              <Text dimColor> · {elapsed}</Text>
            </>
          )}
        </Box>

        <SectionHeader>Output</SectionHeader>
        <Box
          flexDirection="column"
          height={frameRows}
          width={frameWidth}
          borderStyle="round"
          borderDimColor
          paddingX={1}
          overflow="hidden"
        >
          {shell.outputFile === undefined ? (
            <Text dimColor>{OUTPUT_UNREPORTED}</Text>
          ) : !deferredTail.present ? (
            <Text dimColor>{OUTPUT_ABSENT}</Text>
          ) : visibleLines.length === 0 ? (
            <Text dimColor>{running ? 'no output yet' : 'no output'}</Text>
          ) : (
            visibleLines.map((line, index) => (
              <Text key={index} wrap="truncate-end">
                {line}
              </Text>
            ))
          )}
        </Box>

        <Text dimColor italic>
          {visibleLines.length} of {deferredTail.totalLines}{' '}
          {deferredTail.totalLines === 1 ? 'line' : 'lines'} shown
          {truncated ? ` · ${formatFileSize(deferredTail.totalBytes)} total` : ''}
        </Text>

        <Box marginTop={1}>
          {exitState.pending ? (
            <Text dimColor>{exitChordNoticeText(exitState.keyName)}</Text>
          ) : (
            <Text dimColor>
              {running && onKillShell ? (
                <>
                  <KeyboardShortcutHint shortcut="x" action="stop" />
                  {' · '}
                </>
              ) : null}
              {onBack ? (
                <>
                  <KeyboardShortcutHint shortcut="←" action="back" />
                  {' · '}
                </>
              ) : null}
              <KeyboardShortcutHint shortcut="Esc" action="close" />
            </Text>
          )}
        </Box>
      </Box>
    </CommandCenter>
  )
}
