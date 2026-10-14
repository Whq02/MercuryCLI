import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Select } from './CustomSelect/index.js'
import { openBrowser } from '../utils/browser.js'
import { setClipboard } from '../ink/termio/osc.js'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import {
  activateMetaSource,
  liveMetaConnectFacts,
  META_CONNECT_STOPPED_RECEIPT,
  metaConnectRowAction,
  metaConnectRows,
  runMetaDeviceLogin,
  storeMetaApiKeyLogin,
  type MetaConnectRowValue,
  type MetaDeviceLoginEvent,
} from '../services/providers/meta/metaLogin.js'
import { keyPasteGuardNote } from './mercury-ui/screens/keyPasteGuards.js'
import { keyPageLine } from './loginFamilyRows.js'
import { KeyCardTitle } from './KeyCardTitle.js'
import { usePopupCompact } from '../context/popupFormContext.js'

const COPY_ACK_MS = 2000

export function MetaConnect({ onResult, onBack }: {
  onResult: (result: { ok: boolean; receipt: string }) => void
  onBack: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { compact } = usePopupCompact()
  const [step, setStep] = useState<'choice' | 'device' | 'key'>('choice')
  const [event, setEvent] = useState<MetaDeviceLoginEvent>({ phase: 'starting' })
  const [copied, setCopied] = useState(false)
  const cancelled = useRef(false)
  const settled = useRef(false)
  const finish = (result: { ok: boolean; receipt: string }): void => {
    if (settled.current) return
    settled.current = true
    onResult(result)
  }
  useEffect(() => {
    if (step !== 'device') return
    let disposed = false
    void runMetaDeviceLogin({
      cancelled: () => disposed || cancelled.current,
      onEvent: e => {
        if (disposed) return
        setEvent(e)
        if (e.phase === 'waiting' && e.polls === 0) {
          void openBrowser(e.start.verificationUriComplete ?? e.start.verificationUri)
        }
      },
    }).then(outcome => {
      if (!disposed || outcome.settledAfterCancel) finish({ ok: outcome.ok, receipt: outcome.receipt })
    })
    return () => {
      disposed = true
    }
  }, [step])
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [storing, setStoring] = useState(false)
  useInput((input, key, keyEvent) => {
    if (step === 'choice') return
    if (key.escape && !storing) {
      if (step === 'device') {
        cancelled.current = true
        finish({ ok: false, receipt: META_CONNECT_STOPPED_RECEIPT })
      } else {
        setNote(null)
        setStep('choice')
      }
      return
    }
    if (input === 'c' && !key.ctrl && !key.meta && step === 'device' && event.phase === 'waiting') {
      keyEvent.stopImmediatePropagation()
      void setClipboard(event.start.verificationUriComplete ?? event.start.verificationUri).then(sequence => {
        if (sequence) process.stdout.write(sequence)
        setCopied(true)
        setTimeout(() => setCopied(false), COPY_ACK_MS)
      })
    }
  })
  const submit = (raw: string): void => {
    if (storing) return
    const key = raw.trim()
    if (!key) return
    const guard = keyPasteGuardNote(key, { stores: 'a Meta Model API key' })
    if (guard !== null) { setNote(guard); return }
    setStoring(true)
    void storeMetaApiKeyLogin(key).then(outcome => {
      if (!outcome.stored) { setStoring(false); setNote(outcome.receipt); return }
      finish({ ok: outcome.ok, receipt: outcome.receipt })
    })
  }
  if (step === 'choice') {
    return (
      <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
        <Text bold color={tokens.accent} wrap="truncate-end">Connect Meta (Muse)</Text>
        {compact ? null : (
          <Text color={tokens.textSecondary}>
            Sign in with Meta for a Muse Code subscription (device code in your browser), or paste a pay-as-you-go Model API key.
          </Text>
        )}
        <Select
          options={metaConnectRows(liveMetaConnectFacts())}
          onChange={choice => {
            const picked = choice as MetaConnectRowValue
            if (metaConnectRowAction(liveMetaConnectFacts(), picked) === 'activate') {
              finish(activateMetaSource(picked === 'key' ? 'api-key' : 'muse-code'))
              return
            }
            setStep(picked === 'device' ? 'device' : 'key')
          }}
          onCancel={onBack}
        />
      </Box>
    )
  }
  if (step === 'device') {
    return (
      <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
        {compact ? null : <Text bold color={tokens.accent}>Connect Meta (device code)</Text>}
        {event.phase === 'waiting' ? (
          <>
            {compact ? (
              <Text wrap="truncate-end">
                <Text bold>{event.start.userCode}</Text> · {event.start.verificationUriComplete ?? event.start.verificationUri}
              </Text>
            ) : (
              <Text>Enter code: {event.start.userCode}</Text>
            )}
            {compact ? null : <Text color={tokens.info} wrap="wrap">{event.start.verificationUriComplete ?? event.start.verificationUri}</Text>}
            {compact ? null : (
              <Text color={tokens.textMuted}>
                Waiting for approval{event.polls > 0 ? ` (${event.polls} check${event.polls === 1 ? '' : 's'})` : ''} · expires {new Date(event.start.expiresAtMs).toLocaleTimeString()}
              </Text>
            )}
            {event.note ? <Text color={tokens.warning}>{event.note}</Text> : null}
          </>
        ) : (
          <Text color={tokens.textSecondary}>
            {event.phase === 'starting' ? 'Requesting a device code from Meta…' : 'Authorized — minting the Muse Code key and reading your plan…'}
          </Text>
        )}
        {copied ? <Text color={tokens.success}>Copied to clipboard</Text> : null}
        <Text dimColor>c copies the URL · esc cancels</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
      <KeyCardTitle family="meta" short="Meta key">Connect Meta — API key</KeyCardTitle>
      {compact ? null : <Text>{keyPageLine('meta')}</Text>}
      {compact ? null : <Text>Use a pay-as-you-go Model API key. For a Muse Code subscription, press esc and choose Sign in with Meta.</Text>}
      {compact ? null : <Text>Stored auth-scoped (mode 600), never logged. MODEL_API_KEY, then META_API_KEY, wins over the store.</Text>}
      <Box>
        <Text>Key: </Text>
        <TextInput value={value} onChange={setValue} onSubmit={submit} mask="*" columns={48} cursorOffset={cursor} onChangeCursorOffset={setCursor} />
      </Box>
      {storing ? <Text dimColor>Checking the key with Meta…</Text> : null}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      {compact ? null : <Text dimColor>esc back</Text>}
    </Box>
  )
}

export default MetaConnect
