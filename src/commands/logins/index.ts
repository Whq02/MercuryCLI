import type { Command } from '../catalogue/commands.js'
import { flagEnabled } from '../../platform/substrate/flagRegistry.js'
import { anyProviderCredentialed } from '../../models/roads/providerUsage.js'
import { shouldNavCommandBeImmediate } from '../catalogue/immediateCommand.js'
import { passedOver } from '../../platform/errors/passedOver.js'

const SIGN_IN_FAMILIES =
  'Anthropic · OpenAI ChatGPT · OpenRouter · Gemini · Hugging Face · Kimi · GLM · DeepSeek · xAI · Meta · Mistral · Nous Portal · MiniMax · Together AI · Cohere · Groq · Melious AI · OrcaRouter · Cerebras · Fireworks · Qwen · API keys'

export default () =>
  ({
    type: 'local-jsx',
    name: 'logins',
    aliases: ['login'],
    get description() {
      try {
        return anyProviderCredentialed() ? `Re-login or add accounts (${SIGN_IN_FAMILIES})` : `Sign in (${SIGN_IN_FAMILIES})`
      } catch (error) {
        passedOver(error)
        return `Sign in (${SIGN_IN_FAMILIES})`
      }
    },
    argumentHint: '[anthropic|openai|console|openrouter|gemini|huggingface|kimi|glm|deepseek|xai|meta|mistral|nous|zen|minimax|together|cohere|groq|orcarouter|melious|cerebras|fireworks|qwen]',
    isEnabled: () => flagEnabled('MERCURY_LOGIN_COMMAND'),
    get immediate() {
      return shouldNavCommandBeImmediate()
    },
    load: () => import('./login.js'),
  }) satisfies Command
