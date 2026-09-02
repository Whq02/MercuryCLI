import { z, type ZodTypeAny } from 'zod/v4'

/**
 * Zod v4 → JSON Schema via the library's native converter, with an
 * identity cache and the dialect pointer stripped.
 *
 * Identity keying is sound because the tool layer reuses one schema
 * reference per session, and the conversion runs once per tool per API
 * request — a hot path. The top-level `$schema` key is removed (paid for
 * on every tool of every request and never acted on by the model); any
 * `$schema` deeper in the structure is left alone.
 */

export type JsonSchema7Type = Record<string, unknown>

const conversionCache = new WeakMap<object, JsonSchema7Type>()

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema7Type {
  const cached = conversionCache.get(schema as object)
  if (cached !== undefined) return cached
  const converted = z.toJSONSchema(schema as never) as JsonSchema7Type
  delete converted.$schema
  conversionCache.set(schema as object, converted)
  return converted
}
