import React, { useState } from 'react'
import { Box, Text } from '../../../screen/themedRenderer.js'
import TextInput from '../../../screen/composer/text-input/TextInput.js'
import { useMercuryTokens } from '../../../screen/widgets/useMercuryTokens.js'
import { usePopupCompact } from '../../../screen/overlays/popupFormContext.js'
import { useInput } from '../../../screen/themedRenderer.js'
import { OpenaiConnect } from './OpenaiConnect.js'
import { KeyCardTitle } from './KeyCardTitle.js'
import { storeOpenaiApiKeyLogin } from '../../roads/openai/openaiLogin.js'
import { keyPasteGuardNote } from '../../../screen/widgets/faces/keyPasteGuards.js'
import { keyPageLine } from './loginFamilyRows.js'

export function OpenaiSubscriptionLeg({
  onOpenaiDone,
}: {
  onOpenaiDone: (result: { ok: boolean; receipt: string }) => void
}): React.ReactNode {
  const [mode, setMode] = useState<'browser' | 'device'>('browser')
  return (
    <OpenaiConnect
      key={mode}
      mode={mode}
      onDone={() => {}}
      onResult={onOpenaiDone}
      {...(mode === 'browser' ? { onSwitchToDevice: () => setMode('device') } : {})}
    />
  )
}

export function OpenaiKeyLeg({
  onOpenaiDone,
  onBack,
}: {
  onOpenaiDone: (result: { ok: boolean; receipt: string }) => void
  onBack: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [key, setKey] = useState('')
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [storing, setStoring] = useState(false)
  useInput((_input, k) => {
    if (k.escape && !storing) onBack()
  })
  const submit = (raw: string): void => {
    const value = raw.trim()
    if (!value) return
    const guard = keyPasteGuardNote(value, {
      stores: 'an OpenAI key. Anthropic usage-based billing signs in through the Anthropic row, under Usage-based billing, instead',
    })
    if (guard !== null) {
      setNote(guard)
      return
    }
    setStoring(true)
    void storeOpenaiApiKeyLogin(value).then(outcome => {
      if (!outcome.stored) {
        setStoring(false)
        setNote(outcome.receipt)
        return
      }
      onOpenaiDone({ ok: outcome.ok, receipt: outcome.receipt })
    })
  }
  const { compact } = usePopupCompact()
  return (
    <Box flexDirection="column" gap={compact ? 0 : 1}>
      {compact ? <KeyCardTitle family="openai">OpenAI key</KeyCardTitle> : <Text>{keyPageLine('openai')}</Text>}
      {compact ? null : <Text>Paste your OpenAI API key. Stored auth-scoped (mode 600), never logged; an OPENAI_API_KEY env var always wins over the store.</Text>}
      <Box>
        <Text>Key: </Text>
        <TextInput
          value={key}
          onChange={setKey}
          onSubmit={submit}
          mask="*"
          columns={48}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
      {storing ? <Text dimColor>Storing and checking the live catalogue…</Text> : null}
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      {compact ? null : <Text dimColor>esc back</Text>}
    </Box>
  )
}
