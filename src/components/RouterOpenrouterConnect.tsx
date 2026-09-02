import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'
import { Select } from './CustomSelect/index.js'
import { setClipboard } from '../ink/termio/osc.js'
import { errorMessageWithCause } from '../utils/errors.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import {
  beginOpenrouterConnect,
  type OpenrouterAccountRef,
  type OpenrouterConnectHandles,
} from '../services/providers/openrouter/openrouterAccounts.js'
import {
  OPENROUTER_CONNECT_CANCELLED_RECEIPT,
  OPENROUTER_CONNECT_STOPPED_RECEIPT,
  finishOpenrouterConnect,
  openrouterConnectFailedReceipt,
  storeOpenrouterApiKeyLogin,
} from '../services/providers/openrouter/openrouterLogin.js'
import { keyPasteGuardNote } from './mercury-ui/screens/keyPasteGuards.js'


// ============================================================================
//  RouterOpenrouterConnect — the OpenRouter connect surface hosted by
//  /logins. Three legs, one component:
//    · browser OAuth — OpenRouter's real PKCE flow MINTS a scoped runtime
//      key (loopback :1456 + paste fallback);
//    · headless code — the no-callback variant: OpenRouter displays the
//      authorization code on its page; the operator pastes it here;
//    · API key — paste one (auth-scoped store, mode 600).
//  Every leg completes with a FORCED live-catalogue refresh so readiness is
//  proven, not assumed (the RouterOpenaiConnect law). Secrets never render.
// ============================================================================

export function RouterOpenrouterConnect({
  onResult,
}: {
  onResult: (result: { ok: boolean; receipt: string }) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [leg, setLeg] = useState<'choice' | 'browser' | 'headless' | 'key'>('choice')
  const [paste, setPaste] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [phase, setPhase] = useState<'starting' | 'waiting' | 'exchanging'>('starting')
  const [listenerNote, setListenerNote] = useState<string | undefined>(undefined)
  const [authorizeUrl, setAuthorizeUrl] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const handlesRef = useRef<OpenrouterConnectHandles | undefined>(undefined)
  const settledRef = useRef(false)

  const settle = (receipt: string, ok = false): void => {
    if (settledRef.current) return
    settledRef.current = true
    onResult({ ok, receipt })
  }

  const finishConnected = async (ref: OpenrouterAccountRef): Promise<void> => {
    // The settle sentence + the catalogue proof live in the ONE login door
    // (openrouterLogin — shared with the Boot face's logins layer).
    const outcome = await finishOpenrouterConnect(ref)
    settle(outcome.receipt, outcome.ok)
  }

  useEffect(() => {
    if (leg !== 'browser' && leg !== 'headless') return
    const handles = beginOpenrouterConnect({
      mode: leg === 'browser' ? 'browser' : 'headless',
      onListenerIssue: message => setListenerNote(message),
    })
    handlesRef.current = handles
    setAuthorizeUrl(handles.authorizeUrl)
    setPhase('waiting')
    handles.result
      .then(ref => void finishConnected(ref))
      .catch(error => settle(openrouterConnectFailedReceipt(error)))
    return () => {
      handlesRef.current = undefined
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leg])

  useInput((input, key) => {
    if (leg === 'choice') return
    if (key.escape) {
      if (leg === 'key') {
        setLeg('choice')
        return
      }
      handlesRef.current?.cancel('cancelled from the connect surface')
      settle(OPENROUTER_CONNECT_STOPPED_RECEIPT)
      return
    }
    if (
      input === 'c' &&
      !key.ctrl && !key.meta &&
      (leg === 'browser' || leg === 'headless') &&
      paste === '' &&
      phase !== 'exchanging' &&
      authorizeUrl
    ) {
      void setClipboard(authorizeUrl).then(sequence => {
        if (sequence) process.stdout.write(sequence)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
    }
  })

  const submitPaste = (raw: string): void => {
    const value = raw.trim()
    if (!value) return
    setPhase('exchanging')
    handlesRef.current?.completeWithRedirect(value)
  }

  if (leg === 'choice') {
    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Text bold color={tokens.accent}>
          Connect OpenRouter
        </Text>
        <Text color={tokens.textSecondary}>
          One credential unlocks OpenRouter's whole multi-model catalogue (credits-billed).
        </Text>
        <Select
          options={[
            { label: 'Sign in with the browser — OAuth mints a scoped key', value: 'browser' },
            { label: 'Headless — OpenRouter shows a code you paste here', value: 'headless' },
            { label: 'Paste an API key (stored locally, mode 600)', value: 'key' },
          ]}
          onChange={value => setLeg(value as 'browser' | 'headless' | 'key')}
          onCancel={() => settle(OPENROUTER_CONNECT_CANCELLED_RECEIPT)}
        />
      </Box>
    )
  }

  if (leg === 'key') {
    return <OpenrouterKeyLeg onResult={settle} />
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={tokens.accent}>
        Connect OpenRouter ({leg === 'browser' ? 'browser sign-in' : 'headless code'})
      </Text>
      <Text color={tokens.textSecondary}>
        {phase === 'exchanging'
          ? 'Exchanging the authorization code — OpenRouter mints the key…'
          : leg === 'browser'
            ? 'A browser window should be opening. Authorize Mercury and the loopback listener completes automatically.'
            : 'Open this URL on any signed-in browser; OpenRouter displays an authorization code — paste it below.'}
      </Text>
      {listenerNote ? <Text color={tokens.warning}>{listenerNote}</Text> : null}
      {authorizeUrl && phase !== 'exchanging' ? (
        <>
          <Text color={tokens.textMuted}>
            {leg === 'browser' ? 'If nothing opened, visit:' : 'URL:'}
          </Text>
          <Text color={tokens.info} wrap="wrap">
            {authorizeUrl}
          </Text>
          <Box>
            <Text color={tokens.textMuted}>
              {leg === 'browser' ? 'or paste the redirected URL: ' : 'paste the code: '}
            </Text>
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
      <Text color={tokens.textMuted}>c copies the URL · ESC cancels.</Text>
    </Box>
  )
}

function OpenrouterKeyLeg({
  onResult,
}: {
  onResult: (receipt: string, ok?: boolean) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [key, setKey] = useState('')
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [storing, setStoring] = useState(false)
  const submit = (raw: string): void => {
    const value = raw.trim()
    if (!value) return
    // The one guard spelling (keyPasteGuards).
    const guard = keyPasteGuardNote(value, { stores: 'an OpenRouter key (sk-or-…)' })
    if (guard !== null) {
      setNote(guard)
      return
    }
    setStoring(true)
    // The leg's logic lives in openrouterLogin (one driver, shared with
    // the Boot face's logins layer); the receipt proves the catalogue.
    void storeOpenrouterApiKeyLogin(value).then(outcome => {
      if (!outcome.stored) {
        setStoring(false)
        setNote(outcome.receipt)
        return
      }
      onResult(outcome.receipt, outcome.ok)
    })
  }
  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      <Text>
        Paste your OpenRouter API key. Stored auth-scoped (mode 600), never logged; an
        OPENROUTER_API_KEY env var always wins over the store.
      </Text>
      <Box>
        <Text>Key: </Text>
        <TextInput
          value={key}
          onChange={setKey}
          onSubmit={submit}
          mask="*"
          columns={48}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
      {storing ? <Text dimColor>Storing and checking the live catalogue…</Text> : null}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      <Text dimColor>esc back</Text>
    </Box>
  )
}
