import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../../../screen/themedRenderer.js'
import TextInput from '../../../screen/composer/text-input/TextInput.js'
import { useMercuryTokens } from '../../../screen/widgets/useMercuryTokens.js'
import { usePopupCompact } from '../../../screen/overlays/popupFormContext.js'
import { keyPasteGuardNote } from '../../../screen/widgets/faces/keyPasteGuards.js'
import { storeCompatApiKeyLogin } from '../../roads/openaicompat/compatLogin.js'
import { compatKeyEnvName } from '../../roads/openaicompat/compatAccounts.js'

export function CompatConnect({ name, onResult, onBack }: {
  name: string
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
    if (storing || !raw.trim()) return
    const guard = keyPasteGuardNote(raw.trim(), { stores: `the key for endpoint ${name}` })
    if (guard !== null) { setNote(guard); return }
    setStoring(true)
    void storeCompatApiKeyLogin(name, raw).then(outcome => {
      setValue('')
      if (!outcome.stored) { setStoring(false); setNote(outcome.receipt); return }
      onResult(outcome)
    })
  }
  return <Box flexDirection="column" gap={compact ? 0 : 1} paddingX={compact ? 0 : 1}>
    <Text>Endpoint {name} — API key</Text>
    {compact ? null : <Text>Stored for this endpoint only, auth-scoped (mode 600). {compatKeyEnvName(name)} wins over the store.</Text>}
    <Box><Text>Key: </Text><TextInput value={value} onChange={setValue} onSubmit={submit} mask="*" columns={48} cursorOffset={cursor} onChangeCursorOffset={setCursor} /></Box>
    {storing ? <Text dimColor>Storing the key and reading the model list…</Text> : null}
    {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
    {compact ? null : <Text dimColor>esc back</Text>}
  </Box>
}
