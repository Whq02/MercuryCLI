import { z, type ZodTypeAny } from 'zod/v4'


type JsonSchema7Type = Record<string, unknown>

export type SchemaSide = 'input' | 'output'

const conversionCache = new WeakMap<object, Partial<Record<SchemaSide, JsonSchema7Type>>>()

export function zodToJsonSchema(schema: ZodTypeAny, side: SchemaSide = 'input'): JsonSchema7Type {
  const sides = conversionCache.get(schema as object) ?? {}
  const cached = sides[side]
  if (cached !== undefined) return cached
  const converted = z.toJSONSchema(schema as never, { io: side }) as JsonSchema7Type
  delete converted.$schema
  sides[side] = converted
  conversionCache.set(schema as object, sides)
  return converted
}
