// ============================================================================
//  services/eval/jsonExtract — pull one JSON value out of a model's reply.
//
//  Extraction only. Validation of the extracted value is NOT this module's
//  business — that is the one engine's (services/schema/jsonSchemaEngine,
//  spec 03 C1), and a second validator here would break its law.
// ============================================================================

/** Pull one JSON value out of a model's final text: raw parse, then a
 *  ```json fence, then the first balanced {…}/[…] region. */
export function extractJsonValue(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const direct = tryParse(text.trim())
  if (direct.ok) return direct
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(text)
  if (fence?.[1]) {
    const fenced = tryParse(fence[1].trim())
    if (fenced.ok) return fenced
  }
  for (const open of ['{', '[']) {
    const start = text.indexOf(open)
    if (start < 0) continue
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    for (let i = start; i < text.length; i++) {
      const c = text[i]!
      if (inString) {
        if (c === '\\') i++
        else if (c === '"') inString = false
        continue
      }
      if (c === '"') inString = true
      else if (c === open) depth++
      else if (c === close) {
        depth--
        if (depth === 0) {
          const candidate = tryParse(text.slice(start, i + 1))
          if (candidate.ok) return candidate
          break
        }
      }
    }
  }
  return { ok: false, error: 'no parsable JSON value found in the reply' }
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}
