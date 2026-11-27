import { parseForSecurityFromRoot, preparedSecurityParse, type ParseForSecurityResult } from './ast.js'
import { isOutputWriteOperator, pipeSpans, splitCommandWithOperators, splitListSegments, withoutRedirects } from '../../../permissions/rules/decision/command-analysis/sequence.js'

export { pipeSpans, splitCommandWithOperators, splitListSegments }

function partsOf(command: string, parsed: ParseForSecurityResult): string[] {
  return parsed.kind === 'simple' ? parsed.commands.map(simple => simple.text) : command.trim() === '' ? [] : [command]
}

export function splitCommand(command: string): string[] {
  return partsOf(command, preparedSecurityParse(command))
}

export function splitCommandFromRoot(command: string, root: unknown): string[] {
  return partsOf(command, parseForSecurityFromRoot(command, root))
}

type OutputRedirectionCapture = { target: string; operator: '>' | '>>' }
type OutputRedirectionResult = {
  commandWithoutRedirections: string
  redirections: OutputRedirectionCapture[]
  hasDangerousRedirection: boolean
}

export function extractOutputRedirections(command: string): OutputRedirectionResult {
  const parsed = preparedSecurityParse(command)
  if (parsed.kind !== 'simple') return { commandWithoutRedirections: command, redirections: [], hasDangerousRedirection: true }
  const redirections: OutputRedirectionCapture[] = []
  for (const simple of parsed.commands) {
    for (const redirect of simple.redirects) {
      if (!isOutputWriteOperator(redirect.op) || (redirect.op === '>&' && /^[0-9]+$/.test(redirect.target))) continue
      redirections.push({ target: redirect.target, operator: redirect.op === '>>' || redirect.op === '&>>' ? '>>' : '>' })
    }
  }
  return { commandWithoutRedirections: withoutRedirects(command, false), redirections, hasDangerousRedirection: false }
}
