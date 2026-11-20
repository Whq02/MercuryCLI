export const rec = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)

export type ConfigFacts = { modelType?: string; trainedMax?: number; kvBytesPerToken?: number; quantisation?: string }

export function configFactsOf(config: Record<string, unknown>): ConfigFacts {
  const text = rec(config.text_config) ?? config
  const modelType = typeof config.model_type === 'string' ? config.model_type : typeof text.model_type === 'string' ? text.model_type : undefined
  const trainedMax = num(text.max_position_embeddings) ?? num(config.max_position_embeddings)
  const layers = num(text.num_hidden_layers) ?? num(config.num_hidden_layers)
  const heads = num(text.num_attention_heads) ?? num(config.num_attention_heads)
  const kvHeads = num(text.num_key_value_heads) ?? num(config.num_key_value_heads) ?? heads
  const hidden = num(text.hidden_size) ?? num(config.hidden_size)
  const headDim = num(text.head_dim) ?? num(config.head_dim) ?? (heads !== undefined && hidden !== undefined ? hidden / heads : undefined)
  let attentionLayers = layers
  const pattern = typeof text.hybrid_override_pattern === 'string' ? text.hybrid_override_pattern : typeof config.hybrid_override_pattern === 'string' ? config.hybrid_override_pattern : undefined
  const layerTypes = Array.isArray(text.layer_types) ? text.layer_types : Array.isArray(config.layer_types) ? config.layer_types : undefined
  const interval = num(text.full_attention_interval) ?? num(config.full_attention_interval)
  if (pattern !== undefined) attentionLayers = pattern.split('').filter(ch => ch === '*').length
  else if (layerTypes !== undefined) attentionLayers = layerTypes.filter(kind => kind === 'full_attention' || kind === 'attention').length
  else if (interval !== undefined && layers !== undefined) attentionLayers = Math.floor(layers / interval)
  const kvBytesPerToken = attentionLayers !== undefined && kvHeads !== undefined && headDim !== undefined ? attentionLayers * kvHeads * headDim * 2 * 2 : undefined
  const quant = rec(config.quantization) ?? rec(config.quantization_config)
  const bits = num(quant?.bits)
  const group = num(quant?.group_size)
  return {
    ...(modelType !== undefined ? { modelType } : {}),
    ...(trainedMax !== undefined ? { trainedMax } : {}),
    ...(kvBytesPerToken !== undefined ? { kvBytesPerToken } : {}),
    ...(bits !== undefined ? { quantisation: `${bits}-bit${group !== undefined ? `, group ${group}` : ''}` } : {}),
  }
}
