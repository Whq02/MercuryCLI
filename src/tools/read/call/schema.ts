import { z } from 'zod/v4'
import { lineAnchorsEnabled } from '../../engines/change-transaction/lineAnchors.js'
import { lazySchema } from '../../../platform/primitives/lazySchema.js'
import { semanticBoolean } from '../../kit/semanticBoolean.js'
import { semanticNumber } from '../../kit/semanticNumber.js'
import type { Message } from '../../../engine/message-shapes/message.js'
import type { FileReadOutput as Output, OverCapNote } from '../../../engine/attachment-shapes/fileReadOutput.js'
import { MAX_LINES_TO_READ, MAX_PDF_PAGES_PER_REQUEST } from '../../kit/names/fileRead.js'

export const MAX_RANGES_PER_READ = 32

const stockFields = () => ({
  file_path: z.string().describe('Absolute path of the file to read'),
  ocr: semanticBoolean(z.boolean().optional()).describe('For an image, return recognised text instead of the picture; automatic on a model without image input.'),
  lossless: semanticBoolean(z.boolean().optional()).describe('Show complete lines (a line is otherwise cut at 2000 characters); requires offset + limit or ranges, without outline.'),
  offset: semanticNumber(z.number().int().optional()).describe(
    'The first line to read, 1-based; a negative -N starts N lines from the end.',
  ),
  limit: semanticNumber(z.number().int().gt(0).optional()).describe(
    `The most lines to return (default ${MAX_LINES_TO_READ}).`,
  ),
  ranges: z
    .array(z.string())
    .max(MAX_RANGES_PER_READ)
    .optional()
    .describe(
      `Up to ${MAX_RANGES_PER_READ} line ranges read in one call, each N, N-M, N+K, N- or -N (the last N lines), each with its own continuation mark.`,
    ),
  pages: z
    .string()
    .optional()
    .describe(
      `PDF page range ("2-6"), at most ${MAX_PDF_PAGES_PER_REQUEST} pages per call; page pictures on a model with image input, text otherwise.`,
    ),
  scale: semanticNumber(z.number().min(1).optional()).describe('Crop upscale factor, within the image budget; whole numbers repeat pixels; requires crop.'),
  crop: z
    .array(semanticNumber(z.number().int().min(0)))
    .length(4)
    .optional()
    .describe(
      'For an image, a box [x1, y1, x2, y2] in original pixels, cut before any downscale.',
    ),
})

const anchoredSchemaFactory = () =>
  z.strictObject({
    ...stockFields(),
    outline: semanticBoolean(z.boolean().optional()).describe(
      'Return the file\'s declarations with their original line numbers and bodies elided, instead of the full text.',
    ),
    line_anchors: semanticBoolean(z.boolean().optional()).describe(
      'Prefix each line with its content anchor ("N#hhhh"), the address an anchored Edit hunk takes.',
    ),
  })

type WidestReadSchema = ReturnType<typeof anchoredSchemaFactory>

export const inputSchema = lazySchema((): z.ZodType<Input> =>
  lineAnchorsEnabled()
    ? anchoredSchemaFactory()
    : z.strictObject(stockFields()),
)

export function selectedPages(pages: string | undefined): string | undefined {
  return pages && pages.trim() !== '' ? pages : undefined
}

export function selectedCrop(crop: readonly number[] | undefined): CropBox | undefined {
  if (crop === undefined || (crop.length === 4 && crop.every(value => value === 0))) return undefined
  return crop as CropBox
}

export type Input = z.infer<WidestReadSchema>

export type { Output, OverCapNote }

export const outputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    file: z.object({
      filePath: z.string(),
      content: z.string(),
      numLines: z.number(),
      startLine: z.number(),
      totalLines: z.number(),
      reminder: z.string().optional(),
      anchor: z.string().optional(),
      memoryUpdatedAt: z.number().optional(),
      lossless: z.boolean().optional(),
      overCap: z
        .object({ tokens: z.number(), maxTokens: z.number(), next: z.object({ offset: z.number(), limit: z.number() }), room: z.literal(true).optional() })
        .optional(),
    }),
  }),
  z.object({
    type: z.literal('image'),
    file: z.object({
      base64: z.string(),
      type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
      originalSize: z.number(),
      caption: z.string().optional(),
      dimensions: z
        .object({
          originalWidth: z.number().optional(),
          originalHeight: z.number().optional(),
          displayWidth: z.number().optional(),
          displayHeight: z.number().optional(),
        })
        .optional(),
    }),
  }),
  z.object({
    type: z.literal('notebook'),
    file: z.object({ filePath: z.string(), cells: z.array(z.unknown()) }),
  }),
  z.object({
    type: z.literal('pdf'),
    file: z.object({ filePath: z.string(), base64: z.string(), originalSize: z.number() }),
  }),
  z.object({
    type: z.literal('parts'),
    file: z.object({
      filePath: z.string(),
      originalSize: z.number(),
      count: z.number(),
      outputDir: z.string(),
    }),
  }),
  z.object({ type: z.literal('file_unchanged'), file: z.object({ filePath: z.string(), anchor: z.string().optional() }) }),
])

export type CropBox = readonly [number, number, number, number]

export type LaneResult = { data: Output; newMessages?: Message[] }

export type TextFile = Extract<Output, { type: 'text' }>['file']
