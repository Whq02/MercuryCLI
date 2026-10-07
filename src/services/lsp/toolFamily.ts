import { LSP_TOOL_NAMES } from '../../tools/LSPTool/prompt.js'
import { matcherShape } from '../../utils/hooks/matcherGrammar.js'

export function lspFamilyMatches(selector: string, name: string): boolean {
  return selector === 'LSP' && (LSP_TOOL_NAMES as readonly string[]).includes(name)
}

export function expandLspFamily(selector: string): readonly string[] {
  return selector === 'LSP' ? LSP_TOOL_NAMES : [selector]
}

const successors = 'LspRead, LspRename, LspMoveSymbol, LspMoveFile, LspCodeAction, LspFormat and LspRequest'

export function lspPermissionNote(source: string): string {
  return `The permission rule \`LSP\` in ${source} now applies to ${successors}, the tools that replaced LSP in 1.0.0-beta.29; write those names to narrow it.`
}

export function lspCliNote(flag: string): string {
  return `${flag} LSP now applies to ${successors}, the tools that replaced LSP in 1.0.0-beta.29.`
}

export function lspHookNote(event: string, matcher: string, source: string): string | undefined {
  const shape = matcherShape(matcher)
  if (shape === 'names' && matcher.split('|').map(name => name.trim()).includes('LSP')) {
    return `The ${event} hook matcher \`LSP\` in ${source} now fires for ${successors}, the tools that replaced LSP in 1.0.0-beta.29; only LspRead's tool_input has an operation field.`
  }
  if (shape !== 'names' && shape !== 'everything') {
    try {
      const regex = new RegExp(matcher)
      if (regex.test('LSP') && !LSP_TOOL_NAMES.some(name => regex.test(name))) {
        return `The ${event} hook matcher \`${matcher}\` in ${source} matched the LSP tool, which became ${successors} in 1.0.0-beta.29; it matches none of them — add their names to keep it.`
      }
    } catch {}
  }
  return undefined
}

export function lspAgentNote(type: string, disallowed = false): string {
  return disallowed
    ? `The agent ${type} lists \`LSP\` in its disallowedTools; it now excludes ${successors}, the tools that replaced LSP in 1.0.0-beta.29.`
    : `The agent ${type} lists \`LSP\` in its tools; it now gets ${successors}, the tools that replaced LSP in 1.0.0-beta.29.`
}
