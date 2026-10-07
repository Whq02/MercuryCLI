
import { flagEnv } from '../../substrate/flagRegistry.js'

export function mercuryLspEnabled(): boolean {
  
  return flagEnv('MERCURY_LSP') !== '0'
}

export function isLspToolCatalogEnabled(): boolean {
  return mercuryLspEnabled()
}

export function mercuryLspWriteOpsEnabled(): boolean {
  return mercuryLspEnabled()
}

export function mercuryLspServersEnv(): string | undefined {
  if (!mercuryLspEnabled()) return undefined
  const raw = flagEnv('MERCURY_LSP_SERVERS')
  return raw && raw.trim().length > 0 ? raw : undefined
}

export function getLspDoctrineLine(): string | null {
  if (!mercuryLspEnabled()) return null
  return `<ide-evidence>When LspRead is available, edit with IDE evidence instead of guesses: LspRead goToDefinition/findReferences before changing a shared symbol, LspRead diagnostics on files you just edited before calling them done, and LspRename (preview, then apply) instead of hand-editing call sites across files.</ide-evidence>`
}

export function getLspPackEvidenceText(): string | null {
  if (!mercuryLspEnabled()) return null
  return (
    '**Edit with IDE evidence, not guesses (LspRead, when available).** Run `LspRead diagnostics` on every file ' +
    'you just edited before reporting it done — the compiler’s verdict beats a re-read. Use ' +
    '`LspRead goToDefinition`/`LspRead findReferences` before changing a shared symbol, and prefer `LspRename` preview→apply ' +
    'over hand-editing call sites across files. A fresh post-edit diagnostic on your own change is part of ' +
    'the task, not noise — fix it or surface it honestly.'
  )
}
