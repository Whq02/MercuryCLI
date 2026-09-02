
export type ModelJsonDecode =
  | { ok: true; value: unknown }
  | { ok: false }

function tryParse(candidate: string): ModelJsonDecode {
  try {
    return { ok: true, value: JSON.parse(candidate) as unknown }
  } catch {
    return { ok: false }
  }
}

export function decodeModelJson(text: string | null | undefined): ModelJsonDecode {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return { ok: false }

  const whole = tryParse(trimmed)
  if (whole.ok) return whole

  const fence = /```(?:[A-Za-z0-9_-]*)\s*\n([\s\S]*?)```/.exec(trimmed)
  if (fence?.[1] !== undefined) {
    const fenced = tryParse(fence[1].trim())
    if (fenced.ok) return fenced
  }

  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = trimmed.indexOf(open)
    const end = trimmed.lastIndexOf(close)
    if (start >= 0 && end > start) {
      const slice = tryParse(trimmed.slice(start, end + 1))
      if (slice.ok) return slice
    }
  }

  return { ok: false }
}

export function settledProviderFailure(message: {
  isApiErrorMessage?: boolean
  message: { content: unknown }
}): string | null {
  if (message.isApiErrorMessage !== true) return null
  const content = message.message.content
  const text = (
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (b): b is { type: 'text'; text: string } =>
                !!b &&
                (b as { type?: string }).type === 'text' &&
                typeof (b as { text?: unknown }).text === 'string',
            )
            .map(b => b.text)
            .join('\n')
        : ''
  ).trim()
  return text !== '' ? text : 'the provider call failed before any answer arrived'
}

export function describeUndecodableModelText(
  model: string,
  text: string | null | undefined,
  headChars = 120,
): string {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return `${model} returned no text to decode`
  const head = trimmed.length > headChars ? `${trimmed.slice(0, headChars)}…` : trimmed
  return `${model} answered without decodable JSON: ${JSON.stringify(head)}`
}
