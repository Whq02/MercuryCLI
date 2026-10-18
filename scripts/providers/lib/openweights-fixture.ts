export const MINIMAX_FIXTURE_MODELS = [
  { id: 'MiniMax-M3', object: 'model', created: 1_780_272_000, owned_by: 'minimax' },
  { id: 'MiniMax-M3.1-Flash-Preview', object: 'model', created: 1_781_000_000, owned_by: 'minimax' },
  { id: 'MiniMax-M2.7', object: 'model', created: 1_773_799_200, owned_by: 'minimax' },
  { id: 'MiniMax-M2.5', object: 'model', created: 1_770_948_000, owned_by: 'minimax' },
  { id: 'MiniMax-M2.1', object: 'model', created: 1_760_000_000, owned_by: 'minimax' },
  { id: 'MiniMax-H3', object: 'model', created: 1_779_000_000, owned_by: 'minimax' },
  { id: 'speech-02-hd', object: 'model', created: 1_750_000_000, owned_by: 'minimax' },
  { id: 'music-2.5', object: 'model', created: 1_760_000_000, owned_by: 'minimax' },
]

export const MINIMAX_FIXTURE_PLAN = {
  model_remains: [
    { model_name: 'MiniMax-M3', start_time: 1_792_050_000_000, end_time: 1_792_068_000_000, current_interval_remaining_percent: 62, current_interval_total_count: 1000, current_interval_usage_count: 380, current_interval_status: 'normal', weekly_start_time: 1_791_800_000_000, weekly_end_time: 1_792_404_800_000, current_weekly_remaining_percent: 81, current_weekly_status: 'normal' },
  ],
  base_resp: { status_code: 0, status_msg: '' },
}

export const TOGETHER_FIXTURE_MODELS = [
  { id: 'moonshotai/Kimi-K3', object: 'model', type: 'chat', display_name: 'Kimi K3', context_length: 1_048_576, pricing: { input: 3, output: 15 } },
  { id: 'zai-org/GLM-5.3', object: 'model', type: 'chat', context_length: 1_048_575, pricing: { input: 1.4, output: 4.4 } },
  { id: 'deepseek-ai/DeepSeek-V4-Pro-0813', object: 'model', type: 'chat', context_length: 1_048_576, pricing: { input: 1.32, output: 3.96 } },
  { id: 'openai/gpt-oss-120b', object: 'model', type: 'chat', context_length: 131_072, pricing: { input: 0.15, output: 0.6 } },
  { id: 'Prism-ML/Ternary-Bonsai-27B', object: 'model', type: 'chat', context_length: 262_144, pricing: { input: 0, output: 0 } },
  { id: 'fixture-org/Fixture-Chat-1', object: 'model', type: 'chat', display_name: 'Fixture Chat 1', context_length: 65_536, pricing: { input: 0.1, output: 0.2 } },
  { id: 'black-forest-labs/FLUX.1-schnell', object: 'model', type: 'image', context_length: 0 },
  { id: 'cartesia/sonic-2', object: 'model', type: 'audio' },
  { id: 'meta-llama/Llama-Guard-4-12B', object: 'model', type: 'moderation', context_length: 8_192 },
]

export const COHERE_FIXTURE_MODELS = [
  { id: 'command-a-plus-05-2026', object: 'model', created: 1_778_000_000, owned_by: 'cohere' },
  { id: 'north-mini-code-1-0', object: 'model', created: 1_779_000_000, owned_by: 'cohere' },
  { id: 'command-a-reasoning-08-2025', object: 'model', created: 1_755_000_000, owned_by: 'cohere' },
  { id: 'command-a-03-2025', object: 'model', created: 1_741_000_000, owned_by: 'cohere' },
  { id: 'command-r-08-2024', object: 'model', created: 1_724_000_000, owned_by: 'cohere' },
  { id: 'c4ai-aya-expanse-32b', object: 'model', created: 1_730_000_000, owned_by: 'cohere' },
  { id: 'embed-v4.0', object: 'model', created: 1_745_000_000, owned_by: 'cohere' },
  { id: 'rerank-v3.5', object: 'model', created: 1_733_000_000, owned_by: 'cohere' },
]
