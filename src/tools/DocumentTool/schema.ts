import { z } from 'zod/v4'

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()])
const rows = z.array(z.array(cell))
const block = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('heading'), text: z.string(), level: z.number().int().min(1).max(6).optional() }),
  z.strictObject({ kind: z.literal('paragraph'), text: z.string() }),
  z.strictObject({ kind: z.literal('list'), items: z.array(z.string()), ordered: z.boolean().optional() }),
  z.strictObject({ kind: z.literal('table'), rows, name: z.string().optional() }),
  z.strictObject({ kind: z.literal('image'), path: z.string(), alt: z.string().optional(), width: z.number().positive().optional(), height: z.number().positive().optional() }),
  z.strictObject({ kind: z.literal('pageBreak') }),
  z.strictObject({ kind: z.literal('footnote'), id: z.string(), text: z.string() }),
])
export const documentSchema = z.strictObject({
  op: z.enum(['create', 'convert', 'merge', 'split', 'inspect', 'cite']),
  output: z.string().optional().describe('Destination file; extension selects the format'),
  source: z.string().optional().describe('Input document path'),
  sources: z.array(z.string()).optional().describe('merge: ordered PDF paths'),
  markdown: z.string().optional(),
  blocks: z.array(block).optional(),
  sheets: z.array(z.strictObject({ name: z.string(), rows })).optional(),
  csv: z.string().optional().describe('CSV text for a worksheet'),
  json: z.array(z.record(z.string(), cell)).optional().describe('Records for a worksheet'),
  sheet: z.string().optional().describe('Worksheet name, required when exporting one of several sheets'),
  template: z.string().optional().describe('DOCX template path with {{key}} placeholders'),
  replacements: z.record(z.string(), z.string()).optional(),
  append: z.boolean().optional().describe('Append content to source DOCX, keeping existing parts'),
  titlePage: z.strictObject({ title: z.string(), subtitle: z.string().optional(), author: z.string().optional() }).optional(),
  header: z.string().optional(),
  footer: z.string().optional(),
  metadata: z.strictObject({ title: z.string().optional(), author: z.string().optional(), subject: z.string().optional(), keywords: z.array(z.string()).optional() }).optional(),
  paper: z.enum(['A4', 'Letter']).optional(),
  margin: z.number().positive().optional().describe('Page margins in points; default 54'),
  pageNumbers: z.boolean().optional(),
  renderer: z.enum(['auto', 'browser', 'plain', 'libreoffice', 'pandoc']).optional(),
  pages: z.string().optional().describe('1-based page ranges, for example 1-3,7; preserves order'),
  parts: z.array(z.strictObject({ pages: z.string(), output: z.string() })).optional().describe('split: page ranges and destination per part'),
  rotate: z.number().int().multipleOf(90).optional().describe('Clockwise degrees applied to selected PDF pages'),
  expectedSha256: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).optional().describe('Existing output path to digest from inspect; required for replacement'),
  bibtex: z.string().optional(),
  dois: z.array(z.string()).optional().describe('DOIs to resolve through api.crossref.org, only when requested'),
  references: z.array(z.strictObject({ id: z.string(), title: z.string(), authors: z.array(z.strictObject({ family: z.string(), given: z.string().optional() })), year: z.string().optional(), container: z.string().optional(), volume: z.string().optional(), issue: z.string().optional(), pages: z.string().optional(), publisher: z.string().optional(), doi: z.string().optional(), url: z.string().optional() })).optional(),
  style: z.enum(['apa', 'ieee', 'chicago', 'harvard']).optional(),
})
export type DocumentInput = z.infer<typeof documentSchema>
export type Block = z.infer<typeof block>
export type Reference = NonNullable<DocumentInput['references']>[number]
export type DocumentProduct = { files: { path: string; bytes: Uint8Array }[]; road: string; detail?: unknown }
