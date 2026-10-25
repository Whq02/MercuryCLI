import { getSessionId } from '../../bootstrap/state.js'

const refusedFields = new Set<string>()
const FIELD_REFUSAL_WORDS = /unsupported|unknown|unrecognized|not allowed|not permitted|extra inputs|unexpected|invalid|not supported/i

async function fieldRefused(response: Response, field: string): Promise<boolean> {
  if (response.status !== 400) return false
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > 65_536) return false
  const reader = response.clone().body?.getReader()
  if (reader === undefined) return false
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > 65_536) { void reader.cancel().catch(() => {}); return false }
      chunks.push(next.value)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    try {
      const body = JSON.parse(text) as { error?: { param?: string; message?: string }; message?: string }
      return body?.error?.param === field || ((body?.error?.message ?? body?.message ?? '').includes(field) && FIELD_REFUSAL_WORDS.test(text))
    } catch { return text.includes(field) && FIELD_REFUSAL_WORDS.test(text) }
  } catch { return false }
  finally { reader.releaseLock() }
}

export async function sendWithCacheField(input: { body: Record<string, unknown>; url: string; field: string; scope?: string }, send: (body: Record<string, unknown>) => Promise<Response>): Promise<Response> {
  if (input.body[input.field] === undefined) return send(input.body)
  const key = JSON.stringify([getSessionId(), input.url, input.field, input.scope ?? ''])
  const without = (): Record<string, unknown> => { const copy = { ...input.body }; delete copy[input.field]; return copy }
  if (refusedFields.has(key)) return send(without())
  const response = await send(input.body)
  if (!(await fieldRefused(response, input.field))) return response
  refusedFields.add(key)
  void response.body?.cancel().catch(() => {})
  return send(without())
}
