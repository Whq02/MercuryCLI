
import { isEnvTruthy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function mercuryLspEnabled(): boolean {
  
  return flagEnv('MERCURY_LSP') !== '0'
}

export function isLspToolCatalogEnabled(): boolean {
  if (mercuryLspEnabled()) return true
  return isEnvTruthy(process.env.ENABLE_LSP_TOOL)
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
  return `<ide-evidence>When the LSP tool is available, edit with IDE evidence instead of guesses: goToDefinition/findReferences before changing a shared symbol, diagnostics on files you just edited before calling them done, and rename preview→apply instead of hand-editing call sites across files.</ide-evidence>`
}

export function getLspPackEvidenceText(): string | null {
  if (!mercuryLspEnabled()) return null
  return (
    '**Edit with IDE evidence, not guesses (LSP tool, when available).** Run `diagnostics` on every file ' +
    'you just edited before reporting it done — the compiler’s verdict beats a re-read. Use ' +
    '`goToDefinition`/`findReferences` before changing a shared symbol, and prefer `rename` preview→apply ' +
    'over hand-editing call sites across files. A fresh post-edit diagnostic on your own change is part of ' +
    'the task, not noise — fix it or surface it honestly.'
  )
}
