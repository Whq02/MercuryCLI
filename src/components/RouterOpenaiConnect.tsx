import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'
import { setClipboard } from '../ink/termio/osc.js'
import { errorMessageWithCause } from '../utils/errors.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import {
  beginOpenaiBrowserConnect,
  beginOpenaiDeviceConnect,
  type OpenaiAccountRef,
  type OpenaiConnectHandles,
} from '../services/providers/openai/openaiAccounts.js'
import {
  OPENAI_CONNECT_STOPPED_RECEIPT,
  OPENAI_DEVICE_STOPPED_RECEIPT,
  finishOpenaiSubscriptionConnect,
  openaiConnectFailedReceipt,
} from '../services/providers/openai/openaiLogin.js'


export function RouterOpenaiConnect({
  mode,
  onDone,
  onResult,
  onSwitchToDevice,
}: {
  mode: 'browser' | 'device'
  onDone: (receipt: string) => void
  onResult?: (result: { ok: boolean; receipt: string }) => void
  onSwitchToDevice?: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [paste, setPasteState] = useState('')
  const pasteRef = useRef('')
  const setPaste = (next: string): void => {
    pasteRef.current = next
    setPasteState(next)
  }
  const [cursorOffset, setCursorOffset] = useState(0)
  const [phase, setPhase] = useState<'starting' | 'waiting' | 'exchanging'>('starting')
  const [listenerNote, setListenerNote] = useState<string | undefined>(undefined)
  const [authorizeUrl, setAuthorizeUrl] = useState<string | undefined>(undefined)
  const [device, setDevice] = useState<{ userCode: string; verifyHint: string } | undefined>(
    undefined,
  )
  const handlesRef = useRef<OpenaiConnectHandles | undefined>(undefined)
  const settledRef = useRef(false)
  const switchingRef = useRef(false)

  const settle = (receipt: string, ok = false): void => {
    if (settledRef.current) return
    settledRef.current = true
    if (onResult) onResult({ ok, receipt })
    else onDone(receipt)
  }

  const finishConnected = async (ref: OpenaiAccountRef): Promise<void> => {
    const outcome = await finishOpenaiSubscriptionConnect(ref)
    settle(outcome.receipt, outcome.ok)
  }

  useEffect(() => {
    let alive = true
    if (mode === 'device') {
      beginOpenaiDeviceConnect()
        .then(start => {
          if (!alive) return
          setDevice({ userCode: start.userCode, verifyHint: start.verifyHint })
          setPhase('waiting')
          start.result
            .then(ref => void finishConnected(ref))
            .catch(error => settle(openaiConnectFailedReceipt(error, 'device')))
        })
        .catch(error => settle(openaiConnectFailedReceipt(error, 'device')))
      return () => {
        alive = false
      }
    }
    const handles = beginOpenaiBrowserConnect({
      onListenerIssue: message => setListenerNote(message),
    })
    handlesRef.current = handles
    setAuthorizeUrl(handles.authorizeUrl)
    setPhase('waiting')
    handles.result
      .then(ref => void finishConnected(ref))
      .catch(error => {
        if (switchingRef.current) return
        settle(openaiConnectFailedReceipt(error, 'browser'))
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  const [copied, setCopied] = useState(false)
  useInput((input, key, event) => {
    if (key.escape) {
      if (mode === 'browser') {
        handlesRef.current?.cancel('cancelled from the connect surface')
        settle(OPENAI_CONNECT_STOPPED_RECEIPT)
      } else {
        settle(OPENAI_DEVICE_STOPPED_RECEIPT)
      }
      return
    }
    if (input === 'c' && !key.ctrl && !key.meta && pasteRef.current === '' && phase !== 'exchanging') {
      const value = mode === 'browser' ? authorizeUrl : device?.userCode
      if (!value) return
      event.stopImmediatePropagation()
      void setClipboard(value).then(sequence => {
        if (sequence) process.stdout.write(sequence)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
      return
    }
    if (
      input === 'd' &&
      !key.ctrl && !key.meta &&
      mode === 'browser' &&
      onSwitchToDevice !== undefined &&
      pasteRef.current === '' &&
      phase !== 'exchanging'
    ) {
      event.stopImmediatePropagation()
      switchingRef.current = true
      handlesRef.current?.cancel('switching to the device-code flow')
      handlesRef.current = undefined
      onSwitchToDevice()
    }
  })

  const submitPaste = (raw: string): void => {
    const value = raw.trim()
    if (!value) return
    setPhase('exchanging')
    handlesRef.current?.completeWithRedirect(value)
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={tokens.accent}>
        Connect OpenAI (ChatGPT subscription)
      </Text>
      {mode === 'browser' ? (
        <>
          <Text color={tokens.textSecondary}>
            {phase === 'exchanging'
              ? 'Exchanging the authorization code…'
              : 'A browser window should be opening for the OpenAI sign-in. Approve it and Mercury completes automatically via the loopback listener.'}
          </Text>
          {listenerNote ? <Text color={tokens.warning}>{listenerNote}</Text> : null}
          {authorizeUrl && phase !== 'exchanging' ? (
            <>
              <Text color={tokens.textMuted}>If nothing opened, visit:</Text>
              <Text color={tokens.info} wrap="wrap">
                {authorizeUrl}
              </Text>
              <Box>
                <Text color={tokens.textMuted}>or paste the redirected URL: </Text>
                <TextInput
                  value={paste}
                  onChange={setPaste}
                  onSubmit={submitPaste}
                  cursorOffset={cursorOffset}
                  onChangeCursorOffset={setCursorOffset}
                  columns={48}
                />
              </Box>
            </>
          ) : null}
          {copied ? <Text color={tokens.success}>Copied to clipboard</Text> : null}
          <Text color={tokens.textMuted}>c copies the URL{onSwitchToDevice ? ' · d device code (headless)' : ''} · ESC cancels.</Text>
        </>
      ) : (
        <>
          <Text color={tokens.textSecondary}>
            {device
              ? 'On any signed-in browser, enter this one-time code:'
              : 'Requesting a device code…'}
          </Text>
          {device ? (
            <>
              <Text bold color={tokens.info}>
                {device.userCode}
              </Text>
              <Text color={tokens.textMuted} wrap="wrap">
                {device.verifyHint}
              </Text>
              {copied ? <Text color={tokens.success}>Copied to clipboard</Text> : null}
              <Text color={tokens.textMuted}>Waiting for approval… c copies the code · ESC stops watching.</Text>
            </>
          ) : null}
        </>
      )}
    </Box>
  )
}
