import { z } from 'zod/v4'
import type { LspToolName } from './prompt.js'

export const LSP_READ_OPERATIONS = ['goToDefinition', 'findReferences', 'hover', 'goToImplementation', 'typeDefinition', 'incomingCalls', 'outgoingCalls', 'documentSymbol', 'workspaceSymbol', 'diagnostics', 'serverStatus'] as const

const PLAN_DESC = 'Preview token (lsp-…); refuses if touched files changed. Omitted, apply requires current read coverage of touched lines'
const APPLY_DESC = 'Write edits (default false previews)'

export const LSP_INPUT_JSON_SCHEMAS = {
  LspRead: {"type":"object","properties":{"operation":{"type":"string","enum":["goToDefinition","findReferences","hover","goToImplementation","typeDefinition","incomingCalls","outgoingCalls","documentSymbol","workspaceSymbol","diagnostics","serverStatus"],"description":"documentSymbol uses filePath; workspaceSymbol uses query/limit (filePath selects server); diagnostics uses paths or filePath; serverStatus uses optional filePath; all others use filePath + line + character. Unused args are ignored"},"filePath":{"type":"string","description":"Absolute file path"},"line":{"type":"integer","minimum":1,"description":"1-based symbol line"},"character":{"type":"integer","minimum":1,"description":"1-based character"},"query":{"type":"string","description":"workspaceSymbol: symbol name or substring"},"limit":{"type":"integer","minimum":1,"maximum":200,"description":"workspaceSymbol: max results (default 50)"},"paths":{"type":"array","items":{"type":"string"},"maxItems":50,"description":"diagnostics: files or directories"}},"required":["operation"],"additionalProperties":false},
  LspRename: {"type":"object","properties":{"filePath":{"type":"string","description":"Absolute file path"},"line":{"type":"integer","minimum":1,"description":"1-based symbol line"},"character":{"type":"integer","minimum":1,"description":"1-based character"},"newName":{"type":"string","description":"New symbol name"},"apply":{"type":"boolean","description":APPLY_DESC},"plan":{"type":"string","description":PLAN_DESC}},"required":["filePath","line","character","newName"],"additionalProperties":false},
  LspMoveSymbol: {"type":"object","properties":{"filePath":{"type":"string","description":"Absolute source file path"},"line":{"type":"integer","minimum":1,"description":"1-based declaration line"},"character":{"type":"integer","minimum":1,"description":"1-based declaration character"},"targetPath":{"type":"string","description":"Destination file (created or appended)"},"apply":{"type":"boolean","description":APPLY_DESC},"plan":{"type":"string","description":PLAN_DESC}},"required":["filePath","line","character","targetPath"],"additionalProperties":false},
  LspMoveFile: {"type":"object","properties":{"filePath":{"type":"string","description":"Absolute path of file or directory"},"newPath":{"type":"string","description":"Destination path (must not exist)"},"apply":{"type":"boolean","description":"Move and write import edits (default false previews)"},"plan":{"type":"string","description":"Preview token; refuses if touched files changed"}},"required":["filePath","newPath"],"additionalProperties":false},
  LspCodeAction: {"type":"object","properties":{"filePath":{"type":"string","description":"Absolute file path"},"line":{"type":"integer","minimum":1,"description":"1-based start line"},"character":{"type":"integer","minimum":1,"description":"1-based start character"},"endLine":{"type":"integer","minimum":1,"description":"1-based end line (default line)"},"endCharacter":{"type":"integer","minimum":1,"description":"1-based end character (default character)"},"kind":{"type":"string","description":"Filter kind: quickfix, refactor.*, or source.* (organizeImports, addMissingImports, removeUnusedImports, removeUnused); apply:true applies a single match"},"actionId":{"type":"string","description":"The id of an action from the list; ids are stable across listings"},"actionIndex":{"type":"integer","minimum":0,"description":"The position of an action in the current list; positions shift between listings"},"apply":{"type":"boolean","description":APPLY_DESC},"plan":{"type":"string","description":PLAN_DESC}},"required":["filePath","line","character"],"additionalProperties":false},
  LspFormat: {"type":"object","properties":{"filePath":{"type":"string","description":"Absolute file path"},"line":{"type":"integer","minimum":1,"description":"1-based start line (omit with endLine for whole file)"},"endLine":{"type":"integer","minimum":1,"description":"1-based inclusive end line"},"organizeImports":{"type":"boolean","description":"Sort and prune imports instead of formatting"},"apply":{"type":"boolean","description":APPLY_DESC},"plan":{"type":"string","description":PLAN_DESC}},"required":["filePath"],"additionalProperties":false},
  LspRequest: {"type":"object","properties":{"filePath":{"type":"string","description":"Absolute file path"},"method":{"type":"string","description":"Read-only LSP method (editing methods refused: textDocument/rename, codeAction, codeAction/resolve, formatting, rangeFormatting; workspace/executeCommand, willRenameFiles, applyEdit)"},"params":{"type":"string","description":"Verbatim JSON params string (textDocument/position not auto-filled)"}},"required":["filePath","method"],"additionalProperties":false},
} as const

