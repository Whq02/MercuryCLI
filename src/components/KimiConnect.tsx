import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'
import { Select } from './CustomSelect/index.js'
import { setClipboard } from '../ink/termio/osc.js'
import { openBrowser } from '../utils/browser.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import {
  KIMI_REGIONS,
  kimiRegionLabel,
  moonshotStoredRegion,
  type KimiRegion,
  type MoonshotDeviceAuthStart,
} from '../services/providers/moonshot/moonshotAccounts.js'
import { KIMI_CONNECT_STOPPED_RECEIPT, runKimiDeviceLogin, storeMoonshotApiKeyLogin } from '../services/providers/moonshot/moonshotLogin.js'
import { keyPasteGuardNote } from './mercury-ui/screens/keyPasteGuards.js'

// ============================================================================
//  KimiConnect — the Kimi (Moonshot) connect surface hosted by /logins.
//  Two legs, one component:
//    · device-code sign-in — Moonshot's RFC 8628 flow in the region the
//      operator picks (global kimi.ai / mainland kimi.com; the choice is
//      remembered): a short user code to enter at the verification page
//      (opened in the browser when one is available; copyable otherwise),
//      polled until authorized, the fresh bearer proven live on the coding
//      base through the usage endpoint;
//    · API key — a Moonshot platform key (platform.kimi.ai), proven live
//      through the balance endpoint before it is stored (auth-scoped, mode
//      600; MOONSHOT_API_KEY always wins; a sign-in outranks a stored key).
//  The legs' logic lives in moonshotLogin (one driver each, shared with the
//  loopback prover); this surface paints phases and never renders a secret.
// ============================================================================

const COPY_ACK_MS = 2000

export function KimiConnect({
  onResult,
}: {
  onResult: (result: { ok: boolean; receipt: string }) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [leg, setLeg] = useState<'choice' | 'region' | 'device' | 'key'>('choice')
  const [region, setRegion] = useState<KimiRegion>(() => moonshotStoredRegion() ?? 'global')
  const [phase, setPhase] = useState<'starting' | 'waiting' | 'finishing'>('starting')
  const [start, setStart] = useState<MoonshotDeviceAuthStart | undefined>(undefined)
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
    void runKimiDeviceLogin({
      region,
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
    if (leg === 'choice' || leg === 'region') return
    if (key.escape) {
      if (leg === 'key') {
        setLeg('choice')
        return
      }
      cancelledRef.current = true
      settle(KIMI_CONNECT_STOPPED_RECEIPT)
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
          Connect Kimi (Moonshot)
        </Text>
        <Text color={tokens.textSecondary}>
          A Kimi account signs in with a device code and runs on its plan; a Moonshot platform key bills
          usage-based. Either one lights the Kimi rows in /model.
        </Text>
        <Select
          options={[
            { label: 'Sign in with Kimi — device code in your browser', value: 'region' },
            { label: 'Paste a Moonshot API key (platform.kimi.ai; stored locally, mode 600)', value: 'key' },
          ]}
          onChange={value => setLeg(value as 'region' | 'key')}
          onCancel={() => settle('Kimi sign-in cancelled — nothing stored.')}
        />
      </Box>
    )
  }

  if (leg === 'region') {
    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Text bold color={tokens.accent}>
          Connect Kimi — which deployment holds your account?
        </Text>
        <Text color={tokens.textSecondary}>
          The choice picks the sign-in host and the base your turns ride; it is remembered with the login.
        </Text>
        <Select
          defaultFocusValue={region}
          options={KIMI_REGIONS.map(candidate => ({
            label:
              candidate === 'global'
                ? 'Global — kimi.ai (auth.kimi.ai · api.kimi.ai/coding/v1)'
                : 'Mainland China — kimi.com (auth.kimi.com · api.kimi.com/coding/v1)',
            value: candidate,
          }))}
          onChange={value => {
            setRegion(value as KimiRegion)
            setLeg('device')
          }}
          onCancel={() => setLeg('choice')}
        />
      </Box>
    )
  }

  if (leg === 'key') {
    return <MoonshotKeyLeg onResult={settle} />
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={tokens.accent}>
        Connect Kimi (device code · {kimiRegionLabel(region)})
      </Text>
      {phase === 'starting' ? (
        <Text color={tokens.textSecondary}>Requesting a device code from the Kimi sign-in host…</Text>
      ) : null}
      {phase === 'finishing' ? (
        <Text color={tokens.textSecondary}>Authorized — storing the sign-in and reading your usage…</Text>
      ) : null}
      {start && phase === 'waiting' ? (
        <>
          <Text color={tokens.textSecondary}>
            A browser window should be opening. On the Kimi page, enter this code:
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
            waiting for Kimi to confirm{polls > 0 ? ` (${polls} check${polls === 1 ? '' : 's'})` : ''} · expires{' '}
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

function MoonshotKeyLeg({
  onResult,
}: {
  onResult: (receipt: string, ok?: boolean) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [storing, setStoring] = useState(false)
  const submit = (raw: string): void => {
    const key = raw.trim()
    if (!key) return
    // The one guard spelling (keyPasteGuards).
    const guard = keyPasteGuardNote(key, { stores: 'a Moonshot platform key' })
    if (guard !== null) {
      setNote(guard)
      return
    }
    setStoring(true)
    void storeMoonshotApiKeyLogin(key).then(outcome => {
      if (!outcome.stored) {
        // A refused key is corrected here, never stored; a store failure too.
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
        Paste your Moonshot API key (platform.kimi.ai → API keys). Stored auth-scoped (mode 600), never logged;
        a MOONSHOT_API_KEY env var always wins over the store, and a Kimi sign-in outranks a stored key.
      </Text>
      <Box>
        <Text>Key: </Text>
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
      {storing ? <Text dimColor>Checking the key against the Moonshot balance endpoint…</Text> : null}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      <Text dimColor>esc back</Text>
    </Box>
  )
}

export default KimiConnect
