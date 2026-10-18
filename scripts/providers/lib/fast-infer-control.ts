import { strict as assert } from 'node:assert'
import { buildMistralExtras } from '../../../src/services/providers/mistral/mistralCallModel.ts'
import { buildZenExtras } from '../../../src/services/providers/zen/zenCallModel.ts'
import { buildMoonshotExtras, buildDeepseekExtras, buildOpenrouterExtras, buildXaiExtras, buildCompatSlotExtras, buildHuggingfaceExtras, buildGeminiExtras, buildLocalExtras } from '../../../src/services/providers/openaicompat/compatWire.ts'

export async function proveExistingCompatKnobs(): Promise<void> {
  console.log('\ncontrol: existing request knobs remain byte-identical')
  const args = { wireModel: 'fixture-model', effortValue: 'high', thinkingEnabled: true, maxOutputTokensOverride: 256 }
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['Mistral', buildMistralExtras({ ...args, wireModel: 'mistral-large-4' }), '{"reasoning_effort":"high","max_tokens":256}'],
    ['OpenCode Zen', buildZenExtras({ ...args, wireModel: 'glm-5.3' }), '{"stream_options":{"include_usage":true},"reasoning_effort":"high","max_completion_tokens":256}'],
    ['Moonshot', buildMoonshotExtras({ ...args, wireModel: 'kimi-k3' }), '{"stream_options":{"include_usage":true},"reasoning_effort":"high","max_completion_tokens":256}'],
    ['DeepSeek', buildDeepseekExtras({ ...args, wireModel: 'deepseek-v4-pro' }), '{"thinking":{"type":"enabled"},"reasoning_effort":"high","stream_options":{"include_usage":true},"max_tokens":256}'],
    ['OpenRouter', buildOpenrouterExtras({ ...args, vocabulary: ['low', 'high'] }), '{"stream_options":{"include_usage":true},"reasoning":{"effort":"high"},"max_tokens":256}'],
    ['xAI', buildXaiExtras({ ...args, vocabulary: ['low', 'high'] }), '{"stream_options":{"include_usage":true},"reasoning_effort":"high","max_completion_tokens":256}'],
    ['Custom endpoint', buildCompatSlotExtras(args), '{"stream_options":{"include_usage":true},"max_tokens":256}'],
    ['Hugging Face', buildHuggingfaceExtras(args), '{"stream_options":{"include_usage":true},"max_tokens":256}'],
    ['Gemini', buildGeminiExtras({ ...args, acceptsEffort: true }), '{"stream_options":{"include_usage":true},"reasoning_effort":"high","max_tokens":256}'],
    ['Local', buildLocalExtras({ ...args, server: 'ollama', acceptsEffort: true }), '{"stream_options":{"include_usage":true},"reasoning_effort":"high","max_tokens":256}'],
  ]
  for (const [name, actual, expected] of cases) { assert.equal(JSON.stringify(actual), expected, name); console.log(`[PASS] ${name} request knobs`) }
}