type Property = { type: string; minimum?: number; maximum?: number; maxItems?: number; description: string }

export function lspInputSchema(name: LspToolName): z.ZodObject {
  const wire = LSP_INPUT_JSON_SCHEMAS[name]
  const shape: Record<string, z.ZodType> = {}
  for (const [key, property] of Object.entries(wire.properties) as [string, Property][]) {
    let field: z.ZodType
    if (property.type === 'integer') {
      let number = z.number().int()
      if (property.minimum !== undefined) number = number.min(property.minimum)
      if (property.maximum !== undefined) number = number.max(property.maximum)
      field = number
    } else if (property.type === 'boolean') {
      field = z.boolean()
    } else if (property.type === 'array') {
      field = z.array(z.string()).max(property.maxItems!)
    } else {
      field = z.string()
    }
    field = field.describe(property.description)
    shape[key] = (wire.required as readonly string[]).includes(key) ? field : field.optional()
  }
  return z.strictObject(shape)
}

export type LspInput = Partial<{
  operation: string
  filePath: string
  line: number
  character: number
  query: string
  limit: number
  paths: string[]
  newName: string
  newPath: string
  targetPath: string
  apply: boolean
  plan: string
  endLine: number
  endCharacter: number
  actionId: string
  actionIndex: number
  kind: string
  organizeImports: boolean
  method: string
  params: string
}>

const POSITION_OPERATIONS = new Set<string>(LSP_READ_OPERATIONS.slice(0, 7))

export function readArguments(input: LspInput): LspInput {
  const operation = input.operation ?? ''
  const keys: (keyof LspInput)[] = POSITION_OPERATIONS.has(operation)
    ? ['filePath', 'line', 'character']
    : operation === 'workspaceSymbol'
      ? ['query', 'limit', 'filePath']
      : operation === 'diagnostics'
        ? ['filePath', 'paths']
        : ['filePath']
  return Object.fromEntries([['operation', operation], ...keys.filter(key => input[key] !== undefined && (key !== 'paths' || input.paths!.length > 0)).map(key => [key, input[key]])])
}

export function readArgumentError(input: LspInput): string | undefined {
  const op = input.operation ?? ''
  if (POSITION_OPERATIONS.has(op)) {
    const missing = (['filePath', 'line', 'character'] as const).filter(key => input[key] === undefined || input[key] === '')
    if (missing.length) return `${op} requires filePath, line and character (1-based symbol position, as Read shows it); missing: ${missing.join(', ')}. Example: {"operation":"${op}","filePath":"/absolute/path/file.ts","line":12,"character":8}. Nothing was sent to a language server.`
  } else if (op === 'documentSymbol') {
    if (!input.filePath) return 'documentSymbol reads filePath, which is missing. Example: {"operation":"documentSymbol","filePath":"/absolute/path/file.ts"}. Nothing was sent to a language server.'
  } else if (op === 'workspaceSymbol') {
    if (!input.query?.trim()) return 'workspaceSymbol requires a non-empty query (a symbol name or substring). Example: {"operation":"workspaceSymbol","query":"parseConfig"}. Nothing was sent to a language server.'
  } else if (op === 'diagnostics') {
    if (!input.paths?.length && !input.filePath) return 'diagnostics requires paths (up to 50 files or directories) or filePath for one file; neither was given. Example: {"operation":"diagnostics","paths":["/absolute/path/a.ts","/absolute/path/src"]}. Nothing was sent to a language server.'
  } else if (op !== 'serverStatus') {
    return `${op} is not an LspRead operation. LspRead answers goToDefinition, findReferences, hover, goToImplementation, typeDefinition, incomingCalls, outgoingCalls, documentSymbol, workspaceSymbol, diagnostics and serverStatus; renaming, moving, code actions, formatting and raw requests are LspRename, LspMoveSymbol, LspMoveFile, LspCodeAction, LspFormat and LspRequest.`
  }
  return undefined
}
