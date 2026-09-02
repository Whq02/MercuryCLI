import { z } from 'zod/v4'

/**
 * A boolean schema tolerating the quoted literals a model occasionally
 * emits. The tolerance is exact-literal (a truthiness cast would read the
 * quoted string `false` as true) and invisible in the published schema: the
 * API still sees `{"type":"boolean"}`. Optional/default modifiers belong on
 * the INNER schema — chaining them onto the preprocessing pipe collapses the
 * inferred output type.
 */
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
