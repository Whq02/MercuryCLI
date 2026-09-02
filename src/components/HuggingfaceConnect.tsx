import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'
import { Select } from './CustomSelect/index.js'
import { setClipboard } from '../ink/termio/osc.js'
import { openBrowser } from '../utils/browser.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import type { HuggingfaceDeviceAuthStart } from '../services/providers/huggingface/huggingfaceAccounts.js'
import {
  HUGGINGFACE_CONNECT_STOPPED_RECEIPT,
  runHuggingfaceDeviceLogin,
  storeHuggingfaceTokenLogin,
} from '../services/providers/huggingface/huggingfaceLogin.js'
import { keyPasteGuardNote } from './mercury-ui/screens/keyPasteGuards.js'

// ============================================================================
//  HuggingfaceConnect — the Hugging Face connect surface hosted by /logins.
//  Two legs, one component:
//    · device-code sign-in — the Hub's RFC 8628 flow: a short user code to
//      enter at the verification page (opened in the browser when one is
//      available; copyable otherwise), polled until authorized;
//    · token paste — a Hub token with the Inference Providers permission
//      (auth-scoped store, mode 600).
//  The legs' logic lives in huggingfaceLogin (one driver each, shared with
//  the Boot face's logins layer and the prover); every leg
//  proves the credential live through whoami before it reports "connected"
//  and kicks the router catalogue so readiness is proven, not assumed.
//  This surface paints phases and never renders a secret.
// ============================================================================

const COPY_ACK_MS = 2000

export function HuggingfaceConnect({
  onResult,
}: {
  onResult: (result: { ok: boolean; receipt: string }) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [leg, setLeg] = useState<'choice' | 'device' | 'token'>('choice')
  const [phase, setPhase] = useState<'starting' | 'waiting' | 'finishing'>('starting')
  const [start, setStart] = useState<HuggingfaceDeviceAuthStart | undefined>(undefined)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [polls, setPolls] = useState(0)
  const [copied, setCopied] = useState(false)
  const settledRef = useRef(false)
  const cancelledRef = useRef(false)

  const settle = (receipt: string, ok = false): void => {
    if (settledRef.current) return
    settledRef.current = true
    onResult({ ok, receipt })
  }

  useEffect(() => {
    if (leg !== 'device') return
    let disposed = false
    void runHuggingfaceDeviceLogin({
      cancelled: () => disposed || cancelledRef.current,
      onEvent: event => {
        if (disposed) return
        if (event.phase === 'starting') {
          setPhase('starting')
          return
        }
        if (event.phase === 'finishing') {
          setPhase('finishing')
          return
        }
        setStart(event.start)
        setPolls(event.polls)
        setNote(event.note)
        if (event.polls === 0) {
          setPhase('waiting')
          void openBrowser(event.start.verificationUriComplete ?? event.start.verificationUri)
        }
      },
    }).then(outcome => {
      if (disposed) return
      settle(outcome.receipt, outcome.ok)
    })
    return () => {
      disposed = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leg])

  useInput((input, key) => {
    if (leg === 'choice') return
    if (key.escape) {
      if (leg === 'token') {
        setLeg('choice')
        return
      }
      cancelledRef.current = true
      settle(HUGGINGFACE_CONNECT_STOPPED_RECEIPT)
      return
    }
    if (input === 'c' && !key.ctrl && !key.meta && leg === 'device' && start && phase === 'waiting') {
      void setClipboard(start.verificationUriComplete ?? start.verificationUri).then(sequence => {
        if (sequence) process.stdout.write(sequence)
        setCopied(true)
        setTimeout(() => setCopied(false), COPY_ACK_MS)
      })
    }
  })

  if (leg === 'choice') {
    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Text bold color={tokens.accent}>
          Connect Hugging Face
        </Text>
        <Text color={tokens.textSecondary}>
          One Hub token reaches every open model on Inference Providers (monthly credits first, then pay-as-you-go at provider rates).
        </Text>
        <Select
          options={[
            { label: 'Sign in with Hugging Face — device code in your browser', value: 'device' },
            { label: 'Paste a token (Inference Providers permission; stored locally, mode 600)', value: 'token' },
          ]}
          onChange={value => setLeg(value as 'device' | 'token')}
          onCancel={() => settle('Hugging Face sign-in cancelled — nothing stored.')}
        />
      </Box>
    )
  }

  if (leg === 'token') {
    return <HuggingfaceTokenLeg onResult={settle} onNote={setNote} note={note} />
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={tokens.accent}>
        Connect Hugging Face (device code)
      </Text>
      {phase === 'starting' ? (
        <Text color={tokens.textSecondary}>Requesting a device code from huggingface.co…</Text>
      ) : null}
      {phase === 'finishing' ? (
        <Text color={tokens.textSecondary}>Authorized — reading your Hub identity and the live catalogue…</Text>
      ) : null}
      {start && phase === 'waiting' ? (
        <>
          <Text color={tokens.textSecondary}>
            A browser window should be opening. On the Hugging Face page, enter this code:
          </Text>
          <Text bold color={tokens.textPrimary}>
            {'    '}
            {start.userCode}
          </Text>
          <Text color={tokens.textMuted}>If nothing opened, visit:</Text>
          <Text color={tokens.info} wrap="wrap">
            {start.verificationUriComplete ?? start.verificationUri}
          </Text>
          <Text color={tokens.textMuted}>
            waiting for the Hub to confirm{polls > 0 ? ` (${polls} check${polls === 1 ? '' : 's'})` : ''} · expires{' '}
            {new Date(start.expiresAtMs).toLocaleTimeString()}
          </Text>
        </>
      ) : null}
      {copied ? <Text color={tokens.success}>Copied to clipboard</Text> : null}
      {note !== undefined && phase === 'waiting' ? <Text color={tokens.warning}>{note}</Text> : null}
      <Text color={tokens.textMuted}>c copies the URL · ESC cancels.</Text>
    </Box>
  )
}

function HuggingfaceTokenLeg({
  onResult,
  note,
  onNote,
}: {
  onResult: (receipt: string, ok?: boolean) => void
  note: string | undefined
  onNote: (note: string | undefined) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [storing, setStoring] = useState(false)
  const submit = (raw: string): void => {
    const token = raw.trim()
    if (!token) return
    // The one guard spelling (keyPasteGuards).
    const guard = keyPasteGuardNote(token, { stores: 'a Hugging Face token (hf_…)', looksLike: 'a token' })
    if (guard !== null) {
      onNote(guard)
      return
    }
    setStoring(true)
    void storeHuggingfaceTokenLogin(token).then(outcome => {
      if (!outcome.stored) {
        // A refused token is corrected here, never stored; a store failure
        // too — the driver's receipt names which.
        setStoring(false)
        onNote(outcome.receipt)
        return
      }
      onResult(outcome.receipt, outcome.ok)
    })
  }
  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      <Text>
        Paste a Hugging Face token with the Inference Providers permission (huggingface.co/settings/tokens). Stored
        auth-scoped (mode 600), never logged; an HF_TOKEN env var always wins over the store.
      </Text>
      <Box>
        <Text>Token: </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={submit}
          mask="*"
          columns={48}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
      {storing ? <Text dimColor>Checking the token with the Hub and fetching the live catalogue…</Text> : null}
      {note !== undefined ? <Text color={tokens.warning}>{note}</Text> : null}
      <Text dimColor>esc back</Text>
    </Box>
  )
}

export default HuggingfaceConnect
