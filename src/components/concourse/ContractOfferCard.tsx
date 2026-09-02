import React, { useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import TextInput from '../TextInput.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { keyHintLabel } from '../mercury-ui/keyHintLabel.js'
import { PermissionDialog } from '../permissions/PermissionDialog.js'
import { PermissionPrompt, type PermissionPromptOption } from '../permissions/PermissionPrompt.js'


type ContractOfferAnswer = 'yes' | 'no'

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
  const visibleLines = Math.max(2, Math.min(6, rows - 11))

  const submit = (raw: string): void => {
    const words = raw.trim()
    if (words.length === 0) {
      setNote('type the contract first — or esc starts the session plain')
      return
    }
    onAnswer(words)
  }

  return (
    <Box flexDirection="column" flexShrink={0}>
      <PermissionDialog title="Start with a contract?">
        <Box flexDirection="column" flexShrink={0}>
          {face === 'ask' ? (
            <>
              <Box flexShrink={0}>
                <Text dimColor wrap="wrap">
                  a contract is the session's work agreement — what it is for, in your words. It is
                  advisory: the agent is encouraged by it and acknowledges it in its own words, never
                  fenced by it. Yes opens a field here to write one and the session births under it;
                  No births the session plain — /contract can add one any time.
                </Text>
              </Box>
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
              <Box flexShrink={0}>
                <Text dimColor wrap="wrap">
                  the session's work agreement, in your words — advisory: the agent acknowledges it,
                  never fenced by it.
                </Text>
              </Box>
              <Box flexDirection="column" flexShrink={0} marginTop={1}>
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
              <Box flexDirection="column" flexShrink={0} marginTop={1}>
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
