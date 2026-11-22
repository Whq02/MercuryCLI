import { z } from 'zod/v4'
import { notBuilt } from '../pi/holes.js'

export function semanticNumber<Inner extends z.ZodType = z.ZodNumber>(
  inner?: Inner,
): z.ZodPreprocess<Inner> {
  return notBuilt('src/utils/semanticNumber.ts:5')
}
