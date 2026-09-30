import * as React from 'react'
import { useState } from 'react'
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
  const [step, setStep] = useState<'api' | 'management'>('api')
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [apiReceipt, setApiReceipt] = useState('xAI API key kept.')
  const [storing, setStoring] = useState(false)
  const management = step === 'management'
  const keep = (): void => onResult({ ok: true, receipt: `${apiReceipt} Management key unchanged; add one later through /logins xai or /router key xai-management.` })
  useInput((_input, key) => {
    if (key.escape && !storing) {
      if (management) keep()
      else onBack()
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
