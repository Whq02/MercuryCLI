import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../../../ink.js'
import TextInput from '../../../components/TextInput.js'
import { useMercuryTokens } from '../../../components/mercury-ui/useMercuryTokens.js'
import { QWEN_KEY_KINDS_LINE, storeQwenApiKeyLogin } from './qwenLogin.js'
import { keyPasteGuardNote } from '../../../components/mercury-ui/screens/keyPasteGuards.js'
import { keyPageLine } from '../../../components/loginFamilyRows.js'
import { KeyCardTitle } from '../../../components/KeyCardTitle.js'
import { usePopupCompact } from '../../../context/popupFormContext.js'

const QWEN_CONNECT_BILLING_LINE = 'Text models only. The key is bound to the QwenCloud or Model Studio region and plan it was minted in: Mercury probes the documented endpoints and keeps the one that accepts it. Usage and balance are shown in that console.'
const QWEN_CONNECT_STORE_LINE = 'Checked on the model list first (a key no endpoint accepts is never stored); stored auth-scoped (mode 600) with its endpoint, never logged. DASHSCOPE_API_KEY wins over the store; DASHSCOPE_BASE_URL names the endpoint instead of the probe.'

export function QwenConnect({ onResult, onBack }: {
  onResult: (result: { ok: boolean; receipt: string }) => void
  onBack: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const { compact } = usePopupCompact()
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [storing, setStoring] = useState(false)
  useInput((_input, key) => { if (key.escape && !storing) onBack() })
  const submit = (raw: string): void => {
    if (storing) return
    const key = raw.trim()
    if (!key) return
    const guard = keyPasteGuardNote(key, { stores: 'a QwenCloud or Model Studio API key' })
    if (guard !== null) { setNote(guard); return }
    setStoring(true)
    void storeQwenApiKeyLogin(key).then(outcome => {
      if (!outcome.stored) { setStoring(false); setNote(outcome.receipt); return }
      onResult({ ok: outcome.ok, receipt: outcome.receipt })
    })
  }
  return (
    <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
      <KeyCardTitle family="qwen" short="Qwen key">Connect Qwen — QwenCloud or Model Studio API key</KeyCardTitle>
      {compact ? null : <Text>{keyPageLine('qwen')}</Text>}
      {compact ? null : <Text>{QWEN_KEY_KINDS_LINE}</Text>}
      {compact ? null : <Text>{QWEN_CONNECT_BILLING_LINE}</Text>}
      {compact ? null : <Text>{QWEN_CONNECT_STORE_LINE}</Text>}
      <Box>
        <Text>Key: </Text>
        <TextInput value={value} onChange={setValue} onSubmit={submit} mask="*" columns={48} cursorOffset={cursor} onChangeCursorOffset={setCursor} />
      </Box>
      {storing ? <Text dimColor>Finding the QwenCloud or Model Studio region and plan this key belongs to…</Text> : null}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      {compact ? null : <Text dimColor>esc back</Text>}
    </Box>
  )
}

export default QwenConnect
