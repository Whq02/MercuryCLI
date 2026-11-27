import * as React from 'react'
import { useRef, useState } from 'react'
import { useLoad } from '../../../screen/effects/effects.js'
import { Select } from '../../../screen/select/index.js'
import { openBrowser } from '../../../platform/host-os/browser.js'
import { SignInCopyLine, useSignInCopy } from './SignInCopyLine.js'
import { runXaiDeviceLogin, XAI_CONNECT_ROWS, XAI_CONNECT_STOPPED_RECEIPT, type XaiDeviceLoginEvent } from '../../roads/xai/xaiLogin.js'
import { Box, Text, useInput } from '../../../screen/themedRenderer.js'
import TextInput from '../../../screen/composer/text-input/TextInput.js'
import { useMercuryTokens } from '../../../screen/widgets/useMercuryTokens.js'
import { storeXaiApiKeyLogin, storeXaiManagementKeyLogin } from '../../roads/xai/xaiLogin.js'
import { resolveXaiApiKey } from '../../roads/xai/xaiAccounts.js'
import { XAI_MANAGEMENT_KEY_PAGE } from '../../roads/xai/xaiUsageState.js'
import { keyPasteGuardNote } from '../../../screen/widgets/faces/keyPasteGuards.js'
import { keyPageLine } from './loginFamilyRows.js'
import { KeyCardTitle } from './KeyCardTitle.js'
import { usePopupCompact } from '../../../screen/overlays/popupFormContext.js'

export function XaiConnect({
  onResult,
  onBack,
}: {
  onResult: (result: { ok: boolean; receipt: string }) => void
  onBack: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { compact } = usePopupCompact()
  const [step, setStep] = useState<'choice' | 'device' | 'api' | 'management'>('choice')
  const [event, setEvent] = useState<XaiDeviceLoginEvent>({ phase: 'starting' })
  const cancelled = useRef(false)
  useLoad(signal => {
    if (step !== 'device') return
    void runXaiDeviceLogin({ cancelled: () => signal.aborted || cancelled.current, onEvent: e => {
      if (signal.aborted) return
      setEvent(e)
      if (e.phase === 'waiting' && e.polls === 0) void openBrowser(e.start.verificationUriComplete ?? e.start.verificationUri)
    } }).then(outcome => { if (!signal.aborted || outcome.settledAfterCancel) onResult(outcome) })
  }, [step])
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [apiReceipt, setApiReceipt] = useState('xAI API key kept.')
  const [storing, setStoring] = useState(false)
  const copying = useSignInCopy()
  const management = step === 'management'
  const keep = (): void => onResult({ ok: true, receipt: `${apiReceipt} Management key unchanged; add one later through /logins xai.` })
  useInput((input, key, keyEvent) => {
    if (step === 'choice') return
    if (key.escape && !storing) {
      if (step === 'device') { cancelled.current = true; setNote(XAI_CONNECT_STOPPED_RECEIPT) }
      else if (management) keep()
      else setStep('choice')
    }
    if (input === 'c' && !key.ctrl && !key.meta && step === 'device' && event.phase === 'waiting') {
      keyEvent.stopImmediatePropagation()
      copying.copy(event.start.verificationUriComplete ?? event.start.verificationUri)
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
  if (step === 'choice') return <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
    <Text bold color={tokens.accent}>Connect xAI</Text>
    {compact ? null : <Text>Use your Grok subscription or an API key. xAI decides subscription eligibility; consent may say Grok Build.</Text>}
    <Select options={XAI_CONNECT_ROWS} onChange={choice => setStep(choice === 'device' ? 'device' : 'api')} onCancel={onBack} />
  </Box>
  if (step === 'device') return <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
    {compact ? null : <Text bold color={tokens.accent}>Connect Grok (device code)</Text>}
    {event.phase === 'waiting' ? <>
      {compact ? (
        <Text wrap="truncate-end"><Text bold>{event.start.userCode}</Text> · {event.start.verificationUriComplete ?? event.start.verificationUri}</Text>
      ) : (
        <Text>Enter this code on the xAI sign-in page: {event.start.userCode}</Text>
      )}
      {compact ? null : <Text>{event.start.verificationUriComplete ?? event.start.verificationUri}</Text>}
      {compact ? null : <Text>Waiting for approval ({event.polls} checks) · expires {new Date(event.start.expiresAtMs).toLocaleTimeString()}</Text>}
      {event.note ? <Text>{event.note}</Text> : null}
    </> : <Text>{event.phase === 'starting' ? 'Requesting a device code…' : 'Authorized — storing sign-in and reading models…'}</Text>}
    {note ? <Text>{note}</Text> : null}
    <SignInCopyLine said={copying} address={compact && event.phase === 'waiting' ? event.start.verificationUriComplete ?? event.start.verificationUri : undefined} quiet />
    <Text dimColor>c copies the URL · esc cancels</Text>
  </Box>
  return (
    <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
      {management ? (
        <Text bold color={tokens.accent} wrap="truncate-end">Connect xAI — management key (optional){compact ? <Text bold={false} color={tokens.textMuted}> · {XAI_MANAGEMENT_KEY_PAGE} · esc skips</Text> : null}</Text>
      ) : (
        <KeyCardTitle family="xai" short="xAI key">Connect xAI — API key</KeyCardTitle>
      )}
      {compact ? null : <Text>{management ? XAI_MANAGEMENT_KEY_PAGE : keyPageLine('xai')}</Text>}
      {compact ? null : <Text>{management
        ? 'Needs Management Keys Read + Write permission in the console. Stored auth-scoped (mode 600); XAI_MANAGEMENT_API_KEY wins.'
        : 'Stored auth-scoped (mode 600), never logged; XAI_API_KEY wins. An optional management key follows for /usage.'}</Text>}
      <Box>
        <Text>Key: </Text>
        <TextInput value={value} onChange={setValue} onSubmit={submit} mask="*" columns={48} cursorOffset={cursor} onChangeCursorOffset={setCursor} />
      </Box>
      {storing ? <Text dimColor>Checking the key with xAI…</Text> : null}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      {compact ? null : <Text dimColor>{management ? 'enter empty or esc skips — API key stays' : 'enter empty keeps an existing API key · esc back'}</Text>}
    </Box>
  )
}

export default XaiConnect
