import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Select } from '../../../components/CustomSelect/index.js'
import { openBrowser } from '../../../utils/browser.js'
import { setClipboard } from '../../../ink/termio/osc.js'
import { Box, Text, useInput } from '../../../ink.js'
import TextInput from '../../../components/TextInput.js'
import { useMercuryTokens } from '../../../components/mercury-ui/useMercuryTokens.js'
import { QWEN_CONNECT_CLIENT_LINE, QWEN_CONNECT_ROWS, QWEN_CONNECT_STOPPED_RECEIPT, QWEN_FACE_PICK_LINE, runQwenDeviceLogin, storeQwenApiKeyLogin, type QwenDeviceLoginEvent } from './qwenLogin.js'
import { keyPasteGuardNote } from '../../../components/mercury-ui/screens/keyPasteGuards.js'
import { keyPageLine } from '../../../components/loginFamilyRows.js'
import { KeyCardTitle } from '../../../components/KeyCardTitle.js'
import { usePopupCompact } from '../../../context/popupFormContext.js'

const QWEN_CONNECT_BILLING_LINE = 'Text models only. The key is bound to the Model Studio region and plan it was minted in: Mercury probes the documented endpoints and keeps the one that accepts it. Usage and balance are shown in the Model Studio console.'
const QWEN_CONNECT_STORE_LINE = 'Checked on the model list first (a key no endpoint accepts is never stored); stored auth-scoped (mode 600) with its endpoint, never logged. DASHSCOPE_API_KEY wins over the store; DASHSCOPE_BASE_URL names the endpoint instead of the probe.'

export function QwenConnect({ onResult, onBack }: {
  onResult: (result: { ok: boolean; receipt: string }) => void
  onBack: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { compact } = usePopupCompact()
  const [step, setStep] = useState<'choice' | 'device' | 'key'>('choice')
  const [event, setEvent] = useState<QwenDeviceLoginEvent>({ phase: 'starting' })
  const cancelled = useRef(false)
  useEffect(() => {
    if (step !== 'device') return
    let disposed = false
    void runQwenDeviceLogin({ cancelled: () => disposed || cancelled.current, onEvent: e => {
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
      if (step === 'device') { cancelled.current = true; setNote(QWEN_CONNECT_STOPPED_RECEIPT) }
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
    const guard = keyPasteGuardNote(key, { stores: 'a Model Studio API key' })
    if (guard !== null) { setNote(guard); return }
    setStoring(true)
    void storeQwenApiKeyLogin(key).then(outcome => {
      if (!outcome.stored) { setStoring(false); setNote(outcome.receipt); return }
      onResult({ ok: outcome.ok, receipt: outcome.receipt })
    })
  }
  if (step === 'choice') return <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
    <Text bold color={tokens.accent}>Connect Qwen</Text>
    {compact ? null : <Text>{QWEN_FACE_PICK_LINE}</Text>}
    {compact ? null : <Text>{QWEN_CONNECT_CLIENT_LINE}</Text>}
    <Select options={QWEN_CONNECT_ROWS} onChange={choice => setStep(choice === 'device' ? 'device' : 'key')} onCancel={onBack} />
  </Box>
  if (step === 'device') return <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
    {compact ? null : <Text bold color={tokens.accent}>Connect Qwen (device code)</Text>}
    {event.phase === 'waiting' ? <>
      {compact ? (
        <Text wrap="truncate-end"><Text bold>{event.start.userCode}</Text> · {event.start.verificationUriComplete ?? event.start.verificationUri}</Text>
      ) : (
        <Text>On the Qwen sign-in page, enter this code: {event.start.userCode}</Text>
      )}
      {compact ? null : <Text>{event.start.verificationUriComplete ?? event.start.verificationUri}</Text>}
      {compact ? null : <Text>Waiting for approval ({event.polls} checks) · expires {new Date(event.start.expiresAtMs).toLocaleTimeString()}</Text>}
      {event.note ? <Text>{event.note}</Text> : null}
    </> : <Text>{event.phase === 'starting' ? 'Requesting a device code from the Qwen sign-in service…' : 'Approved — storing the sign-in and reading the plan\'s model list…'}</Text>}
    {note ? <Text>{note}</Text> : null}
    <Text dimColor>c copies the URL · esc cancels</Text>
  </Box>
  return (
    <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
      <KeyCardTitle family="qwen" short="Qwen key">Connect Qwen — Model Studio API key</KeyCardTitle>
      {compact ? null : <Text>{keyPageLine('qwen')}</Text>}
      {compact ? null : <Text>{QWEN_CONNECT_BILLING_LINE}</Text>}
      {compact ? null : <Text>{QWEN_CONNECT_STORE_LINE}</Text>}
      <Box>
        <Text>Key: </Text>
        <TextInput value={value} onChange={setValue} onSubmit={submit} mask="*" columns={48} cursorOffset={cursor} onChangeCursorOffset={setCursor} />
      </Box>
      {storing ? <Text dimColor>Finding the Model Studio region and plan this key belongs to…</Text> : null}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      {compact ? null : <Text dimColor>esc back</Text>}
    </Box>
  )
}

export default QwenConnect
