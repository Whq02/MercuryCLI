import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Select } from './CustomSelect/index.js'
import { openBrowser } from '../utils/browser.js'
import { setClipboard } from '../ink/termio/osc.js'
import { runXaiDeviceLogin, XAI_CONNECT_ROWS, XAI_CONNECT_STOPPED_RECEIPT, type XaiDeviceLoginEvent } from '../services/providers/xai/xaiLogin.js'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { storeXaiApiKeyLogin, storeXaiManagementKeyLogin } from '../services/providers/xai/xaiLogin.js'
import { resolveXaiApiKey } from '../services/providers/xai/xaiAccounts.js'
import { XAI_MANAGEMENT_KEY_PAGE } from '../services/providers/xai/xaiUsageState.js'
import { keyPasteGuardNote } from './mercury-ui/screens/keyPasteGuards.js'
import { keyPageLine } from './loginFamilyRows.js'

export function XaiConnect({
  onResult,
  onBack,
}: {
  onResult: (result: { ok: boolean; receipt: string }) => void
  onBack: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [step, setStep] = useState<'choice' | 'device' | 'api' | 'management'>('choice')
  const [event, setEvent] = useState<XaiDeviceLoginEvent>({ phase: 'starting' })
  const cancelled = useRef(false)
  useEffect(() => {
    if (step !== 'device') return
    let disposed = false
    void runXaiDeviceLogin({ cancelled: () => disposed || cancelled.current, onEvent: e => {
      if (disposed) return
      setEvent(e)
      if (e.phase === 'waiting' && e.polls === 0) void openBrowser(e.start.verificationUriComplete ?? e.start.verificationUri)
    } }).then(outcome => { if (!disposed || outcome.settledAfterCancel) onResult(outcome) })
    return () => { disposed = true }
  }, [step])
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [apiReceipt, setApiReceipt] = useState('xAI API key kept.')
  const [storing, setStoring] = useState(false)
  const management = step === 'management'
  const keep = (): void => onResult({ ok: true, receipt: `${apiReceipt} Management key unchanged; add one later through /logins xai or /router key xai-management.` })
  useInput((input, key, keyEvent) => {
    if (step === 'choice') return
    if (key.escape && !storing) {
      if (step === 'device') { cancelled.current = true; setNote(XAI_CONNECT_STOPPED_RECEIPT) }
      else if (management) keep()
      else setStep('choice')
    }
    if (input === 'c' && step === 'device' && event.phase === 'waiting') {
      keyEvent.stopImmediatePropagation()
      void setClipboard(event.start.verificationUriComplete ?? event.start.verificationUri).then(sequence => { if (sequence) process.stdout.write(sequence) })
    }
  })
  const submit = (raw: string): void => {
    if (storing) return
    const key = raw.trim()
    if (!key) {
      if (management) keep()
      else if (resolveXaiApiKey()) { setNote(null); setStep('management') }
      return
    }
    const guard = keyPasteGuardNote(key, { stores: management ? 'an xAI management key' : 'an xAI API key' })
    if (guard !== null) { setNote(guard); return }
    setStoring(true)
    void (management ? storeXaiManagementKeyLogin(key) : storeXaiApiKeyLogin(key)).then(outcome => {
      setStoring(false)
      setValue('')
      setCursor(0)
      if (!outcome.stored) { setNote(outcome.receipt); return }
      if (management) onResult({ ok: outcome.ok, receipt: `${apiReceipt} ${outcome.receipt}` })
      else { setApiReceipt(outcome.receipt); setNote(null); setStep('management') }
    })
  }
  if (step === 'choice') return <Box flexDirection="column" gap={1} paddingX={1}>
    <Text bold color={tokens.accent}>Connect xAI</Text>
    <Text>Use your Grok subscription or an API key. xAI decides subscription eligibility; consent may say Grok Build.</Text>
    <Select options={XAI_CONNECT_ROWS} onChange={choice => setStep(choice === 'device' ? 'device' : 'api')} onCancel={onBack} />
  </Box>
  if (step === 'device') return <Box flexDirection="column" gap={1} paddingX={1}>
    <Text bold color={tokens.accent}>Connect Grok (device code)</Text>
    {event.phase === 'waiting' ? <>
      <Text>Enter this code on the xAI sign-in page: {event.start.userCode}</Text>
      <Text>{event.start.verificationUriComplete ?? event.start.verificationUri}</Text>
      <Text>Waiting for approval ({event.polls} checks) · expires {new Date(event.start.expiresAtMs).toLocaleTimeString()}</Text>
      {event.note ? <Text>{event.note}</Text> : null}
    </> : <Text>{event.phase === 'starting' ? 'Requesting a device code…' : 'Authorized — storing sign-in and reading models…'}</Text>}
    {note ? <Text>{note}</Text> : null}
    <Text dimColor>c copies the URL · esc cancels</Text>
  </Box>
  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      <Text bold color={tokens.accent}>{management ? 'Connect xAI — management key (optional)' : 'Connect xAI — API key'}</Text>
      <Text>{management ? XAI_MANAGEMENT_KEY_PAGE : keyPageLine('xai')}</Text>
      <Text>{management
        ? 'Needs Management Keys Read + Write permission in the console. Stored auth-scoped (mode 600); XAI_MANAGEMENT_API_KEY wins.'
        : 'Stored auth-scoped (mode 600), never logged; XAI_API_KEY wins. An optional management key follows for /usage.'}</Text>
      <Box>
        <Text>Key: </Text>
        <TextInput value={value} onChange={setValue} onSubmit={submit} mask="*" columns={48} cursorOffset={cursor} onChangeCursorOffset={setCursor} />
      </Box>
      {storing ? <Text dimColor>Checking the key with xAI…</Text> : null}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      <Text dimColor>{management ? 'enter empty or esc skips — API key stays' : 'enter empty keeps an existing API key · esc back'}</Text>
    </Box>
  )
}

export default XaiConnect
