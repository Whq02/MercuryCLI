type ModelCapability = {
  id: string
  max_input_tokens?: number
  max_tokens?: number
}

export function getModelCapability(_model: string): ModelCapability | undefined {
  return undefined
}
