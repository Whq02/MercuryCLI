import { z, type ZodTypeAny } from 'zod/v4'


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
