import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { storeMetaApiKeyLogin } from '../services/providers/meta/metaLogin.js'
import { keyPasteGuardNote } from './mercury-ui/screens/keyPasteGuards.js'
import { keyPageLine } from './loginFamilyRows.js'
import { KeyCardTitle } from './KeyCardTitle.js'
import { usePopupCompact } from '../context/popupFormContext.js'

export function MetaConnect({ onResult, onBack }: {
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
    const guard = keyPasteGuardNote(key, { stores: 'a Meta Model API key' })
    if (guard !== null) { setNote(guard); return }
    setStoring(true)
    void storeMetaApiKeyLogin(key).then(outcome => {
      if (!outcome.stored) { setStoring(false); setNote(outcome.receipt); return }
      onResult({ ok: outcome.ok, receipt: outcome.receipt })
    })
  }
  return (
    <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
      <KeyCardTitle family="meta" short="Meta key">Connect Meta — API key</KeyCardTitle>
      {compact ? null : <Text>{keyPageLine('meta')}</Text>}
      {compact ? null : <Text>Use a pay-as-you-go Model API key. Muse Code browser sign-in and subscriptions are for Muse Code only.</Text>}
      {compact ? null : <Text>Stored auth-scoped (mode 600), never logged. MODEL_API_KEY, then META_API_KEY, wins over the store.</Text>}
      <Box>
        <Text>Key: </Text>
        <TextInput value={value} onChange={setValue} onSubmit={submit} mask="*" columns={48} cursorOffset={cursor} onChangeCursorOffset={setCursor} />
      </Box>
      {storing ? <Text dimColor>Checking the key with Meta…</Text> : null}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      {compact ? null : <Text dimColor>esc back</Text>}
    </Box>
  )
}

export default MetaConnect
