import type { Command } from '../../commands.js'
import { anyProviderCredentialed } from '../../services/providers/providerUsage.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { shouldNavCommandBeImmediate } from '../../utils/immediateCommand.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'logins',
    aliases: ['login'],
    // LAZY + hardened: the eager form ran credential IO
    // at catalogue-build time — a bare environment threw before any command
    // could render. Resolved per read; a failed probe falls back to sign-in copy.
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
    isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGIN_COMMAND),
    // Opens immediately, even mid-turn (auth changes take effect immediately).
    get immediate() {
      return shouldNavCommandBeImmediate()
    },
    load: () => import('./login.js'),
  }) satisfies Command
