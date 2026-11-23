import * as React from 'react'
import { Box, Text } from '../../../screen/themedRenderer.js'
import TextInput from '../../../screen/composer/text-input/TextInput.js'
import type { useMercuryTokens } from '../../../screen/widgets/useMercuryTokens.js'
import {
  GEMINI_CLIENT_STORED_UNVERIFIED_NOTE,
  type GeminiConnectHandles,
} from '../../roads/gemini/geminiAccounts.js'
import { GEMINI_CONNECT_CANCELLED_RECEIPT } from '../../roads/gemini/geminiLogin.js'
import {
  geminiGuideHint,
  geminiGuidePaneLines,
  type GeminiGuideLine,
  type GeminiGuideStepNumber,
} from './geminiConnectGuide.js'

type Setter<T> = React.Dispatch<React.SetStateAction<T>>

type ClientStepsArgs = {
  GuideLines: (props: { lines: GeminiGuideLine[] }) => React.ReactNode
  step: GeminiGuideStepNumber
  tokens: ReturnType<typeof useMercuryTokens>
  compact: boolean
  popupCompact: boolean
  field: 'id' | 'secret'
  setField: Setter<'id' | 'secret'>
  clientId: string
  setClientId: Setter<string>
  submitClientId: (raw: string) => void
  clientCursor: number
  setClientCursor: Setter<number>
  stepFiveBackRef: { current: 'step4' | 'choice' }
  backToChoice: () => void
  enterStep: (next: GeminiGuideStepNumber, withNote?: string) => void
  clientSecret: string
  setClientSecret: Setter<string>
  submitClientSecret: (raw: string) => void
  note: string | undefined
  setNote: Setter<string | undefined>
  phase: 'starting' | 'waiting' | 'exchanging'
  listenerNote: string | undefined
  authorizeUrl: string | undefined
  paste: string
  setPaste: (next: string) => void
  submitPaste: (raw: string) => void
  cursorOffset: number
  setCursorOffset: Setter<number>
  handlesRef: { current: GeminiConnectHandles | undefined }
  settle: (receipt: string, ok?: boolean) => void
  copied: boolean
}

export function geminiClientSteps({ GuideLines, step, tokens, compact, popupCompact, field, setField, clientId, setClientId, submitClientId, clientCursor, setClientCursor, stepFiveBackRef, backToChoice, enterStep, clientSecret, setClientSecret, submitClientSecret, note, setNote, phase, listenerNote, authorizeUrl, paste, setPaste, submitPaste, cursorOffset, setCursorOffset, handlesRef, settle, copied }: ClientStepsArgs): React.ReactNode {
  if (step === 5) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <GuideLines lines={geminiGuidePaneLines({ step, compact })} />
        <Text color={tokens.textSecondary} wrap="wrap">
          {GEMINI_CLIENT_STORED_UNVERIFIED_NOTE}
        </Text>
        {field === 'id' ? (
          <Box>
            <Text>Client id: </Text>
            <TextInput
              value={clientId}
              onChange={setClientId}
              onSubmit={submitClientId}
              columns={48}
              cursorOffset={clientCursor}
              onChangeCursorOffset={setClientCursor}
              onEscape={() => {
                if (stepFiveBackRef.current === 'choice') backToChoice()
                else enterStep(4)
              }}
            />
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text>
              Client id: <Text color={tokens.success}>{clientId}</Text> ✓
            </Text>
            <Box>
              <Text>Client secret (optional, ↵ skips): </Text>
              <TextInput
                value={clientSecret}
                onChange={setClientSecret}
                onSubmit={submitClientSecret}
                mask="*"
                columns={40}
                cursorOffset={clientCursor}
                onChangeCursorOffset={setClientCursor}
                onEscape={() => {
                  setClientSecret('')
                  setField('id')
                  setClientCursor(clientId.length)
                  setNote(undefined)
                }}
              />
            </Box>
          </Box>
        )}
        {note !== undefined ? (
          <Text color={tokens.warning} wrap="wrap">
            {note}
          </Text>
        ) : null}
        <Text dimColor>{geminiGuideHint(5, field)}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={popupCompact ? 0 : 1}>
      {popupCompact ? null : <GuideLines lines={geminiGuidePaneLines({ step: 6, compact })} />}
      {phase === 'exchanging' ? <Text color={tokens.textSecondary}>Exchanging the authorization code…</Text> : null}
      {listenerNote ? <Text color={tokens.warning}>{listenerNote}</Text> : null}
      {authorizeUrl && phase !== 'exchanging' ? (
        <>
          {popupCompact ? null : <Text color={tokens.textMuted}>If nothing opened, visit:</Text>}
          <Text color={tokens.info} wrap={popupCompact ? 'truncate-end' : 'wrap'}>
            {authorizeUrl}
          </Text>
          <Box>
            <Text color={tokens.textMuted}>or paste the redirected URL: </Text>
            <TextInput
              value={paste}
              onChange={setPaste}
              onSubmit={submitPaste}
              mask="*"
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              columns={48}
              onEscape={() => {
                handlesRef.current?.cancel('cancelled from the connect surface')
                settle(GEMINI_CONNECT_CANCELLED_RECEIPT)
              }}
            />
          </Box>
        </>
      ) : null}
      {copied ? <Text color={tokens.success}>Copied to clipboard</Text> : null}
      <Text dimColor>{geminiGuideHint(6)}</Text>
    </Box>
  )
}
