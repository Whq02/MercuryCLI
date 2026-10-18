import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../../../ink.js'
import TextInput from '../../../components/TextInput.js'
import { useMercuryTokens } from '../../../components/mercury-ui/useMercuryTokens.js'
import { storeCerebrasApiKeyLogin } from './cerebrasLogin.js'
import { keyPasteGuardNote } from '../../../components/mercury-ui/screens/keyPasteGuards.js'
import { keyPageLine } from '../../../components/loginFamilyRows.js'
import { KeyCardTitle } from '../../../components/KeyCardTitle.js'
import { usePopupCompact } from '../../../context/popupFormContext.js'

const CEREBRAS_CONNECT_BILLING_LINE = 'Text models only. Trial and paid accounts have different context and rate limits; the cloud console shows account spend.'
const CEREBRAS_CONNECT_STORE_LINE = 'Checked on the model list first (a refused key is never stored); stored auth-scoped (mode 600), never logged. CEREBRAS_API_KEY wins over the store.'

export function CerebrasConnect({ onResult, onBack }: {
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
    const guard = keyPasteGuardNote(key, { stores: 'a Cerebras API key' })
    if (guard !== null) { setNote(guard); return }
    setStoring(true)
    void storeCerebrasApiKeyLogin(key).then(outcome => {
      if (!outcome.stored) { setStoring(false); setNote(outcome.receipt); return }
      onResult({ ok: outcome.ok, receipt: outcome.receipt })
    })
  }
  return (
    <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
      <KeyCardTitle family="cerebras" short="Cerebras key">Connect Cerebras — API key</KeyCardTitle>
      {compact ? null : <Text>{keyPageLine('cerebras')}</Text>}
      {compact ? null : <Text>{CEREBRAS_CONNECT_BILLING_LINE}</Text>}
      {compact ? null : <Text>{CEREBRAS_CONNECT_STORE_LINE}</Text>}
      <Box>
        <Text>Key: </Text>
        <TextInput value={value} onChange={setValue} onSubmit={submit} mask="*" columns={48} cursorOffset={cursor} onChangeCursorOffset={setCursor} />
      </Box>
      {storing ? <Text dimColor>Checking the key with Cerebras…</Text> : null}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      {compact ? null : <Text dimColor>esc back</Text>}
    </Box>
  )
}

export default CerebrasConnect
