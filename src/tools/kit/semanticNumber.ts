import { z } from 'zod/v4'

export function semanticNumber(): z.ZodPreprocess<z.ZodNumber>
export function semanticNumber<Inner extends z.ZodType = z.ZodNumber>(
  inner: Inner,
): z.ZodPreprocess<Inner>
export function semanticNumber(inner: z.ZodType = z.number()): z.ZodPreprocess<z.ZodType> {
  return z.preprocess(value => {
    if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) return value
    const number = Number(value)
    return Number.isFinite(number) ? number : value
  }, inner)
}
