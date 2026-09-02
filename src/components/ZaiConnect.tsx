import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'
import { Select } from './CustomSelect/index.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import type { ZaiApiPlan } from '../services/providers/zai/zaiClient.js'
import { storeZaiApiKeyLogin, zaiPlanLabel } from '../services/providers/zai/zaiLogin.js'
import { keyPasteGuardNote } from './mercury-ui/screens/keyPasteGuards.js'

// ============================================================================
//  ZaiConnect — the GLM (Z.AI) connect surface hosted by /logins. Z.AI is
//  API-key only (no OAuth exists to offer), so the surface is the honest
//  key leg: the operator says which key it is — a GLM Coding Plan key rides
//  https://api.z.ai/api/coding/paas/v4, a general key rides
//  https://api.z.ai/api/paas/v4 — then pastes it (auth-scoped store, mode
//  600; ZAI_API_KEY always wins). The leg's logic lives in zaiLogin (one
//  driver, shared with the loopback prover); secrets never render.
// ============================================================================

export function ZaiConnect({
  onResult,
}: {
  onResult: (result: { ok: boolean; receipt: string }) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [plan, setPlan] = useState<ZaiApiPlan | undefined>(undefined)

  if (plan === undefined) {
    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Text bold color={tokens.accent}>
          Connect GLM (Z.AI) — API key
        </Text>
        <Text color={tokens.textSecondary}>
          Z.AI signs in with API keys only (z.ai/manage-apikey). Which key is this? A GLM Coding Plan key is
          valid on the Coding Plan base and refused on the general one, so the answer picks the base.
        </Text>
        <Select
          options={[
            { label: 'GLM Coding Plan key — api.z.ai/api/coding/paas/v4', value: 'coding' },
            { label: 'Z.AI API key (general, pay-as-you-go) — api.z.ai/api/paas/v4', value: 'general' },
          ]}
          onChange={value => setPlan(value as ZaiApiPlan)}
          onCancel={() => onResult({ ok: false, receipt: 'GLM (Z.AI) key entry cancelled — nothing stored.' })}
        />
      </Box>
    )
  }

  return <ZaiKeyLeg plan={plan} onBack={() => setPlan(undefined)} onResult={onResult} />
}

function ZaiKeyLeg({
  plan,
  onBack,
  onResult,
}: {
  plan: ZaiApiPlan
  onBack: () => void
  onResult: (result: { ok: boolean; receipt: string }) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  useInput((_input, key) => {
    if (key.escape) onBack()
  })
  const submit = (raw: string): void => {
    const key = raw.trim()
    if (!key) return
    // The one guard spelling (keyPasteGuards).
    const guard = keyPasteGuardNote(key, { stores: `a ${zaiPlanLabel(plan)}` })
    if (guard !== null) {
      setNote(guard)
      return
    }
    const outcome = storeZaiApiKeyLogin(key, plan)
    if (!outcome.stored) {
      setNote(outcome.receipt)
      return
    }
    onResult({ ok: outcome.ok, receipt: outcome.receipt })
  }
  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      <Text bold color={tokens.accent}>
        Connect GLM (Z.AI) — {zaiPlanLabel(plan)}
      </Text>
      <Text>
        Paste your {zaiPlanLabel(plan)}. Stored auth-scoped (mode 600), never logged; a ZAI_API_KEY env var
        always wins over the store (and rides the general base).
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
      {note !== null ? <Text color={tokens.warning}>{note}</Text> : null}
      <Text dimColor>esc back</Text>
    </Box>
  )
}

export default ZaiConnect
