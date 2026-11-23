import type { ProviderId } from '../../roads/providerUsability.js'

export const MORE_BELOW_ROW = (hidden: number): string => `…and ${hidden} more below`

export const READINESS_ROWS: ReadonlyArray<{ id: ProviderId; label: string }> = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'huggingface', label: 'Hugging Face' },
  { id: 'moonshot', label: 'Kimi (Moonshot)' },
  { id: 'zai', label: 'GLM (Z.AI)' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'xai', label: 'xAI' },
  { id: 'meta', label: 'Meta' },
  { id: 'mistral', label: 'Mistral' },
  { id: 'zen', label: 'OpenCode Zen' },
  { id: 'minimax', label: 'MiniMax' },
  { id: 'together', label: 'Together AI' },
  { id: 'cohere', label: 'Cohere' },
  { id: 'groq', label: 'Groq' },
  { id: 'melious', label: 'Melious AI' },
  { id: 'orcarouter', label: 'OrcaRouter' },
  { id: 'cerebras', label: 'Cerebras' },
  { id: 'fireworks', label: 'Fireworks' },
  { id: 'qwen', label: 'Qwen' },
  { id: 'local', label: 'Local servers' },
  { id: 'openai-compat', label: 'OpenAI-compatible' },
  { id: 'nous', label: 'Nous Portal' },
]
