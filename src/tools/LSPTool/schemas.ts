import { z } from 'zod/v4'
import type { LspToolName } from './prompt.js'

export const LSP_READ_OPERATIONS = ['goToDefinition', 'findReferences', 'hover', 'goToImplementation', 'typeDefinition', 'incomingCalls', 'outgoingCalls', 'documentSymbol', 'workspaceSymbol', 'diagnostics', 'serverStatus'] as const

export const LSP_INPUT_JSON_SCHEMAS = {
  LspRead: {"type":"object","properties":{"operation":{"type":"string","enum":["goToDefinition","findReferences","hover","goToImplementation","typeDefinition","incomingCalls","outgoingCalls","documentSymbol","workspaceSymbol","diagnostics","serverStatus"],"description":"The question; the description lists the arguments each operation reads"},"filePath":{"type":"string","description":"Absolute path of the file"},"line":{"type":"integer","minimum":1,"description":"Position operations: the symbol's 1-based line"},"character":{"type":"integer","minimum":1,"description":"Position operations: the symbol's 1-based character on that line"},"query":{"type":"string","description":"workspaceSymbol: a symbol name or part of one"},"limit":{"type":"integer","minimum":1,"maximum":200,"description":"workspaceSymbol: the most symbols to return (default 50)"},"paths":{"type":"array","items":{"type":"string"},"maxItems":50,"description":"diagnostics: files or directories, at most 50"}},"required":["operation"],"additionalProperties":false},
  LspRename: {"type":"object","properties":{"filePath":{"type":"string","description":"Absolute path of the file that holds the symbol"},"line":{"type":"integer","minimum":1,"description":"The symbol's 1-based line, as Read shows it"},"character":{"type":"integer","minimum":1,"description":"The symbol's 1-based character on that line"},"newName":{"type":"string","description":"What the symbol is called after the rename"},"apply":{"type":"boolean","description":"true writes; omitted or false previews and writes nothing"},"plan":{"type":"string","description":"With apply: the plan token the preview printed (lsp-…); exactly those edits are written"}},"required":["filePath","line","character","newName"],"additionalProperties":false},
  LspMoveSymbol: {"type":"object","properties":{"filePath":{"type":"string","description":"Absolute path of the file that holds the declaration"},"line":{"type":"integer","minimum":1,"description":"The declaration name's 1-based line"},"character":{"type":"integer","minimum":1,"description":"The declaration name's 1-based character on that line"},"targetPath":{"type":"string","description":"The file the declaration moves into"},"apply":{"type":"boolean","description":"true writes; omitted or false previews and writes nothing"},"plan":{"type":"string","description":"With apply: the plan token the preview printed (lsp-…); exactly those edits are written"}},"required":["filePath","line","character","targetPath"],"additionalProperties":false},
  LspMoveFile: {"type":"object","properties":{"filePath":{"type":"string","description":"Absolute path of the file or directory to move"},"newPath":{"type":"string","description":"Where it goes; must not exist yet"},"apply":{"type":"boolean","description":"true moves and writes; omitted or false previews"},"plan":{"type":"string","description":"With apply: the plan token the preview printed, when it printed one"}},"required":["filePath","newPath"],"additionalProperties":false},
  LspCodeAction: {"type":"object","properties":{"filePath":{"type":"string","description":"Absolute path of the file"},"line":{"type":"integer","minimum":1,"description":"1-based line where the range starts, as Read shows it"},"character":{"type":"integer","minimum":1,"description":"1-based character where the range starts"},"endLine":{"type":"integer","minimum":1,"description":"1-based line where the range ends (default: line)"},"endCharacter":{"type":"integer","minimum":1,"description":"1-based character where the range ends (default: character)"},"kind":{"type":"string","description":"Only actions of this kind: quickfix, refactor (or a sub-kind), or a source.* kind"},"actionId":{"type":"string","description":"The id of an action from the list"},"actionIndex":{"type":"integer","minimum":0,"description":"The positional selector from a prior listing (actionId is preferred)"},"apply":{"type":"boolean","description":"true writes; omitted or false previews and writes nothing"},"plan":{"type":"string","description":"With apply: the plan token the preview printed (lsp-…); exactly those edits are written"}},"required":["filePath","line","character"],"additionalProperties":false},
  LspFormat: {"type":"object","properties":{"filePath":{"type":"string","description":"Absolute path of the file"},"line":{"type":"integer","minimum":1,"description":"First line to format (1-based); omit both to format the whole file"},"endLine":{"type":"integer","minimum":1,"description":"Last line to format, included"},"organizeImports":{"type":"boolean","description":"true organizes the imports instead of formatting"},"apply":{"type":"boolean","description":"true writes; omitted or false previews and writes nothing"},"plan":{"type":"string","description":"With apply: the plan token the preview printed (lsp-…); exactly those edits are written"}},"required":["filePath"],"additionalProperties":false},
  LspRequest: {"type":"object","properties":{"filePath":{"type":"string","description":"Absolute path of a file the server covers"},"method":{"type":"string","description":"The LSP method, e.g. textDocument/documentHighlight"},"params":{"type":"string","description":"The request params as JSON text"}},"required":["filePath","method"],"additionalProperties":false},
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
    if (missing.length) return `${op} reads filePath, line and character — the symbol's position, 1-based, as Read shows it — and ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing. Example: {"operation":"${op}","filePath":"/absolute/path/file.ts","line":12,"character":8}. Nothing was sent to a language server.`
  } else if (op === 'documentSymbol') {
    if (!input.filePath) return 'documentSymbol reads filePath, which is missing. Example: {"operation":"documentSymbol","filePath":"/absolute/path/file.ts"}. Nothing was sent to a language server.'
  } else if (op === 'workspaceSymbol') {
    if (!input.query?.trim()) return 'workspaceSymbol reads query — a symbol name or part of one — which is missing or empty. Example: {"operation":"workspaceSymbol","query":"parseConfig"}. Nothing was sent to a language server.'
  } else if (op === 'diagnostics') {
    if (!input.paths?.length && !input.filePath) return 'diagnostics reads paths — up to 50 files or directories — or filePath for one file, and neither was given. Example: {"operation":"diagnostics","paths":["/absolute/path/a.ts","/absolute/path/src"]}. Nothing was sent to a language server.'
  } else if (op !== 'serverStatus') {
    return `${op} is not an LspRead operation. LspRead answers goToDefinition, findReferences, hover, goToImplementation, typeDefinition, incomingCalls, outgoingCalls, documentSymbol, workspaceSymbol, diagnostics and serverStatus; renaming, moving, code actions, formatting and raw requests are LspRename, LspMoveSymbol, LspMoveFile, LspCodeAction, LspFormat and LspRequest.`
  }
  return undefined
}
