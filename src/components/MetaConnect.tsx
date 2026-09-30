import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { storeMetaApiKeyLogin } from '../services/providers/meta/metaLogin.js'
import { keyPasteGuardNote } from './mercury-ui/screens/keyPasteGuards.js'
import { keyPageLine } from './loginFamilyRows.js'

export function MetaConnect({ onResult, onBack }: {
  onResult: (result: { ok: boolean; receipt: string }) => void
  onBack: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [storing, setStoring] = useState(false)
  useInput((_input, key) => { if (key.escape && !storing) onBack() })
  const submit = (raw: string): void => {
    if (storing) return
    const key = raw.trim()
    if (!key) return
    const guard = keyPasteGuardNote(key, { stores: 'a Meta Model API key' })
    if (guard !== null) { setNote(guard); return }
    setStoring(true)
    void storeMetaApiKeyLogin(key).then(outcome => {
      if (!outcome.stored) { setStoring(false); setNote(outcome.receipt); return }
      onResult({ ok: outcome.ok, receipt: outcome.receipt })
    })
  }
  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      <Text bold color={tokens.accent}>Connect Meta — API key</Text>
      <Text>{keyPageLine('meta')}</Text>
      <Text>Use a pay-as-you-go Model API key. Muse Code browser sign-in and subscriptions are for Muse Code only.</Text>
      <Text>Stored auth-scoped (mode 600), never logged. MODEL_API_KEY, then META_API_KEY, wins over the store.</Text>
      <Box>
        <Text>Key: </Text>
        <TextInput value={value} onChange={setValue} onSubmit={submit} mask="*" columns={48} cursorOffset={cursor} onChangeCursorOffset={setCursor} />
      </Box>
      {storing ? <Text dimColor>Checking the key with Meta…</Text> : null}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      <Text dimColor>esc back</Text>
    </Box>
  )
}

export default MetaConnect
