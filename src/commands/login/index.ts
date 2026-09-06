import type { Command } from '../../commands.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { anyProviderCredentialed } from '../../services/providers/providerUsage.js'
import { shouldNavCommandBeImmediate } from '../../utils/immediateCommand.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'logins',
    aliases: ['login'],
    get description() {
      try {
        return anyProviderCredentialed()
          ? 'Re-login or add accounts (Claude subscription · OpenAI ChatGPT · OpenRouter · Gemini · Hugging Face · Kimi · GLM · DeepSeek · API keys)'
          : 'Sign in (Claude subscription · OpenAI ChatGPT · OpenRouter · Gemini · Hugging Face · Kimi · GLM · DeepSeek · API keys)'
      } catch {
        return 'Sign in (Claude subscription · OpenAI ChatGPT · OpenRouter · Gemini · Hugging Face · Kimi · GLM · DeepSeek · API keys)'
      }
    },
    argumentHint: '[anthropic|openai|console|openrouter|gemini|huggingface|kimi|glm|deepseek]',
    isEnabled: () => flagEnabled('MERCURY_LOGIN_COMMAND'),
    get immediate() {
      return shouldNavCommandBeImmediate()
    },
    load: () => import('./login.js'),
  }) satisfies Command
