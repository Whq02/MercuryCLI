import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from '../../../ink.js'
import { Select } from '../../../components/CustomSelect/index.js'
import TextInput from '../../../components/TextInput.js'
import { KeyCardTitle } from '../../../components/KeyCardTitle.js'
import { keyPageLine } from '../../../components/loginFamilyRows.js'
import { keyPasteGuardNote } from '../../../components/mercury-ui/screens/keyPasteGuards.js'
import { useMercuryTokens } from '../../../components/mercury-ui/useMercuryTokens.js'
import { usePopupCompact } from '../../../context/popupFormContext.js'
import { openBrowser } from '../../../utils/browser.js'
import { setClipboard } from '../../../ink/termio/osc.js'
import { ORCAROUTER_CONNECT_ROWS, runOrcarouterDeviceLogin, storeOrcarouterApiKeyLogin, type OrcarouterDeviceLoginEvent } from './orcarouterLogin.js'

export function OrcarouterConnect({ onResult, onBack }: {
  onResult: (result: { ok: boolean; receipt: string }) => void
  onBack: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { compact } = usePopupCompact()
  const [step, setStep] = useState<'choice' | 'device' | 'key'>('choice')
  const [event, setEvent] = useState<OrcarouterDeviceLoginEvent>({ phase: 'starting' })
  const cancelled = useRef(false)
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [storing, setStoring] = useState(false)
  useEffect(() => {
    if (step !== 'device') return
    let disposed = false
    void runOrcarouterDeviceLogin({ cancelled: () => disposed || cancelled.current, onEvent: next => {
      if (disposed) return
      setEvent(next)
      if (next.phase === 'waiting' && next.polls === 0) void openBrowser(next.start.verificationUriComplete ?? next.start.verificationUri)
    } }).then(outcome => { if (!disposed || outcome.settledAfterCancel) onResult(outcome) })
    return () => { disposed = true }
  }, [step])
  useInput((input, key, keyEvent) => {
    if (step === 'choice') return
    if (key.escape && !storing) {
      if (step === 'device') { cancelled.current = true; onBack() }
      else setStep('choice')
    }
    if (input === 'c' && !key.ctrl && !key.meta && step === 'device' && event.phase === 'waiting') {
      keyEvent.stopImmediatePropagation()
      void setClipboard(event.start.verificationUriComplete ?? event.start.verificationUri).then(sequence => { if (sequence) process.stdout.write(sequence) })
    }
  })
  const submit = (raw: string): void => {
    if (storing || !raw.trim()) return
    const guard = keyPasteGuardNote(raw.trim(), { stores: 'an OrcaRouter API key' })
    if (guard !== null) { setNote(guard); return }
    setStoring(true)
    void storeOrcarouterApiKeyLogin(raw).then(outcome => {
      if (!outcome.stored) { setStoring(false); setNote(outcome.receipt); return }
      onResult(outcome)
    })
  }
  if (step === 'choice') return <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
    <Text bold color={tokens.accent}>Connect OrcaRouter</Text>
    {compact ? null : <Text>Requests bill OrcaRouter credits.</Text>}
    <Select options={ORCAROUTER_CONNECT_ROWS} onChange={choice => setStep(choice === 'device' ? 'device' : 'key')} onCancel={onBack} />
  </Box>
  if (step === 'device') return <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
    <Text bold color={tokens.accent}>Connect OrcaRouter</Text>
    {event.phase === 'waiting' ? <>
      <Text>Approve this code on the OrcaRouter sign-in page: {event.start.userCode}</Text>
      <Text>{event.start.verificationUriComplete ?? event.start.verificationUri}</Text>
    </> : null}
    <Text dimColor>c copies the URL · esc cancels</Text>
  </Box>
  return <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
    <KeyCardTitle family="orcarouter" short="OrcaRouter key">Connect OrcaRouter — API key</KeyCardTitle>
    {compact ? null : <Text>{keyPageLine('orcarouter')}</Text>}
    <Box><Text>Key: </Text><TextInput value={value} onChange={setValue} onSubmit={submit} mask="*" columns={48} cursorOffset={cursor} onChangeCursorOffset={setCursor} /></Box>
    {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
    {compact ? null : <Text dimColor>esc back</Text>}
  </Box>
}
