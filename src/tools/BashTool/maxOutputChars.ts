import { z } from 'zod/v4'
import { semanticNumber } from '../../utils/semanticNumber.js'

export const maxOutputCharsField = semanticNumber(z.number().int().positive().optional())

export function readMaxOutputChars(value: unknown): number | undefined {
  const parsed = maxOutputCharsField.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function refuseMaxOutputChars(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const parsed = maxOutputCharsField.safeParse(value)
  return parsed.success ? undefined : `max_output_chars: ${parsed.error.issues.map(issue => issue.message).join('; ')}`
}
