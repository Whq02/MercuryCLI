
import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
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

export type ShellCardFacts = {
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
    command: shell.command,
    ...(shell.description !== '' ? { description: shell.description } : {}),
    status: shell.status,
    startTime: shell.startTime,
    ...(shell.endTime !== undefined ? { endTime: shell.endTime } : {}),
    ...(shell.totalPausedMs !== undefined ? { totalPausedMs: shell.totalPausedMs } : {}),
    outputFile: shell.outputFile,
    ...(shell.verifyCwd !== undefined ? { cwd: shell.verifyCwd } : {}),
    ...(shell.kind !== undefined ? { kind: shell.kind } : {}),
    ...(shell.result !== undefined ? { exitCode: shell.result.code } : {}),
  }
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

export function freshLineCount(path: string | undefined): LineCount {
  return { path, scanned: 0, lines: 0, open: false }
}

export function advanceLineCount(count: LineCount, size: number): number {
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

export function fitRows(text: string, width: number, maxRows: number): string {
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
  const elapsed = useElapsedTime(
    shell.startTime,
    running,
    1000,
    shell.totalPausedMs,
    shell.endTime,
  )
  const exitState = useExitOnCtrlCD(useKeybindings)

  const count = useRef(freshLineCount(shell.outputFile))
  const [tail, setTail] = useState(() => readTail(shell.outputFile, count.current))
  useEffect(() => {
    if (count.current.path !== shell.outputFile) count.current = freshLineCount(shell.outputFile)
    setTail(readTail(shell.outputFile, count.current))
    if (!running) return
    const timer = setInterval(() => {
      setTail(readTail(shell.outputFile, count.current))
    }, 1000)
    return () => clearInterval(timer)
  }, [shell.outputFile, running])
  const deferredTail = useDeferredValue(tail)

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === ' ' || e.key === 'escape') {
      e.stopImmediatePropagation()
      onDone()
      return
    }
    if (e.key === 'left') {
      e.stopImmediatePropagation()
      if (onBack) onBack()
      else onDone()
      return
    }
    if (e.key === 'x' && running && onKillShell) {
      e.stopImmediatePropagation()
      onKillShell()
    }
  }
  useInput((_input, _key, event) => {
    handleKeyDown(new KeyboardEvent(event.keypress))
  })
  useKeybinding('confirm:yes', () => onDone(), { context: 'Confirmation' })

  const isMonitor = shell.kind === 'monitor'
  const commandLabel = isMonitor ? 'script' : 'command'
  const exitCode = shell.exitCode
  const valueWidth = Math.max(20, columns - 4 - LABEL_WIDTH)
  const cwdRows = shell.cwd !== undefined ? 1 : 0
  const commandRowsMax = Math.max(1, rows - CARD_ROWS_ABOVE_KEYS - HOST_FOOTER_ROWS - cwdRows)
  const commandText = useMemo(() => fitRows(shell.command, valueWidth, commandRowsMax), [shell.command, valueWidth, commandRowsMax])
  const commandRows = wrappedRows(commandText, valueWidth)
  const fixedRows = commandRows + cwdRows + CARD_CHROME_ROWS
  const frameRows = Math.max(FRAME_ROWS_FLOOR, Math.min(FRAME_ROWS, rows - fixedRows))
  const lines = deferredTail.content
    .split('\n')
    .filter(line => line !== '')
  const shown = lines.slice(-Math.min(OUTPUT_LINES, frameRows - 2))
  const frameWidth = Math.max(20, columns - 6)
  const truncatedRead = deferredTail.totalBytes > TAIL_BYTES

  return (
    <CommandCenter
      view={isMonitor ? 'monitor' : 'shell'}
      subtitle={shell.description}
      onClose={onDone}
      captureInput={false}
    >
      <Box flexDirection="column" tabIndex={-1}>
        <Box flexDirection="row">
          <Box width={LABEL_WIDTH} flexShrink={0}>
            <Text dimColor>{commandLabel}</Text>
          </Box>
          <Box flexGrow={1} minWidth={0} height={commandRows} overflow="hidden">
            <Text dimColor wrap="wrap">
              {commandText}
            </Text>
          </Box>
        </Box>
        {shell.cwd !== undefined ? (
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
            <Text
              color={
                shell.status === 'completed'
                  ? tokens.success
                  : shell.status === 'killed'
                    ? tokens.warning
                    : tokens.failure
              }
            >
              {stateWord(shell)}
              {exitCode !== undefined ? ` (exit ${exitCode})` : ''}
              <Text dimColor> · {elapsed}</Text>
            </Text>
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
          {!deferredTail.present ? (
            <Text dimColor>
              {shell.outputFile === undefined ? OUTPUT_UNREPORTED : OUTPUT_ABSENT}
            </Text>
          ) : shown.length === 0 ? (
            <Text dimColor>
              {running ? 'no output yet' : 'no output'}
            </Text>
          ) : (
            shown.map((line, index) => (
              <Text key={index} wrap="truncate-end">
                {line}
              </Text>
            ))
          )}
        </Box>
        <Text dimColor italic>
          {shown.length} of {deferredTail.totalLines} {deferredTail.totalLines === 1 ? 'line' : 'lines'} shown
          {truncatedRead
            ? ` · ${formatFileSize(deferredTail.totalBytes)} total`
            : ''}
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
              <KeyboardShortcutHint shortcut="esc" action="close" />
            </Text>
          )}
        </Box>
      </Box>
    </CommandCenter>
  )
}
