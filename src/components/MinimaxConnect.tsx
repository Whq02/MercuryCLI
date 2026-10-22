import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { storeMinimaxApiKeyLogin } from '../services/providers/minimax/minimaxLogin.js'
import { keyPasteGuardNote } from './mercury-ui/screens/keyPasteGuards.js'
import { keyPageLine } from './loginFamilyRows.js'
import { KeyCardTitle } from './KeyCardTitle.js'
import { usePopupCompact } from '../context/popupFormContext.js'

const MINIMAX_CONNECT_BILLING_LINE = 'A pay-as-you-go API key (Account Management → API Keys) or an M Plan Subscription Key (the plan console); text models only — video, speech and music models are not used here.'
const MINIMAX_CONNECT_STORE_LINE = 'Checked on the model list first (a refused key is never stored); stored auth-scoped (mode 600), never logged. MINIMAX_API_KEY wins over the store.'

export function MinimaxConnect({ onResult, onBack }: {
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
    const guard = keyPasteGuardNote(key, { stores: 'a MiniMax API key' })
    if (guard !== null) { setNote(guard); return }
    setStoring(true)
    void storeMinimaxApiKeyLogin(key).then(outcome => {
      if (!outcome.stored) { setStoring(false); setNote(outcome.receipt); return }
      onResult({ ok: outcome.ok, receipt: outcome.receipt })
    })
  }
  return (
    <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
      <KeyCardTitle family="minimax" short="MiniMax key">Connect MiniMax — API key</KeyCardTitle>
      {compact ? null : <Text>{keyPageLine('minimax')}</Text>}
      {compact ? null : <Text>{MINIMAX_CONNECT_BILLING_LINE}</Text>}
      {compact ? null : <Text>{MINIMAX_CONNECT_STORE_LINE}</Text>}
      <Box>
        <Text>Key: </Text>
        <TextInput value={value} onChange={setValue} onSubmit={submit} mask="*" columns={48} cursorOffset={cursor} onChangeCursorOffset={setCursor} />
      </Box>
      {storing ? <Text dimColor>Checking the key with MiniMax…</Text> : null}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      {compact ? null : <Text dimColor>esc back</Text>}
    </Box>
  )
}

export default MinimaxConnect
