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
  return `The permission rule \`LSP\` in ${source} covers ${successors}; write those names to narrow it.`
}

export function lspCliNote(flag: string): string {
  return `${flag} LSP covers ${successors}.`
}

export function lspHookNote(event: string, matcher: string, source: string): string | undefined {
  const shape = matcherShape(matcher)
  if (shape === 'names' && matcher.split('|').map(name => name.trim()).includes('LSP')) {
    return `The ${event} hook match \`LSP\` in ${source} fires for ${successors}; only LspRead's input has an operation field.`
  }
  if (shape !== 'names' && shape !== 'everything') {
    try {
      const regex = new RegExp(matcher)
      if (regex.test('LSP') && !LSP_TOOL_NAMES.some(name => regex.test(name))) {
        return `The ${event} hook match \`${matcher}\` in ${source} matches \`LSP\` but none of ${successors} — add their names to keep it.`
      }
    } catch {}
  }
  return undefined
}

export function lspAgentNote(type: string, disallowed = false): string {
  return disallowed
    ? `The agent ${type} lists \`LSP\` in its disallowedTools; that excludes ${successors}.`
    : `The agent ${type} lists \`LSP\` in its tools; that gives it ${successors}.`
}
