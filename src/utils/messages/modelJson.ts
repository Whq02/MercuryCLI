// ============================================================================
//  messages/modelJson — decoding a JSON payload out of MODEL-RETURNED text.
//
//  The one decode every structured side-query shares. Providers differ in
//  how faithfully they honor a JSON output format: the Anthropic and OpenAI
//  wires carry a schema constraint, but several routed chat families ignore
//  or lack one and answer with the JSON wrapped in markdown fences or a
//  line of prose ("Here is the plan: …"). A consumer that bare-JSON.parses
//  the text refuses correct answers from half the families (the Minerva
//  "non-JSON output" class, operator live-drive block B).
//
//  The ladder, strictest first — each rung only runs when the previous
//  failed, so a well-behaved wire costs one JSON.parse:
//    1. the whole trimmed text;
//    2. the body of the first fenced block (```json … ``` or ``` … ```);
//    3. the outermost {…} / […] slice (first opener to last closer).
//  A text no rung decodes is GENUINELY non-JSON — the caller degrades typed
//  with describeUndecodableModelText (names the head of what came back, so
//  the operator sees WHAT the model said, not just that decoding failed).
// ============================================================================

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

/** Decode a JSON payload from model-returned text (the ladder above). */
export function decodeModelJson(text: string | null | undefined): ModelJsonDecode {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return { ok: false }

  // 1. The whole text.
  const whole = tryParse(trimmed)
  if (whole.ok) return whole

  // 2. The first fenced block's body.
  const fence = /```(?:[A-Za-z0-9_-]*)\s*\n([\s\S]*?)```/.exec(trimmed)
  if (fence?.[1] !== undefined) {
    const fenced = tryParse(fence[1].trim())
    if (fenced.ok) return fenced
  }

  // 3. The outermost object/array slice.
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

/**
 * The settlement-classification half of the decode seam: a one-shot's
 * settled assistant message can be the RUNTIME'S OWN refusal (an
 * isApiErrorMessage settlement — no account, a 4xx, a usage window, a
 * mid-stream fault) rather than anything the model said. Feeding that prose
 * into decodeModelJson mis-attributes the failure as "<model> answered
 * without decodable JSON" — the live Minerva-on-luna sighting painted
 * exactly that over a provider refusal. One owner: callers ask THIS before
 * decoding; a non-null answer is the provider-side failure in the runtime's
 * own full sentence (remedy included), and the model is never blamed for
 * words it did not say.
 */
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

/** The typed degrade line for a genuinely undecodable answer: names the
 *  model and the head of what it actually said (bounded), never a bare
 *  "non-JSON output". */
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
