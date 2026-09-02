import { z } from 'zod'

export const PolicyLimitsResponseSchema = z.object({
  restrictions: z.record(z.string(), z.object({ allowed: z.boolean() })),
})

export type PolicyLimitsResponse = z.infer<typeof PolicyLimitsResponseSchema>

export type PolicyLimitsFetchResult =
  | {
      success: true
      restrictions: PolicyLimitsResponse['restrictions'] | null
    }
  | {
      success: false
      retryable: boolean
      error: string
    }
