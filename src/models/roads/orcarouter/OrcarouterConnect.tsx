import * as React from 'react'
import { useRef, useState } from 'react'
import { useLoad } from '../../../screen/effects/effects.js'
import { Box, Text, useInput } from '../../../screen/themedRenderer.js'
import { Select } from '../../../screen/select/index.js'
import TextInput from '../../../screen/composer/text-input/TextInput.js'
import { KeyCardTitle } from '../../sign-in/flow-cards/KeyCardTitle.js'
import { keyPageLine } from '../../sign-in/flow-cards/loginFamilyRows.js'
import { keyPasteGuardNote } from '../../../screen/widgets/faces/keyPasteGuards.js'
import { useMercuryTokens } from '../../../screen/widgets/useMercuryTokens.js'
import { usePopupCompact } from '../../../screen/overlays/popupFormContext.js'
import { openBrowser } from '../../../platform/host-os/browser.js'
import { setClipboard } from '../../../screen/renderer/termio/osc.js'
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
  useLoad(signal => {
    if (step !== 'device') return
    void runOrcarouterDeviceLogin({ cancelled: () => signal.aborted || cancelled.current, onEvent: next => {
      if (signal.aborted) return
      setEvent(next)
      if (next.phase === 'waiting' && next.polls === 0) void openBrowser(next.start.verificationUriComplete ?? next.start.verificationUri)
    } }).then(outcome => { if (!signal.aborted || outcome.settledAfterCancel) onResult(outcome) })
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
