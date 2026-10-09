import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Select } from './CustomSelect/index.js'
import { openBrowser } from '../utils/browser.js'
import { setClipboard } from '../ink/termio/osc.js'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { NOUS_CONNECT_ROWS, NOUS_CONNECT_STOPPED_RECEIPT, runNousDeviceLogin, storeNousApiKeyLogin, type NousDeviceLoginEvent } from '../services/providers/nous/nousLogin.js'
import { keyPasteGuardNote } from './mercury-ui/screens/keyPasteGuards.js'
import { keyPageLine } from './loginFamilyRows.js'
import { KeyCardTitle } from './KeyCardTitle.js'
import { usePopupCompact } from '../context/popupFormContext.js'

export function NousConnect({ onResult, onBack }: {
  onResult: (result: { ok: boolean; receipt: string }) => void
  onBack: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { compact } = usePopupCompact()
  const [step, setStep] = useState<'choice' | 'device' | 'key'>('choice')
  const [event, setEvent] = useState<NousDeviceLoginEvent>({ phase: 'starting' })
  const cancelled = useRef(false)
  useEffect(() => {
    if (step !== 'device') return
    let disposed = false
    void runNousDeviceLogin({ cancelled: () => disposed || cancelled.current, onEvent: e => {
      if (disposed) return
      setEvent(e)
      if (e.phase === 'waiting' && e.polls === 0) void openBrowser(e.start.verificationUriComplete ?? e.start.verificationUri)
    } }).then(outcome => { if (!disposed || outcome.settledAfterCancel) onResult(outcome) })
    return () => { disposed = true }
  }, [step])
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [storing, setStoring] = useState(false)
  useInput((input, key, keyEvent) => {
    if (step === 'choice') return
    if (key.escape && !storing) {
      if (step === 'device') { cancelled.current = true; setNote(NOUS_CONNECT_STOPPED_RECEIPT) }
      else setStep('choice')
    }
    if (input === 'c' && !key.ctrl && !key.meta && step === 'device' && event.phase === 'waiting') {
      keyEvent.stopImmediatePropagation()
      void setClipboard(event.start.verificationUriComplete ?? event.start.verificationUri).then(sequence => { if (sequence) process.stdout.write(sequence) })
    }
  })
  const submit = (raw: string): void => {
    if (storing) return
    const key = raw.trim()
    if (!key) return
    const guard = keyPasteGuardNote(key, { stores: 'a Nous Portal API key' })
    if (guard !== null) { setNote(guard); return }
    setStoring(true)
    void storeNousApiKeyLogin(key).then(outcome => {
      if (!outcome.stored) { setStoring(false); setNote(outcome.receipt); return }
      onResult({ ok: outcome.ok, receipt: outcome.receipt })
    })
  }
  if (step === 'choice') return <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
    <Text bold color={tokens.accent}>Connect Nous Portal</Text>
    {compact ? null : <Text>Sign in with your Nous Portal account in the browser, or paste an API key. Either one bills the Portal credits or subscription behind it.</Text>}
    <Select options={NOUS_CONNECT_ROWS} onChange={choice => setStep(choice === 'device' ? 'device' : 'key')} onCancel={onBack} />
  </Box>
  if (step === 'device') return <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
    {compact ? null : <Text bold color={tokens.accent}>Connect Nous Portal (browser approval)</Text>}
    {event.phase === 'waiting' ? <>
      {compact ? (
        <Text wrap="truncate-end"><Text bold>{event.start.userCode}</Text> · {event.start.verificationUriComplete ?? event.start.verificationUri}</Text>
      ) : (
        <Text>Approve this code on the Nous Portal sign-in page: {event.start.userCode}</Text>
      )}
      {compact ? null : <Text>{event.start.verificationUriComplete ?? event.start.verificationUri}</Text>}
      {compact ? null : <Text>Waiting for approval ({event.polls} checks) · expires {new Date(event.start.expiresAtMs).toLocaleTimeString()}</Text>}
      {event.note ? <Text>{event.note}</Text> : null}
    </> : <Text>{event.phase === 'starting' ? 'Requesting a sign-in code from the Portal…' : 'Approved — storing the sign-in and reading your account…'}</Text>}
    {note ? <Text>{note}</Text> : null}
    <Text dimColor>c copies the URL · esc cancels</Text>
  </Box>
  return (
    <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
      <KeyCardTitle family="nous" short="Nous Portal key">Connect Nous Portal — API key</KeyCardTitle>
      {compact ? null : <Text>{keyPageLine('nous')}</Text>}
      {compact ? null : <Text>The key bills the Portal credits or subscription behind it; the Portal's model gateway lists the models.</Text>}
      {compact ? null : <Text>Stored auth-scoped (mode 600), never logged. NOUS_API_KEY wins over the store.</Text>}
      <Box>
        <Text>Key: </Text>
        <TextInput value={value} onChange={setValue} onSubmit={submit} mask="*" columns={48} cursorOffset={cursor} onChangeCursorOffset={setCursor} />
      </Box>
      {storing ? <Text dimColor>Reading the Portal account behind the key…</Text> : null}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      {compact ? null : <Text dimColor>esc back</Text>}
    </Box>
  )
}

export default NousConnect
