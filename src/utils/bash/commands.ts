import { preparedSecurityParse } from './ast.js'
import { isOutputWriteOperator, pipeSpans, splitCommandWithOperators, splitListSegments, withoutRedirects } from '../permissions/decision/commandAnalysis/sequence.js'
import { notBuilt } from '../../pi/holes.js'

export { pipeSpans, splitCommandWithOperators, splitListSegments }

export function splitCommand(command: string): string[] {
  return notBuilt('src/utils/bash/commands.ts:6')
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
