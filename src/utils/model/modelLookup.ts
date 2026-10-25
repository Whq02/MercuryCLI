export const MODEL_LOOKUP_LADDER = "The ladder is live, then known, then web, then ask: read mercury://models, then mercury://models/known. If neither page carries the word, you may use WebSearch with the provider's name and that word, starting with its published models page listed in mercury://models. Web text is unverified: it informs the ask, never a launch. Then ask the operator for the model id with AskUserQuestion, naming the providers that are signed in, the nearest live or known rows, and any web findings with their links; in a headless run say why in one line and stop. Never switch to another provider on your own — if the one you were asked for cannot run, say why and stop."

export const PROVIDER_MODEL_PAGES: Readonly<Record<string, string>> = {
  anthropic: 'https://platform.claude.com/docs/en/models/overview',
  openai: 'https://developers.openai.com/api/docs/models',
  xai: 'https://docs.x.ai/developers/models',
  meta: 'https://dev.meta.ai/docs/models',
  zai: 'https://docs.z.ai/guides/overview/overview',
  moonshot: 'https://platform.kimi.ai/docs/introduction',
  deepseek: 'https://api-docs.deepseek.com/quick_start/pricing/',
  gemini: 'https://ai.google.dev/gemini-api/docs/models',
  mistral: 'https://docs.mistral.ai/models',
  openrouter: 'https://openrouter.ai/models',
  huggingface: 'https://huggingface.co/models?inference_provider=all',
  zen: 'https://opencode.ai/v2/docs/console/models/',
  minimax: 'https://platform.minimax.io/docs/guides/models-intro',
  together: 'https://docs.together.ai/docs/serverless-models',
  cohere: 'https://docs.cohere.com/docs/models',
  groq: 'https://console.groq.com/docs/models',
  melious: 'https://melious.ai/hub/models',
  orcarouter: 'https://docs.orcarouter.ai/getting-started/models',
  cerebras: 'https://inference-docs.cerebras.ai/models/overview',
  fireworks: 'https://fireworks.ai/models',
  qwen: 'https://www.alibabacloud.com/help/en/model-studio/getting-started/models',
}
const MODEL_PAGES_CHECKED = '2026-10-13'
