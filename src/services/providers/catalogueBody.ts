export const MODELS_ENDPOINT_NOT_JSON = 'the models endpoint answered a body that is not JSON'

export async function catalogueBodyJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new Error(MODELS_ENDPOINT_NOT_JSON)
  }
}

function nextCause(node: Error): unknown {
  const inner = (node as { errors?: unknown[] }).errors
  return inner && inner.length > 0 ? inner[0] : (node as { cause?: unknown }).cause
}

function causeCode(error: unknown): string | undefined {
  let node: unknown = error
  for (let depth = 0; node instanceof Error && depth < 6; depth++) {
    const code = (node as { code?: unknown }).code
    if (typeof code === 'string' && code.trim() !== '') return code
    node = nextCause(node)
  }
  return undefined
}

function deepestMessage(error: unknown): string {
  let node: unknown = error
  let last = ''
  for (let depth = 0; node instanceof Error && depth < 6; depth++) {
    if (node.message.trim() !== '') last = node.message
    node = nextCause(node)
  }
  return last || String(error)
}

export function modelsEndpointUnreachable(error: unknown): Error | undefined {
  const code = causeCode(error)
  if (!(error instanceof TypeError) && code === undefined) return undefined
  return new Error(`the models endpoint could not be reached (${code ?? deepestMessage(error)})`)
}
