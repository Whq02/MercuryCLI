import { z } from 'zod/v4'
import { lazySchema } from '../lazySchema.js'

const facts = () => z.object({
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  prices: z.object({ input: z.number().nonnegative().optional(), output: z.number().nonnegative().optional(), cacheRead: z.number().nonnegative().optional(), cacheWrite: z.number().nonnegative().optional() }).strict().optional(),
  efforts: z.array(z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])).optional(),
  images: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  thinkingBudget: z.number().int().positive().optional(),
}).strict()

export const ModelFactsSchema = lazySchema(() => z.record(z.string().min(1), z.union([facts(), z.record(z.string(), facts())])).superRefine((entries, ctx) => {
  for (const [id, entry] of Object.entries(entries)) {
    const schema = id === '_default' ? z.record(z.string(), facts()) : facts()
    const result = schema.safeParse(entry)
    if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: [id, ...issue.path] })
  }
}))
