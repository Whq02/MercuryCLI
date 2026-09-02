import { z } from 'zod/v4'

/**
 * A number schema tolerating quoted decimal literals. Only strings that are
 * valid decimal literals (optional leading minus, digits, optional fraction)
 * coerce, and only to finite values — a general numeric cast would turn an
 * empty string or a null into zero and hide malformed input. The API still
 * sees `{"type":"number"}`; optionality belongs on the inner schema.
 */
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
