import React from 'react'
import { Box, Text } from '../../../screen/themedRenderer.js'
import { Select } from '../../../screen/select/index.js'
import type { useAnthropicLoginModel } from '../../../screen/widgets/faces/anthropicLoginModel.js'
import { OpenrouterConnect } from './OpenrouterConnect.js'
import { GeminiConnect } from './GeminiConnect.js'
import { HuggingfaceConnect } from './HuggingfaceConnect.js'
import { KimiConnect } from './KimiConnect.js'
import { ZaiConnect } from './ZaiConnect.js'
import { DeepseekConnect } from './DeepseekConnect.js'
import { XaiConnect } from './XaiConnect.js'
import { MetaConnect } from './MetaConnect.js'
import { MistralConnect } from './MistralConnect.js'
import { NousConnect } from './NousConnect.js'
import { ZenConnect } from './ZenConnect.js'
import { MinimaxConnect } from './MinimaxConnect.js'
import { TogetherConnect } from './TogetherConnect.js'
import { CohereConnect } from './CohereConnect.js'
import { GroqConnect } from '../../roads/groq/GroqConnect.js'
import { MeliousConnect } from '../../roads/melious/MeliousConnect.js'
import { OrcarouterConnect } from '../../roads/orcarouter/OrcarouterConnect.js'
import { CerebrasConnect } from '../../roads/cerebras/CerebrasConnect.js'
import { FireworksConnect } from '../../roads/fireworks/FireworksConnect.js'
import { QwenConnect } from '../../roads/qwen/QwenConnect.js'
import { AnthropicKeyLeg } from './AnthropicKeyLeg.js'
import { anthropicArmPickRows, openaiArmPickRows } from './loginFamilyRows.js'
import { OpenaiSubscriptionLeg, OpenaiKeyLeg } from './openaiLegs.js'

export type EngineLeg =
  | 'anthropic'
  | 'anthropic-key'
  | 'openai'
  | 'openai-subscription'
  | 'openai-key'
  | 'openrouter'
  | 'gemini'
  | 'huggingface'
  | 'moonshot'
  | 'zai'
  | 'deepseek'
  | 'xai'
  | 'meta'
  | 'mistral'
  | 'nous'
  | 'zen'
  | 'minimax'
  | 'together'
  | 'cohere'
  | 'groq'
  | 'melious'
  | 'orcarouter'
  | 'cerebras'
  | 'fireworks'
  | 'qwen'
  | `compat/${string}`

