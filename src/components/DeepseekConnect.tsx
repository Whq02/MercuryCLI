import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { storeDeepseekApiKeyLogin } from '../services/providers/deepseek/deepseekLogin.js'
import { keyPasteGuardNote } from './mercury-ui/screens/keyPasteGuards.js'

// ============================================================================
//  DeepseekConnect — the DeepSeek connect surface hosted by /logins. DeepSeek
//  is API-key only (no OAuth exists to offer), so the surface is the honest
//  key leg: the key is proven live through the documented balance endpoint
//  before it is stored (auth-scoped, mode 600; DEEPSEEK_API_KEY always
//  wins). The leg's logic lives in deepseekLogin (one driver, shared with
//  the loopback prover); secrets never render.
// ============================================================================

export function DeepseekConnect({
  onResult,
  onBack,
}: {
  onResult: (result: { ok: boolean; receipt: string }) => void
  /** Esc before anything is stored returns to the card's menu. */
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
    // The one guard spelling (keyPasteGuards).
    const guard = keyPasteGuardNote(key, { stores: 'a DeepSeek API key' })
    if (guard !== null) {
      setNote(guard)
      return
    }
    setStoring(true)
    void storeDeepseekApiKeyLogin(key).then(outcome => {
      if (!outcome.stored) {
        // A refused key is corrected here, never stored; a store failure too.
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
        Connect DeepSeek — API key
      </Text>
      <Text>
        DeepSeek signs in with API keys only (platform.deepseek.com → API keys). Stored auth-scoped (mode 600),
        never logged; a DEEPSEEK_API_KEY env var always wins over the store.
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
      {storing ? <Text dimColor>Checking the key against the DeepSeek balance endpoint…</Text> : null}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      <Text dimColor>esc back</Text>
    </Box>
  )
}

export default DeepseekConnect
