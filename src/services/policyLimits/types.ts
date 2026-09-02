/**
 * The organisation policy-limits wire contract: a restrictions map from
 * policy name → `{ allowed: boolean }`. Only BLOCKED policies appear — an
 * absent key means allowed.
 */
import { z } from 'zod'

export const PolicyLimitsResponseSchema = z.object({
  restrictions: z.record(z.string(), z.object({ allowed: z.boolean() })),
})

export type PolicyLimitsResponse = z.infer<typeof PolicyLimitsResponseSchema>

/** The settled outcome of one fetch attempt. */
export type PolicyLimitsFetchResult =
  | {
      success: true
      /** null = 304 (the cached document is still valid). */
      restrictions: PolicyLimitsResponse['restrictions'] | null
    }
  | {
      success: false
      retryable: boolean
      error: string
    }
