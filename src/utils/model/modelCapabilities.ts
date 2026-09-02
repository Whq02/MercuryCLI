
export type ModelCapability = {
  id: string
  max_input_tokens?: number
  max_tokens?: number
}

function isModelCapabilitiesEligible(): boolean {
  return false
}

export function getModelCapability(model: string): ModelCapability | undefined {
  void model
  if (!isModelCapabilitiesEligible()) return undefined
  return undefined
}

export async function refreshModelCapabilities(): Promise<void> {
  if (!isModelCapabilitiesEligible()) return
}
