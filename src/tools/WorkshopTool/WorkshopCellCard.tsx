import React, { useMemo } from 'react'
import { exitChordNoticeText } from '../../components/PromptInput/ExitChordNotice.js'
import { Box, Text, useInput } from '../../ink.js'
import { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import { useExitOnCtrlCD } from '../../hooks/useExitOnCtrlCD.js'
import wrapText from '../../ink/wrap-text.js'
import { KeyboardShortcutHint } from '../../components/design-system/KeyboardShortcutHint.js'
import { CommandCenter, SectionHeader } from '../../components/mercury-ui/components.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { fitRows } from '../../components/tasks/ShellDetailDialog.js'
import { AMBER } from '../../components/mercuryPalette.js'
import { lastShellCallOf, shellCallHeadline, type WorkshopCellCardFacts } from './cellCards.js'

const CHROME_ROWS = 6
const LABEL_WIDTH = 8
const ERROR_FLOOR = 3
const OUTPUT_LINES = 10
const RUNTIME_KILLED = 'runtime killed — retained state lost'

const wrappedRows = (text: string, width: number): number => wrapText(text, width, 'wrap').split('\n').length

export function cellCardRows(rows: number, wanted: { code: number; error: number; output: number; killed: boolean; shell?: number }): { code: number; error: number; output: number | null; shell: number } {
  const body = Math.max(1, rows - CHROME_ROWS)
  const baseFixed = 3 + (wanted.killed ? 1 : 0)
  const shell = Math.min(wanted.shell ?? 0, Math.max(0, Math.floor((body - baseFixed - 1) / 3)))
  const fixed = baseFixed + shell
  const showOutput = wanted.output > 0 && wanted.error + 4 <= body - fixed - 1
  let left = Math.max(2, body - fixed - 1 - (showOutput ? 2 : 0))
  let error = wanted.error
  if (wanted.error > left - 1) {
    left = Math.max(2, left - 1)
    error = wanted.code > 1 ? Math.min(left - 1, Math.max(Math.min(ERROR_FLOOR, wanted.error), Math.ceil(left * 0.6))) : left - 1
  }
  const code = Math.max(1, Math.min(wanted.code, left - error - (showOutput ? 1 : 0)))
  if (wanted.error > error) error = Math.min(wanted.error, left - code)
  const output = showOutput ? Math.max(0, Math.min(wanted.output, left - error - code)) : null
  return { code, error, output, shell }
}

export function WorkshopCellCard({
  cell,
  onDone,
  onBack,
}: {
  cell: WorkshopCellCardFacts
  onDone: () => void
  onBack?: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { columns, rows } = useTerminalSize()
  const exitState = useExitOnCtrlCD(useKeybindings)

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
    }
  }
  useInput((_input, _key, event) => {
    handleKeyDown(new KeyboardEvent(event.keypress))
  })
  useKeybinding('confirm:yes', () => onDone(), { context: 'Confirmation' })

  const valueWidth = Math.max(20, columns - 4 - LABEL_WIDTH)
  const lineWidth = Math.max(20, columns - 4)
  const code = cell.code === '' ? 'code not in the transcript' : cell.code
  const error = cell.error === '' ? (cell.state === 'timed-out' ? 'the cell timed out' : 'the cell failed') : cell.error
  const tail = cell.outputTail.slice(-OUTPUT_LINES)
  const shellCall = lastShellCallOf(cell)
  const shellTail = shellCall?.outputTail ?? []
  const shellWanted = shellCall === undefined ? 0 : 1 + shellTail.length
  const plan = useMemo(
    () => cellCardRows(rows, { code: wrappedRows(code, valueWidth), error: wrappedRows(error, lineWidth), output: tail.length, killed: cell.runtimeKilled, shell: shellWanted }),
    [rows, code, error, tail.length, cell.runtimeKilled, valueWidth, lineWidth, shellWanted],
  )
  const codeText = useMemo(() => fitRows(code, valueWidth, plan.code), [code, valueWidth, plan.code])
  const errorText = useMemo(() => fitRows(error, lineWidth, plan.error), [error, lineWidth, plan.error])
  const errorLines = wrappedRows(error, lineWidth)
  const shown = plan.output === null ? [] : tail.slice(-plan.output)
  const shellShown = plan.shell > 1 ? shellTail.slice(-(plan.shell - 1)) : []
  const stateWord = cell.state === 'timed-out' ? 'timed out' : 'failed'

  return (
    <CommandCenter elevated view="workshop" subtitle={cell.cellId} onClose={onDone} captureInput={false}>
      <Box flexDirection="column" tabIndex={-1}>
        <Box flexDirection="row">
          <Box width={LABEL_WIDTH} flexShrink={0}>
            <Text dimColor>cell</Text>
          </Box>
          <Box flexGrow={1} minWidth={0}>
            <Text wrap="truncate-end">
              {cell.language}
              {cell.title !== undefined ? ` · ${cell.title}` : ''}
            </Text>
          </Box>
        </Box>
        <Box flexDirection="row">
          <Box width={LABEL_WIDTH} flexShrink={0}>
            <Text dimColor>code</Text>
          </Box>
          <Box flexGrow={1} minWidth={0} height={plan.code} overflow="hidden">
            <Text dimColor wrap="wrap">
              {codeText}
            </Text>
          </Box>
        </Box>
        <Box>
          <Text color={tokens.failure}>
            {stateWord}
            <Text dimColor>
              {' · '}
              {cell.durationMs}ms · gen {cell.generation}
              {plan.output === null && cell.outputTail.length > 0 ? ` · ${cell.outputTail.length} output ${cell.outputTail.length === 1 ? 'line' : 'lines'}` : ''}
            </Text>
          </Text>
        </Box>
        {cell.runtimeKilled ? <Text color={AMBER}>{RUNTIME_KILLED}</Text> : null}
        <SectionHeader>Error</SectionHeader>
        <Box flexDirection="column" height={plan.error} overflow="hidden">
          <Text color={tokens.failure} wrap="wrap">
            {errorText}
          </Text>
        </Box>
        {errorLines > plan.error ? (
          <Text dimColor italic>
            {plan.error} of {errorLines} lines shown
          </Text>
        ) : null}
        {shellCall !== undefined && plan.shell > 0 ? (
          <>
            <Box flexDirection="row">
              <Box width={LABEL_WIDTH} flexShrink={0}>
                <Text dimColor>{shellCall.refused === true ? 'refused' : 'command'}</Text>
              </Box>
              <Box flexGrow={1} minWidth={0}>
                <Text wrap="truncate-end">{shellCallHeadline(shellCall)}</Text>
              </Box>
            </Box>
            {shellShown.map((line, index) => (
              <Box key={index} flexDirection="row">
                <Box width={LABEL_WIDTH} flexShrink={0} />
                <Box flexGrow={1} minWidth={0}>
                  <Text dimColor wrap="truncate-end">
                    {line}
                  </Text>
                </Box>
              </Box>
            ))}
          </>
        ) : null}
        {plan.output !== null ? (
          <>
            <SectionHeader>Output</SectionHeader>
            {shown.map((line, index) => (
              <Text key={index} dimColor wrap="truncate-end">
                {line}
              </Text>
            ))}
            <Text dimColor italic>
              {shown.length} of {cell.outputTail.length} {cell.outputTail.length === 1 ? 'line' : 'lines'} shown
              {cell.artifactRef !== undefined ? ` · full output: ${cell.artifactRef}` : ''}
            </Text>
          </>
        ) : null}
        <Box>
          {exitState.pending ? (
            <Text dimColor>{exitChordNoticeText(exitState.keyName)}</Text>
          ) : (
            <Text dimColor>
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
