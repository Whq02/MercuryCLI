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

// ============================================================================
//  RouterOpenaiConnect — the Mercury-native OpenAI subscription connect
//  surface (hosted by /logins's OpenAI method; the operator
//  order retired the /router arms). Browser mode
//  opens the PKCE authorize URL and captures the code via the fixed loopback
//  listener OR the paste fallback (the full redirected URL, or `code#state`);
//  device mode shows the user code for a second machine's browser. Secrets
//  never render — the receipt carries plan/account facts only, and completes
//  with a forced live-catalogue refresh so readiness is proven, not assumed.
// ============================================================================

export function RouterOpenaiConnect({
  mode,
  onDone,
  onResult,
  onSwitchToDevice,
}: {
  mode: 'browser' | 'device'
  onDone: (receipt: string) => void
  /** Structured outcome for host surfaces that branch on success (the /logins
   *  card) — called alongside nothing else; when present, onDone is NOT
   *  called (the host owns settling its own command). */
  onResult?: (result: { ok: boolean; receipt: string }) => void
  /** Browser-mode hosts that can remount in device mode pass this; 'd'
   *  (empty paste field) switches — the headless path lives IN /logins now
   *  (no capability lost with the /router arm's retirement). */
  onSwitchToDevice?: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [paste, setPaste] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [phase, setPhase] = useState<'starting' | 'waiting' | 'exchanging'>('starting')
  const [listenerNote, setListenerNote] = useState<string | undefined>(undefined)
  const [authorizeUrl, setAuthorizeUrl] = useState<string | undefined>(undefined)
  const [device, setDevice] = useState<{ userCode: string; verifyHint: string } | undefined>(
    undefined,
  )
  const handlesRef = useRef<OpenaiConnectHandles | undefined>(undefined)
  const settledRef = useRef(false)
  // The d-switch cancels the browser flow to REMOUNT in device mode — that
  // cancellation's rejection must never settle the host as a failure (it
  // closed /logins with "OpenAI connect failed: switching to the
  // device-code flow" and the device leg never ran). Set synchronously
  // BEFORE cancel(): the rejection lands on a microtask, ahead of React's
  // unmount commit, so an unmount-scoped flag alone cannot guard it.
  const switchingRef = useRef(false)

  const settle = (receipt: string, ok = false): void => {
    if (settledRef.current) return
    settledRef.current = true
    if (onResult) onResult({ ok, receipt })
    else onDone(receipt)
  }

  const finishConnected = async (ref: OpenaiAccountRef): Promise<void> => {
    // The settle sentence + the catalogue proof live in the ONE login door
    // (openaiLogin — shared with the Boot face's logins layer).
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
        // A d-switch cancellation is not an outcome — the device remount
        // carries the flow on; only a real browser-leg failure settles.
        if (switchingRef.current) return
        settle(openaiConnectFailedReceipt(error, 'browser'))
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  const [copied, setCopied] = useState(false)
  useInput((input, key) => {
    if (key.escape) {
      if (mode === 'browser') {
        handlesRef.current?.cancel('cancelled from the connect surface')
        settle(OPENAI_CONNECT_STOPPED_RECEIPT)
      } else {
        // The device poll has no cancel handle: stopping the watch leaves the
        // background poll to land the connection if the code is approved.
        settle(OPENAI_DEVICE_STOPPED_RECEIPT)
      }
      return
    }
    // 'c' copies the actionable value — the URL (browser) / the one-time
    // code (device) — ONLY while the paste field is empty, so typing a code
    // containing 'c' never triggers it (the ConsoleOAuthFlow pattern; the
    // advertised-keys-fire invariant).
    if (input === 'c' && !key.ctrl && !key.meta && paste === '' && phase !== 'exchanging') {
      const value = mode === 'browser' ? authorizeUrl : device?.userCode
      if (!value) return
      void setClipboard(value).then(sequence => {
        if (sequence) process.stdout.write(sequence)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
      return
    }
    // 'd' switches a browser host to the device-code flow (headless): the
    // browser handles cancel cleanly, the host remounts in device mode.
    if (
      input === 'd' &&
      !key.ctrl && !key.meta &&
      mode === 'browser' &&
      onSwitchToDevice !== undefined &&
      paste === '' &&
      phase !== 'exchanging'
    ) {
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
