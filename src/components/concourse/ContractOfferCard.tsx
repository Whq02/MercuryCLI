import React, { useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import TextInput from '../TextInput.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { keyHintLabel } from '../mercury-ui/keyHintLabel.js'
import { PermissionDialog } from '../permissions/PermissionDialog.js'
import { PermissionPrompt, type PermissionPromptOption } from '../permissions/PermissionPrompt.js'
import wrapText from '../../ink/wrap-text.js'


type ContractOfferAnswer = 'yes' | 'no'

export const CONTRACT_ASK_BLURB = `a contract is the session's work agreement — what it is for, in your words. It is advisory: the agent is encouraged by it and acknowledges it in its own words, never fenced by it. Yes opens a field here to write one and the session births under it; No births the session plain — /contract can add one any time.`
export const CONTRACT_FIELD_BLURB = `the session's work agreement, in your words — advisory: the agent acknowledges it, never fenced by it.`
export const CONTRACT_ASK_KEYS = '↑↓ choose · ↵ confirm · esc starts it plain'
export const CONTRACT_ASK_CHROME_ROWS = 9
export const CONTRACT_FIELD_CHROME_ROWS = 9

export type ContractCardFitV1 = {
  askBlurbRows: number | null
  liftMargin: boolean
  fieldBlurbRows: number | null
  fieldLines: number
  fieldGaps: boolean
}

export function contractCardTextColumns(width: number): number {
  return Math.max(8, width - 8)
}

export function contractCardFit(rows: number, textColumns: number): ContractCardFitV1 {
  const askLines = wrapText(CONTRACT_ASK_BLURB, textColumns, 'wrap').split('\n').length
  const keysRows = wrapText(CONTRACT_ASK_KEYS, textColumns, 'wrap').split('\n').length
  const askChrome = CONTRACT_ASK_CHROME_ROWS + keysRows - 1
  const fieldBlurbLines = wrapText(CONTRACT_FIELD_BLURB, textColumns, 'wrap').split('\n').length
  const visibleLines = Math.max(2, Math.min(6, rows - 11))
  const askBlurbRows = askChrome + askLines <= rows ? null : Math.min(askLines, Math.max(0, rows - askChrome))
  const fieldMin = Math.min(visibleLines, 2)
  const blurbRoom = rows - CONTRACT_FIELD_CHROME_ROWS - fieldMin
  const fieldBlurbRows = blurbRoom >= fieldBlurbLines ? null : Math.max(0, blurbRoom)
  const blurbShown = fieldBlurbRows ?? fieldBlurbLines
  const fieldGaps = CONTRACT_FIELD_CHROME_ROWS + blurbShown + 1 <= rows
  const chrome = fieldGaps ? CONTRACT_FIELD_CHROME_ROWS : CONTRACT_FIELD_CHROME_ROWS - 2
  const fieldLines = Math.max(1, Math.min(visibleLines, rows - chrome - blurbShown))
  return { askBlurbRows, liftMargin: askBlurbRows === 0 && askChrome > rows, fieldBlurbRows, fieldLines, fieldGaps }
}

export function ContractOfferCard({
  onAnswer,
  width,
  rows,
}: {
  onAnswer: (contractText: string | null) => void
  width: number
  rows: number
}): React.ReactNode {
  const t = useMercuryTokens()
  const [face, setFace] = useState<'ask' | 'field'>('ask')
  const [text, setText] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const options = useMemo<PermissionPromptOption<ContractOfferAnswer>[]>(
    () => [
      { label: 'Yes — write it here', value: 'yes' },
      { label: 'No, start it plain (esc)', value: 'no' },
    ],
    [],
  )
  const columns = Math.max(16, width - 6)
  const fit = contractCardFit(rows, contractCardTextColumns(width))
  const visibleLines = fit.fieldLines

  const submit = (raw: string): void => {
    const words = raw.trim()
    if (words.length === 0) {
      setNote('type the contract first — or esc starts the session plain')
      return
    }
    onAnswer(words)
  }

  return (
    <Box flexDirection="column" flexShrink={0} marginTop={face === 'ask' && fit.liftMargin ? -1 : 0}>
      <PermissionDialog title="Start with a contract?">
        <Box flexDirection="column" flexShrink={0}>
          {face === 'ask' ? (
            <>
              {fit.askBlurbRows === 0 ? null : (
                <Box flexShrink={0} {...(fit.askBlurbRows === null ? {} : { height: fit.askBlurbRows, overflow: 'hidden' as const })}>
                  <Text dimColor wrap="wrap">{CONTRACT_ASK_BLURB}</Text>
                </Box>
              )}
              <PermissionPrompt
                options={options}
                onSelect={value => (value === 'yes' ? setFace('field') : onAnswer(null))}
                onCancel={() => onAnswer(null)}
                escapeHint="esc starts it plain"
              />
            </>
          ) : (
            <>
              <Box flexShrink={0}>
                <Text bold wrap="wrap">
                  What is the contract?
                </Text>
              </Box>
              {fit.fieldBlurbRows === 0 ? null : (
                <Box flexShrink={0} {...(fit.fieldBlurbRows === null ? {} : { height: fit.fieldBlurbRows, overflow: 'hidden' as const })}>
                  <Text dimColor wrap="wrap">{CONTRACT_FIELD_BLURB}</Text>
                </Box>
              )}
              <Box flexDirection="column" flexShrink={0} marginTop={fit.fieldGaps ? 1 : 0}>
                <TextInput
                  value={text}
                  onChange={value => {
                    setText(value)
                    if (note !== null) setNote(null)
                  }}
                  onSubmit={submit}
                  onEscape={() => onAnswer(null)}
                  cursorOffset={cursorOffset}
                  onChangeCursorOffset={setCursorOffset}
                  columns={columns}
                  multiline
                  maxVisibleLines={visibleLines}
                  placeholder="what this session is for…"
                  focus
                />
              </Box>
              {note !== null ? (
                <Box flexShrink={0} marginTop={1}>
                  <Text color={t.warning} wrap="truncate-end">
                    {note}
                  </Text>
                </Box>
              ) : null}
              {
}
              <Box flexDirection="column" flexShrink={0} marginTop={fit.fieldGaps ? 1 : 0}>
                <Text color="subtle" wrap="truncate-end">
                  {keyHintLabel('↵ starts the session under it · ⇧↵ newline')}
                </Text>
                <Text color="subtle" wrap="truncate-end">
                  {'esc starts it plain — /contract can add one later'}
                </Text>
              </Box>
            </>
          )}
        </Box>
      </PermissionDialog>
    </Box>
  )
}
