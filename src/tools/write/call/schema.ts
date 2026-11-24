import { z } from 'zod/v4'

import { gitDiffSchema, hunkSchema, type FileEditOutput } from '../../edit/schema.js'

export const inputSchema = z.strictObject({
  file_path: z.string().describe('Absolute path of the file to write'),
  content: z.string().describe('The content to write to the file'),
})

export type FileWriteInput = z.input<typeof inputSchema>

export type Input = z.infer<typeof inputSchema>

export type Output = {
  type: 'create' | 'update' | 'no-change' | 'delete' | 'not-found'
  filePath: string
  content: string
  structuredPatch: FileEditOutput['structuredPatch']
  originalFile: string | null
  gitDiff?: FileEditOutput['gitDiff']
  noChange?: FileEditOutput['noChange']
  parseError?: string
  diverged?: boolean
}

export const outputSchema = z.object({
  type: z.enum(['create', 'update', 'no-change', 'delete', 'not-found']),
  filePath: z.string(),
  content: z.string(),
  structuredPatch: z.array(hunkSchema()),
  originalFile: z.string().nullable(),
  gitDiff: gitDiffSchema().optional(),
  noChange: z
    .object({
      streak: z.number(),
      stop: z.boolean(),
      guidance: z.string(),
    })
    .optional(),
  parseError: z.string().optional(),
  diverged: z.boolean().optional(),
})
