import React, { useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import TextInput from '../TextInput.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { keyHintLabel } from '../mercury-ui/keyHintLabel.js'
import { PermissionDialog } from '../permissions/PermissionDialog.js'
import { PermissionPrompt, type PermissionPromptOption } from '../permissions/PermissionPrompt.js'

// ============================================================================
//  ContractOfferCard — the coordinator-tooling ledger's T2 offer (operator
//  ruling): a CONCOURSE New Session birth asks "start with contract.
//  Yes. No." as a permission-class card in the LIVE-VIEW pane — in the
//  live session view, to the right of the focused chat, never on it —
//  never a boot-menu birth ("from the boot face, it starts with no
//  contract"). Yes opens the card's OWN text field ("What is the
//  contract?" — ledger L25); No just births. esc = No.
//
//  THE TWO FACES (ledger L25, the operator's morning report): the ask face
//  (Yes/No — the one consent option grammar) and the field face — Yes keeps
//  the card STANDING and opens a multi-line box INSIDE its frame, the
//  question in the operator's own words; ↵ births the session under the
//  words, ⇧↵ breaks a line, esc births plain; an empty ↵ keeps the card (a
//  blank contract is no contract). The words never touch the live
//  composer: the pre-fix Yes CLOSED the card and routed the typing to the
//  board's live box beneath whichever session's transcript the board had
//  selected, with nothing on screen saying the box had become the contract
//  — "it should then have a field saying, what is the contract? … It
//  shouldn't be, like, type into the composer because also typing into the
//  composer shows a chat that isn't actually the current chat." The pane
//  keeps the card while it stands, so no sibling transcript paints behind
//  the field.
//
//  ASK-EACH-TIME, MEMORYLESS (T2's flagged-unsettled wording, STRIKE-ABLE
//  at the operator's look): the ask paints on EVERY concourse birth and
//  stores nothing — one key declines; quieting it is the operator's strike
//  to make, not a remembered-away default.
//
//  REUSE, never a lookalike (the SeatOverloadCard law): this file composes
//  the estate's real owners VERBATIM — PermissionDialog (the one consent
//  frame), PermissionPrompt (the one option grammar: ↑↓ choose · ↵ confirm ·
//  esc cancel, clickable rows) and TextInput (the one text field — the
//  composer's own caret, wrap, ⇧↵ newline and paste laws). ADVISORY
//  ALWAYS: the contract encourages the agent, never fences it — nothing
//  gates on the answer.
// ============================================================================

type ContractOfferAnswer = 'yes' | 'no'

export function ContractOfferCard({
  onAnswer,
  width,
  rows,
}: {
  /** A string = the Yes leg landed: the words ARE the contract and the
   *  session births under them; null = the No leg (esc from either face):
   *  the session births plain, nothing else changes. */
  onAnswer: (contractText: string | null) => void
  /** The pane's interior width — the field wraps inside the card's frame. */
  width: number
  /** The pane's interior rows — they bound the field's visible height. */
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
  // The frame costs six columns (the mount's, the dialog's and its body's
  // padding); the field wraps inside what remains. Its visible height
  // leaves room for the question, the blurb and the keys.
  const columns = Math.max(16, width - 6)
  const visibleLines = Math.max(2, Math.min(6, rows - 11))

  const submit = (raw: string): void => {
    const words = raw.trim()
    if (words.length === 0) {
      // An empty ↵ births nothing — a blank contract is no contract; the
      // card stays and says so (esc still births plain).
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
                // C3 (win-triage S10): esc here BIRTHS the session plain —
                // the inherited 'esc cancel' printed an act that never
                // happens on this card.
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
              {/* Two rows so every printed key survives the pane's width
                  (each key names its real binder: ↵ = onSubmit · ⇧↵ = the
                  text input's own shift-enter newline · esc = onEscape). */}
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
