const MODELS_ENDPOINT_NOT_JSON = 'the models endpoint answered a body that is not JSON'

export async function catalogueBodyJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new Error(MODELS_ENDPOINT_NOT_JSON)
  }
}

export async function quietBodyJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

const SERVICE_WORDS_MAX = 240

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export interface ServiceWords {
  code?: string
  message?: string
}

export function serviceWordsOf(body: unknown): ServiceWords {
  if (typeof body !== 'object' || body === null) return {}
  const row = body as Record<string, unknown>
  const error = typeof row.error === 'object' && row.error !== null ? (row.error as Record<string, unknown>) : undefined
  const base = typeof row.base_resp === 'object' && row.base_resp !== null ? (row.base_resp as Record<string, unknown>) : undefined
  const codeValue = error?.code ?? error?.type ?? row.code ?? base?.status_code
  const code = str(codeValue) ?? (typeof codeValue === 'number' ? String(codeValue) : undefined)
  const message =
    str(error?.message) ?? str(row.message) ?? str(row.error) ?? str(row.msg) ?? str(row.detail) ?? str(row.error_description) ?? str(base?.status_msg)
  return {
    ...(code ? { code } : {}),
    ...(message ? { message: message.length > SERVICE_WORDS_MAX ? `${message.slice(0, SERVICE_WORDS_MAX)}…` : message } : {}),
  }
}

const KEY_WORDS = /api[ _-]?key|access token|token expired|credential|unauthori[sz]ed|authentication|login fail|secret key/i

export function wordsNameTheKey(words: ServiceWords): boolean {
  return KEY_WORDS.test(`${words.code ?? ''} ${words.message ?? ''}`)
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
