import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../../../ink.js'
import TextInput from '../../../components/TextInput.js'
import { useMercuryTokens } from '../../../components/mercury-ui/useMercuryTokens.js'
import { storeMeliousApiKeyLogin } from './meliousLogin.js'
import { keyPasteGuardNote } from '../../../components/mercury-ui/screens/keyPasteGuards.js'
import { keyPageLine } from '../../../components/loginFamilyRows.js'
import { KeyCardTitle } from '../../../components/KeyCardTitle.js'
import { usePopupCompact } from '../../../context/popupFormContext.js'


export function MeliousConnect({ onResult, onBack }: {
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
    const guard = keyPasteGuardNote(key, { stores: 'a Melious AI API key' })
    if (guard !== null) { setNote(guard); return }
    setStoring(true)
    void storeMeliousApiKeyLogin(key).then(outcome => {
      if (!outcome.stored) { setStoring(false); setNote(outcome.receipt); return }
      onResult({ ok: outcome.ok, receipt: outcome.receipt })
    })
  }
  return (
    <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
      <KeyCardTitle family="melious" short="Melious key">Connect Melious AI — API key</KeyCardTitle>
      {compact ? null : <Text>{keyPageLine('melious')}</Text>}
      <Box>
        <Text>Key: </Text>
        <TextInput value={value} onChange={setValue} onSubmit={submit} mask="*" columns={48} cursorOffset={cursor} onChangeCursorOffset={setCursor} />
      </Box>
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      {compact ? null : <Text dimColor>esc back</Text>}
    </Box>
  )
}

export default MeliousConnect
