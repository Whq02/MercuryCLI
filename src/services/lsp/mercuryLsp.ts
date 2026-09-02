// mercuryLsp — the Mercury gates for the IDE-hands bridge (LSP tool + built-in
// TS sidecar + write-capable ops + passive-diagnostics servers).
//
// Contract:
//   · `MERCURY_LSP` is default-on: default-ON for the Mercury build, `=0` opts
//     out. OFF ⇒ byte-identical to the pre-bridge tree — no built-in servers,
//     compat ENABLE_LSP_TOOL semantics, base tool schema/prompt/client-caps,
//     no doctor/doctrine/pack additions.
//   · Every gate here RE-READS env live on each call (the authority-toggles
//     invariant — a toggle is only honest if the gate re-reads env live).
//   · Kept dependency-light (config + envUtils only) so `bun run` proof
//     scripts can load it directly (scripts/lsp/prove-lsp-gating.ts).

import { isEnvTruthy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

/**
 * Master gate for the Mercury IDE-hands bridge. True on a Mercury build unless
 * the operator opted out with MERCURY_LSP=0.
 */
export function mercuryLspEnabled(): boolean {
  
  return flagEnv('MERCURY_LSP') !== '0'
}

/**
 * Catalog gate for LSPTool inclusion in the base tool list:
 * mercuryLspEnabled(), with the compat ENABLE_LSP_TOOL opt-in honoured
 * unchanged. The tool additionally self-gates via isEnabled() →
 * isLspToolMounted(), so it only materializes when a server is actually
 * configured — whatever its health: a failed server is reported by the
 * tool's own serverStatus, never by the tool's absence (FN-015 rank 56).
 */
export function isLspToolCatalogEnabled(): boolean {
  if (mercuryLspEnabled()) return true
  return isEnvTruthy(process.env.ENABLE_LSP_TOOL)
}

/**
 * Write-capable fork ops (rename apply / codeActions apply) ride the same
 * master gate. Split out so that turning off JUST the write path has one
 * seam to land on.
 */
export function mercuryLspWriteOpsEnabled(): boolean {
  return mercuryLspEnabled()
}

/**
 * Operator-provided extra LSP servers (MERCURY_LSP_SERVERS): a JSON object of
 * name → LspServerConfig, validated against the same language-server schema at the
 * builtinServers merge seam. Returns the raw string (or undefined); parsing
 * and validation live in builtinServers.ts so this module stays schema-free.
 */
export function mercuryLspServersEnv(): string | undefined {
  if (!mercuryLspEnabled()) return undefined
  const raw = flagEnv('MERCURY_LSP_SERVERS')
  return raw && raw.trim().length > 0 ? raw : undefined
}

/**
 * The IDE-evidence doctrine line for spawned agents (subagentDoctrine seam)
 * and the scribe/party packs. Phrased conditionally ("when the LSP tool is
 * available") because the tool self-hides when no server exists for the
 * workspace — the line must stay honest in both worlds. Null when the bridge
 * is off ⇒ byte-identical doctrine.
 */
export function getLspDoctrineLine(): string | null {
  if (!mercuryLspEnabled()) return null
  return `<ide-evidence>When the LSP tool is available, edit with IDE evidence instead of guesses: goToDefinition/findReferences before changing a shared symbol, diagnostics on files you just edited before calling them done, and rename preview→apply instead of hand-editing call sites across files.</ide-evidence>`
}

/**
 * The pack-section variant of the IDE-evidence doctrine — spliced as an
 * `evidence` section into the Implementer pack (implementerMode.ts) and the
 * the retired party packs before them) AT CONSUMPTION, never into
 * the generated pack sources (a pack regeneration must not silently drop
 * the bridge doctrine). Null when the bridge is off ⇒ packs byte-identical.
 */
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
