import { z } from 'zod/v4'

const DECIMAL_LITERAL = /^-?\d+(\.\d+)?$/

export function semanticNumber<Inner extends z.ZodType = z.ZodNumber>(
  inner?: Inner,
): z.ZodPreprocess<Inner> {
  const target = (inner ?? z.number()) as Inner
  return z.preprocess(value => {
    if (typeof value === 'string' && DECIMAL_LITERAL.test(value)) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
    return value
  }, target)
}
