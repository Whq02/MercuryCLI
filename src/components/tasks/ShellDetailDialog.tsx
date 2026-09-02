// Detail card for a background shell/monitor: a 1-second output-file
// tail poll (last 8 KiB, deferred, never installed for a settled task), the
// last 10 lines in a fixed 12-row rounded frame, honest empties by liveness,
// and a state line whose running glyph rides the live tone — routing
// "running" through the generic background role is what makes a
// healthy shell look like a failure. Escape is bound explicitly here: this
// card hosts its own command-center shell with input capture disabled.

import React, { useDeferredValue, useEffect, useState } from 'react'
import { exitChordNoticeText } from '../PromptInput/ExitChordNotice.js'
import { Box, Text, useInput } from '../../ink.js'
import { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import { useExitOnCtrlCD } from '../../hooks/useExitOnCtrlCD.js'
import type { LocalShellTaskState } from '../../tasks/LocalShellTask/guards.js'
import { formatFileSize } from '../../utils/format.js'
import { tailFileSync } from '../../utils/fsOperations.js'
import { truncateToWidth } from '../mercury-ui/glyphs.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { CommandCenter, SectionHeader } from '../mercury-ui/components.js'
import { WorkingGlyph } from '../mercury-ui/LiveGlyphs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'

/** Tail read size: the last 8 KiB of the output file. */
const TAIL_BYTES = 8 * 1024
/** Output frame: last 10 lines inside a fixed 12-row rounded frame. */
const OUTPUT_LINES = 10
const FRAME_ROWS = 12
/** Command display cap, by display width. */
const COMMAND_WIDTH_CAP = 280

function readTail(path: string): { content: string; totalBytes: number } {
  try {
    // Bounded: the final 8 KiB only, at any file size — the whole-file
    // readFileSync form re-read + re-decoded a growing build log every
    // second, and past V8's max string length it threw, so the frame said
    // "0 lines shown" while the file kept growing (TASK-017 S2).
    const tail = tailFileSync(path, TAIL_BYTES)
    return { content: tail.content, totalBytes: tail.bytesTotal }
  } catch {
    return { content: '', totalBytes: 0 }
  }
}

function stateWord(shell: LocalShellTaskState): string {
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
  shell: LocalShellTaskState
  onDone: () => void
  onKillShell?: () => void
  onBack?: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns } = useTerminalSize()
  const running = shell.status === 'running' || shell.status === 'pending'
  const elapsed = useElapsedTime(
    shell.startTime,
    running,
    1000,
    shell.totalPausedMs,
    shell.endTime,
  )
  const exitState = useExitOnCtrlCD(useKeybindings)

  // The tail poll: 1 Hz while running only; a settled task reads once.
  const [tail, setTail] = useState(() => readTail(shell.outputFile))
  useEffect(() => {
    setTail(readTail(shell.outputFile))
    if (!running) return
    const timer = setInterval(() => {
      setTail(readTail(shell.outputFile))
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

  const lines = deferredTail.content
    .split('\n')
    .filter(line => line !== '')
  const shown = lines.slice(-OUTPUT_LINES)
  const frameWidth = Math.max(20, columns - 6)
  const truncatedRead = deferredTail.totalBytes > TAIL_BYTES

  const isMonitor = shell.kind === 'monitor'
  const commandLabel = isMonitor ? 'script' : 'command'
  const exitCode = shell.result?.code

  return (
    <CommandCenter
      view={isMonitor ? 'monitor' : 'shell'}
      subtitle={shell.description}
      onClose={onDone}
      captureInput={false}
    >
      <Box flexDirection="column" tabIndex={-1}>
        <Text dimColor wrap="truncate-end">
          {commandLabel} {truncateToWidth(shell.command, COMMAND_WIDTH_CAP)}
        </Text>
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
          height={FRAME_ROWS}
          width={frameWidth}
          borderStyle="round"
          borderDimColor
          paddingX={1}
          overflow="hidden"
        >
          {shown.length === 0 ? (
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
          {shown.length} {shown.length === 1 ? 'line' : 'lines'} shown
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
