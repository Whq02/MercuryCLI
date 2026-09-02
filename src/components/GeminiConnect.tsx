import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'
import { Select } from './CustomSelect/index.js'
import { setClipboard } from '../ink/termio/osc.js'
import { errorMessageWithCause } from '../utils/errors.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import {
  beginGeminiBrowserConnect,
  geminiOauthClientConfig,
  geminiOauthClientMissingCopy,
  GEMINI_CLIENT_STORED_UNVERIFIED_NOTE,
  writeGeminiOauthClientConfig,
  type GeminiConnectHandles,
} from '../services/providers/gemini/geminiAccounts.js'
import {
  GEMINI_CONNECT_CANCELLED_RECEIPT,
  GEMINI_CONNECT_STOPPED_RECEIPT,
  finishGeminiOauthConnect,
  geminiConnectFailedReceipt,
  storeGeminiApiKeyLogin,
} from '../services/providers/gemini/geminiLogin.js'
import { keyPasteGuardNote } from './mercury-ui/screens/keyPasteGuards.js'

// ============================================================================
//  GeminiConnect — the Google Gemini connect surface hosted by /logins
// Legs:
//    · API key — paste one (auth-scoped store, mode 600; env
//      GOOGLE_API_KEY/GEMINI_API_KEY always win);
//    · Google OAuth — the REAL desktop flow, gated HONESTLY on the
//      operator's own Google Cloud OAuth client (Desktop type). Missing
//      client ⇒ the gate copy + a set-client leg (id + optional secret,
//      stored auth-scoped) — never a fake flow;
//    · set OAuth client — one-time client id/secret entry.
//  Every credential leg completes with a FORCED live-catalogue refresh so
//  readiness is proven, not assumed. Secrets never render.
// ============================================================================

