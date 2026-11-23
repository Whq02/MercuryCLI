import type { LspDiagnostic } from '../lsp.js'
import type { DocContext } from '../needs.js'

export function diagnosticRequest(params: unknown, docContext: DocContext, computeDiagnostics: (file: string) => LspDiagnostic[]): unknown {
  const { file } = docContext(params)
  return { kind: 'full', items: computeDiagnostics(file) }
}
