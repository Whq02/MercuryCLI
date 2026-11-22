import { z } from 'zod/v4'

export function semanticNumber<Inner extends z.ZodType = z.ZodNumber>(
  inner?: Inner,
): z.ZodPreprocess<Inner> {
  return z.preprocess(value => {
    if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) return value
    const number = Number(value)
    return Number.isFinite(number) ? number : value
  }, (inner ?? z.number()) as Inner)
}
