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
  writeStoredHuggingfaceApiKey,
  writeStoredLocalApiKey,
  writeStoredMoonshotApiKey,
  writeStoredTavilyApiKey,
  writeStoredZaiApiKey,
} from '../utils/router/providerSecrets.js'
import { zaiKeySource } from '../utils/router/providerDiscovery.js'

// ============================================================================
//  RouterKeyEntry — the masked engine-key entry (`/router key <provider>`;
//  provider-08-21 generalizes it across every key lane). The key is
//  typed/pasted MASKED and never echoes: not in the transcript, not in the
//  receipt, not in any log — presence + storage path only. ESC cancels
//  without writing. The store is auth-scoped (providerSecrets.ts); an
//  explicit env pin (each lane's documented variable) still WINS over what
//  is saved here.
// ============================================================================

export type KeyEntryProvider = 'zai' | 'moonshot' | 'deepseek' | 'compat' | 'huggingface' | 'local' | 'brave' | 'tavily'

const LANES: Record<
  KeyEntryProvider,
  {
    title: string
    envVar: string
    write: (key: string | null) => void
    /** True when an env pin currently shadows the store. */
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
  deepseek: {
    title: 'DeepSeek API key',
    envVar: 'DEEPSEEK_API_KEY',
    write: writeStoredDeepseekApiKey,
    envShadow: () => Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
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
  // The web-search keys (services/search): not model credentials, but the
  // same secret laws and the same masked door.
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
