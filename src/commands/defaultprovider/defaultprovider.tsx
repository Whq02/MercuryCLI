import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../../components/CustomSelect/index.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { providerDisplayName } from '../../services/providers/routeLaw.js'
import { presenceIdentityWords, providerFamilyPresences } from '../../services/providers/providerUsage.js'
import {
  knownDefaultProviderFamilies,
  switchDefaultProvider,
} from '../../utils/model/defaultProviderRung.js'
import {
  NO_SIGN_IN_ROW,
  computedDefault,
  describeComputedDefault,
  type ComputedDefault,
} from '../../utils/model/computedDefault.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'


export function parseDefaultProviderWord(token: string | undefined): string | undefined {
  switch ((token ?? '').toLowerCase()) {
    case 'anthropic':
    case 'claude':
    case 'claudeai':
      return 'anthropic'
    case 'openai':
    case 'chatgpt':
    case 'gpt':
      return 'openai'
    case 'openrouter':
      return 'openrouter'
    case 'gemini':
    case 'google':
      return 'gemini'
    case 'huggingface':
    case 'hf':
      return 'huggingface'
    case 'moonshot':
    case 'kimi':
      return 'moonshot'
    case 'zai':
    case 'z.ai':
    case 'glm':
      return 'zai'
    case 'deepseek':
      return 'deepseek'
    case 'local':
      return 'local'
    case 'compat':
    case 'openai-compat':
    case 'custom':
      return 'openai-compat'
    default:
      return undefined
  }
}

function loginsWord(family: string): string {
  return family === 'openai-compat' ? 'compat' : family
}

function standing(decision: ComputedDefault): string {
  return decision.provider === null
    ? NO_SIGN_IN_ROW
    : `${decision.row} (${decision.setting}) on ${providerDisplayName(decision.provider)}`
}

function switchReceipt(family: string, recorded: boolean): string {
  const name = providerDisplayName(family)
  if (!recorded) {
    return `Default provider NOT switched — the sign-in ledger could not record ${name}; the default stays ${standing(computedDefault())}.`
  }
  const decision = computedDefault()
  if (decision.provider === family) {
    return `Default provider set to ${name} — default model now ${decision.setting} (${decision.row}); fresh sessions start there. Recorded in the sign-in ledger; a later sign-in moves it.`
  }
  const considered = decision.considered.find(c => c.family === family)
  if (considered === undefined) {
    return `Default provider set to ${name} — it holds no credential yet, so the default stays ${standing(decision)}; /logins ${loginsWord(family)} signs it in and the switch takes effect then. Recorded in the sign-in ledger.`
  }
  const why = considered.verdict.usable ? 'its row was not chosen' : considered.verdict.why
  return `Default provider set to ${name} — it offers no usable row yet (${why}), so the default stays ${standing(decision)}. Recorded in the sign-in ledger.`
}

function currentLine(decision: ComputedDefault): string {
  return `Default: ${describeComputedDefault(decision, providerDisplayName)}.`
}

function DefaultProviderPicker({ onDone }: { onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const tokens = useMercuryTokens()
  const decision = computedDefault()
  const current = decision.provider ?? undefined
  const presences = providerFamilyPresences()
  const options = knownDefaultProviderFamilies().map(id => {
    const presence = presences.find(p => p.id === id)
    const marks: string[] = []
    if (id === current) marks.push('current')
    marks.push(
      presence?.credentialed
        ? (presenceIdentityWords(presence) ?? 'signed in')
        : `not connected — /logins ${loginsWord(id)} signs it in first`,
    )
    return { label: `${providerDisplayName(id)} — ${marks.join(' · ')}`, value: id }
  })
  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Default provider</Text>
      <Text dimColor>
        {currentLine(decision)} The default is the provider of the most recent sign-in; a switch here is
        your word that a provider is the most recent, and the next sign-in moves it again. Explicit
        /model picks always win.
      </Text>
      <Select
        visibleOptionCount={options.length}
        options={options}
        {...(current !== undefined ? { defaultFocusValue: current } : {})}
        onChange={value => {
          onDone(switchReceipt(value, switchDefaultProvider(value)))
        }}
        onCancel={() => onDone(undefined, { display: 'skip' })}
      />
      <Text color={tokens.textSecondary}>↵ sets · esc closes</Text>
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const token = (args ?? '').trim().split(/\s+/).filter(Boolean)[0]
  if (token !== undefined) {
    const family = parseDefaultProviderWord(token)
    if (family === undefined) {
      onDone(
        `Unknown provider '${token}' — the vocabulary: anthropic · openai · openrouter · gemini · huggingface · moonshot · zai · deepseek · compat · local.`,
      )
      return null
    }
    onDone(switchReceipt(family, switchDefaultProvider(family)))
    return null
  }
  return <DefaultProviderPicker onDone={onDone} />
}
