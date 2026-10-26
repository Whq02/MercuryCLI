import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { storeAnthropicApiKeyLogin } from '../services/providers/anthropic/anthropicLogin.js'
import { usePopupCompact } from '../context/popupFormContext.js'
import TextInput from './TextInput.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'

export function AnthropicKeyLeg({ onDone, onBack }: { onDone: () => void; onBack: () => void }): React.ReactNode {
  const tokens = useMercuryTokens()
  const { compact } = usePopupCompact()
  const [key, setKey] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [needsWorkspace, setNeedsWorkspace] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [storing, setStoring] = useState(false)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])
  useInput((_input, pressed) => {
    if (pressed.escape) { pending.current?.abort(); onBack() }
  })
  const submit = (raw: string): void => {
    if (pending.current || !raw.trim()) return
    const request = new AbortController()
    pending.current = request
    setStoring(true)
    void storeAnthropicApiKeyLogin(needsWorkspace ? key : raw, { workspaceId: needsWorkspace ? raw : undefined, signal: request.signal }).then(outcome => {
      if (request.signal.aborted) return
      pending.current = null
      setStoring(false)
      if (outcome.stored) { setKey(''); onDone(); return }
      setNote(outcome.receipt)
      if (outcome.needsWorkspace) { setNeedsWorkspace(true); setCursor(workspace.length) }
    })
  }
  return (
    <Box flexDirection="column" gap={compact ? 0 : 1}>
      <Text>Paste your Anthropic API key</Text>
      {needsWorkspace ? <Text>Key: {'*'.repeat(Math.min(key.length, 48))}</Text> : null}
      <Box>
        <Text>{needsWorkspace ? 'Workspace ID: ' : 'Key: '}</Text>
        <TextInput
          value={needsWorkspace ? workspace : key}
          onChange={needsWorkspace ? setWorkspace : setKey}
          onSubmit={submit}
          mask={needsWorkspace ? undefined : '*'}
          focus={!storing}
          columns={48}
          cursorOffset={cursor}
          onChangeCursorOffset={setCursor}
        />
      </Box>
      {note ? <Text color={tokens.warning}>{note}</Text> : null}
      <Text dimColor>↵ save · esc back</Text>
    </Box>
  )
}
