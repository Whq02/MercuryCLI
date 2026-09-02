import { z } from 'zod/v4'

import { mercuryLspEnabled } from '../../services/lsp/mercuryLsp.js'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * The LSP tool's input schemas: a discriminated union keyed on `operation`
 * carrying each operation's real requirements (the flat framework schema
 * lives with the tool). The union is memoised, so the bridge gate is read
 * once at first materialisation; with the gate off the union is
 * byte-identical to the base-only form.
 */

/** The nine base operations — contract data. */
export const BASE_LSP_OPERATIONS = [
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'workspaceSymbol',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
] as const

/** The fourteen bridge operations — contract data. */
export const BRIDGE_LSP_OPERATIONS = [
  'diagnostics',
  'rename',
  'codeActions',
  'switchSourceHeader',
  'typeDefinition',
  'serverStatus',
  'workspaceDiagnostics',
  'pathRename',
  'fixDiagnostic',
  'formatDocument',
  'formatRange',
  'organizeImports',
  'capabilities',
  'rawRequest',
] as const

const ALL_OPERATIONS: ReadonlySet<string> = new Set([
  ...BASE_LSP_OPERATIONS,
  ...BRIDGE_LSP_OPERATIONS,
])

/** Whether a string is one of the 23 operation names. */
export function isValidLSPOperation(operation: string): boolean {
  return ALL_OPERATIONS.has(operation)
}

const FILE_PATH = z.string().describe('Absolute path to the file')
const LINE = z
  .number()
  .int()
  .positive()
  .describe('1-based line number, as shown by the Read tool')
const CHARACTER = z.number().int().positive().describe('1-based character position')
const APPLY = z
  .boolean()
  .optional()
  .describe('Actually write the change (default: preview only)')

function positionalSchema<Op extends string>(operation: Op) {
  return z.strictObject({
    operation: z.literal(operation),
    filePath: FILE_PATH,
    line: LINE,
    character: CHARACTER,
  })
}

/** filePath-only operations reject position fields outright. */
function fileOnlySchema<Op extends string>(operation: Op) {
  return z.strictObject({
    operation: z.literal(operation),
    filePath: FILE_PATH,
  })
}

function fileWithApplySchema<Op extends string>(operation: Op) {
  return z.strictObject({
    operation: z.literal(operation),
    filePath: FILE_PATH,
    apply: APPLY,
  })
}

const workspaceSymbolSchema = z.strictObject({
  operation: z.literal('workspaceSymbol'),
  query: z.string().min(1).describe('The symbol name or fragment to search for'),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe('Maximum symbols to return (default 50, maximum 200)'),
  filePath: z
    .string()
    .optional()
    .describe('Route the search through the server that claims this file'),
})

const renameSchema = z.strictObject({
  operation: z.literal('rename'),
  filePath: FILE_PATH,
  line: LINE,
  character: CHARACTER,
  newName: z.string().min(1).describe('What the symbol should be called after the rename'),
  apply: APPLY,
})

const codeActionsSchema = z.strictObject({
  operation: z.literal('codeActions'),
  filePath: FILE_PATH,
  line: LINE,
  character: CHARACTER,
  endLine: z.number().int().positive().optional().describe('Range end line (defaults to line)'),
  endCharacter: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Range end character (defaults to character)'),
  apply: APPLY,
  actionId: z
    .string()
    .optional()
    .describe('Stable action id from a prior listing — the safe apply selector'),
  actionIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Positional selector from a prior listing (legacy)'),
})

const workspaceDiagnosticsSchema = z.strictObject({
  operation: z.literal('workspaceDiagnostics'),
  paths: z
    .array(z.string())
    .min(1)
    .max(50)
    .describe('Files and/or directories to pull diagnostics for (1-50 entries)'),
})

const pathRenameSchema = z.strictObject({
  operation: z.literal('pathRename'),
  filePath: FILE_PATH,
  newPath: z.string().describe('The destination path'),
  apply: APPLY,
})

const fixDiagnosticSchema = z.strictObject({
  operation: z.literal('fixDiagnostic'),
  filePath: FILE_PATH,
  line: LINE,
  character: CHARACTER,
  endLine: z.number().int().positive().optional(),
  endCharacter: z.number().int().positive().optional(),
  actionId: z.string().optional().describe('Fix selector from a prior listing'),
  apply: APPLY,
})

const formatRangeSchema = z.strictObject({
  operation: z.literal('formatRange'),
  filePath: FILE_PATH,
  line: LINE,
  character: CHARACTER,
  endLine: z.number().int().positive().describe('Range end line'),
  endCharacter: z.number().int().positive().describe('Range end character'),
  apply: APPLY,
})

const serverStatusSchema = z.strictObject({
  operation: z.literal('serverStatus'),
  filePath: z
    .string()
    .optional()
    .describe('Show the server that claims this file'),
})

const capabilitiesSchema = z.strictObject({
  operation: z.literal('capabilities'),
  filePath: FILE_PATH,
})

const rawRequestSchema = z.strictObject({
  operation: z.literal('rawRequest'),
  filePath: FILE_PATH,
  method: z
    .string()
    .min(1)
    .describe('The LSP request method (e.g. "textDocument/documentHighlight")'),
  params: z
    .string()
    .optional()
    .describe('The request params as JSON text (the textDocument/position envelope is NOT auto-filled)'),
})

function baseUnionMembers() {
  return [
    positionalSchema('goToDefinition'),
    positionalSchema('findReferences'),
    positionalSchema('hover'),
    fileOnlySchema('documentSymbol'),
    workspaceSymbolSchema,
    positionalSchema('goToImplementation'),
    positionalSchema('prepareCallHierarchy'),
    positionalSchema('incomingCalls'),
    positionalSchema('outgoingCalls'),
  ] as const
}

const switchSourceHeaderSchema = z.strictObject({
  operation: z.literal('switchSourceHeader'),
  filePath: FILE_PATH,
})

function bridgeUnionMembers() {
  return [
    fileOnlySchema('diagnostics'),
    renameSchema,
    codeActionsSchema,
    switchSourceHeaderSchema,
    positionalSchema('typeDefinition'),
    serverStatusSchema,
    workspaceDiagnosticsSchema,
    pathRenameSchema,
    fixDiagnosticSchema,
    fileWithApplySchema('formatDocument'),
    formatRangeSchema,
    fileWithApplySchema('organizeImports'),
    capabilitiesSchema,
    rawRequestSchema,
  ] as const
}

type UnionSchema = z.ZodDiscriminatedUnion<
  [
    ...ReturnType<typeof baseUnionMembers>,
    ...ReturnType<typeof bridgeUnionMembers>,
  ]
>

/**
 * The discriminated union used for precise per-operation validation. The
 * widest static type is asserted over the base-only runtime form (which is
 * strictly more restrictive).
 */
export const lspToolInputSchema = lazySchema((): UnionSchema => {
  if (!mercuryLspEnabled()) {
    return z.discriminatedUnion('operation', [...baseUnionMembers()]) as unknown as UnionSchema
  }
  return z.discriminatedUnion('operation', [
    ...baseUnionMembers(),
    ...bridgeUnionMembers(),
  ]) as UnionSchema
})

export type LSPToolInput = z.infer<UnionSchema>
