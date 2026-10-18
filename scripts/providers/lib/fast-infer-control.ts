import { strict as assert } from 'node:assert'
import { configureEffortParams } from '../../../src/services/providers/anthropic/requestParams.ts'
import { buildOpenaiResponsesRequest } from '../../../src/services/providers/openai/responsesBridge.ts'
import { buildZaiChatRequest } from '../../../src/services/providers/zai/zaiCodec.ts'
import { buildMetaExtras } from '../../../src/services/providers/meta/metaCallModel.ts'
import { buildMistralExtras } from '../../../src/services/providers/mistral/mistralCallModel.ts'
import { nousLaneProfile } from '../../../src/services/providers/nous/nousCallModel.ts'
import { buildZenExtras } from '../../../src/services/providers/zen/zenCallModel.ts'
import { buildMinimaxExtras } from '../../../src/services/providers/minimax/minimaxCallModel.ts'
import { buildTogetherExtras } from '../../../src/services/providers/together/togetherCallModel.ts'
import { buildCohereExtras } from '../../../src/services/providers/cohere/cohereCallModel.ts'
import { buildMoonshotExtras, buildDeepseekExtras, buildOpenrouterExtras, buildXaiExtras, buildCompatSlotExtras, buildHuggingfaceExtras, buildGeminiExtras, buildLocalExtras } from '../../../src/services/providers/openaicompat/compatWire.ts'

export async function proveExistingCompatKnobs(): Promise<void> {
  console.log('\ncontrol: existing request knobs remain byte-identical')
  const args = { wireModel: 'fixture-model', effortValue: 'high', thinkingEnabled: true, maxOutputTokensOverride: 256 }
  const anthropicOut: Record<string, unknown> = {}
  configureEffortParams('high', anthropicOut as never, {}, 'claude-opus-5-5')
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['Anthropic', anthropicOut, '{"effort":"high"}'],
    ['OpenAI', buildOpenaiResponsesRequest({ model: 'gpt-6-astra', instructions: 'sys', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'high', promptCacheKey: 'sess-1' }) as unknown as Record<string, unknown>, '{"model":"gpt-6-astra","instructions":"sys","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],"reasoning":{"effort":"high","summary":"auto"},"store":false,"stream":true,"include":["reasoning.encrypted_content"],"prompt_cache_key":"sess-1"}'],
    ['Z.AI', buildZaiChatRequest({ model: 'glm-5.3', system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 256, reasoningEffort: 'high', thinkingEnabled: true }) as unknown as Record<string, unknown>, '{"model":"glm-5.3","messages":[{"role":"system","content":"sys"},{"role":"user","content":"hi"}],"max_tokens":256,"reasoning_effort":"high","thinking":{"type":"enabled"}}'],
    ['Meta', buildMetaExtras({ ...args, wireModel: 'muse-spark-1.3' }), '{"stream_options":{"include_usage":true},"reasoning_effort":"high","max_completion_tokens":256}'],
    ['Nous Portal', nousLaneProfile.buildExtras!({ ...args, wireModel: 'anthropic/claude-sonnet-4.6' }), '{"stream_options":{"include_usage":true},"max_tokens":256}'],
    ['Mistral', buildMistralExtras({ ...args, wireModel: 'mistral-large-4' }), '{"reasoning_effort":"high","max_tokens":256}'],
    ['OpenCode Zen', buildZenExtras({ ...args, wireModel: 'glm-5.3' }), '{"stream_options":{"include_usage":true},"reasoning_effort":"high","max_completion_tokens":256}'],
    ['MiniMax', buildMinimaxExtras({ ...args, wireModel: 'MiniMax-M3.1-Flash-Preview' }), '{"reasoning_split":true,"stream_options":{"include_usage":true},"reasoning_effort":"high","max_completion_tokens":256}'],
    ['Together AI', buildTogetherExtras({ ...args, wireModel: 'openai/gpt-oss-120b', promptCacheKey: 'sess-1' }), '{"stream_options":{"include_usage":true},"prompt_cache_key":"sess-1","reasoning_effort":"high","max_tokens":256}'],
    ['Cohere', buildCohereExtras({ ...args, wireModel: 'command-a-plus-05-2026' }), '{"reasoning_effort":"high","max_tokens":256}'],
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