export function legCard({
  leg,
  frame,
  compact,
  setLeg,
  model,
  onDone,
  onOpenaiDone,
  settleLeg,
}: {
  leg: EngineLeg
  frame: (children: React.ReactNode) => React.ReactNode
  compact: boolean
  setLeg: React.Dispatch<React.SetStateAction<EngineLeg | null>>
  model: ReturnType<typeof useAnthropicLoginModel>
  onDone: () => void
  onOpenaiDone: ((result: { ok: boolean; receipt: string }) => void) | undefined
  settleLeg: (result: { ok: boolean; receipt: string }) => void
}): React.ReactNode {
  switch (leg) {
    case 'anthropic':
      return frame(
        <Box flexDirection="column" gap={compact ? 0 : 1}>
          <Text wrap="truncate-end">Anthropic</Text>
          <Select
            options={[...anthropicArmPickRows]}
            onChange={value => {
              if (value === 'key') { setLeg('anthropic-key'); return }
              setLeg(null)
              model.start(value === 'claudeai')
            }}
            onCancel={() => setLeg(null)}
          />
        </Box>,
      )

    case 'anthropic-key':
      return frame(<AnthropicKeyLeg onDone={onDone} onBack={() => setLeg('anthropic')} />)
    case 'openai':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>OpenAI login unavailable here.</Text>)
      return frame(
        <Box flexDirection="column" gap={compact ? 0 : 1}>
          <Text wrap="truncate-end">OpenAI</Text>
          <Select
            options={[...openaiArmPickRows]}
            onChange={value => setLeg(value === 'key' ? 'openai-key' : 'openai-subscription')}
            onCancel={() => setLeg(null)}
          />
        </Box>,
      )

    case 'openai-subscription':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>OpenAI login unavailable here.</Text>)
      return frame(<OpenaiSubscriptionLeg onOpenaiDone={settleLeg} />)

    case 'openrouter':
      if (onOpenaiDone === undefined)
        return frame(<Text dimColor>OpenRouter login unavailable here.</Text>)
      return frame(<OpenrouterConnect onResult={settleLeg} />)

    case 'gemini':
      if (onOpenaiDone === undefined)
        return frame(<Text dimColor>Gemini login unavailable here.</Text>)
      return frame(<GeminiConnect onResult={settleLeg} />)

    case 'huggingface':
      if (onOpenaiDone === undefined)
        return frame(<Text dimColor>Hugging Face login unavailable here.</Text>)
      return frame(<HuggingfaceConnect onResult={settleLeg} />)

    case 'moonshot':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>Kimi login unavailable here.</Text>)
      return frame(<KimiConnect onResult={settleLeg} />)

    case 'zai':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>GLM (Z.AI) login unavailable here.</Text>)
      return frame(<ZaiConnect onResult={settleLeg} />)

    case 'meta':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>Meta login unavailable here.</Text>)
      return frame(<MetaConnect onResult={settleLeg} onBack={() => setLeg(null)} />)

    case 'mistral':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>Mistral login unavailable here.</Text>)
      return frame(<MistralConnect onResult={settleLeg} onBack={() => setLeg(null)} />)

    case 'nous':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>Nous Portal login unavailable here.</Text>)
      return frame(<NousConnect onResult={settleLeg} onBack={() => setLeg(null)} />)

    case 'zen':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>OpenCode Zen login unavailable here.</Text>)
      return frame(<ZenConnect onResult={settleLeg} onBack={() => setLeg(null)} />)

    case 'minimax':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>MiniMax login unavailable here.</Text>)
      return frame(<MinimaxConnect onResult={settleLeg} onBack={() => setLeg(null)} />)

    case 'together':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>Together AI login unavailable here.</Text>)
      return frame(<TogetherConnect onResult={settleLeg} onBack={() => setLeg(null)} />)

    case 'cohere':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>Cohere login unavailable here.</Text>)
      return frame(<CohereConnect onResult={settleLeg} onBack={() => setLeg(null)} />)

    case 'groq':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>Groq login unavailable here.</Text>)
      return frame(<GroqConnect onResult={settleLeg} onBack={() => setLeg(null)} />)
    case 'melious':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>Melious login unavailable here.</Text>)
      return frame(<MeliousConnect onResult={settleLeg} onBack={() => setLeg(null)} />)
    case 'orcarouter':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>OrcaRouter login unavailable here.</Text>)
      return frame(<OrcarouterConnect onResult={settleLeg} onBack={() => setLeg(null)} />)
    case 'cerebras':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>Cerebras login unavailable here.</Text>)
      return frame(<CerebrasConnect onResult={settleLeg} onBack={() => setLeg(null)} />)
    case 'fireworks':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>Fireworks login unavailable here.</Text>)
      return frame(<FireworksConnect onResult={settleLeg} onBack={() => setLeg(null)} />)
    case 'qwen':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>Qwen login unavailable here.</Text>)
      return frame(<QwenConnect onResult={settleLeg} onBack={() => setLeg(null)} />)
    case 'deepseek':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>DeepSeek login unavailable here.</Text>)
      return frame(<DeepseekConnect onResult={settleLeg} onBack={() => setLeg(null)} />)

    case 'xai':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>xAI login unavailable here.</Text>)
      return frame(<XaiConnect onResult={settleLeg} onBack={() => setLeg(null)} />)

    case 'openai-key':
      if (onOpenaiDone === undefined) return frame(<Text dimColor>OpenAI login unavailable here.</Text>)
      return frame(<OpenaiKeyLeg onOpenaiDone={settleLeg} onBack={() => setLeg('openai')} />)
  }
  return null
}