export function GeminiConnect({
  onResult,
}: {
  onResult: (result: { ok: boolean; receipt: string }) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [leg, setLeg] = useState<'choice' | 'oauth' | 'key' | 'client'>('choice')
  const [paste, setPaste] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [phase, setPhase] = useState<'starting' | 'waiting' | 'exchanging'>('starting')
  const [listenerNote, setListenerNote] = useState<string | undefined>(undefined)
  const [authorizeUrl, setAuthorizeUrl] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const handlesRef = useRef<GeminiConnectHandles | undefined>(undefined)
  const settledRef = useRef(false)

  const settle = (receipt: string, ok = false): void => {
    if (settledRef.current) return
    settledRef.current = true
    onResult({ ok, receipt })
  }

  useEffect(() => {
    if (leg !== 'oauth') return
    const handles = beginGeminiBrowserConnect({
      onListenerIssue: message => setListenerNote(message),
    })
    handlesRef.current = handles
    setAuthorizeUrl(handles.authorizeUrl || undefined)
    setPhase('waiting')
    handles.result
      .then(async () => {
        // The settle sentence + the catalogue proof live in the ONE login
        // door (geminiLogin — shared with the Boot face's logins layer).
        const outcome = await finishGeminiOauthConnect()
        settle(outcome.receipt, outcome.ok)
      })
      .catch(error => settle(geminiConnectFailedReceipt(error)))
    return () => {
      handlesRef.current = undefined
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leg])

  useInput((input, key) => {
    if (leg === 'choice') return
    if (key.escape) {
      // Per-leg esc law: the key/client legs' OWN fields carry onEscape and
      // the escape event is not consumed on that path — acting here too
      // double-stepped (secret→id AND client→choice in one press). This
      // handler owns esc only for the oauth leg's field-less phases.
      if (leg === 'key' || leg === 'client') return
      handlesRef.current?.cancel('cancelled from the connect surface')
      settle(GEMINI_CONNECT_STOPPED_RECEIPT)
      return
    }
    if (input === 'c' && !key.ctrl && !key.meta && leg === 'oauth' && paste === '' && phase !== 'exchanging' && authorizeUrl) {
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
    const clientMissing = geminiOauthClientMissingCopy()
    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Text bold color={tokens.accent}>
          Connect Google Gemini
        </Text>
        <Text color={tokens.textSecondary}>
          API-key sign-in works immediately; Google OAuth needs your own OAuth client (a one-time
          Google Cloud setup).
        </Text>
        <Select
          options={[
            { label: 'Paste an API key (stored locally, mode 600)', value: 'key' },
            {
              label: clientMissing
                ? 'Google OAuth — needs an OAuth client first (set it below)'
                : 'Sign in with Google (OAuth, browser)',
              value: 'oauth',
            },
            {
              label: geminiOauthClientConfig()
                ? 'Update the stored OAuth client (id/secret)'
                : 'Set the OAuth client (id/secret from Google Cloud Console)',
              value: 'client',
            },
          ]}
          onChange={value => {
            if (value === 'oauth' && geminiOauthClientMissingCopy()) {
              setLeg('client')
              return
            }
            setLeg(value as 'oauth' | 'key' | 'client')
          }}
          onCancel={() => settle(GEMINI_CONNECT_CANCELLED_RECEIPT)}
        />
        {clientMissing ? <Text color={tokens.textMuted} wrap="wrap">{clientMissing}</Text> : null}
      </Box>
    )
  }

  if (leg === 'key') {
    return <GeminiKeyLeg onResult={settle} onBack={() => setLeg('choice')} />
  }

  if (leg === 'client') {
    return <GeminiClientLeg onDone={() => setLeg('choice')} />
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={tokens.accent}>
        Connect Google Gemini (OAuth)
      </Text>
      <Text color={tokens.textSecondary}>
        {phase === 'exchanging'
          ? 'Exchanging the authorization code…'
          : 'A browser window should be opening for the Google sign-in. Approve it and the loopback listener completes automatically.'}
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
              // Per-leg esc law: the paste field must not swallow the
              // cancel behind its own escape dance.
              onEscape={() => {
                handlesRef.current?.cancel('cancelled from the connect surface')
                settle(GEMINI_CONNECT_CANCELLED_RECEIPT)
              }}
            />
          </Box>
        </>
      ) : null}
      {copied ? <Text color={tokens.success}>Copied to clipboard</Text> : null}
      <Text color={tokens.textMuted}>c copies the URL · ESC cancels.</Text>
    </Box>
  )
}

function GeminiKeyLeg({
  onResult,
  onBack,
}: {
  onResult: (receipt: string, ok?: boolean) => void
  onBack: () => void
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
    const guard = keyPasteGuardNote(value, { stores: 'a Google Gemini key (AIza…)' })
    if (guard !== null) {
      setNote(guard)
      return
    }
    setStoring(true)
    // The leg's logic lives in geminiLogin (one driver, shared with the
    // Boot face's logins layer); the receipt proves the catalogue.
    void storeGeminiApiKeyLogin(value).then(outcome => {
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
        Paste your Gemini API key. Stored auth-scoped (mode 600), never logged; GOOGLE_API_KEY /
        GEMINI_API_KEY env vars always win over the store (GOOGLE_API_KEY outranks — the
        documented precedence).
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
          // Per-leg esc law: back to the choice — the input's own escape
          // dance would otherwise consume the key and strand the leg.
          onEscape={onBack}
        />
      </Box>
      {storing ? <Text dimColor>Storing and checking the live catalogue…</Text> : null}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      <Text dimColor>esc back</Text>
    </Box>
  )
}

function GeminiClientLeg({ onDone }: { onDone: () => void }): React.ReactNode {
  const tokens = useMercuryTokens()
  // The UPDATE flow starts from the STORED id (visible, editable) — an
  // empty field over an existing config read as "the id would not stick"
  // (operator live-drive block A). The secret is write-only: never
  // prefilled, never rendered.
  const [field, setField] = useState<'id' | 'secret'>('id')
  const [clientId, setClientId] = useState(() => geminiOauthClientConfig()?.clientId ?? '')
  const [clientSecret, setClientSecret] = useState('')
  const [cursor, setCursor] = useState(() => (geminiOauthClientConfig()?.clientId ?? '').length)
  const [note, setNote] = useState<string | null>(null)
  const submitId = (raw: string): void => {
    const value = raw.trim()
    if (!value) {
      setNote('The client id is required (the secret is optional for Desktop clients).')
      return
    }
    setClientId(value)
    setCursor(0)
    setField('secret')
    setNote(null)
  }
  const submitSecret = (raw: string): void => {
    try {
      writeGeminiOauthClientConfig({
        clientId,
        ...(raw.trim() ? { clientSecret: raw.trim() } : {}),
      })
    } catch (error) {
      setNote(`Could not store the client config: ${String((error as Error).message ?? error)}`)
      return
    }
    onDone()
  }
  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      <Text bold>Set the Google OAuth client (one-time)</Text>
      <Text color={tokens.textSecondary} wrap="wrap">
        Google Cloud Console → APIs &amp; Services → Credentials → Create credentials → OAuth
        client ID → type "Desktop app". Enable the Generative Language API on the project. Google
        documents the desktop client secret as not confidential; both values are stored
        auth-scoped (mode 600). Env pins MERCURY_GEMINI_OAUTH_CLIENT_ID/_SECRET always win.
      </Text>
      <Text color={tokens.textSecondary} wrap="wrap">
        {GEMINI_CLIENT_STORED_UNVERIFIED_NOTE}
      </Text>
      {field === 'id' ? (
        <Box>
          <Text>Client id: </Text>
          <TextInput
            value={clientId}
            onChange={setClientId}
            onSubmit={submitId}
            columns={48}
            cursorOffset={cursor}
            onChangeCursorOffset={setCursor}
            // Per-leg esc law: the id field is the leg's FIRST layer — esc
            // leaves the leg. Without this the input's own escape dance
            // (double-press-to-clear) consumed the key and the leg was
            // inescapable.
            onEscape={onDone}
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
              onSubmit={submitSecret}
              mask="*"
              columns={40}
              cursorOffset={cursor}
              onChangeCursorOffset={setCursor}
              // One esc = one layer: back to the id field, id preserved.
              onEscape={() => {
                setField('id')
                setCursor(clientId.length)
                setNote(null)
              }}
            />
          </Box>
        </Box>
      )}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      <Text dimColor>{field === 'id' ? '↵ continues to the secret · esc back' : '↵ stores (secret optional) · esc back to the id'}</Text>
    </Box>
  )
}
