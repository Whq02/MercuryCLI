import { quotedArguments } from '../../permissions/rules/decision/commandAnalysis.js'
import type { QuotedScript } from '../../permissions/rules/uncPath.js'
import { scriptArgumentIndexes } from './pathValidation.js'

export function quotedScripts(command: string): QuotedScript[] {
  return quotedArguments(command, argv => scriptArgumentIndexes(argv[0] ?? '', argv.slice(1)).map(index => index + 1))
}
