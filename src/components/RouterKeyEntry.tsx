import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import TextInput from './TextInput.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import {
  providerSecretsPathForDisplay,
  writeStoredBraveSearchApiKey,
  writeStoredCompatApiKey,
  writeStoredDeepseekApiKey,
  writeStoredMetaApiKey,
  writeStoredMistralApiKey,
  writeStoredMistralAdminApiKey,
  writeStoredHuggingfaceApiKey,
  writeStoredLocalApiKey,
  writeStoredMoonshotApiKey,
  writeStoredNousApiKey,
  writeStoredTavilyApiKey,
  writeStoredXaiApiKey,
  writeStoredXaiManagementApiKey,
  writeStoredZaiApiKey,
  writeStoredZenApiKey,
} from '../utils/router/providerSecrets.js'
import { zaiKeySource } from '../utils/router/providerDiscovery.js'
import { XAI_MANAGEMENT_KEY_PAGE } from '../services/providers/xai/xaiUsageState.js'
import { MISTRAL_ADMIN_KEY_PAGE } from '../services/providers/mistral/mistralUsageState.js'


export type KeyEntryProvider = 'zai' | 'moonshot' | 'deepseek' | 'xai' | 'xai-management' | 'meta' | 'compat' | 'huggingface' | 'local' | 'brave' | 'tavily' | 'mistral' | 'mistral-admin' | 'nous' | 'zen'

const LANES: Record<
  KeyEntryProvider,
  {
    title: string
    envVar: string
    write: (key: string | null) => void
    envShadow: () => boolean
  }
> = {
  zai: {
    title: 'Z.AI API key',
    envVar: 'ZAI_API_KEY',
    write: writeStoredZaiApiKey,
    envShadow: () => zaiKeySource() === 'env',
  },
  moonshot: {
    title: 'Moonshot API key',
    envVar: 'MOONSHOT_API_KEY',
    write: writeStoredMoonshotApiKey,
    envShadow: () => Boolean(process.env.MOONSHOT_API_KEY?.trim()),
  },
  meta: {
    title: 'Meta Model API key (pay-as-you-go)',
    envVar: 'MODEL_API_KEY / META_API_KEY',
    write: writeStoredMetaApiKey,
    envShadow: () => Boolean(process.env.MODEL_API_KEY?.trim() || process.env.META_API_KEY?.trim()),
  },
  deepseek: {
    title: 'DeepSeek API key',
    envVar: 'DEEPSEEK_API_KEY',
    write: writeStoredDeepseekApiKey,
    envShadow: () => Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
  },
  xai: {
    title: 'xAI API key',
    envVar: 'XAI_API_KEY',
    write: writeStoredXaiApiKey,
    envShadow: () => Boolean(process.env.XAI_API_KEY?.trim()),
  },
  'xai-management': {
    title: 'xAI management key',
    envVar: 'XAI_MANAGEMENT_API_KEY',
    write: writeStoredXaiManagementApiKey,
    envShadow: () => Boolean(process.env.XAI_MANAGEMENT_API_KEY?.trim()),
  },
  compat: {
    title: 'Custom endpoint API key',
    envVar: 'MERCURY_COMPAT_API_KEY',
    write: writeStoredCompatApiKey,
    envShadow: () => Boolean(process.env.MERCURY_COMPAT_API_KEY?.trim()),
  },
  huggingface: {
    title: 'Hugging Face token',
    envVar: 'HF_TOKEN',
    write: writeStoredHuggingfaceApiKey,
    envShadow: () => Boolean(process.env.HF_TOKEN?.trim()),
  },
  local: {
    title: 'Local server API key',
    envVar: 'MERCURY_LOCAL_API_KEY',
    write: writeStoredLocalApiKey,
    envShadow: () => Boolean(process.env.MERCURY_LOCAL_API_KEY?.trim()),
  },
  brave: {
    title: 'Brave Search API key',
    envVar: 'BRAVE_API_KEY',
    write: writeStoredBraveSearchApiKey,
    envShadow: () => Boolean(process.env.BRAVE_API_KEY?.trim()),
  },
  tavily: {
    title: 'Tavily API key',
    envVar: 'TAVILY_API_KEY',
    write: writeStoredTavilyApiKey,
    envShadow: () => Boolean(process.env.TAVILY_API_KEY?.trim()),
  },
  mistral: {
    title: 'Mistral API key',
    envVar: 'MISTRAL_API_KEY',
    write: writeStoredMistralApiKey,
    envShadow: () => Boolean(process.env.MISTRAL_API_KEY?.trim()),
  },
  'mistral-admin': {
    title: 'Mistral Admin API key (usage meter)',
    envVar: 'MISTRAL_ADMIN_API_KEY',
    write: writeStoredMistralAdminApiKey,
    envShadow: () => Boolean(process.env.MISTRAL_ADMIN_API_KEY?.trim()),
  },
  nous: {
    title: 'Nous Portal API key',
    envVar: 'NOUS_API_KEY',
    write: writeStoredNousApiKey,
    envShadow: () => Boolean(process.env.NOUS_API_KEY?.trim()),
  },
  zen: {
    title: 'OpenCode Zen API key',
    envVar: 'OPENCODE_API_KEY',
    write: writeStoredZenApiKey,
    envShadow: () => Boolean(process.env.OPENCODE_API_KEY?.trim()),
  },
}

export function RouterKeyEntry({
  provider = 'zai',
  onDone,
}: {
  provider?: KeyEntryProvider
  onDone: (receipt: string) => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [value, setValue] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const lane = LANES[provider]

  useInput((_input, key) => {
    if (key.escape) onDone(`${lane.title} entry cancelled — nothing written.`)
  })

  const submit = (raw: string): void => {
    const key = raw.trim()
    if (!key) {
      onDone(`${lane.title} entry cancelled — empty input, nothing written.`)
      return
    }
    try {
      lane.write(key)
      const envShadow = lane.envShadow()
      onDone(
        `${lane.title} stored (auth-scoped, mode 600): ${providerSecretsPathForDisplay()}${envShadow ? ` — NOTE: an explicit ${lane.envVar} env pin is set and WINS over the store this session` : ''}. /router engines shows readiness; /router key ${provider === 'zai' ? '' : `${provider} `}clear removes it.`,
      )
    } catch (error) {
      onDone(
        `${lane.title} NOT stored — write failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={tokens.accent}>
        {lane.title}
      </Text>
      {provider === 'xai-management' ? <Text>{XAI_MANAGEMENT_KEY_PAGE} Needs Management Keys Read + Write permission; the API key identifies the team.</Text> : null}
      {provider === 'mistral-admin' ? <Text>{MISTRAL_ADMIN_KEY_PAGE}</Text> : null}
      <Text color={tokens.textSecondary}>
        Paste the key — input is masked (the last 6 characters stay visible so you can
        confirm the paste); the value never enters the transcript, receipts, or logs.
        Enter saves to the auth-scoped secret store; ESC cancels.
      </Text>
      <Box>
        <Text color={tokens.textMuted}>key: </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={submit}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          columns={60}
          mask="*"
        />
      </Box>
    </Box>
  )
}

export default RouterKeyEntry
