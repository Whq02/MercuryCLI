import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { storeXaiApiKeyLogin } from '../services/providers/xai/xaiLogin.js'
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
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [storing, setStoring] = useState(false)
  useInput((_input, key) => {
    if (key.escape && !storing) onBack()
  })
  const submit = (raw: string): void => {
    const key = raw.trim()
    if (!key) return
    const guard = keyPasteGuardNote(key, { stores: 'an xAI API key' })
    if (guard !== null) {
      setNote(guard)
      return
    }
    setStoring(true)
    void storeXaiApiKeyLogin(key).then(outcome => {
      if (!outcome.stored) {
        setStoring(false)
        setNote(outcome.receipt)
        return
      }
      onResult({ ok: outcome.ok, receipt: outcome.receipt })
    })
  }
  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      <Text bold color={tokens.accent}>
        Connect xAI — API key
      </Text>
      <Text>{keyPageLine('xai')}</Text>
      <Text>
        xAI signs in with API keys only. Stored auth-scoped (mode 600), never logged; an XAI_API_KEY env var
        always wins over the store.
      </Text>
      <Box>
        <Text>Key: </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={submit}
          mask="*"
          columns={48}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
      {storing ? <Text dimColor>Checking the key with xAI…</Text> : null}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      <Text dimColor>esc back</Text>
    </Box>
  )
}

export default XaiConnect
