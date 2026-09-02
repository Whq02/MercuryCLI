import { z } from 'zod/v4'

export function semanticBoolean<Inner extends z.ZodType = z.ZodBoolean>(
  inner?: Inner,
): z.ZodPreprocess<Inner> {
  const target = (inner ?? z.boolean()) as Inner
  return z.preprocess(value => {
    if (value === 'true') return true
    if (value === 'false') return false
    return value
  }, target)
}
